// Storage honesty: the durability verdict lib/storage.js hands the server,
// and what a production server actually does with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectStorage, parseMountInfo } from "../lib/storage.js";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE = process.execPath;

// statSync stand-in: a map of path -> st_dev; unknown paths "do not exist".
const fakeStat = (devs) => (p) => {
  if (!(p in devs)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return { dev: devs[p] };
};
const realStat = (p) => fs.statSync(p);
const anyStat = () => ({ dev: 1 }); // synthetic paths "exist" with any device id
const identity = (p) => p;

// A mountinfo stand-in in the real kernel format.
const MOUNTINFO = [
  "22 29 0:6 / /dev rw,nosuid - devtmpfs devtmpfs rw",
  "29 1 0:21 / / rw,relatime - overlay none rw",
  "33 22 0:26 / /dev/shm rw,nosuid - tmpfs shm rw",
  "38 29 0:31 / /sys/fs/cgroup rw - tmpfs tmpfs rw",
  "50 29 254:32 / /data rw,relatime - ext4 /dev/vdc rw",
  "51 29 0:40 / /mnt/scratch rw - tmpfs scratch rw",
  "52 29 254:33 / /tmp rw - ext4 /dev/vdd rw"
].join("\n");

test("mountinfo parsing keeps mount point, filesystem type and source", () => {
  const mounts = parseMountInfo(MOUNTINFO);
  const data = mounts.find((m) => m.mountPoint === "/data");
  assert.equal(data.fstype, "ext4");
  assert.equal(data.source, "/dev/vdc");
  assert.equal(mounts.find((m) => m.mountPoint === "/").fstype, "overlay");
  // escaped spaces in mount points survive
  const escaped = parseMountInfo("30 29 0:22 /with\\040space /mnt/a\\040b rw - ext4 /dev/vdX rw");
  assert.equal(escaped[0].mountPoint, "/mnt/a b");
});

test("a writable directory on the volume's own filesystem (a mounted volume) is durable", () => {
  const v = inspectStorage("/data/store", { stat: anyStat, realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(v.durable, true);
  assert.equal(v.reason, "");
  assert.deepEqual(v.mount, { point: "/data", fstype: "ext4", source: "/dev/vdc" }, "the verdict names the verified backing mount");
});

test("a directory on the container's own filesystem is not durable, however writable", () => {
  const v = inspectStorage("/app/data", { stat: anyStat, realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(v.durable, false);
  assert.match(v.reason, /own filesystem/);
});

test("a tmpfs at a non-denylisted path is not durable — the filesystem type decides, not the pathname", () => {
  const v = inspectStorage("/mnt/scratch/store", { stat: anyStat, realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(v.durable, false, "/mnt/scratch is not on the denylist, yet its tmpfs is ephemeral");
  assert.match(v.reason, /tmpfs/);
  const cgroup = inspectStorage("/sys/fs/cgroup/openslack", { stat: anyStat, realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(cgroup.durable, false);
  assert.match(cgroup.reason, /tmpfs|does not survive/);
});

test("an alias to temporary storage is not durable: the resolved path decides the mount", () => {
  // /var/lib/store → /dev/shm/store: the pathname looks permanent, the
  // resolved location is not.
  const v = inspectStorage("/var/lib/store", {
    stat: fakeStat({ "/var/lib/store": 21, "/": 21 }),
    realpath: (p) => (p === "/var/lib/store" ? "/dev/shm/store" : p),
    mountInfo: MOUNTINFO
  });
  assert.equal(v.durable, false);
  assert.match(v.reason, /tmpfs|does not survive/);
});

test("a temporary mount is not durable even though it is a separate filesystem", () => {
  const v = inspectStorage("/dev/shm/store", { stat: anyStat, realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(v.durable, false);
  assert.match(v.reason, /tmpfs|does not survive|temporary/);
  const t2 = inspectStorage("/tmp/scratch", { stat: anyStat, realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(t2.durable, false, "even a real ext4 mounted at /tmp stays on the denylist");
  assert.match(t2.reason, /temporary/);
});

test("a path outside any known mount is not durable", () => {
  const v = inspectStorage("/mnt/unlisted/store", { stat: anyStat, realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(v.durable, false);
  assert.match(v.reason, /not inside any mounted filesystem|own filesystem/);
});

test("a path that cannot be inspected is not durable", () => {
  const v = inspectStorage("/no/such/dir", { stat: fakeStat({}), realpath: identity, mountInfo: MOUNTINFO });
  assert.equal(v.durable, false);
  assert.match(v.reason, /not usable/);
});

test("unavailable mount information is reported as unverifiable, never as durable", () => {
  const v = inspectStorage("/data", { stat: anyStat, realpath: identity, mountInfo: null });
  assert.equal(v.durable, false);
  assert.match(v.reason, /mount information/);
});

// ---- production startup: the gate the deployment runs behind ----

// A refused production start is degraded, not dead: it binds the port and
// serves the verdict (503, durable:false, the reason) on /healthz and 503
// everywhere else, having opened no store and touched no data — so the
// failure stays diagnosable from outside instead of leaving a machine that
// accepts connections and answers nothing. This helper starts such a server
// on a concrete port, waits for /healthz to answer, and returns the verdict
// plus a stop() that SIGTERMs it and resolves on exit.
async function refusedServer(dataDir, env = {}) {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(NODE, [path.join(ROOT, "server.js")], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATA_DIR: dataDir || "", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const stop = () =>
    new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    });
  let res = null;
  try {
    for (let i = 0; i < 100 && !res; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        res = await fetch(`http://127.0.0.1:${port}/healthz`);
      } catch {}
    }
    assert.ok(res, `the degraded server must answer /healthz: ${out.slice(0, 300)}`);
    return { port, res, body: await res.json(), out, stop };
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }
}

test("production without DATA_DIR serves its refusal instead of vanishing", async () => {
  const { port, res, body, out, stop } = await refusedServer("");
  try {
    assert.equal(res.status, 503);
    assert.equal(body.durable, false);
    assert.match(body.reason, /DATA_DIR is not set/);
    assert.match(out, /refusing to serve private data/);
    // Everything but /healthz is refused too: no pages, no API, no store.
    const other = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(other.status, 503);
  } finally {
    assert.equal(await stop(), 0, "SIGTERM shuts the degraded server down cleanly");
  }
});

test("production refuses a writable DATA_DIR that is not persistent storage, without opening a store", async () => {
  // A temp directory is writable, but no verdict may call it durable: on this
  // machine it sits on the container's own (overlay) filesystem.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-prod-local-"));
  const { port, res, body, out, stop } = await refusedServer(local);
  try {
    assert.equal(res.status, 503);
    assert.equal(body.durable, false);
    assert.match(body.reason, /own filesystem|temporary|not inside/);
    assert.match(out, /refusing to serve private data/);
    const other = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(other.status, 503, "no static assets are served in a degraded start");
    // The refusal must not have created a store it does not trust.
    assert.deepEqual(fs.readdirSync(local), [], "the data directory stays untouched");
  } finally {
    await stop();
    fs.rmSync(local, { recursive: true, force: true });
  }
});

test("production refuses a separate but temporary mount (/dev/shm)", async () => {
  if (!fs.existsSync("/dev/shm")) return;
  const dir = fs.mkdtempSync("/dev/shm/openslack-prod-");
  const { res, body, stop } = await refusedServer(dir);
  try {
    assert.equal(res.status, 503, "a tmpfs mount must not count as persistent storage");
    assert.equal(body.durable, false);
    assert.match(body.reason, /tmpfs|does not survive|temporary/);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("production refuses tmpfs at a non-denylisted path", async () => {
  // A real tmpfs we cannot create without root, so the check sees one through
  // the documented mountinfo test seam while everything else — the real
  // writable directory, the real stat calls — stays real.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-prod-tmpfs-"));
  const fake = `29 1 0:21 / / rw,relatime - overlay none rw\n60 29 0:99 / ${local} rw - tmpfs scratch rw\n`;
  const mi = path.join(os.tmpdir(), `openslack-mi-${process.pid}`);
  fs.writeFileSync(mi, fake);
  const { res, body, stop } = await refusedServer(local, { OPENSLACK_MOUNTINFO_FILE: mi });
  try {
    assert.equal(res.status, 503, "tmpfs must be refused wherever it is mounted");
    assert.match(body.reason, /tmpfs/);
  } finally {
    await stop();
    fs.rmSync(mi, { force: true });
    fs.rmSync(local, { recursive: true, force: true });
  }
});

test("production refuses a symlink alias to temporary storage", async () => {
  if (!fs.existsSync("/dev/shm")) return;
  const hidden = fs.mkdtempSync("/dev/shm/openslack-alias-");
  const alias = path.join(os.tmpdir(), `openslack-alias-${process.pid}`);
  fs.symlinkSync(hidden, alias);
  const { res, body, stop } = await refusedServer(alias);
  try {
    assert.equal(res.status, 503, "an alias to /dev/shm must not count as persistent storage");
    assert.match(body.reason, /tmpfs|does not survive|temporary/);
  } finally {
    await stop();
    fs.rmSync(alias, { force: true });
    fs.rmSync(hidden, { recursive: true, force: true });
  }
});

test("production refuses an unwritable DATA_DIR", async () => {
  if (process.getuid && process.getuid() === 0) return; // root writes anywhere; CI runs unprivileged
  const base = path.join(process.cwd(), `openslack-prod-ro-${process.pid}`);
  fs.mkdirSync(base);
  fs.chmodSync(base, 0o555);
  const { res, body, stop } = await refusedServer(path.join(base, "data"));
  try {
    assert.equal(res.status, 503);
    assert.match(body.reason, /cannot be created|not writable/);
  } finally {
    await stop();
    fs.chmodSync(base, 0o755);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The positive case needs a real, non-ephemeral filesystem of its own to
// point at — the deployment's own situation (a volume at /data, ext4 on its
// own device). Where the environment offers one, a production server must
// start there and report durable: true; where it offers none, there is
// nothing honest to pass on and the test says so instead of faking a mount.
test("production starts on a real persistent mount and reports durable: true", async () => {
  const candidates = ["/data", "/mnt", "/srv"].filter((c) => {
    try {
      return fs.statSync(c).isDirectory() && inspectStorage(c).durable;
    } catch {
      return false;
    }
  });
  if (!candidates.length) return; // no real volume here; the unit tests above cover the verdict
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
