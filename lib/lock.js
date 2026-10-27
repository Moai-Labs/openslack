// Exclusive ownership of a data directory, shared by the server and the
// administrator scripts that rewrite it. A small lock file in the directory
// names the owning process; a lock left behind by a dead process (a SIGKILLed
// server, a crashed restore) is detected via the pid and taken over.
//
// The point is that restore and the server must never touch the same store at
// once: the server would overwrite a restored workspace from its stale
// in-memory copy, and concurrent appends or compactions can lose messages.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class LockError extends Error {}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but belongs to someone else
  }
}

// Returns a handle with release(). Throws LockError when a live process owns
// the directory.
function acquire(dir, role) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "lock.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        /* a torn lock file is as good as none */
      }
      if (holder && holder.pid && pidAlive(holder.pid)) {
        throw new LockError(
          `${dir} is owned by pid ${holder.pid} (${holder.role || "unknown process"}); stop that process before running this`
        );
      }
      fs.unlinkSync(lockPath); // stale: its owner is gone
      continue;
    }
    try {
      const data = Buffer.from(JSON.stringify({ pid: process.pid, role, at: new Date().toISOString() }) + "\n", "utf8");
      let off = 0;
      while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return {
      path: lockPath,
      release() {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
    };
  }
  throw new LockError(`could not take ownership of ${dir}`);
}

module.exports = { acquire, LockError };
