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
// The reverse death is watched too. If the holder chain dies while its owner
// is still alive — an OOM kill, an operator's stray SIGKILL — the kernel
// releases the flock at that moment and another process can acquire the
// directory while the first owner still holds live state in memory. So the
// owner watches its wrapper's exit: an unexpected exit is a lost lock, and
// the owner is told at once through the onLost callback (the server fails
// closed and exits rather than keep writing beside a new owner). release()
// marks its own teardown first, so an intentional release is never reported
// as a loss. alive() re-checks the holder synchronously — one kill(pid, 0) —
// so a caller that is about to write can refuse even in the moments before
// the exit event is delivered. Both are advisory in the same direction:
// they may only ever report MORE deadness, never less.
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
// the lock is held — carrying the holder's own pid, so the owner can
// re-check the holder synchronously — then keeps holding until the owner is
// gone (stdin EOF) or it is killed.
const HOLDER = `
const fs = require("node:fs");
fs.writeFileSync(process.argv[1], process.pid + "\\n");
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
// the directory or the OS lock cannot be taken. opts.onLost, when given, is
// called once with a reason if the holder chain dies without release() —
// the moment an owner learns the lock is gone is the moment it must stop
// using the store.
function acquire(dir, role, opts = {}) {
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

  // Loss detection is attached before the handshake ends, so a holder that
  // dies at any point is never mistaken for a live one. Events are not
  // delivered while this function blocks in sleepSync, and everything from
  // here to the return is synchronous — an exit that happens during the
  // handshake is handled by the handshake itself (the status file appears,
  // or the marker never does), and any pending exit event is delivered only
  // after this function has returned with the handler attached.
  let owned = false;
  let released = false;
  let lost = false;
  let lossReason = null;
  child.on("exit", () => {
    removeQuietly(status); // the wrapper's own exit echo, if it got that far
    if (!owned || released) return; // handshake failure or an intentional release
    lost = true;
    lossReason = `the data-directory lock on ${dir} was lost unexpectedly: the holder process (pid ${holderPid || "?"}) exited without release()`;
    // The wrapper may have exited while the holder beneath it lives on; end
    // the whole group so the lock is certainly released and "lost" means
    // released, in every case.
    killGroup(child, "SIGKILL");
    try {
      opts.onLost && opts.onLost(lossReason);
    } catch (err) {
      console.error("lock-loss handler failed:", err);
    }
  });

  let holderPid = null;
  const deadline = Date.now() + HANDSHAKE_MS;
  for (;;) {
    if (fs.existsSync(marker)) {
      // The marker carries the holder's pid; a writeFileSync can be observed
      // between create and write, so an empty read is retried, not trusted.
      const pid = Number(fs.readFileSync(marker, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        holderPid = pid;
        break;
      }
    }
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
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, holderPid, role, at: new Date().toISOString() }) + "\n");
  } catch {
    /* a full disk must not turn into a lost lock */
  }

  owned = true; // from here the exit handler reports unexpected loss

  return {
    path: lockPath,
    holderPid,
    get lost() {
      return lost;
    },
    get lossReason() {
      return lossReason;
    },
    // A synchronous, advisory re-check of the holder, for a caller that is
    // about to write and wants to refuse if the lock may already be gone.
    // The exit event is the authoritative signal; this only catches a death
    // whose event has not been delivered yet. A false positive is impossible
    // in the dangerous direction — it reports the holder as gone, which at
    // worst stops an owner that could in principle have kept writing.
    alive() {
      if (lost) return false;
      if (holderPid == null) return true; // unknown holder: defer to the exit event
      try {
        process.kill(holderPid, 0); // signal 0: existence only, nothing sent
        return true;
      } catch {
        return false;
      }
    },
    release() {
      released = true; // this teardown is intentional, never a reported loss
      if (child.exitCode != null) return;
      // The kernel releases the flock the moment the holder dies; ending the
      // whole group makes that immediate and leaves nothing behind.
      try { child.stdin.end(); } catch { /* already closed */ }
      killGroup(child, "SIGKILL");
      // The dying wrapper still writes its exit echo into the status file;
      // sweep it once it has had the moment to do that.
      const sweep = setTimeout(() => removeQuietly(status), 100);
      sweep.unref();
    }
  };
}

module.exports = { acquire, LockError };
