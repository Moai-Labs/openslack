// Exclusive ownership of a data directory, shared by the server and the
// administrator scripts that rewrite it.
//
// Ownership is an OS lock: a holder process, kept running by this module,
// holds a flock(2) (LOCK_EX) on a lock file inside the directory. The kernel
// arbitrates, so the mechanism has none of the failure modes a home-made
// takeover has:
//
//  - Of any number of acquirers — two in this container, or two containers
//    mounting the same volume, or processes in different PID namespaces —
//    exactly one holds LOCK_EX at a time. There is no protocol step at which
//    two writers can both believe they own the directory.
//  - Nothing is ever unlinked by an acquirer and no holder record is ever
//    interpreted for liveness. A file left behind by a SIGKILLed server is
//    simply a file nobody holds the flock on: the next acquirer wins it
//    immediately, and it can never delete a record a replacement owner has
//    just published.
//  - Nothing is inferred from /proc, which is local to a PID namespace: the
//    state of a process in another container is not ours to judge, and the
//    kernel does not need our help — it releases the flock itself.
//  - Ownership lasts exactly as long as the holder process does. The holder
//    reads the pipe from its owner: when the owning process dies — SIGKILL
//    included — the kernel closes the pipe, the holder sees EOF and exits,
//    and the kernel releases the flock on the spot.
//
// The handshake is synchronous by construction: the shell wrapper records
// flock's exit status in a status file, and a holder that is actually
// running — which is proof that flock(2) was won, since it only runs then —
// publishes a marker file before its owner proceeds. Both are unique to one
// acquisition and are removed again; the lock file's own contents are a
// diagnostic record only and are never read to decide anything.
//
// The point of all this is that restore and the server must never touch the
// same store at once: the server would overwrite a restored workspace from
// its stale in-memory copy, and concurrent appends or compactions can lose
// messages.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

class LockError extends Error {}

// Runs under flock(1), which has already taken LOCK_EX on the lock file
// before this process starts. It publishes the marker that tells its owner
// the lock is held, then keeps holding until the owner is gone (stdin EOF)
// or it is killed.
const HOLDER = `
const fs = require("node:fs");
fs.writeFileSync(process.argv[1], "held\\n");
let done = false;
const finish = () => { if (!done) { done = true; process.exit(0); } };
process.stdin.on("end", finish);
process.stdin.on("close", finish);
process.stdin.on("error", finish);
process.stdin.resume();
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
setInterval(() => {}, 1 << 30); // otherwise stay alive and keep holding
`;

// How long acquire() waits for the handshake before giving up loudly.
const HANDSHAKE_MS = 10000;

// A synchronous sleep that does not need the event loop: the server must not
// start listening before the lock is provably held.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal); // the whole group: sh, flock(1), holder
  } catch {
    /* already gone */
  }
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

// Returns a handle with release(). Throws LockError when a live process owns
// the directory or the OS lock cannot be taken.
function acquire(dir, role) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "lock.json");
  const token = crypto.randomBytes(8).toString("hex");
  const marker = path.join(dir, `.lock-held-${token}`);
  const status = path.join(dir, `.lock-status-${token}`);

  // flock(1) takes LOCK_EX on the file, creating it if needed, then runs the
  // holder. -n: never wait — a busy directory must fail loudly, not queue.
  // The wrapper records flock's exit status, so a loser is known at once.
  // detached: the child leads its own process group, so release() can end
  // the whole chain with one signal.
  const child = spawn(
    "sh",
    ["-c", 'flock -x -n "$1" "$2" -e "$3" "$4"; echo $? > "$5"', "sh", lockPath, process.execPath, HOLDER, marker, status],
    { stdio: ["pipe", "ignore", "ignore"], detached: true }
  );
  // The holder must never keep its owner alive: an owner that finishes its
  // own work and exits (a test file, a script) releases the lock by dying.
  child.unref();
  child.stdin.unref();

  const cleanup = () => {
    removeQuietly(marker);
    removeQuietly(status);
  };

  const deadline = Date.now() + HANDSHAKE_MS;
  for (;;) {
    if (fs.existsSync(marker)) break; // our holder runs — so our flock won
    if (fs.existsSync(status)) {
      const code = fs.readFileSync(status, "utf8").trim();
      cleanup();
      killGroup(child, "SIGKILL");
      if (code === "1") {
        // flock(1) exits 1 when the lock is held by someone else.
        let found = null;
        try { found = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { /* diagnostics only */ }
        const who = found && found.role ? ` (${found.role}, pid ${found.pid})` : "";
        throw new LockError(`${dir} is owned by another process${who}; stop that process before running this`);
      }
      throw new LockError(`cannot lock ${dir}: flock(1) exited with status ${code} — is the flock utility (util-linux) installed and the data directory writable?`);
    }
    if (Date.now() > deadline) {
      cleanup();
      killGroup(child, "SIGKILL");
      throw new LockError(`${dir}: timed out waiting for the data-directory lock`);
    }
    sleepSync(20);
  }
  cleanup(); // the handshake files have served their purpose

  // Diagnostics only: never read back to decide anything.
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, holderPid: child.pid, role, at: new Date().toISOString() }) + "\n");
  } catch {
    /* a full disk must not turn into a lost lock */
  }

  return {
    path: lockPath,
    release() {
      if (child.exitCode != null) return;
      // The kernel releases the flock the moment the holder dies; ending the
      // whole group makes that immediate and leaves nothing behind.
      try { child.stdin.end(); } catch { /* already closed */ }
      killGroup(child, "SIGKILL");
    }
  };
}

module.exports = { acquire, LockError };
