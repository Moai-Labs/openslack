// Tests for the data-directory lock: ownership is an OS flock held by the
// writing process itself, on a descriptor it keeps open for its whole life.
// Proven here with real processes: exactly one of any number of simultaneous
// acquirers wins, a lock left behind by a dead process is free without any
// takeover step (the kernel released it at death), killing some OTHER process
// cannot free a live owner's directory, and — the property the holder-process
// design could not give — during a long synchronous rewrite no replacement
// writer can acquire ownership while the original writer can still mutate the
// store.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { acquire, LockError } from "../lib/lock.js";

const LOCK_MODULE = JSON.stringify(new URL("../lib/lock.js", import.meta.url).pathname);
const STORE_MODULE = JSON.stringify(new URL("../lib/store.js", import.meta.url).pathname);

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openslack-lock-"));
}

const lockPath = (dir) => path.join(dir, "lock.json");
const logPath = (dir) => path.join(dir, "messages.jsonl");
const progressPath = (dir) => path.join(dir, ".rewrite-progress");

// A child process that tries once to acquire a directory, prints the
// outcome, and then HOLDS the lock for a moment if it won — used to prove
// the rules hold between real process instances. Holding matters: the lock
// lives on a descriptor the child keeps open until it exits.
const CHILD = `
const { acquire, LockError } = require(${LOCK_MODULE});
try {
  acquire(process.argv[2], "child");
  console.log("WON");
  setTimeout(() => process.exit(0), 4000); // hold the lock while the test looks
} catch (err) {
  console.log(err instanceof LockError ? "REFUSED" : "ERROR:" + err.message);
}
`;

// Runs one child and resolves { child, outcome } as soon as it prints one.
async function runChild(cmd, args) {
  const child = execFile(cmd, args);
  const outcome = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.trim()) resolve(out.trim().split("\n")[0]);
    });
    child.on("exit", (code) => resolve(out.trim() || `EXIT:${code}`));
    child.on("error", reject);
    setTimeout(() => resolve("TIMEOUT"), 10000);
  });
  return { child, outcome };
}

const childOutcome = (dir) => runChild(process.execPath, ["-e", CHILD, "holder", dir]);

const exited = (child) =>
  new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode) return resolve();
    child.on("exit", resolve);
  });

// After an owner dies the kernel has already released the flock; poll rather
// than assume, so the test measures the mechanism, not scheduler lag.
function acquireEventually(dir, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return acquire(dir, "test");
    } catch (err) {
      if (!(err instanceof LockError) || Date.now() > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

const killHard = async (child) => {
  try {
    child.kill("SIGKILL");
  } catch { /* already gone */ }
  await exited(child);
};

// A child that acquires the lock and then performs a LONG SYNCHRONOUS
// REWRITE of the store — the shape of scripts/restore.js and of the server's
// own saves: nothing async, no chances for the event loop, each mutation
// fsynced before the next. Its only side channel to the test is the progress
// file; the store itself is mutated through the real Store API.
const CHILD_WRITER = `
const fs = require("node:fs");
const { acquire, LockError } = require(${LOCK_MODULE});
const { Store } = require(${STORE_MODULE});
const dir = process.argv[2];
const progress = process.argv[3];
let store;
try {
  acquire(dir, "writer");
  store = new Store(dir).init();
} catch (err) {
  console.log(err instanceof LockError ? "REFUSED" : "ERROR:" + err.message);
  process.exit(0);
}
console.log("WON");
const TOTAL = 600;
fs.writeFileSync(progress, "START\\n");
for (let i = 1; i <= TOTAL; i++) {
  store.appendMessage({
    id: String(i), wsId: "ws-rewrite", chId: "ch-rewrite", userId: "u-rewrite",
    handle: "writer", text: "rewrite message " + i, at: new Date().toISOString()
  });
  fs.writeFileSync(progress, String(i) + "\\n");
}
fs.writeFileSync(progress, "DONE\\n");
process.exit(0);
`;

// Launches the writing child. Returns { child, waitStart } — waitStart
// resolves once the child owns the lock and the rewrite has begun.
function runWriter(dir) {
  const child = execFile(process.execPath, ["-e", CHILD_WRITER, "writer", dir, progressPath(dir)]);
  const waitStart = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer never started the rewrite")), 15000);
    const poll = () => {
      let p = "";
      try { p = fs.readFileSync(progressPath(dir), "utf8").trim(); } catch { /* not yet */ }
      if (p === "START" || /^\d+$/.test(p)) { clearTimeout(timer); resolve(p); return; }
      setTimeout(poll, 10);
    };
    child.stdout.on("data", (c) => { if (c.toString().includes("REFUSED")) { clearTimeout(timer); reject(new Error("writer was refused a free directory")); } });
    poll();
  });
  return { child, waitStart };
}

// Reads the progress file, tolerating the races of watching a file the
// writer rewrites every iteration.
function readProgress(dir) {
  try {
    return fs.readFileSync(progressPath(dir), "utf8").trim();
  } catch {
    return "";
  }
}

test("a lock file left behind by a dead process needs no takeover: the kernel already released it", () => {
  const dir = freshDir();
  // What a SIGKILLed server leaves: a file with a record, held by nobody.
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 4193, role: "server", at: "2020-01-01T00:00:00.000Z" }) + "\n");
  const lock = acquire(dir, "test");
  assert.equal(fs.existsSync(lockPath(dir)), true, "acquiring never deletes the lock file");
  const record = JSON.parse(fs.readFileSync(lockPath(dir), "utf8"));
  assert.equal(record.pid, process.pid, "the record now names the current owner");
  lock.release();
  assert.equal(fs.existsSync(lockPath(dir)), true, "releasing never deletes the lock file either");
});

test("simultaneous acquisition of an existing stale lock races to exactly one winner", async () => {
  const dir = freshDir();
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999, role: "dead process" }) + "\n");
  const [a, b] = await Promise.all([childOutcome(dir), childOutcome(dir)]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["REFUSED", "WON"], "one acquirer wins, the other is refused");
  const winner = a.outcome === "WON" ? a : b;
  await killHard(winner.child);
  // The winner died without releasing: the lock must still be free to take
  // at once, with no takeover step that could race a second acquirer.
  acquireEventually(dir).release();
});

test("a live holder is respected, its death alone frees the directory", async () => {
  const dir = freshDir();
  const { child, outcome } = await childOutcome(dir);
  assert.equal(outcome, "WON", "the child took the free lock");
  const record = fs.readFileSync(lockPath(dir), "utf8");

  assert.throws(() => acquire(dir, "test"), LockError, "a live holder's lock is refused, not stolen or re-judged");
  assert.equal(fs.readFileSync(lockPath(dir), "utf8"), record, "the refused acquirer left the lock file untouched");

  // SIGKILL: no cleanup, no release call. The kernel ends the flock because
  // the owner dies with its descriptor — that is the whole release mechanism.
  await killHard(child);
  acquireEventually(dir).release();
});

test("ownership lasts until release, and release is safe to repeat", () => {
  const dir = freshDir();
  const lock = acquire(dir, "test");
  assert.throws(() => acquire(dir, "test"), LockError, "a second acquirer in the same process is refused: a new descriptor cannot share the lock");
  lock.release();
  acquireEventually(dir).release();
  acquireEventually(dir).release(); // must not throw
});

// A child that owns the lock and spawns an unrelated child of its own — a
// stand-in for any other process an operator might point a signal at.
const CHILD_OWNER_WITH_DECOY = `
const { spawn } = require("node:child_process");
const { acquire, LockError } = require(${LOCK_MODULE});
try {
  acquire(process.argv[2], "owner");
} catch (err) {
  console.log(err instanceof LockError ? "REFUSED" : "ERROR:" + err.message);
  process.exit(0);
}
const decoy = spawn("sleep", ["30"]);
console.log("WON " + decoy.pid);
setTimeout(() => { try { decoy.kill("SIGKILL"); } catch { /* done */ } process.exit(0); }, 15000);
`;

test("killing another process never frees the directory; killing the owner does", async () => {
  const dir = freshDir();
  const { child, outcome } = await runChild(process.execPath, ["-e", CHILD_OWNER_WITH_DECOY, "owner", dir]);
  assert.match(outcome, /^WON \d+$/, "the owner took the free lock and reported its decoy");
  const decoyPid = Number(outcome.split(" ")[1]);
  assert.ok(decoyPid > 0);

  // Kill the decoy — some other process entirely. The directory must stay
  // owned: no process but the owner holds anything, so nothing can be freed.
  process.kill(decoyPid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => acquire(dir, "test"), LockError, "the owner still owns the directory after its decoy died");

  // Only the owner's own death frees the directory.
  await killHard(child);
  acquireEventually(dir).release();
});

test("no replacement writer can acquire ownership during a long synchronous rewrite, and the writer can still mutate the store throughout", async () => {
  const dir = freshDir();
  const { child, waitStart } = runWriter(dir);
  await waitStart; // the writer owns the directory and is rewriting

  // Compete for the whole window: every attempt while the rewrite runs must
  // be refused, and the writer's mutations must keep landing meanwhile.
  const seenLines = new Set();
  let attempts = 0;
  for (;;) {
    const p = readProgress(dir);
    if (p === "DONE") break;
    attempts++;
    try {
      acquire(dir, "racer").release();
      assert.fail("a replacement writer acquired ownership during the original writer's rewrite");
    } catch (err) {
      if (!(err instanceof LockError)) throw err;
    }
    for (const line of fs.readFileSync(logPath(dir), "utf8").split("\n")) {
      if (line.trim()) seenLines.add(JSON.parse(line).id);
    }
  }
  assert.ok(attempts > 5, `the competitor actually raced the rewrite (attempted ${attempts} times)`);
  assert.equal(seenLines.size, 600, "every one of the writer's 600 fsynced mutations landed while it owned the directory");

  await exited(child);
  assert.equal(child.exitCode, 0);
  // When the writer finishes, ownership is available — not stuck behind any
  // takeover logic.
  acquireEventually(dir).release();
});

test("a writer SIGKILLed mid-rewrite frees the directory at once", async () => {
  const dir = freshDir();
  const { child, waitStart } = runWriter(dir);
  await waitStart;
  // Let the rewrite get well under way, then kill it with no chance to clean up.
  while (Number(readProgress(dir) || 0) < 100) {
    await new Promise((r) => setImmediate(r));
  }
  child.kill("SIGKILL");
  await exited(child);
  assert.ok(fs.existsSync(logPath(dir)), "the killed writer had already mutated the store");

  // The kernel released the flock with the process: no stale-lock takeover,
  // no liveness re-judging — the next owner simply succeeds, immediately.
  const next = acquireEventually(dir, 2000);
  next.release();
});

test("two live processes in separate PID namespaces sharing one data directory: exactly one writer", async (t) => {
  // unshare(1) needs user-namespace privileges; where the environment does
  // not grant them this test says so and skips. The mechanism itself reads
  // no /proc and no pid at all — liveness is the kernel's own flock state —
  // so a foreign PID namespace has nothing to misread.
  let permitted = null;
  try {
    permitted = await runChild("unshare", ["--user", "--map-root-user", "--fork", "--pid", "true"]);
  } catch {
    permitted = null;
  }
  if (!permitted || permitted.outcome !== "EXIT:0") {
    t.skip("unshare is not permitted in this environment; cross-namespace safety is structural (the lock never reads /proc)");
    return;
  }
  const dir = freshDir();
  // --kill-child: killing the unshare wrapper kills the node process inside
  // the namespace, which is the lock's owner.
  const ns = (d) => runChild("unshare", ["--user", "--map-root-user", "--fork", "--pid", "--kill-child", process.execPath, "-e", CHILD, "holder", d]);

  const a = await ns(dir);
  assert.equal(a.outcome, "WON", "the first namespace's process took the lock");
  const b = await ns(dir);
  assert.equal(b.outcome, "REFUSED", "a live process in another PID namespace is refused, not declared stale");

  await killHard(a.child);
  const c = await ns(dir);
  assert.equal(c.outcome, "WON", "once the owner is gone, another namespace's process acquires the lock");
  c.child.kill("SIGKILL");
});
