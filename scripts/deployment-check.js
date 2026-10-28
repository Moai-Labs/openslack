// Deployment check for OpenSlack — exercises a LIVE deployment (the dev
// stack preview) with synthetic data only. This is the deployed-side
// counterpart of scripts/persistence-check.js (which runs local servers):
// here the server is the real, platform-deployed one, and the check proves
// what the post's completion requires against it.
//
// Usage:
//   node scripts/deployment-check.js <base-url>            full exercise, then cleanup
//   node scripts/deployment-check.js <base-url> record     create a synthetic workspace,
//                                                          print a record and leave it in place
//   node scripts/deployment-check.js <base-url> verify '<recordJson>'
//                                                          after a redeploy: the recorded
//                                                          history is intact, /healthz durable
//
// What the full exercise proves on the deployed instance:
//   1. /healthz reports verified durable storage (the production server
//      refuses to start on anything else, so durable=true means the
//      persistent volume is mounted and writable by the container user).
//   2. private accounts, a workspace, channels and messages work over the
//      public URL.
//   3. live delivery over SSE, and reconnect recovery: a fresh stream
//      receives a message posted after the previous stream was dropped.
//   4. export gives the owner the full synthetic history.
//   5. secure restore: that export rebuilds into a clean LOCAL store where an
//      unrelated signup with the exported owner's handle gains nothing, and
//      the administrator's verified --attach mapping restores access.
//   6. deletion removes the synthetic workspace and its history for good.
//
// Everything is namespaced per run (handles synth-<ts>-*) and, in the full
// mode, deleted at the end. The script only ever creates and removes its own
// synthetic workspace; it never touches other data. Exit 0 on pass, 1 on
// failure.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const NODE = fs.existsSync(process.execPath) ? process.execPath : "node";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  else passed++;
  return ok;
}

async function call(base, method, p, body, cookie) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})), res };
}

async function signup(base, handle, password) {
  const r = await call(base, "POST", "/api/signup", { handle, password });
  return { ...r, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}

// Subscribe to a workspace's SSE stream and record message events; resolve
// `ended` when the server closes the stream.
function openStream(base, path, cookie) {
  const state = { events: [], ended: false, error: null };
  state.ready = (async () => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    if (!res.ok || res.headers.get("content-type") !== "text/event-stream") {
      throw new Error(`stream did not open (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        state.ended = true;
        return;
      }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("event: message")) state.events.push(JSON.parse(chunk.split("data: ")[1]));
      }
    }
  })().catch((err) => {
    state.error = err;
    state.ended = true;
  });
  return state;
}

const saw = (state, text) => state.events.some((e) => e.type === "message" && e.text === text);

async function waitReady(base, tries = 30) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return await res.json();
      last = res.status;
    } catch (err) {
      last = err.message;
    }
    await sleep(500);
  }
  throw new Error(`deployment not reachable at ${base} (${last})`);
}

// ---- local secure-restore phase: the live export rebuilds into a clean local store ----

function localServer(dataDir, port) {
  const lock = require("../lib/lock.js");
  const cmd = lock.wrapper(dataDir, NODE, [path.join(ROOT, "server.js")]);
  const child = spawn(cmd.file, cmd.args, {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "openslack-deploycheck-cwd-")),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "test" },
    stdio: "ignore"
  });
  return child;
}

async function runLocalRestorePhase(exportBody, tag) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-deploycheck-restore-"));
  const exportFile = path.join(os.tmpdir(), `openslack-deploycheck-${tag}.json`);
  fs.writeFileSync(exportFile, exportBody);
  const run = (args) => {
    try {
      return { ok: true, out: execFileSync(NODE, [path.join(ROOT, "scripts", "restore.js"), ...args], {
        env: { ...process.env, DATA_DIR: dataDir },
        encoding: "utf8",
        timeout: 20000
      }) };
    } catch (err) {
      return { ok: false, err: String(err.stderr || err.message) };
    }
  };
  let server = null;
  try {
    const restored = run([exportFile]);
    check("the live export restores into a clean store", restored.ok, String(restored.err || "").slice(0, 160));
    if (!restored.ok) return;

    const port = 19400 + Math.floor(Math.random() * 500);
    server = localServer(dataDir, port);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(100);
      try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
    }
    check("the restored store serves locally", up);
    if (!up) return;

    const exp = JSON.parse(exportBody);
    const slug = exp.workspace.slug;
    const ownerHandle = exp.members.find((m) => m.role === "owner").handle;
    // An unrelated signup with the exported owner's handle gains nothing.
    const attacker = await signup(`http://127.0.0.1:${port}`, ownerHandle, "attacker password 1");
    check("a handle claimer of the restored workspace gains no access", (await call(`http://127.0.0.1:${port}`, "GET", `/api/ws/${slug}`, null, attacker.cookie)).status === 403);

    // The administrator verifies accounts out of band, then attaches them.
    // attachMember is administrator-only (never reachable over HTTP): stop
    // the server, run the restore command's attach step, restart.
    const ownerNew = await signup(`http://127.0.0.1:${port}`, `${tag}-recovered-owner`, "verified by admin");
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([exited, sleep(4000)]);
    const attached = run([exportFile, "--attach", `${ownerHandle}=${tag}-recovered-owner`]);
    check("the administrator's verified attach restores the owner", attached.ok, String(attached.err || "").slice(0, 160));
    server = localServer(dataDir, port);
    up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(100);
      try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
    }
    const login = await call(`http://127.0.0.1:${port}`, "POST", "/api/login", { handle: `${tag}-recovered-owner`, password: "verified by admin" });
    const ownerCookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const back = await call(`http://127.0.0.1:${port}`, "GET", `/api/ws/${slug}`, null, ownerCookie);
    check("the reattached owner regains access to the restored workspace", back.status === 200 && back.body.role === "owner", `status ${back.status}`);
    const msgs = await call(`http://127.0.0.1:${port}`, "GET", `/api/ws/${slug}/channels/general/messages?limit=100`, null, ownerCookie);
    check("the restored workspace serves the deployed history", msgs.status === 200 && (msgs.body.messages || []).length >= 1, `${(msgs.body.messages || []).length} messages`);
  } finally {
    if (server && server.exitCode == null && !server.signalCode) server.kill("SIGKILL");
    fs.rmSync(exportFile, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---- the synthetic workspace the check creates on the deployment ----

async function buildSyntheticWorkspace(base, tag) {
  const health = await waitReady(base);
  check("deployed /healthz answers", !!health.ok);
  check("deployed /healthz reports verified durable storage", health.durable === true, `durable=${health.durable} at ${health.storage && health.storage.dataDir}`);
  check("deployed storage holds a real message log", !!health.storage && Number.isInteger(health.storage.messages), JSON.stringify(health.storage));

  const owner = await signup(base, `synth-${tag}-a`, "synthetic password 1");
  const guest = await signup(base, `synth-${tag}-b`, "synthetic password 1");
  check("two synthetic accounts sign up on the deployment", owner.status === 201 && guest.status === 201, `${owner.status}/${guest.status}`);

  const ws = await call(base, "POST", "/api/workspaces", { name: `Deploy Check ${tag}` }, owner.cookie);
  check("synthetic workspace created", ws.status === 201, ws.body.slug);
  const inv = await call(base, "POST", "/api/invites", { slug: ws.body.slug }, owner.cookie);
  check("invite link issued", inv.status === 201);
  check("guest joins via the invitation link", (await call(base, "POST", `/api/invites/${inv.body.token}/join`, null, guest.cookie)).status === 200);

  const texts = [
    "Alpha: deployment-check message one",
    "Bravo: deployment-check message two",
    "Charlie: deployment-check message three"
  ];
  for (const text of texts) {
    const r = await call(base, "POST", `/api/ws/${ws.body.slug}/channels/general/messages`, { text }, owner.cookie);
    if (r.status !== 201) check("post synthetic message", false, `${text}: ${r.status}`);
  }
  check("three synthetic messages posted", true);

  // Live delivery, then a dropped connection and a fresh stream: the new
  // stream must deliver a message posted after the drop (reconnect proof).
  const stream = openStream(base, `/api/ws/${ws.body.slug}/stream`, guest.cookie);
  await sleep(500);
  const live = await call(base, "POST", `/api/ws/${ws.body.slug}/channels/general/messages`, { text: "Delta: live one" }, owner.cookie);
  check("a message posted live arrives over SSE", live.status === 201);
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    ok = saw(stream, "Delta: live one");
    if (!ok) await sleep(100);
  }
  check("live delivery over the deployed SSE stream", ok);

  const stream2 = openStream(base, `/api/ws/${ws.body.slug}/stream`, guest.cookie); // fresh stream = the reconnect
  await sleep(500);
  await call(base, "POST", `/api/ws/${ws.body.slug}/channels/general/messages`, { text: "Echo: after reconnect" }, owner.cookie);
  ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    ok = saw(stream2, "Echo: after reconnect");
    if (!ok) await sleep(100);
  }
  check("a fresh stream (reconnect) delivers new messages", ok);

  const hist = await call(base, "GET", `/api/ws/${ws.body.slug}/channels/general/messages?limit=100`, null, guest.cookie);
  const got = (hist.body.messages || []).map((m) => m.text);
  check("history over a fresh connection holds every synthetic message", texts.every((t) => got.includes(t)) && got.includes("Delta: live one") && got.includes("Echo: after reconnect"), `${got.length} messages`);

  const exp = await fetch(`${base}/api/ws/${ws.body.slug}/export`, { headers: { cookie: owner.cookie } });
  const exportBody = await exp.text();
  check("the owner can export the workspace", exp.status === 200 && JSON.parse(exportBody).messages.length >= 4, `${JSON.parse(exportBody).messages.length} exported messages`);

  return { ws: ws.body, owner, guest, texts, exportBody, tag };
}

async function deleteSyntheticWorkspace(base, built) {
  const del = await call(base, "DELETE", `/api/ws/${built.ws.slug}`, null, built.owner.cookie);
  check("the owner deletes the synthetic workspace", del.status === 200);
  check("its history is gone for good", (await call(base, "GET", `/api/ws/${built.ws.slug}/channels/general/messages?limit=100`, null, built.owner.cookie)).status === 404);
  check("its export is gone", (await fetch(`${base}/api/ws/${built.ws.slug}/export`, { headers: { cookie: built.owner.cookie } })).status === 403);
}

async function main() {
  const base = process.argv[2] ? process.argv[2].replace(/\/$/, "") : null;
  const mode = process.argv[3] || "full";
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("usage: node scripts/deployment-check.js <base-url> [record | verify '<recordJson>' | full]");
    process.exitCode = 1;
    return;
  }

  if (mode === "verify") {
    // The redeploy proof: a workspace recorded before the redeploy must be
    // intact after it, and the deployment must still report durable storage.
    let record;
    try {
      record = JSON.parse(process.argv[4]);
    } catch {
      console.error("verify needs the JSON record printed by a previous `record` run");
      process.exitCode = 1;
      return;
    }
    const health = await waitReady(base);
    check("deployed /healthz answers after the redeploy", !!health.ok);
    check("deployed /healthz still reports verified durable storage", health.durable === true, `durable=${health.durable}`);
    const login = await call(base, "POST", "/api/login", { handle: record.handle, password: record.password });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    check("the recorded account still signs in after the redeploy", login.status === 200);
    const hist = await call(base, "GET", `/api/ws/${record.slug}/channels/general/messages?limit=100`, null, cookie);
    const got = (hist.body.messages || []).map((m) => m.text);
    check("every message recorded before the redeploy is still there", record.texts.every((t) => got.includes(t)), `${got.length} messages of ${record.texts.length} expected`);
    console.log(`\n${process.exitCode ? "FAILED" : "ALL PASS"} — ${passed} checks passed`);
    return;
  }

  const tag = String(Date.now() % 10000000);
  const built = await buildSyntheticWorkspace(base, tag);

  if (mode === "record") {
    // Leave the workspace in place; its record is the input to `verify` after
    // the platform's next redeploy of the same deployment.
    console.log("RECORD " + JSON.stringify({
      slug: built.ws.slug,
      handle: `synth-${tag}-a`,
      password: "synthetic password 1",
      texts: built.texts,
      recordedAt: new Date().toISOString()
    }));
  } else {
    await runLocalRestorePhase(built.exportBody, tag);
    await deleteSyntheticWorkspace(base, built);
  }

  console.log(`\n${process.exitCode ? "FAILED" : "ALL PASS"} — ${passed} checks passed`);
}

main().catch((err) => {
  console.error("deployment check crashed:", err.message);
  process.exitCode = 1;
});
