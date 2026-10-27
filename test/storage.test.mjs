// Storage honesty: the durability verdict lib/storage.js hands the server,
// and what a production server actually does with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectStorage } from "../lib/storage.js";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE = process.execPath;

// statSync stand-in: a map of path -> st_dev; unknown paths "do not exist".
const fakeStat = (devs) => (p) => {
  if (!(p in devs)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return { dev: devs[p] };
};

test("a writable directory on its own filesystem (a mounted volume) is durable", () => {
  const v = inspectStorage("/data", { stat: fakeStat({ "/data": 65056, "/": 21 }) });
  assert.equal(v.durable, true);
  assert.equal(v.reason, "");
});

test("a directory on the container's own filesystem is not durable, however writable", () => {
  const v = inspectStorage("/app/data", { stat: fakeStat({ "/app": 21, "/app/data": 21, "/": 21 }) });
  assert.equal(v.durable, false);
  assert.match(v.reason, /own filesystem/);
});

test("a temporary mount is not durable even though it is a separate filesystem", () => {
  const v = inspectStorage("/dev/shm/store", { stat: fakeStat({ "/dev/shm": 26, "/dev/shm/store": 26, "/": 21 }) });
  assert.equal(v.durable, false);
  assert.match(v.reason, /temporary/);
  const t2 = inspectStorage(path.join(os.tmpdir(), "scratch"), {
    stat: fakeStat({ [path.join(os.tmpdir(), "scratch")]: 26, [os.tmpdir()]: 26, "/": 21 })
  });
  assert.equal(t2.durable, false, "os.tmpdir() is always a temporary location");
});

test("a path that cannot be inspected is not durable", () => {
  const v = inspectStorage("/no/such/dir", { stat: fakeStat({}) });
  assert.equal(v.durable, false);
  assert.match(v.reason, /not usable/);
});

// ---- production startup: the gate the deployment runs behind ----

function startProd(dataDir, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(ROOT, "server.js")], {
      env: { ...process.env, NODE_ENV: "production", PORT: "0", DATA_DIR: dataDir || "", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
    setTimeout(() => {
      if (child.exitCode == null) {
        child.kill("SIGKILL");
        resolve({ code: "timeout", out });
      }
    }, 10000).unref();
  });
}

test("production refuses to start without DATA_DIR", async () => {
  const r = await startProd("");
  assert.equal(r.code, 1);
  assert.match(r.out, /DATA_DIR is not set/);
});

test("production refuses a writable DATA_DIR that is not persistent storage", async () => {
  // A temp directory is writable, but no verdict may call it durable: on a
  // machine where it is the container's own filesystem it is "own
  // filesystem", where it is a tmpfs it is "temporary" — either way refused.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-prod-local-"));
  const r = await startProd(local);
  assert.equal(r.code, 1);
  assert.match(r.out, /refusing to start/);
  assert.match(r.out, /own filesystem|temporary/);
  fs.rmSync(local, { recursive: true, force: true });
});

test("production refuses a separate but temporary mount (/dev/shm)", async () => {
  if (!fs.existsSync("/dev/shm")) return;
  const dir = fs.mkdtempSync("/dev/shm/openslack-prod-");
  const r = await startProd(dir);
  assert.equal(r.code, 1, "a tmpfs mount must not count as persistent storage");
  assert.match(r.out, /temporary/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("production refuses an unwritable DATA_DIR", async () => {
  if (process.getuid && process.getuid() === 0) return; // root writes anywhere; CI runs unprivileged
  const base = path.join(process.cwd(), `openslack-prod-ro-${process.pid}`);
  fs.mkdirSync(base);
  fs.chmodSync(base, 0o555);
  const r = await startProd(path.join(base, "data"));
  assert.equal(r.code, 1);
  assert.match(r.out, /refusing to start/);
  fs.chmodSync(base, 0o755);
  fs.rmSync(base, { recursive: true, force: true });
});

// The positive case needs a real, non-temporary filesystem of its own to
// point at — the deployment's own situation (a volume at /data). Where the
// environment offers one, a production server must start there and report
// durable: true; where it offers none (plain CI containers), there is nothing
// honest to pass on and the test says so instead of faking a mount.
test("production starts on a real persistent mount and reports durable: true", async () => {
  const candidates = ["/data", "/mnt", "/srv"].filter((c) => {
    try {
      return fs.statSync(c).isDirectory() && inspectStorage(c).durable;
    } catch {
      return false;
    }
  });
  if (!candidates.length) return; // no real volume here; the unit tests above cover the verdict
  // The mount must also be writable by this user; a read-only or root-owned
  // volume is not a usable DATA_DIR and the test skips to an honest skip.
  let dir = null;
  for (const c of candidates) {
    try {
      dir = fs.mkdtempSync(path.join(c, "openslack-prod-ok-"));
      break;
    } catch {}
  }
  if (!dir) return;
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(NODE, [path.join(ROOT, "server.js")], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    let health = null;
    for (let i = 0; i < 100 && !health; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) health = await res.json();
      } catch {}
    }
    assert.ok(health, `production server did not come up on ${dir}: ${out.slice(0, 300)}`);
    assert.equal(health.durable, true, "/healthz must report the verified durability");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});