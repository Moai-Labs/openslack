// Tests for the data-directory lock: exclusive ownership that survives
// container restarts (pid reuse), cannot steal an initializing or foreign
// lock, races two simultaneous acquirers to exactly one winner, and releases
// only its own lock.
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
const bootId = () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

// The /proc start time of a pid, the same way lib/lock.js reads it.
const startTimeOf = (pid) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};

// A child process that tries once to acquire a directory, prints the
// outcome, and then HOLDS the lock for a moment if it won — used to prove
// the rules hold between real process instances. Holding matters: an
// exited process leaves a stale lock, which is exactly what takeover is for.
const CHILD = `
const { acquire, LockError } = require(${JSON.stringify(new URL("../lib/lock.js", import.meta.url).pathname)});
try {
  acquire(process.argv[2], "child");
  console.log("WON");
  setTimeout(() => process.exit(0), 3000); // hold the lock while the test looks
} catch (err) {
  console.log(err instanceof LockError ? "REFUSED" : "ERROR:" + err.message);
}
`;

// Runs the child and resolves { outcome } as soon as it prints one.
async function childOutcome(dir) {
  const child = execFile(process.execPath, ["-e", CHILD, "holder", dir]);
  const outcome = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.trim()) resolve(out.trim().split("\n")[0]);
    });
    child.on("exit", (code) => resolve(out.trim() || `EXIT:${code}`));
    child.on("error", reject);
    setTimeout(() => resolve("TIMEOUT"), 8000);
  });
  return { child, outcome };
}

test("a lock naming this pid with a different start time is stale: pid reuse after a container restart", () => {
  const dir = freshDir();
  // The container scenario: the dead server and the live one share pid 1,
  // so a bare pid looks alive. The start time betrays the reuse.
  const stale = { pid: process.pid, bootId: bootId(), startTime: "999999999", role: "server", at: new Date().toISOString() };
  fs.writeFileSync(lockPath(dir), JSON.stringify(stale) + "\n");
  const lock = acquire(dir, "test");
  assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).pid, process.pid, "the new holder record replaced the stale one");
  lock.release();
  assert.equal(fs.existsSync(lockPath(dir)), false, "release removed the taken-over lock");
});

test("a lock naming a live, distinct process instance is respected", async () => {
  const dir = freshDir();
  const { child, outcome } = await childOutcome(dir);
  assert.equal(outcome, "WON", "the child took the free lock");
  const holder = JSON.parse(fs.readFileSync(lockPath(dir), "utf8"));
  assert.equal(holder.bootId, bootId(), "the record names this boot");
  assert.equal(holder.startTime, startTimeOf(holder.pid), "the record names the live instance");

  assert.throws(() => acquire(dir, "test"), LockError, "a live instance's lock is refused, not stolen");
  assert.equal(
    JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).token,
    holder.token,
    "the refused acquirer left the lock file untouched"
  );

  // Once the holding process is gone, the same directory is acquirable again
  // — the restart scenario, end to end.
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));
  const lock = acquire(dir, "test");
  lock.release();
});

test("simultaneous acquisition races to exactly one winner", async () => {
  const dir = freshDir();
  const [a, b] = await Promise.all([childOutcome(dir), childOutcome(dir)]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["REFUSED", "WON"], "one acquirer wins, the other is refused");
  const winner = a.outcome === "WON" ? a : b;
  winner.child.kill();
  await new Promise((resolve) => winner.child.on("exit", resolve));
  const holder = JSON.parse(fs.readFileSync(lockPath(dir), "utf8"));
  assert.ok(holder.token, "the winner's lock file remains, complete and readable");
});

test("an unreadable lock file is never stolen and never deleted", () => {
  const dir = freshDir();
  const garbage = '{"pid": nope — torn bytes';
  fs.writeFileSync(lockPath(dir), garbage);
  assert.throws(() => acquire(dir, "test"), LockError, "a lock we cannot interpret is treated as live");
  assert.equal(fs.readFileSync(lockPath(dir), "utf8"), garbage, "the file was left exactly as it was");
});

test("release removes only a lock the releasing instance still owns", () => {
  const dir = freshDir();
  const lock = acquire(dir, "test");
  // Someone else's record under the same path: not ours to remove.
  const foreign = { pid: 1, bootId: bootId(), startTime: "1", role: "someone else", token: "not-mine" };
  fs.writeFileSync(lockPath(dir), JSON.stringify(foreign) + "\n");
  lock.release();
  assert.equal(fs.readFileSync(lockPath(dir), "utf8"), JSON.stringify(foreign) + "\n", "a foreign lock survives a foreign release");
  // And a normal release of a normal lock works.
  const lock2 = acquire(dir, "test");
  lock2.release();
  assert.equal(fs.existsSync(lockPath(dir)), false);
});
