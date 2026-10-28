// Tests for the data-directory lock: ownership is an OS flock held by a
// holder process. Proven here with real processes: exactly one of any number
// of simultaneous acquirers wins, a lock left by a dead process is free
// without any takeover step (the kernel released it at death), a live holder
// is never judged from /proc — including from another PID namespace — and
// ownership lasts until release or process death.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { acquire, LockError } from "../lib/lock.js";

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openslack-lock-"));
}

const lockPath = (dir) => path.join(dir, "lock.json");

// A child process that tries once to acquire a directory, prints the
// outcome, and then HOLDS the lock for a moment if it won — used to prove
// the rules hold between real process instances. Holding matters: the
// holder process keeps the flock until it is killed or its owner exits.
const CHILD = `
const { acquire, LockError } = require(${JSON.stringify(new URL("../lib/lock.js", import.meta.url).pathname)});
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

// After a holder dies the kernel releases the flock within moments; poll
// rather than assume, so the test measures the mechanism, not scheduler lag.
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

test("a lock file left behind by a dead process needs no takeover: the kernel already released it", () => {
  const dir = freshDir();
  // What a SIGKILLed server leaves: a file with a record, held by nobody.
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 4193, role: "server", at: "2020-01-01T00:00:00.000Z" }) + "\n");
  const lock = acquire(dir, "test");
  assert.equal(fs.existsSync(lockPath(dir)), true, "acquiring never deletes the lock file");
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
  // the holder dies with its owner — that is the whole takeover mechanism.
  await killHard(child);
  acquireEventually(dir).release();
});

test("ownership lasts until release, and release is safe to repeat", () => {
  const dir = freshDir();
  const lock = acquire(dir, "test");
  assert.throws(() => acquire(dir, "test"), LockError, "a second acquirer in the same process is refused");
  lock.release();
  acquireEventually(dir).release();
  acquireEventually(dir).release(); // must not throw
});

// A child that owns the lock AND writes to a file while it does — the real
// shape of a server. On unexpected lock loss it must stop writing: first the
// synchronous liveness check, then the loss callback, whichever lands first.
const CHILD_WRITER = `
const fs = require("node:fs");
const { acquire } = require(${JSON.stringify(new URL("../lib/lock.js", import.meta.url).pathname)});
let stopped = false;
const lock = acquire(process.argv[2], "writer", {
  onLost: () => {
    if (!stopped) { stopped = true; console.log("LOST"); }
  }
});
console.log("WON " + lock.holderPid);
const timer = setInterval(() => {
  if (stopped || !lock.alive()) {
    if (!stopped) { stopped = true; console.log("LOST"); }
    clearInterval(timer);
    return;
  }
  fs.appendFileSync(process.argv[3], "w\\n");
}, 20);
setTimeout(() => process.exit(0), 30000); // stay alive for the test to watch
`;

// Runs the writing child and lets the test wait for its next line.
function runWriter(dir, file) {
  const child = execFile(process.execPath, ["-e", CHILD_WRITER, "writer", dir, file]);
  const lines = [];
  const wait = (prefix, ms = 10000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for "${prefix}"; saw: ${lines.join(" | ") || "nothing"}`)), ms);
      const check = () => {
        const hit = lines.find((l) => l.startsWith(prefix));
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        }
      };
      child.stdout.on("data", (c) => {
        for (const l of c.toString().split("\n")) if (l.trim()) lines.push(l.trim());
        check();
      });
      check();
    });
  return { child, wait };
}

test("an intentional release is never reported as a loss", async () => {
  const dir = freshDir();
  const losses = [];
  const lock = acquire(dir, "owner", { onLost: (why) => losses.push(why) });
  lock.release(); // the owner chose to let go
  acquireEventually(dir).release(); // the directory is free for the next owner
  // Give the wrapper's exit event its moment: it must not surface as a loss.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(losses, [], "release() is an intentional release, not an unexpected loss");
  assert.equal(lock.lost, false);
});

test("killing the holder while its owner stays alive fails the owner closed before another owner acquires", async () => {
  const dir = freshDir();
  const losses = [];
  const lock = acquire(dir, "owner", { onLost: (why) => losses.push(why) });
  assert.equal(lock.alive(), true, "the holder is alive while the lock is held");
  assert.ok(lock.holderPid > 0, "the owner knows the holder it depends on");

  // Kill the HOLDER alone; the owner process keeps running.
  process.kill(lock.holderPid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (!lock.lost && Date.now() < deadline) await new Promise((r) => setImmediate(r));
  assert.equal(lock.lost, true, "the owner learned of the unexpected loss");
  assert.match(lock.lossReason, /lost unexpectedly/);
  assert.equal(losses.length, 1, "the loss was reported exactly once");
  assert.equal(lock.alive(), false, "the synchronous check refuses to vouch for a dead holder");

  // Only after the first owner has failed closed does a second owner take
  // the directory — the first owner's handle reports lost, its callback has
  // run, and nothing of it is mid-write.
  const second = acquireEventually(dir);
  lock.release(); // must not surface as a second loss
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(losses.length, 1, "an intentional release after a loss is not another loss");
  second.release();
});

test("a writing owner stops writing when its holder dies, and writes nothing under the new owner", async () => {
  const dir = freshDir();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-writes-"));
  const file = path.join(scratch, "writes.log");
  const writer = runWriter(dir, file);
  const won = await writer.wait("WON");
  const holderPid = Number(won.split(" ")[1]);
  assert.ok(holderPid > 0);

  // The owner is writing while it owns the lock.
  const writesStart = Date.now();
  while ((!fs.existsSync(file) || fs.readFileSync(file, "utf8").length === 0) && Date.now() - writesStart < 5000) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(fs.existsSync(file) && fs.readFileSync(file, "utf8").length > 0, "the owner was writing while it owned the lock");

  // Kill the holder; the owner must stop — synchronously, before the next
  // write — and report the loss.
  process.kill(holderPid, "SIGKILL");
  await writer.wait("LOST");
  const stoppedAt = fs.readFileSync(file, "utf8");

  // Now a second owner takes the directory. The first owner, failed closed,
  // must not write a byte under it.
  const second = acquireEventually(dir);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.readFileSync(file, "utf8"), stoppedAt, "no write after the loss — the directory belongs to the new owner alone");
  second.release();
  writer.child.kill("SIGKILL");
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
  assert.equal(c.outcome, "WON", "once the holder is gone, another namespace's process acquires the lock");
  c.child.kill("SIGKILL");
});
