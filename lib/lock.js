// Exclusive ownership of a data directory, held by the writing process
// itself.
//
// The guarantee: at most one process believes it owns a data directory, and
// that belief lasts exactly as long as the process does. The mechanism is one
// kernel flock on lock.json, taken on an open file description the CALLING
// process keeps open for its entire life:
//
//   - We open lock.json and ask the flock(1) utility to LOCK_EX|LOCK_NB the
//     descriptor, passing it to the child as fd 3. flock(2) locks are owned
//     by the open file description, not the process, so the lock survives
//     the helper's exit and is held by us — the same process that then
//     writes the store. There is no holder process to babysit, no liveness
//     check that can race a rewrite, and no handshake window in which two
//     owners can briefly coexist.
//   - The lock is released only by release() (an intentional release) or by
//     the kernel, when the owning process dies — including SIGKILL, from any
//     PID namespace, mid-rewrite. A dead owner needs no takeover step: the
//     next acquirer simply succeeds. Conversely, killing any OTHER process
//     cannot free the directory, because no other process holds anything.
//
// A stale-looking lock.json is therefore never a reason to take over, and
// never deleted: the flock state is the only truth; the file just records
// who owns the directory for operators reading it.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

class LockError extends Error {}

// The descriptor the flock child locks; it must be a dup of our own fd for
// the lock to land on the description we keep open (node passes a positive
// stdio entry through as that child fd).
const LOCK_CHILD_FD = 3;

function readRecord(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null; // no record yet, or unreadable: the flock decides, not the file
  }
}

// Takes exclusive ownership of dir. Throws LockError if another process owns
// it (or the lock cannot be taken at all); never blocks. The returned handle
// must be release()d by an intentional shutdown; death releases implicitly.
function acquire(dir, role) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "lock.json");
  const fd = fs.openSync(lockPath, "a");
  let taken;
  try {
    taken = spawnSync("flock", ["-x", "-n", String(LOCK_CHILD_FD)], {
      stdio: ["ignore", "ignore", "ignore", fd],
    });
  } catch (err) {
    fs.closeSync(fd);
    throw new LockError(`cannot lock ${dir}: ${err.message}`);
  }
  if (taken.error) {
    fs.closeSync(fd);
    throw new LockError(
      `cannot lock ${dir}: ${taken.error.message} — is the flock utility (util-linux) installed?`
    );
  }
  if (taken.status === 1) {
    fs.closeSync(fd);
    const record = readRecord(lockPath);
    const who = record
      ? ` (held by pid ${record.pid}, role ${record.role}, since ${record.at})`
      : "";
    throw new LockError(
      `${dir} is owned by another process${who}; stop that process before running this`
    );
  }
  if (taken.status !== 0) {
    fs.closeSync(fd);
    throw new LockError(`cannot lock ${dir}: flock(1) exited with status ${taken.status}`);
  }

  // We own the directory. Leave a record for operators; the flock stays the
  // only source of truth about ownership.
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, role, at: new Date().toISOString() }) + "\n"
    );
  } catch {
    /* a diagnostics file that cannot be written is not worth failing over */
  }

  let released = false;
  return {
    path: lockPath,
    // With the owner holding the lock itself there is no unexpected loss to
    // report: the lock cannot outlive this process and cannot be freed by
    // killing anything else. Kept for callers that check these fields.
    get lost() {
      return false;
    },
    get lossReason() {
      return null;
    },
    alive() {
      return !released;
    },
    release() {
      if (released) return;
      released = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}

module.exports = { acquire, LockError };
