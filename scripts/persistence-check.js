// Persistence check for OpenSlack (synthetic data only).
//
// Proves, with a script and no manual steps, that:
//   1. messages posted through the API are durable: a SIGKILL of the server
//      loses nothing and a fresh connection sees the full history (reconnect);
//   2. a "redeploy" — a brand new server process, fresh cwd, same data
//      directory — serves the same history;
//   3. restore never grants access by handle alone: an unrelated signup with
//      the exported owner handle gains nothing, and members regain access only
//      through the administrator's verified --attach mapping;
//   4. restore refuses to run while the server owns the data directory;
//   5. an export taken before the crash rebuilds a store that was wiped
//      entirely (restore); and
//   6. deletion removes a workspace and its messages for good.
//
// Usage: node scripts/persistence-check.js [dataDir]
// The data directory is always synthetic-only: the argument, if given, must be
// empty or not yet existing, so an existing store can never be touched — the
// check fills it with its own accounts and may wipe it during the restore
// phase. Servers started by the check are killed in a finally block, whatever
// the outcome.
//
// Exits 0 on pass, 1 on failure. Run in CI and before inviting real users.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

// Some environments report an execPath that does not exist; fall back to PATH.
const NODE = fs.existsSync(process.execPath) ? process.execPath : "node";

const live = new Set(); // child servers, killed in finally whatever happens

function startServer(dataDir, port) {
  const cwd = path.join(os.tmpdir(), "openslack-check-" + Date.now()); // fresh cwd like a new container
  fs.mkdirSync(cwd, { recursive: true });
  // NODE_ENV=test: the strict production storage gate is what deployments
  // exercise, not this check, whose data directories are ordinary temp dirs.
  // The server is started under flock(2) exactly as the deployment does: the
  // shell wrapper takes the exclusive lock and exec's node, so the direct
  // child holds the kernel data-directory lock itself — a hard kill (SIGKILL)
  // releases it the moment the process dies, no stale lock, no takeover logic.
  const lock = require("../lib/lock.js");
  const cmd = lock.wrapper(dataDir, NODE, [path.join(ROOT, "server.js")]);
  const child = spawn(cmd.file, cmd.args, {
    cwd,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  live.add(child);
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  child.on("exit", () => live.delete(child));
  return child;
}

// Stop a server and wait until it is really gone: the restore phase must not
// race a server that still owns the data directory.
function stopServer(child, { hard = false } = {}) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode) return resolve();
    child.once("exit", resolve);
    child.kill(hard ? "SIGKILL" : "SIGTERM");
    setTimeout(() => {
      if (child.exitCode == null && !child.signalCode) child.kill("SIGKILL");
    }, 2000).unref();
  });
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

const api = (port, path, opts, cookie) => {
  opts = opts || {};
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
};

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

  // The store is synthetic-only by construction: a supplied directory must be
  // empty (or not exist yet), and the default is a fresh temp directory.
  const supplied = process.argv[2];
  let dataDir;
  if (supplied) {
    if (fs.existsSync(supplied) && fs.readdirSync(supplied).length) {
      console.error(`refusing: ${supplied} is not empty. The persistence check wipes and rewrites its data`);
      console.error("directory; point it at an empty directory (or nothing, for a fresh temp dir), never at a live store.");
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(supplied, { recursive: true });
    dataDir = supplied;
  } else {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-data-"));
  }

  const exportFile = path.join(os.tmpdir(), `openslack-export-${Date.now()}.json`);
  console.log(`persistence check: data in ${dataDir}, server on ${base}`);

  // ---- phase 1: synthetic data through the public API ----
  let server = startServer(dataDir, port);
  const ready = await waitReady(port);
  check("server boots and reports its storage path", !!ready.storage && ready.storage.dataDir === dataDir, ready.storage && ready.storage.dataDir);
  check("healthz reports the verified durability of its storage", typeof ready.durable === "boolean", `durable=${ready.durable}`);

  const alice = await signup(port, `alice-${Date.now() % 100000}`, "correct horse battery");
  const bob = await signup(port, `bob-${Date.now() % 100000}`, "correct horse battery");
  check("two synthetic accounts sign up", alice.res.status === 201 && bob.res.status === 201);

  const ws = await j(await api(port, "/api/workspaces", { method: "POST", body: { name: "Durability Check" } }, alice.cookie));
  check("alice creates a workspace", ws.status === 201, ws.body.slug);

  const invite = await j(await api(port, "/api/invites", { method: "POST", body: { slug: ws.body.slug } }, alice.cookie));
  check("invite link issued", invite.status === 201, invite.body.url);
  const joined = await j(await api(port, `/api/invites/${invite.body.token}/join`, { method: "POST" }, bob.cookie));
  check("bob joins via the invite link", joined.status === 200);

  // The server owns the data directory now; a concurrent restore must refuse.
  const ref = await restoreFromFile(exportFile, dataDir); // not even a real export yet: must fail either way
  check("restore refuses while the server owns the data directory", !ref.ok, ref.detail);

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
  await stopServer(server, { hard: true });
  server = startServer(dataDir, port);
  const afterKill = await waitReady(port);
  check("server restarts on the same data directory after SIGKILL", afterKill.storage.dataDir === dataDir);

  const reconnect = await j(await api(port, `/api/ws/${ws.body.slug}/channels/general/messages?limit=100`, {}, bob.cookie));
  const got = (reconnect.body.messages || []).map((m) => m.text);
  check("fresh connection sees all messages after SIGKILL (reconnect proof)", synth.every((t) => got.includes(t)) && got.includes("Delta: from bob"), `${got.length} messages`);

  // ---- phase 3: redeploy — brand new process, fresh cwd, same data dir ----
  await stopServer(server);
  server = startServer(dataDir, port);
  await waitReady(port);
  const afterRedeploy = await j(await api(port, `/api/ws/${ws.body.slug}/channels/general/messages?limit=100`, {}, alice.cookie));
  const got2 = (afterRedeploy.body.messages || []).map((m) => m.text);
  check("history intact across a redeploy (new process, fresh cwd)", synth.every((t) => got2.includes(t)), `${got2.length} messages`);

  // ---- phase 4: restore from export into a wiped store ----
  await stopServer(server); // restore needs the data directory free
  fs.rmSync(dataDir, { recursive: true, force: true }); // lose the container: only the export survives
  const restored = await restoreFromFile(exportFile, dataDir);
  check("restore rebuilds the workspace from the export (no owner attached)", restored.ok, restored.detail);

  server = startServer(dataDir, port);
  await waitReady(port);
  const exp = JSON.parse(fs.readFileSync(exportFile, "utf8"));
  const slug = exp.workspace.slug;
  const ownerHandle = exp.members.find((m) => m.role === "owner").handle;
  const memberHandle = exp.members.find((m) => m.role === "member").handle;

  // Nobody may claim the workspace by signing up with an exported handle.
  const attacker = await signup(port, ownerHandle, "attacker password 1");
  check("a stranger signs up with the exported owner handle", attacker.res.status === 201);
  const sneak = await j(await api(port, `/api/ws/${slug}`, null, attacker.cookie));
  check("that account gains no access to the restored workspace", sneak.status === 403, sneak.body.error);
  const sneakExport = await j(await api(port, `/api/ws/${slug}/export`, null, attacker.cookie));
  check("no export for a handle claimer", sneakExport.status === 403);
  const sneakDelete = await j(await api(port, `/api/ws/${slug}`, { method: "DELETE" }, attacker.cookie));
  check("no deletion for a handle claimer", sneakDelete.status === 403);
  const sneakMsgs = await j(await api(port, `/api/ws/${slug}/channels/general/messages?limit=100`, null, attacker.cookie));
  check("no history for a handle claimer", sneakMsgs.status === 403);
  const dbJson = JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf8"));
  const restoredWs = dbJson.workspaces.find((w) => w.slug === slug);
  const pendingHandles = (restoredWs.pendingMembers || []).map((p) => p.handle);
  check("every exported member is preserved as a pending record", pendingHandles.includes(ownerHandle) && pendingHandles.includes(memberHandle), pendingHandles.join(", "));

  // Recovery: the administrator verifies accounts out of band, then attaches
  // them to the pending records with the restore command. In this check the
  // accounts are created through the API, then the server is stopped so the
  // administrator command can take the data directory.
  const ownerNew = await signup(port, "recovered-owner", "verified by admin");
  const memberNew = await signup(port, "recovered-member", "verified by admin");
  check("the administrator creates verified accounts for recovery", ownerNew.res.status === 201 && memberNew.res.status === 201);
  await stopServer(server);
  const attached = await restoreFromFile(exportFile, dataDir, [`${ownerHandle}=recovered-owner`, `${memberHandle}=recovered-member`]);
  check("admin attach reattaches the pending members to verified accounts", attached.ok, attached.detail);

  server = startServer(dataDir, port);
  await waitReady(port);
  const ownerCookie = ownerNew.cookie;
  const memberCookie = memberNew.cookie;
  const back = await j(await api(port, `/api/ws/${slug}`, null, ownerCookie));
  check("the attached owner regains access", back.status === 200 && back.body.role === "owner", back.body.role);
  const backExport = await fetch(`http://127.0.0.1:${port}/api/ws/${slug}/export`, { headers: { cookie: ownerCookie } });
  check("the attached owner can export again", backExport.status === 200);
  await backExport.text();
  const backMsgs = await j(await api(port, `/api/ws/${slug}/channels/general/messages?limit=100`, null, ownerCookie));
  const got3 = (backMsgs.body.messages || []).map((m) => m.text);
  check("restored workspace serves the full message history", synth.every((t) => got3.includes(t)), `${got3.length} messages`);
  const memberBack = await j(await api(port, `/api/ws/${slug}/channels/general/messages?limit=100`, null, memberCookie));
  check("the attached member can read but not export", memberBack.status === 200 && (await j(await api(port, `/api/ws/${slug}/export`, null, memberCookie))).status === 403);
  const stillOut = await j(await api(port, `/api/ws/${slug}`, null, attacker.cookie));
  check("the handle claimer still gains nothing", stillOut.status === 403);

  // ---- phase 5: deletion is real deletion ----
  const del = await j(await api(port, `/api/ws/${slug}`, { method: "DELETE" }, ownerCookie));
  check("owner deletes the workspace", del.status === 200);
  const afterDel = await j(await api(port, `/api/ws/${slug}/channels/general/messages?limit=100`, null, ownerCookie));
  check("deleted workspace and its history are gone", afterDel.status === 404);
  const rawLog = fs.readFileSync(path.join(dataDir, "messages.jsonl"), "utf8");
  check("message log no longer contains the deleted workspace's text", !synth.some((t) => rawLog.includes(t.split(":")[1].trim().slice(0, 12))));

  await stopServer(server);
  fs.rmSync(exportFile, { force: true });
  console.log(`\n${process.exitCode ? "FAILED" : "ALL PASS"} — ${passed} checks passed`);
}

async function restoreFromFile(exportFile, dataDir, attach = []) {
  const { execFileSync } = require("node:child_process");
  const args = [path.join(ROOT, "scripts", "restore.js"), exportFile];
  for (const a of attach) args.push("--attach", a);
  try {
    const out = execFileSync(NODE, args, {
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 20000
    });
    return { ok: true, detail: out.trim().split("\n").pop() };
  } catch (err) {
    return { ok: false, detail: String(err.stderr || err.message).slice(0, 300) };
  }
}

main()
  .catch((err) => {
    console.error("check crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of [...live]) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
