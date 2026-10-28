import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { isSeparateMount } from "../lib/durable.js";

// Unit: the check is a plain device-id comparison on stat(2), injectable.
test("isSeparateMount: a different device id means a separate mount", () => {
  const stat = (p) => ({ dev: p === "/" ? 1 : 2 });
  assert.equal(isSeparateMount("/data", stat), true);
});

test("isSeparateMount: the same device id means container-local storage", () => {
  const stat = () => ({ dev: 1 });
  assert.equal(isSeparateMount("/app/data", stat), false);
});

test("isSeparateMount: an unreadable path is never claimed separate", () => {
  const stat = () => {
    throw new Error("EACCES");
  };
  assert.equal(isSeparateMount("/whatever", stat), false);
});

// Regression for the deploy that never answered: fs.statfsSync() has no dev
// field, so the old check compared undefined to undefined and the production
// server refused to start on the real mounted volume. The real check must
// recognise a genuinely separate filesystem when it sees one.
const separate = ["/dev/shm", "/tmp"]
  .map((p) => ({ p, separate: (() => {
    try { return fs.statSync(p).dev !== fs.statSync("/").dev; } catch { return false; }
  })() }))
  .find((c) => c.separate);

if (!separate) {
  test("skipped: no separate writable filesystem available for the spawn check", { skip: true }, () => {});
} else {
  const scratch = path.join(separate.p, `openslack-durable-${process.pid}`);
  test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  test("production server starts on a separate-mount DATA_DIR and reports it durable", async () => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const child = spawn(process.execPath, [path.resolve("server.js")], {
      env: { ...process.env, NODE_ENV: "production", DATA_DIR: scratch, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    try {
      const deadline = Date.now() + 10000;
      while (!out.includes("listening on")) {
        assert.ok(Date.now() < deadline, `server never started; output:\n${out}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      // Listening is logged with the port; find it and ask /healthz.
      const port = Number(out.match(/listening on (\d+)/)?.[1]);
      assert.ok(port > 0, `no port in output:\n${out}`);
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.durable, true, "a separate-mount DATA_DIR must be reported durable");
    } finally {
      child.kill("SIGTERM");
    }
  });
}

test("production server still refuses container-local DATA_DIR", async () => {
  // The refusal case needs a directory on the SAME device as the filesystem
  // root — the container's own layer. os.tmpdir() qualifies on machines where
  // it sits on the root fs, but is a separate mount elsewhere (including this
  // workspace, whose checkout lives on a real volume), so guard it and skip
  // when no such directory exists rather than asserting the wrong thing.
  const sameDev = (() => {
    try { return fs.statSync(os.tmpdir()).dev === fs.statSync("/").dev; } catch { return false; }
  })();
  if (!sameDev) {
    test("skipped: tmpdir is not on the root filesystem here", { skip: true }, () => {});
    return;
  }
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-local-"));
  const child = spawn(process.execPath, [path.resolve("server.js")], {
    env: { ...process.env, NODE_ENV: "production", DATA_DIR: local, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server neither exited nor refused: ${err}`)), 10000);
    child.on("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 1, "container-local storage must fail production startup");
  assert.match(err, /refusing to start/);
  fs.rmSync(local, { recursive: true, force: true });
});
