// Persistence check for OpenSlack (synthetic data only).
//
// Proves, with a script and no manual steps, that:
//   1. messages posted through the API are durable: a SIGKILL of the server
//      loses nothing and a fresh connection sees the full history (reconnect);
//   2. a "redeploy" — a brand new server process, fresh cwd, same data
//      directory — serves the same history;
//   3. an export taken before the crash rebuilds a store that was wiped
//      entirely (restore);
//   4. deletion removes a workspace and its messages for good.
//
// Usage: node scripts/persistence-check.js [dataDir]
// Exits 0 on pass, 1 on failure. Run in CI and before inviting real users.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

// Some environments report an execPath that does not exist; fall back to PATH.
const NODE = fs.existsSync(process.execPath) ? process.execPath : "node";

function startServer(dataDir, port) {
  const cwd = path.join(os.tmpdir(), "openslack-check-" + Date.now()); // fresh cwd like a new container
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(NODE, [path.join(ROOT, "server.js")], {
    cwd,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  child.on("exit", (code, signal) => console.log(`[server] exited code=${code} signal=${signal}`));
  return child;
}

async function waitReady(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become ready");
}

const api = (port, path, opts = {}, cookie) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  else passed++;
  return ok;
}

async function signup(port, handle, password) {
  const res = await api(port, "/api/signup", { method: "POST", body: { handle, password } });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { res: await j(res), cookie };
}

async function main() {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  const dataDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "openslack-data-"));
  const exportFile = path.join(os.tmpdir(), `openslack-export-${Date.now()}.json`);
  console.log(`persistence check: data in ${dataDir}, server on ${base}`);

  // ---- phase 1: synthetic data through the public API ----
  let server = startServer(dataDir, port);
  const ready = await waitReady(port);
  check("server boots and reports its storage path", !!ready.storage && ready.storage.dataDir === dataDir, ready.storage && ready.storage.dataDir);

  const alice = await signup(port, `alice-${Date.now() % 100000}`, "correct horse battery");
  const bob = await signup(port, `bob-${Date.now() % 100000}`, "correct horse battery");
  check("two synthetic accounts sign up", alice.res.status === 201 && bob.res.status === 201);

  const ws = await j(await api(port, "/api/workspaces", { method: "POST", body: { name: "Durability Check" } }, alice.cookie));
  check("alice creates a workspace", ws.status === 201, ws.body.slug);

  const invite = await j(await api(port, "/api/invites", { method: "POST", body: { slug: ws.body.slug } }, alice.cookie));
  check("invite link issued", invite.status === 201, invite.body.url);
  const joined = await j(await api(port, `/api/invites/${invite.body.token}/join`, { method: "POST" }, bob.cookie));
  check("bob joins via the invite link", joined.status === 200);

  const synth = [
    "Alpha: first synthetic message",
    "Bravo: second synthetic message",
    "Charlie: third synthetic message"
  ];
  for (const text of synth) {
    const r = await j(await api(port, `/api/ws/${ws.body.slug}/channels/general/messages`, { method: "POST", body: { text } }, alice.cookie));
    if (r.status !== 201) check("post synthetic message", false, text);
  }
  const bobMsg = await j(await api(port, `/api/ws/${ws.body.slug}/channels/general/messages`, { method: "POST", body: { text: "Delta: from bob" } }, bob.cookie));
  check("four synthetic messages posted", bobMsg.status === 201);

  const exportRes = await fetch(`${base}/api/ws/${ws.body.slug}/export`, { headers: { cookie: alice.cookie } });
  fs.writeFileSync(exportFile, await exportRes.text());
  check("owner exports the workspace", exportRes.status === 200 && exportRes.headers.get("content-disposition").includes("attachment"));

  // ---- phase 2: SIGKILL = the hard disconnect. Then reconnect. ----
  server.kill("SIGKILL");
  await sleep(300);
  server = startServer(dataDir, port);
  const afterKill = await waitReady(port);
  check("server restarts on the same data directory", afterKill.storage.dataDir === dataDir);

  const reconnect = await j(await api(port, `/api/ws/${ws.body.slug}/channels/general/messages?limit=100`, {}, bob.cookie));
  const got = (reconnect.body.messages || []).map((m) => m.text);
  check("fresh connection sees all messages after SIGKILL (reconnect proof)", synth.every((t) => got.includes(t)) && got.includes("Delta: from bob"), `${got.length} messages`);

  // ---- phase 3: redeploy — brand new process, fresh cwd, same data dir ----
  server.kill("SIGTERM");
  await sleep(300);
  server = startServer(dataDir, port);
  await waitReady(port);
  const afterRedeploy = await j(await api(port, `/api/ws/${ws.body.slug}/channels/general/messages?limit=100`, {}, alice.cookie));
  const got2 = (afterRedeploy.body.messages || []).map((m) => m.text);
  check("history intact across a redeploy (new process, fresh cwd)", synth.every((t) => got2.includes(t)), `${got2.length} messages`);

  // ---- phase 4: restore from export into a wiped store ----
  server.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(dataDir, { recursive: true, force: true }); // lose the container: only the export survives
  server = startServer(dataDir, port);
  await waitReady(port);

  const restoredLog = await restoreFromFile(exportFile, dataDir);
  check("restore script rebuilds the workspace from the export", restoredLog.ok, restoredLog.detail);
  server.kill("SIGTERM");
  await sleep(300);
  server = startServer(dataDir, port);
  await waitReady(port);

  // alice re-signs up with her original handle (accounts were lost with the store)
  const exp = JSON.parse(fs.readFileSync(exportFile, "utf8"));
  const ownerHandle = exp.members.find((m) => m.role === "owner").handle;
  const ownerSignup = await signup(port, ownerHandle, "restored password 123");
  const wsAfter = await j(await api(port, `/api/ws/${exp.workspace.slug}` ? `/api/ws/${exp.workspace.slug}` : "/", {}, ownerSignup.cookie));
  check("owner reclaims the restored workspace by signing up with the original handle", wsAfter.status === 200, exp.workspace.slug);

  const msgsAfter = await j(await api(port, `/api/ws/${exp.workspace.slug}/channels/general/messages?limit=100`, {}, ownerSignup.cookie));
  const got3 = (msgsAfter.body.messages || []).map((m) => m.text);
  check("restored workspace serves the full message history", synth.every((t) => got3.includes(t)), `${got3.length} messages`);

  // ---- phase 5: deletion is real deletion ----
  const del = await j(await api(port, `/api/ws/${exp.workspace.slug}`, { method: "DELETE" }, ownerSignup.cookie));
  check("owner deletes the workspace", del.status === 200);
  const afterDel = await j(await api(port, `/api/ws/${exp.workspace.slug}/channels/general/messages?limit=100`, {}, ownerSignup.cookie));
  check("deleted workspace and its history are gone", afterDel.status === 404);
  const rawLog = fs.readFileSync(require("node:path").join(dataDir, "messages.jsonl"), "utf8");
  check("message log no longer contains the deleted workspace's text", !synth.some((t) => rawLog.includes(t.split(":")[1].trim().slice(0, 12))));

  server.kill("SIGTERM");
  fs.rmSync(exportFile, { force: true });
  console.log(`\n${process.exitCode ? "FAILED" : "ALL PASS"} — ${passed} checks passed`);
}

async function restoreFromFile(exportFile, dataDir) {
  const { execFileSync } = require("node:child_process");
  try {
    const out = execFileSync(NODE, [path.join(ROOT, "scripts", "restore.js"), exportFile], {
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 20000
    });
    return { ok: true, detail: out.trim().split("\n").pop() };
  } catch (err) {
    return { ok: false, detail: String(err.stderr || err.message).slice(0, 300) };
  }
}

main().catch((err) => {
  console.error("check crashed:", err);
  process.exitCode = 1;
});
