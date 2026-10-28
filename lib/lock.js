// Exclusive ownership of a data directory, shared by the server and the
// administrator scripts that rewrite it. A small lock file in the directory
// names the owning process; a lock left behind by a dead process (a SIGKILLed
// server, a crashed restore, a container that went away) is detected and taken
// over.
//
// A process is identified not by its PID alone but by its incarnation: the
// PID together with the kernel's start time for that PID (from /proc, the same
// trick ps and pgrep use). A container restart runs the new server as the same
// PID — usually 1 — and PID numbers are reused freely elsewhere, so "a live
// process has this PID" proves nothing; "a live process has this PID and
// started when the lock says it did" proves the lock still belongs to someone.
// Without that, a server on a persistent volume could refuse to restart behind
// its own previous incarnation's lock.
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

// The kernel records each process's start time in jiffies since boot as field
// 22 of /proc/<pid>/stat. The comm field may contain spaces, so parse from
// after the final ')': state is field 3 there, making starttime index 19.
function startTick(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    return afterComm.split(" ")[19] || null;
  } catch {
    return null; // no such process, or /proc is not available here
  }
}

// A lock's holder is alive only if a process with that PID exists AND it is
// the same process incarnation the lock was written by. When /proc cannot
// settle the question, the lock is treated as stale: a restart must never be
// blocked by a lock it cannot verify, and a genuinely live holder in the same
// PID namespace is always verifiable.
function holderIsLive(holder) {
  if (!holder || !holder.pid || !pidAlive(holder.pid)) return false;
  const now = startTick(holder.pid);
  if (now == null || !holder.startTick) return false;
  return String(now) === String(holder.startTick);
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
      if (holderIsLive(holder)) {
        throw new LockError(
          `${dir} is owned by pid ${holder.pid} (${holder.role || "unknown process"}); stop that process before running this`
        );
      }
      fs.unlinkSync(lockPath); // stale: its owner is gone or is a past incarnation
      continue;
    }
    try {
      const data = Buffer.from(
        JSON.stringify({ pid: process.pid, startTick: startTick(process.pid), role, at: new Date().toISOString() }) + "\n",
        "utf8"
      );
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

module.exports = { acquire, LockError, startTick, holderIsLive };
