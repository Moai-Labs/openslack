// Tests for the data-directory lock: an exclusive kernel lock (flock) that
// one owner holds for its lifetime, that a second process — in this container
// or another, whatever its PID namespace — can never take or remove while the
// owner lives, and that the kernel itself releases the moment the owner dies,
// so a restart is never blocked by its own past.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const { acquire, LockError } = await import("../lib/lock.js");

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openslack-lock-"));
}

// A holder in a child process: takes the lock, reports, then lives until
// killed. Its lock is held by the kernel for as long as it lives.
function spawnHolder(dir, script) {
  const child = spawn(
    process.execPath,
    ["-e", script(dir), dir],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  return child;
}

const HOLDER_SCRIPT = (dir) => `
  const { acquire } = require(${JSON.stringify(path.resolve("lib/lock.js"))});
  acquire(process.argv[1], "server");
  console.log("held");
  setInterval(() => {}, 1000);`;

async function waitHeld(child) {
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => (d.toString().includes("held") ? resolve() : null));
    child.on("exit", (code) => reject(new Error(`holder exited early (${code})`)));
    setTimeout(() => reject(new Error("holder never reported")), 5000);
  });
}

test("a live holder blocks acquisition by another process, and release frees the directory", async () => {
  const dir = freshDir();
  const child = spawnHolder(dir, HOLDER_SCRIPT);
  try {
    await waitHeld(child);
    // a claimant in a separate process is refused while the holder lives —
    // without ever needing to know or verify who the holder is
    const contender = spawn(
      process.execPath,
      ["-e", `try { require(${JSON.stringify(path.resolve("lib/lock.js"))}).acquire(process.argv[1], "restore"); console.log("took"); }
       catch (e) { console.log("refused:" + (e instanceof Error && e.constructor.name === "LockError")); }`, dir],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    const verdict = await new Promise((resolve, reject) => {
      contender.stdout.on("data", (d) => resolve(d.toString().trim()));
      contender.on("exit", (code) => reject(new Error(`contender exited (${code})`)));
      setTimeout(() => reject(new Error("contender never reported")), 5000);
    });
    assert.equal(verdict, "refused:true", "a second process cannot take a held directory");
    assert.equal(fs.existsSync(path.join(dir, "lock")), true, "the lock file is still there, still held");
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
  }
  // SIGKILL releases the lock instantly: the kernel, not a cleanup handler,
  // owns the release
  const handle = acquire(dir, "server");
  handle.release();
});

test("two simultaneous claimants: exactly one wins, whatever the timing", async () => {
  const dir = freshDir();
  // Two fresh processes racing the same directory at the same moment: the
  // kernel arbitrates the flock atomically, so no interleaving of file
  // inspection can hand the directory to both. A winner holds on (its script
  // stays alive), so the verdicts are checked against a lock still held.
  const claim = () =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        ["-e", `try { require(${JSON.stringify(path.resolve("lib/lock.js"))}).acquire(process.argv[1], "server"); console.log("won"); setInterval(() => {}, 1000); }
         catch { console.log("lost"); }`, dir],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      p.stdout.on("data", (d) => resolve({ verdict: d.toString().trim(), child: p }));
      p.on("exit", (code) => reject(new Error(`claimant exited (${code})`)));
      setTimeout(() => reject(new Error("claimant never reported")), 5000);
    });
  const [a, b] = await Promise.all([claim(), claim()]);
  assert.deepEqual([a.verdict, b.verdict].sort(), ["lost", "won"], "exactly one claimant owns the directory");
  const winner = a.verdict === "won" ? a : b;
  try {
    // the winner is still holding: another claimant is refused
    assert.throws(() => acquire(dir, "restore"), LockError);
  } finally {
    winner.child.kill("SIGKILL");
    await new Promise((resolve) => winner.child.on("exit", resolve));
  }
});

test("takeover contention on a lock left behind by a dead owner: one contender wins, the other is refused", async () => {
  const dir = freshDir();
  // A crash leaves the lock file behind, unlocked. Two contenders racing for
  // it must not both take it — and neither may be able to remove the other's
  // fresh acquisition, the way an inspect-and-unlink protocol allowed.
  fs.writeFileSync(path.join(dir, "lock"), "left by a process that is gone\n");
  const claim = () =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        ["-e", `try { require(${JSON.stringify(path.resolve("lib/lock.js"))}).acquire(process.argv[1], "restore"); console.log("won"); setInterval(() => {}, 1000); }
         catch { console.log("lost"); }`, dir],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      p.stdout.on("data", (d) => resolve({ verdict: d.toString().trim(), child: p }));
      p.on("exit", (code) => reject(new Error(`claimant exited (${code})`)));
      setTimeout(() => reject(new Error("claimant never reported")), 5000);
    });
  const [a, b] = await Promise.all([claim(), claim()]);
  assert.deepEqual([a.verdict, b.verdict].sort(), ["lost", "won"], "the stale lock goes to exactly one contender");
  const winner = a.verdict === "won" ? a : b;
  try {
    assert.throws(() => acquire(dir, "server"), LockError, "the winner still holds it");
  } finally {
    winner.child.kill("SIGKILL");
    await new Promise((resolve) => winner.child.on("exit", resolve));
  }
});

test("a concurrent owner in a separate PID namespace cannot take or remove the lock", async () => {
  // The old protocol identified holders by PID, which another PID namespace
  // can hide or misrepresent — that is how one owner could remove another's
  // lock. The kernel lock knows nothing about PIDs, so the holder's identity
  // being invisible is irrelevant. When the environment allows a real PID
  // namespace, the contender runs inside one, where the holder's PID is
  // genuinely invisible; otherwise the same run happens from an unrelated
  // process, which is the part the lock mechanism actually sees.
  const dir = freshDir();
  const child = spawnHolder(dir, HOLDER_SCRIPT);
  try {
    await waitHeld(child);
    const run = (cmd, args) =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("error", () => resolve({ out: "", code: -1 })); // tool unavailable in this environment
        p.on("exit", (code) => resolve({ out: out.trim(), code }));
        setTimeout(() => resolve({ out: out.trim(), code: -1 }), 10000);
      });
    const contenderScript = `try { require(${JSON.stringify(path.resolve("lib/lock.js"))}).acquire(process.argv[1], "restore"); console.log("took"); }
      catch { console.log("refused"); }`;
    // Is a real PID namespace permitted here at all?
    const probe = await run("unshare", ["--pid", "--fork", "true"]);
    if (probe.code !== 0) {
      test.skip("a real PID namespace is not permitted in this environment; the lock consults no process identity by construction", () => {});
    } else {
      const inNs = await run("unshare", ["--pid", "--fork", process.execPath, "-e", contenderScript, dir]);
      assert.equal(inNs.out, "refused", "a holder invisible to the contender's PID namespace still holds the directory");
    }
    // and from this namespace too: the lock is simply held
    assert.throws(() => acquire(dir, "restore"), LockError);
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
  }
  const handle = acquire(dir, "server"); // the dead owner's lock was kernel-released
  handle.release();
});

test("restart after the owner's termination is never blocked, and release is re-acquirable", () => {
  const dir = freshDir();
  const first = acquire(dir, "server");
  first.release();
  const second = acquire(dir, "server"); // a clean handover: no past incarnation to mistake
  second.release();
  // a released lock leaves nothing that could block or confuse a later owner
  assert.equal(fs.existsSync(path.join(dir, "lock")), true, "the lock file may remain; it holds nothing");
  const third = acquire(dir, "restore");
  third.release();
});
