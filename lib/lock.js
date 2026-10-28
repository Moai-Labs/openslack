// Exclusive ownership of a data directory, shared by the server and the
// administrator scripts that rewrite it. The mechanism is the kernel's
// advisory file lock (flock(2)), taken through the standard flock(1) utility
// on a file descriptor this process keeps open for its whole lifetime:
// `flock -x -n 3` locks the descriptor the parent passed down and exits, and
// the lock then belongs to the parent's open file description — held until
// that descriptor is closed or the process dies, cleanly or by SIGKILL or by
// the container going away.
//
// That is what a lock file naming its holder could never deliver:
// - Exclusivity is the kernel's arbitration, not an inspect-and-replace
//   protocol on a file, so there is no window between "read the holder" and
//   "remove the lock" for a contender to slip through, and two claimants can
//   never both win — including two stale-lock contenders racing a fresh
//   acquisition.
// - No process identity is ever consulted. A PID plus a start time proves
//   nothing across containers: another container's holder may be invisible
//   in our /proc or appear as an unrelated process, and a lock on that
//   evidence alone would let one owner evict another. A kernel lock on the
//   inode has no such blind spot, whatever namespace the holders sit in.
// - A dead owner needs no takeover decision at all: the kernel itself
//   releases the lock when the owner exits, so restart-after-termination is
//   simply "acquire again", and a lock that cannot be taken means a live
//   owner — never an excuse to overwrite a store somebody may be using.
//
// The lock file's contents are never read and the file is never unlinked;
// only the kernel lock on the inode matters, and a file left behind by a
// crash is simply unlocked. Where an exclusive lock cannot be taken at all —
// the flock utility missing, or a filesystem without advisory locks —
// acquisition fails closed rather than opening the store unprotected.
//
// The point of all of it: restore and the server must never touch the same
// store at once — the server would overwrite a restored workspace from its
// stale in-memory copy, and concurrent appends or compactions can lose
// messages.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

class LockError extends Error {}

// Returns a handle with release(). Throws LockError when the directory is
// owned by a live process, or when an exclusive lock cannot be taken here.
function acquire(dir, role) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "lock");
  const fd = fs.openSync(lockPath, "a+"); // create if missing; held open for the owner's lifetime
  let res;
  try {
    // stdio index 3 becomes descriptor 3 in the child: a duplicate of this
    // process's open file description, which is what flock locks and what
    // keeps the lock after the helper exits.
    res = spawnSync("flock", ["-x", "-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
  } catch (err) {
    fs.closeSync(fd);
    throw new LockError(`could not run flock to lock ${dir} exclusively: ${err.message}`);
  }
  if (res.error) {
    fs.closeSync(fd);
    throw new LockError(`could not run flock to lock ${dir} exclusively: ${res.error.message}`);
  }
  if (res.status !== 0) {
    fs.closeSync(fd);
    if (res.status === 1) {
      throw new LockError(`${dir} is owned by another process; stop it before running this`);
    }
    const detail = (res.stderr && res.stderr.toString().trim()) || `flock exited ${res.status}`;
    throw new LockError(`could not lock ${dir} exclusively: ${detail}`);
  }
  return {
    path: lockPath,
    role,
    release() {
      try {
        fs.closeSync(fd); // the kernel drops the lock with the descriptor
      } catch {
        /* already closed */
      }
    }
  };
}

module.exports = { acquire, LockError };
