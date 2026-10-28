// Exclusive ownership of a data directory, shared by the server and the
// administrator scripts that rewrite it. Restore and the server must never
// touch the same store at once: the server would overwrite a restored
// workspace from its stale in-memory copy, and concurrent appends or
// compactions can lose messages.
//
// The mechanism is flock(2) — an OS-backed advisory lock the kernel grants to
// exactly one open file description and drops the moment every fd referring
// to it is closed, i.e. when its owner dies, however it dies (clean exit,
// SIGKILL, a replaced container). The lock's state lives in the kernel, never
// on disk, so:
//   - there is no torn lock file to "repair" by unlinking (no contender can
//     delete a lock between creation and writing);
//   - a takeover never inspects a pid, so a replacement container whose node
//     runs as pid 1 cannot be mistaken for the previous owner, and pid reuse
//     is irrelevant;
//   - a crashed owner's lock is simply gone; no stale-lock takeover exists.
//
// The process that serves (or restores) is the process that holds the lock,
// for its whole lifetime. A tiny shell wrapper opens the lock file on fd 9,
// takes the non-blocking exclusive flock, and exec's the entry point — so the
// serving process inherits the locked fd itself and releases the lock by
// dying. (The `flock FILE COMMAND` form would fork instead, leaving the lock
// with a parent that outlives the intended owner.) lib/lock.js provides:
//   wrapper(dir, entry, args) — the spawn-ready wrapper command.
//   runUnderLock(dir, role)   — re-run the current entry point inside the
//     wrapper and act as its supervisor (forwarding signals and the exit
//     code). For CLI entry points started outside the wrapper (npm start).
//   acquire(dir, role)        — assert ownership: verify the inherited lock
//     when started inside the wrapper, otherwise verify no live owner (the
//     in-process starts of the test suite).
//   watchSupervisor()         — best-effort: if the supervisor that launched
//     the wrapper was SIGKILLed, shut down instead of lingering as an orphan
//     holding the lock. A courtesy cleanup of our own process; it unlinks
//     nothing and never decides ownership — the kernel lock does that.
//
// Linux only by design: this is the deployment platform, and the lock's
// honesty is worth more than portability.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

class LockError extends Error {}

const LOCK_FD = 9; // the wrapper holds the lock on this inherited descriptor

function lockFileFor(dir) {
  return path.join(dir, LOCK_NAME);
}
const LOCK_NAME = ".owner.lock";

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The wrapper command for an entry point: open the lock file on fd 9, take
// the exclusive lock without waiting, then replace this process with the
// entry point, which inherits the locked fd. If the lock is taken, exit 160
// — another live owner exists and nothing was touched.
function wrapper(dir, entry, args = []) {
  const lf = lockFileFor(dir);
  const script = [
    `exec ${LOCK_FD}>>${shq(lf)}`,
    `flock -x -n ${LOCK_FD} || exit 160`,
    `export OPENSLACK_LOCK_FD=${LOCK_FD} OPENSLACK_LOCK_FILE=${shq(lf)}`,
    `exec ${shq(entry)}${args.length ? " " + args.map(shq).join(" ") : ""}`
  ].join("; ");
  return { file: "sh", args: ["-c", script], lockPath: lf };
}

// Does this process hold the kernel flock on the inherited fd, pointing at
// the data directory's lock file? /proc/self/fdinfo/<fd> carries the lock's
// kind and mode, and fstat compares the inode to the lock file's.
function kernelLockHeld(fd, lf) {
  try {
    const st = fs.fstatSync(fd);
    const lockStat = fs.statSync(lf);
    if (st.dev !== lockStat.dev || st.ino !== lockStat.ino) return false;
    const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    // The fdinfo line reads e.g. "lock:\t1: FLOCK  ADVISORY  WRITE 2259 ...";
    // a READ lock says READ and must not count as ownership.
    return /FLOCK.*\bWRITE\b/.test(info);
  } catch {
    return false;
  }
}

// Is this process already the locked owner of dir? (Started inside the
// wrapper: the Docker CMD, the persistence check, runUnderLock's child.)
function alreadyHeld(dir) {
  const lf = lockFileFor(dir);
  if (process.env.OPENSLACK_LOCK_FILE !== lf) return false;
  const fd = Number(process.env.OPENSLACK_LOCK_FD);
  return Number.isInteger(fd) && fd > 2 && kernelLockHeld(fd, lf);
}

// A momentary probe of the advisory lock: exit 0 means no live owner right
// now, anything else means the directory is taken.
function lockFree(dir) {
  const lf = lockFileFor(dir);
  fs.mkdirSync(dir, { recursive: true });
  const probe = spawnSync("sh", ["-c", `exec ${LOCK_FD}>>${shq(lf)}; flock -x -n ${LOCK_FD}`], { encoding: "utf8" });
  if (probe.error) throw new LockError(`flock(2) is not available (${probe.error.message}); exclusive data-directory ownership needs it`);
  return probe.status === 0;
}

const busyMessage = (dir) => `${dir} is owned by another live process (it holds the advisory lock ${lockFileFor(dir)}); stop that process before running this`;

// Re-run the current entry point inside the wrapper and supervise it:
// forward SIGTERM/SIGINT and exit with the child's code. The child holds the
// kernel lock itself for its lifetime. Returns to the supervisor once the
// child is running — the caller must stop and never start its own copy.
function runUnderLock(dir, role) {
  if (!lockFree(dir)) throw new LockError(busyMessage(dir));
  const cmd = wrapper(dir, process.execPath, [process.argv[1], ...process.argv.slice(2)]);
  const child = spawn(cmd.file, cmd.args, {
    stdio: "inherit",
    env: { ...process.env, OPENSLACK_SUPERVISOR_PID: String(process.pid) }
  });
  child.on("error", (err) => {
    console.error(`refusing to start: could not take exclusive ownership of ${dir}: ${err.message}`);
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => child.kill(sig));
  }
  child.on("exit", (code, signal) => process.exit(code == null ? 1 : code));
  return { supervisor: true, role, child };
}

// Best-effort guard against an orphaned holder: if the supervisor that
// launched us under the wrapper was SIGKILLed, shut down instead of lingering
// with the lock. This is a courtesy cleanup of our own process — it unlinks
// nothing and never decides ownership; the kernel lock does that.
function watchSupervisor() {
  const ppid = Number(process.env.OPENSLACK_SUPERVISOR_PID);
  if (!ppid) return;
  const timer = setInterval(() => {
    try {
      process.kill(ppid, 0);
    } catch {
      process.kill(process.pid, "SIGTERM");
    }
  }, 500);
  timer.unref();
}

// Record ownership of dir for this process. Inside the wrapper the kernel
// lock is already held and dies with this process; otherwise (the test
// suite's in-process starts) verify that no live owner exists, which is what
// those starts need from the check.
function acquire(dir, role) {
  if (alreadyHeld(dir)) {
    return { path: lockFileFor(dir), kernel: true, release() {} };
  }
  if (!lockFree(dir)) throw new LockError(busyMessage(dir));
  return { path: lockFileFor(dir), kernel: false, release() {} };
}

module.exports = { acquire, runUnderLock, alreadyHeld, watchSupervisor, lockFree, lockFileFor, wrapper, kernelLockHeld, LOCK_FD, LockError };