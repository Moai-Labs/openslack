// Exclusive data-directory ownership: OS-backed flock(2), held by the owner
// process for its lifetime. What is proven here:
//   - two concurrent contenders cannot both own a directory (kernel arbitrated);
//   - lock file contents are irrelevant — a leftover file naming a live pid
//     (pid reuse) or an old-format pid lock blocks nothing and misleads no one;
//   - a crashed owner releases the lock without any takeover logic;
//   - restore refuses a directory a live process owns, before touching it;
//   - an in-process owner check refuses a live owner too.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import lock from "../lib/lock.js";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE = process.execPath;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "openslack-lock-"));

// A contender: holds the directory's advisory lock for `ms`, then exits 0.
// Started through the same wrapper the deployment uses, so the node process
// itself owns the kernel lock — killing it releases the lock immediately.
function holder(dir, ms) {
  const cmd = lock.wrapper(dir, NODE, ["-e", `setTimeout(() => process.exit(0), ${ms})`]);
  return spawn(cmd.file, cmd.args, { stdio: "ignore" });
}

const exited = (child) => new Promise((resolve) => child.on("exit", (code) => resolve(code)));

test("two concurrent contenders cannot both own the directory", async () => {
  const dir = tempDir();
  const a = holder(dir, 700);
  const b = holder(dir, 700);
  const codes = await Promise.all([exited(a), exited(b)]);
  assert.deepEqual(codes.filter((c) => c === 0).length, 1, `exactly one winner: ${codes}`);
  assert.deepEqual(codes.includes(0) && codes.some((c) => c !== 0), true, "the loser fails loudly");
});

test("lock file contents are irrelevant: a live pid recorded in a leftover file neither blocks nor grants", async () => {
  const dir = tempDir();
  // A lock file naming THIS live process — the pid-reuse scenario that breaks
  // pid-based locks (node as pid 1 in a replacement container) — plus a
  // leftover old-format pid lock from a previous implementation.
  fs.writeFileSync(path.join(dir, ".owner.lock"), JSON.stringify({ pid: process.pid, role: "ghost", at: "yesterday" }));
  fs.writeFileSync(path.join(dir, "lock.json"), JSON.stringify({ pid: process.pid, role: "ghost" }));
  const h = holder(dir, 200);
  assert.equal(await exited(h), 0, "the kernel lock, not the file, decides ownership");
  // and the pid-claimed directory works for a server start too
  const check = lock.acquire(dir, "test");
  assert.equal(check.kernel, false);
});

test("a crashed owner's lock is simply gone — no stale takeover, no waiting", async () => {
  const dir = tempDir();
  const victim = holder(dir, 30000); // would hold far past the test
  await new Promise((r) => setTimeout(r, 150)); // let it take the lock
  victim.kill("SIGKILL");
  await exited(victim);
  const next = holder(dir, 150);
  assert.equal(await exited(next), 0, "the kernel dropped the lock at process death");
});

test("restore refuses a directory a live process owns, before touching anything", async () => {
  const dir = tempDir();
  const h = holder(dir, 4000);
  await new Promise((r) => setTimeout(r, 150));
  const exportFile = path.join(os.tmpdir(), `openslack-lock-export-${process.pid}.json`);
  fs.writeFileSync(exportFile, JSON.stringify({ format: "openslack-export-v1", workspace: { slug: "x", name: "X" }, members: [], channels: [], messages: [] }));
  try {
    let failed = null;
    try {
      execFileSync(NODE, [path.join(ROOT, "scripts", "restore.js"), exportFile], {
        env: { ...process.env, DATA_DIR: dir },
        encoding: "utf8",
        timeout: 15000
      });
    } catch (err) {
      failed = err;
    }
    assert.ok(failed, "restore must refuse");
    assert.match(String(failed.stderr), /owned by another live process/);
    assert.equal(fs.existsSync(path.join(dir, "db.json")), false, "nothing was written before the lock check");
  } finally {
    fs.rmSync(exportFile, { force: true });
    await exited(h);
  }
});

test("an in-process ownership check refuses a live owner and passes once it is gone", async () => {
  const dir = tempDir();
  const h = holder(dir, 1500);
  await new Promise((r) => setTimeout(r, 150));
  assert.throws(() => lock.acquire(dir, "test"), /owned by another live process/);
  await exited(h);
  assert.doesNotThrow(() => lock.acquire(dir, "test"));
});