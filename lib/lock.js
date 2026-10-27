// Exclusive ownership of a data directory, shared by the server and the
// administrator scripts that rewrite it.
//
// The lock is a hardlinked file whose contents exist before the name does:
// the would-be owner writes a full holder record to a temporary file and
// link(2)s it onto the lock path, which is atomic — the lock file, once
// visible, is always complete, so no acquiring process can ever observe a
// torn or still-initializing lock, and no one ever has an excuse to delete
// a file it cannot read.
//
// A holder is identified as one running process instance, not by a bare pid:
// in this container the server runs as pid 1, so after a restart the stale
// lock still names pid 1 while a brand-new process sits behind it, and a
// pid-liveness check would refuse to start forever. The record therefore
// carries the kernel boot id (different after every restart) and the pid's
// /proc starttime (different whenever a pid is reused); only a holder that
// matches both is alive. Anything else is a lock left by a SIGKILLed server
// or a crashed restore and may be taken over.
//
// The point of all this is that restore and the server must never touch the
// same store at once: the server would overwrite a restored workspace from
// its stale in-memory copy, and concurrent appends or compactions can lose
// messages.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class LockError extends Error {}

// Changes on every machine boot (and every container restart), so a lock
// naming a different boot id is stale no matter which pids exist now.
const BOOT_ID = (() => {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null; // no /proc: the pid-liveness fallback below still applies
  }
})();

// Field 22 of /proc/<pid>/stat: the process's start time since boot. Two
// processes that share a pid (a restart in a container where init is pid 1)
// never share a start time, so this distinguishes instances.
function startTimeOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2); // comm may contain spaces
    return afterComm.split(" ")[19];
  } catch {
    return null; // no such process (or no /proc)
  }
}

function holderIsAlive(holder) {
  if (!holder || typeof holder.pid !== "number" || !Number.isInteger(holder.pid)) return false;
  if (BOOT_ID == null) {
    // Without /proc a live-looking pid is the best proof available.
    try {
      process.kill(holder.pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM"; // exists but belongs to someone else
    }
  }
  if (holder.bootId !== BOOT_ID) return false; // a previous boot: stale
  return holder.startTime != null && holder.startTime === startTimeOf(holder.pid);
}

// Returns a handle with release(). Throws LockError when a live process owns
// the directory or the lock file cannot be interpreted safely.
function acquire(dir, role) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "lock.json");
  const token = crypto.randomBytes(16).toString("hex");
  const holder = {
    pid: process.pid,
    bootId: BOOT_ID,
    startTime: startTimeOf(process.pid),
    role,
    token,
    at: new Date().toISOString()
  };

  for (;;) {
    // The contents are complete before the name exists: a hardlink from a
    // fully written, fsynced temp file fails with EEXIST if anyone else won
    // the race, and never exposes a half-written lock under the real name.
    const tmp = path.join(dir, `.${token}.lock-tmp`);
    const fd = fs.openSync(tmp, "wx");
    try {
      const data = Buffer.from(JSON.stringify(holder) + "\n", "utf8");
      let off = 0;
      while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, lockPath);
    } catch (err) {
      fs.unlinkSync(tmp);
      if (err.code !== "EEXIST") throw err;
      // Someone else holds — or just took — the lock. The file is complete
      // by construction, so whatever it says can be trusted.
      let found = null;
      try {
        found = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        found = null;
      }
      if (found && holderIsAlive(found)) {
        throw new LockError(
          `${dir} is owned by pid ${found.pid} (${found.role || "unknown process"}); stop that process before running this`
        );
      }
      if (found) {
        try {
          fs.unlinkSync(lockPath); // stale: its owning instance is gone
        } catch {
          /* another acquirer cleared it first; race it again from the top */
        }
        continue;
      }
      // Not ours to interpret: a foreign or unreadable lock file is treated
      // as live rather than stolen. Deleting it could rob a process whose
      // record we simply failed to parse.
      throw new LockError(
        `${dir} holds a lock file that cannot be read as a holder record; remove ${lockPath} by hand only if you are sure no server is running`
      );
    }
    fs.unlinkSync(tmp); // the link, not the lock file, is the visible name now
    return {
      path: lockPath,
      release() {
        // Only the owning instance removes the lock: a different record
        // under the same path (an impossibly stale takeover, a foreign
        // replacement) is left alone.
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (!current || current.token !== token) return;
        } catch {
          return; // unreadable or gone: not provably ours, leave it
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
    };
  }
}

module.exports = { acquire, LockError };
