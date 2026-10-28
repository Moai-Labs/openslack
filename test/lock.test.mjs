// Tests for the data-directory lock: a lock naming a process incarnation that
// no longer exists must never block a restart — even when the PID it names was
// reused and is live again — while a genuinely live holder still blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const { acquire, LockError, startTick, holderIsLive } = await import("../lib/lock.js");

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-lock-"));
  return dir;
}

test("startTick reads the kernel's start time for a pid", () => {
  const mine = startTick(process.pid);
  assert.ok(mine, "our own start time is readable");
  assert.ok(/^\d+$/.test(mine), "it is the jiffies counter, a plain number");
  assert.equal(startTick(999999999), null, "a pid that does not exist has no start time");
});

test("a lock left by a previous incarnation at the current pid does not block a restart", () => {
  const dir = freshDir();
  // The deployment restarts the server as the same PID (usually 1). The lock
  // on the persistent volume still names that PID with the previous
  // incarnation's start time; the new server must take the directory over.
  fs.writeFileSync(
    path.join(dir, "lock.json"),
    JSON.stringify({ pid: process.pid, startTick: "4194303", role: "server", at: "2026-10-27T00:00:00.000Z" }) + "\n"
  );
  const handle = acquire(dir, "server"); // must not throw
  // the takeover wrote our own incarnation
  const holder = JSON.parse(fs.readFileSync(handle.path, "utf8"));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.startTick, startTick(process.pid));
  handle.release();
});

test("a lock naming a dead pid is taken over; a lock naming our own incarnation is refused", () => {
  const dir = freshDir();
  fs.writeFileSync(
    path.join(dir, "lock.json"),
    JSON.stringify({ pid: 999999999, startTick: "1", role: "server", at: new Date().toISOString() }) + "\n"
  );
  const handle = acquire(dir, "server");
  handle.release();

  // our own live incarnation holding the lock: a second claimant is refused
  fs.writeFileSync(
    path.join(dir, "lock.json"),
    JSON.stringify({ pid: process.pid, startTick: startTick(process.pid), role: "server", at: new Date().toISOString() }) + "\n"
  );
  assert.throws(() => acquire(dir, "restore"), LockError);
});

test("a live holder in this incarnation blocks acquisition, and its death frees the directory", async () => {
  const dir = freshDir();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { acquire } = require(${JSON.stringify(path.resolve("lib/lock.js"))});
       acquire(process.argv[1], "server");
       console.log("held");
       setInterval(() => {}, 1000);`,
      dir
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => (d.toString().includes("held") ? resolve() : null));
      child.on("exit", (code) => reject(new Error(`holder exited early (${code})`)));
      setTimeout(() => reject(new Error("holder never reported")), 5000);
    });
    // the lock names a live process of this incarnation: refused
    assert.throws(() => acquire(dir, "restore"), LockError);
    assert.equal(fs.readFileSync(path.join(dir, "lock.json"), "utf8").includes('"role":"server"'), true);
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
  }
  // SIGKILL releases the directory instantly: the holder's incarnation is gone
  const handle = acquire(dir, "server");
  handle.release();
});

test("holderIsLive answers only for a matching live incarnation", () => {
  const live = { pid: process.pid, startTick: startTick(process.pid) };
  assert.equal(holderIsLive(live), true);
  assert.equal(holderIsLive({ pid: process.pid, startTick: "4194303" }), false, "same pid, past incarnation: not live");
  assert.equal(holderIsLive({ pid: 999999999, startTick: startTick(999999999) }), false, "no such pid");
  assert.equal(holderIsLive(null), false);
  assert.equal(holderIsLive({ pid: process.pid, startTick: null }), false, "an unverifiable lock never blocks");
});
