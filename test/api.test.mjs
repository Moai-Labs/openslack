// End-to-end API tests over a real HTTP server on an ephemeral port.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";

const ROOT_SERVER = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-api-"));
process.env.PORT = "0";
process.env.NODE_ENV = "test"; // the production storage gate is exercised by the deployment, not here
const server = (await import("../server.js")).default;

async function onceReady(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server not ready");
}
const port = await (async () => {
  for (let i = 0; i < 100 && !server.address(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!server.address()) throw new Error("server never started listening");
  return server.address().port;
})();
await onceReady(port);

const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function call(method, p, body, cookie) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { res, ...(await j(res)) };
}

test("healthz reports storage and its verified durability", async () => {
  const { res, body } = await call("GET", "/healthz");
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.storage.dataDir);
  assert.equal(typeof body.durable, "boolean");
});

test("signup, login, me", async () => {
  const signup = await call("POST", "/api/signup", { handle: "tester", password: "longenough1" });
  assert.equal(signup.res.status, 201);
  const cookie = cookieOf(signup.res);
  assert.ok(cookie.startsWith("sid="));

  const dup = await call("POST", "/api/signup", { handle: "tester", password: "longenough1" });
  assert.equal(dup.res.status, 409);

  const me = await call("GET", "/api/me", null, cookie);
  assert.equal(me.body.user.handle, "tester");

  const bad = await call("POST", "/api/login", { handle: "tester", password: "wrong pass 1" });
  assert.equal(bad.res.status, 401);
  const good = await call("POST", "/api/login", { handle: "tester", password: "longenough1" });
  assert.equal(good.res.status, 200);

  const anon = await call("GET", "/api/me");
  assert.equal(anon.body.user, null);
});

test("workspace, invite join, member cap enforced over the API", async () => {
  const a = cookieOf((await call("POST", "/api/signup", { handle: "owner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "API Test" }, a);
  assert.equal(ws.res.status, 201);
  const slug = ws.body.slug;

  // isolation: a stranger cannot read anything
  const stranger = cookieOf((await call("POST", "/api/signup", { handle: "stranger", password: "longenough1" })).res);
  assert.equal((await call("GET", `/api/ws/${slug}`, null, stranger)).res.status, 403);
  assert.equal((await call("GET", `/api/ws/${slug}/channels`, null, stranger)).res.status, 403);
  assert.equal((await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: "sneak" }, stranger)).res.status, 403);
  assert.equal((await call("GET", `/api/ws/${slug}/channels/general/messages`, null, stranger)).res.status, 403);
  assert.equal((await call("GET", `/api/ws/${slug}/export`, null, stranger)).res.status, 403);
  assert.equal((await call("GET", `/api/ws/${slug}`, null, null)).res.status, 401);

  // invite flow
  const inv = await call("POST", "/api/invites", { slug }, a);
  assert.equal(inv.res.status, 201);
  const guestCookie = cookieOf((await call("POST", "/api/signup", { handle: "guest", password: "longenough1" })).res);
  const info = await call("GET", `/api/invites/${inv.body.token}`);
  assert.equal(info.body.workspace.name, "API Test");
  const joined = await call("POST", `/api/invites/${inv.body.token}/join`, null, guestCookie);
  assert.equal(joined.res.status, 200);
  assert.equal((await call("GET", `/api/ws/${slug}`, null, guestCookie)).res.status, 200);

  // cap at 5 members
  const cookies = [];
  for (let i = 0; i < 4; i++) {
    const c = cookieOf((await call("POST", "/api/signup", { handle: `member${i}`, password: "longenough1" })).res);
    cookies.push(c);
  }
  for (let i = 0; i < 3; i++) {
    const r = await call("POST", `/api/invites/${inv.body.token}/join`, null, cookies[i]);
    assert.equal(r.res.status, 200);
  }
  const overflow = await call("POST", `/api/invites/${inv.body.token}/join`, null, cookies[3]);
  assert.equal(overflow.res.status, 403);
});

test("channels and messages with pagination, live SSE delivery", async () => {
  const a = cookieOf((await call("POST", "/api/login", { handle: "owner", password: "longenough1" })).res);
  const slug = (await call("GET", "/api/me", null, a)).body.workspaces[0].slug;

  const ch = await call("POST", `/api/ws/${slug}/channels`, { name: "random" }, a);
  assert.equal(ch.res.status, 201);
  assert.equal((await call("POST", `/api/ws/${slug}/channels`, { name: "Random" }, a)).res.status, 409);

  for (let i = 0; i < 5; i++) {
    await call("POST", `/api/ws/${slug}/channels/random/messages`, { text: `n${i}` }, a);
  }
  const hist = await call("GET", `/api/ws/${slug}/channels/random/messages?limit=3`, null, a);
  assert.deepEqual(hist.body.messages.map((m) => m.text), ["n2", "n3", "n4"]);
  const older = await call("GET", `/api/ws/${slug}/channels/random/messages?limit=3&before=${hist.body.messages[0].id}`, null, a);
  assert.deepEqual(older.body.messages.map((m) => m.text), ["n0", "n1"]);

  // SSE: subscribe, post, expect delivery
  const stream = await fetch(`http://127.0.0.1:${port}/api/ws/${slug}/stream`, { headers: { cookie: a } });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  const events = [];
  const reader = stream.body.getReader();
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("event: message")) events.push(JSON.parse(chunk.split("data: ")[1]));
      }
      if (events.length >= 1) break;
    }
  })();
  await new Promise((r) => setTimeout(r, 150));
  await call("POST", `/api/ws/${slug}/channels/random/messages`, { text: "live one" }, a);
  await Promise.race([reading, new Promise((r) => setTimeout(r, 3000))]);
  reader.cancel().catch(() => {});
  assert.ok(events.some((e) => e.type === "message" && e.text === "live one" && e.channel === "random"), JSON.stringify(events));

  // message body rules
  assert.equal((await call("POST", `/api/ws/${slug}/channels/random/messages`, { text: "" }, a)).res.status, 400);
  assert.equal((await call("POST", `/api/ws/${slug}/channels/random/messages`, { text: "x".repeat(4001) }, a)).res.status, 400);
  assert.equal((await call("POST", `/api/ws/${slug}/channels/nosuch/messages`, { text: "hi" }, a)).res.status, 404);
  assert.equal((await call("POST", `/api/ws/nosuch/channels/general/messages`, { text: "hi" }, a)).res.status, 404);
});

test("export, delete, restore path over the API", async () => {
  const a = cookieOf((await call("POST", "/api/login", { handle: "owner", password: "longenough1" })).res);
  const slug = (await call("GET", "/api/me", null, a)).body.workspaces[0].slug;

  const expRes = await fetch(`http://127.0.0.1:${port}/api/ws/${slug}/export`, { headers: { cookie: a } });
  const exp = await expRes.json();
  assert.equal(exp.format, "openslack-export-v1");
  assert.ok(exp.messages.some((m) => m.text === "live one"));

  // delete
  assert.equal((await call("DELETE", `/api/ws/${slug}`, null, a)).res.status, 200);
  assert.equal((await call("GET", `/api/ws/${slug}`, null, a)).res.status, 404);

  // restore via the store API with the administrator's verified mapping
  const { Store } = await import("../lib/store.js");
  const store = new Store(process.env.DATA_DIR).init();
  const ownerId = store.db.users.find((u) => u.handle === "owner").id;
  const ws2 = store.restoreExport(exp, { attach: [{ exportHandle: "owner", userId: ownerId }] });
  assert.equal(store.history(ws2.id, store.channelByName(ws2.id, "random").id, { limit: 1 })[0].text, "live one");
  assert.equal(store.membership(ws2.id, ownerId).role, "owner");
  assert.equal((ws2.pendingMembers || []).map((p) => p.handle).sort().join(","), "guest,member0,member1,member2", "unattached exported members stay pending");
});

test("the restore command never mistakes an unrelated workspace for a restore of the same slug", async () => {
  const { Store } = await import("../lib/store.js");
  const runRestore = (dataDir, args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [path.join(ROOT_SERVER, "scripts", "restore.js"), ...args], {
          env: { ...process.env, DATA_DIR: dataDir },
          encoding: "utf8",
          timeout: 20000
        })
      };
    } catch (err) {
      return { code: err.status, out: String(err.stdout || ""), err: String(err.stderr || err.message) };
    }
  };
  const exportBody = (slug) => JSON.stringify({
    format: "openslack-export-v1",
    exportedAt: "2026-10-27T12:00:00.000Z",
    workspace: { slug, name: "Collide", ownerId: "u1", createdAt: "2026-10-01T00:00:00.000Z" },
    members: [{ handle: "alice", role: "owner", joinedAt: null }],
    channels: [{ name: "general", topic: "", createdAt: "2026-10-01T00:00:00.000Z" }],
    messages: [{ id: "1", channel: "general", handle: "alice", text: "from the export", at: "2026-10-02T00:00:00.000Z" }]
  });

  // An unrelated workspace already holds the export's slug.
  const collDir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-restore-collide-"));
  const pre = new Store(collDir).init();
  const owner = pre.createUser("stranger", "longenough1");
  pre.createWorkspace(owner, "Collide"); // takes the slug "collide"
  const dbBefore = fs.readFileSync(path.join(collDir, "db.json"), "utf8");
  const logBefore = fs.readFileSync(path.join(collDir, "messages.jsonl"), "utf8");

  const expFile = path.join(os.tmpdir(), `openslack-collide-export-${process.pid}.json`);
  fs.writeFileSync(expFile, exportBody("collide"));
  const refused = runRestore(collDir, [expFile]);
  assert.equal(refused.code, 1, "the collision is refused, not silently ignored");
  assert.match(refused.err, /Refusing to guess|already exists/, refused.err.slice(0, 200));
  assert.equal(fs.readFileSync(path.join(collDir, "db.json"), "utf8"), dbBefore, "the unrelated workspace is untouched");
  assert.equal(fs.readFileSync(path.join(collDir, "messages.jsonl"), "utf8"), logBefore, "no messages were imported behind the refusal");

  // --into names an explicit target: the operator's call, the command proceeds.
  const into = runRestore(collDir, [expFile, "--into", "collide", "--attach", "alice=stranger"]);
  assert.equal(into.code, 1, "attaching to a workspace with no such pending record is refused, not guessed");
  assert.match(into.err, /No pending member/, into.err.slice(0, 200));

  // A free slug imports normally; a second run of the same export attaches.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-restore-fresh-"));
  const first = runRestore(fresh, [expFile]);
  assert.equal(first.code, 0, first.err && first.err.slice(0, 200));
  assert.match(first.out, /restored:/);
  const second = runRestore(fresh, [expFile, "--attach", "alice=alice2"]);
  assert.equal(second.code, 1, "the verified account must exist first");
  assert.match(second.err, /no account/);
  const mk = new Store(fresh).init();
  mk.createUser("alice2", "longenough1");
  const third = runRestore(fresh, [expFile, "--attach", "alice=alice2"]);
  assert.equal(third.code, 0, third.err && third.err.slice(0, 200));
  assert.match(third.out, /attached:/, "the recorded restoration identity admits the second run as an attach");
  const store = new Store(fresh).init();
  const ws = store.workspaceBySlug("collide");
  assert.equal(store.workspaceBySlug("collide").ownerId, store.db.users.find((u) => u.handle === "alice2").id, "the attached owner owns the workspace");
  assert.equal(ws.pendingMembers, undefined, "the pending record is consumed");
  fs.rmSync(expFile, { force: true });
});

test("pages and static assets are served", async () => {
  // A GET here can hit a keep-alive socket the server idled out (5 s) while
  // the previous test's synchronous restore runs blocked this event loop;
  // the connection then resets and undici reports "fetch failed". Browsers
  // retry a reset idempotent GET the same way.
  const get = async (p) => {
    let err;
    for (let i = 0; i < 3; i++) {
      try {
        return await fetch(`http://127.0.0.1:${port}${p}`);
      } catch (e) {
        err = e;
      }
    }
    throw err;
  };
  const home = await get("/");
  assert.match(await home.text(), /OpenSlack/);
  assert.equal((await get("/app.js")).status, 200);
  assert.equal((await get("/style.css")).status, 200);
  const joinPage = await get("/join/abc123");
  assert.match(await joinPage.text(), /Join a workspace/);
  assert.equal((await get("/w/UPPER")).status, 404);
  assert.equal((await call("POST", "/api/nope")).res.status, 404);
});

test("shutdown holds the data directory until in-flight requests finish", async () => {
  // A server started exactly as the deployment does: under flock, holding the
  // exclusive lock for its lifetime. SIGTERM must not hand the directory to a
  // restore while a mutation request is still being received.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-shutdown-"));
  const port = 19000 + Math.floor(Math.random() * 500);
  const lock = await import("../lib/lock.js");
  const start = (p) => {
    const cmd = lock.wrapper(dir, process.execPath, [path.join(ROOT_SERVER, "server.js")]);
    return spawn(cmd.file, cmd.args, {
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "openslack-shutdown-cwd-")),
      env: { ...process.env, PORT: String(p), DATA_DIR: dir, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"]
    });
  };
  const child = start(port);
  let childOut = "";
  child.stdout.on("data", (d) => (childOut += d));
  child.stderr.on("data", (d) => (childOut += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) break;
      } catch {}
      if (i === 99) throw new Error(`child server did not start: ${childOut.slice(0, 300)}`);
    }

    const signup = await fetch(`http://127.0.0.1:${port}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "drainer", password: "longenough1" })
    });
    const cookie = (signup.headers.get("set-cookie") || "").split(";")[0];
    const ws = await (
      await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Drain" })
      })
    ).json();

    // A mutation request whose body is only partly received: the server has
    // the headers, the message is not yet written.
    const body = JSON.stringify({ text: "posted during shutdown" });
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/api/ws/${ws.slug}/channels/general/messages`,
      method: "POST",
      headers: { "content-type": "application/json", cookie, "content-length": String(body.length) }
    });
    req.write(body.slice(0, 5));
    await new Promise((r) => setTimeout(r, 300)); // let the server take the request in

    child.kill("SIGTERM"); // graceful shutdown: it must wait for this request
    await new Promise((r) => setTimeout(r, 300));

    // While the request is still open, the directory is still owned.
    let refused = null;
    try {
      execFileSync(process.execPath, [path.join(ROOT_SERVER, "scripts", "restore.js"), path.join(os.tmpdir(), `no-such-export-${process.pid}.json`)], {
        env: { ...process.env, DATA_DIR: dir },
        encoding: "utf8",
        timeout: 10000
      });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused, "restore must be refused while the server drains");
    assert.match(String(refused.stderr), /owned by another live process/, String(refused.stderr).slice(0, 200));

    // Finish the request: the server completes it, then exits, then the
    // directory is free.
    const res = await new Promise((resolve, reject) => {
      req.on("response", resolve);
      req.on("error", reject);
      req.end(body.slice(5));
    });
    assert.equal(res.statusCode, 201, "the in-flight mutation completes during the drain");
    res.resume();
    assert.equal(await exited, 0, "the server exits once nothing can write");

    // The directory is free again, and the message made it to disk.
    const again = start(port + 1);
    let restarted = false;
    for (let i = 0; i < 100 && !restarted; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res2 = await fetch(`http://127.0.0.1:${port + 1}/healthz`);
        if (res2.ok) restarted = true;
      } catch {}
    }
    assert.ok(restarted, "a new server acquires the freed directory");
    const login = await fetch(`http://127.0.0.1:${port + 1}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "drainer", password: "longenough1" })
    });
    const cookie2 = (login.headers.get("set-cookie") || "").split(";")[0];
    const history = await (
      await fetch(`http://127.0.0.1:${port + 1}/api/ws/${ws.slug}/channels/general/messages`, { headers: { cookie: cookie2 } })
    ).json();
    assert.ok((history.messages || []).some((m) => m.text === "posted during shutdown"), "the drained mutation persisted");
    again.kill("SIGTERM");
  } finally {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
  }
});

// A mutation request whose JSON body is only partly delivered: the server has
// taken the headers and is waiting for the rest, which lets the test change
// the world (delete the workspace) before the body completes.
function pendingBody(method, path, cookie, body) {
  const req = http.request({
    host: "127.0.0.1",
    port,
    path,
    method,
    headers: { "content-type": "application/json", cookie, "content-length": String(body.length) }
  });
  req.on("error", () => {}); // the outcome is asserted, not crashed on
  req.write(body.slice(0, 2)); // just "{"
  return () =>
    new Promise((resolve, reject) => {
      req.on("response", (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
      });
      req.on("error", reject);
      req.end(body.slice(2));
    });
}

test("a workspace deleted while a channel-creation body is pending leaves no orphan channel", async () => {
  const a = cookieOf((await call("POST", "/api/signup", { handle: "vanisher", password: "longenough1" })).res);
  const ws = (await call("POST", "/api/workspaces", { name: "Vanish While Pending" }, a)).body;

  const finish = pendingBody("POST", `/api/ws/${ws.slug}/channels`, a, JSON.stringify({ name: "doomed" }));
  await new Promise((r) => setTimeout(r, 300)); // the server is now waiting for the body
  assert.equal((await call("DELETE", `/api/ws/${ws.slug}`, null, a)).res.status, 200, "the owner deletes while the body is pending");

  const res = await finish();
  assert.equal(res.status, 404, "the mutation is refused against the deleted workspace");

  // No orphan metadata anywhere: not in the live API, not on disk.
  const me = await call("GET", "/api/me", null, a);
  assert.ok(!me.body.workspaces.some((w) => w.slug === ws.slug));
  const db = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "db.json"), "utf8"));
  assert.ok(!db.channels.some((c) => c.name === "doomed"), "no orphan channel record on disk");
  assert.ok(!db.workspaces.some((w) => w.id === ws.id), "the workspace record is gone");
  assert.ok(!db.members.some((x) => x.wsId === ws.id), "no membership rows left behind");
});

test("a workspace deleted while a message body is pending acknowledges nothing and stores nothing", async () => {
  const a = cookieOf((await call("POST", "/api/signup", { handle: "vanisher2", password: "longenough1" })).res);
  const ws = (await call("POST", "/api/workspaces", { name: "Vanish Mid Message" }, a)).body;
  assert.equal((await call("POST", `/api/ws/${ws.slug}/channels/general/messages`, { text: "kept" }, a)).res.status, 201);

  const text = "posted for a deleted workspace";
  const finish = pendingBody("POST", `/api/ws/${ws.slug}/channels/general/messages`, a, JSON.stringify({ text }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call("DELETE", `/api/ws/${ws.slug}`, null, a)).res.status, 200);

  const res = await finish();
  assert.equal(res.status, 404, "the message is not acknowledged for a deleted workspace");

  // Nothing was written for it: not in the log on disk, not recoverable by a
  // fresh store (the old bug acknowledged a message the next restart pruned).
  const log = fs.readFileSync(path.join(process.env.DATA_DIR, "messages.jsonl"), "utf8");
  assert.ok(!log.includes(text), "no message record in the log for the deleted workspace");
  const { Store } = await import("../lib/store.js");
  const store = new Store(process.env.DATA_DIR).init();
  assert.ok(!store.messages.some((m) => m.text === text), "a fresh store recovers no such message");
  assert.ok(!store.db.workspaces.some((w) => w.id === ws.id), "the workspace stays deleted");
});

test("logging out ends a stream's live delivery; another session keeps receiving", async () => {
  const make = async (handle) => cookieOf((await call("POST", "/api/signup", { handle, password: "longenough1" })).res);
  const owner = await make("streamowner");
  const leaver = await make("streamleaver");
  const ws = (await call("POST", "/api/workspaces", { name: "Stream Auth" }, owner)).body;
  const inv = (await call("POST", "/api/invites", { slug: ws.slug }, owner)).body;
  assert.equal((await call("POST", `/api/invites/${inv.token}/join`, null, leaver)).res.status, 200);

  const openStream = async (cookie) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ws/${ws.slug}/stream`, { headers: { cookie } });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const state = { events: [], ended: false };
    (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            state.ended = true;
            return;
          }
          const buf = (state._buf = (state._buf || "") + dec.decode(value, { stream: true }));
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            state._buf = buf.slice(i + 2);
            if (chunk.startsWith("event: message")) state.events.push(JSON.parse(chunk.split("data: ")[1]));
          }
          state._reader = reader;
        }
      } catch {
        state.ended = true;
      }
    })();
    await new Promise((r) => setTimeout(r, 150)); // let the server register the stream
    return state;
  };

  const stay = await openStream(owner);
  const gone = await openStream(leaver);
  await call("POST", `/api/ws/${ws.slug}/channels/general/messages`, { text: "before logout" }, owner);
  await until(() => stay.events.some((e) => e.text === "before logout") && gone.events.some((e) => e.text === "before logout"), "both streams delivered");

  // Logging out must terminate that session's stream — not the other's.
  assert.equal((await call("POST", "/api/logout", null, leaver)).res.status, 200);
  await until(() => gone.ended, "the logged-out stream is terminated");
  assert.equal(stay.ended, false, "the other session's stream is untouched");

  await call("POST", `/api/ws/${ws.slug}/channels/general/messages`, { text: "after logout" }, owner);
  await until(() => stay.events.some((e) => e.text === "after logout"), "the valid session still receives");
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!gone.events.some((e) => e.text === "after logout"), "the logged-out session received nothing more");

  // And the logged-out session really is gone: the API refuses it.
  assert.equal((await call("GET", `/api/ws/${ws.slug}`, null, leaver)).res.status, 401);
  if (stay._reader) stay._reader.cancel().catch(() => {});
});

test("an expired session's stream is terminated by broadcast and heartbeat, without being refreshed", async () => {
  const { Store } = await import("../lib/store.js");
  const { Api } = await import("../lib/api.js");
  const { default: LIMITS } = await import("../lib/limits.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-streamauth-"));
  const store = new Store(dir).init();
  const u1 = store.createUser("streamer", "longenough1");
  const u2 = store.createUser("bystander", "longenough1");
  const t1 = store.createSession(u1.id);
  const t2 = store.createSession(u2.id);
  const ws = store.createWorkspace(u1, "Stream Expiry");
  store.joinWorkspace(ws, u2);

  // Fake SSE responses: writes are recorded, end() is observable.
  const fakeRes = () => ({ writes: [], ended: false, write(c) { this.writes.push(c); }, end() { this.ended = true; } });
  const s1 = { res: fakeRes(), wsId: ws.id, userId: u1.id, token: t1 };
  const s2 = { res: fakeRes(), wsId: ws.id, userId: u2.id, token: t2 };
  const api = new Api(store);
  api.streams.add(s1);
  api.streams.add(s2);

  api.broadcast(ws.id, { type: "message", text: "one" });
  assert.ok(s1.res.writes.some((w) => w.includes("one")), "a valid session receives live messages");
  assert.ok(s2.res.writes.some((w) => w.includes("one")));

  // The session expires (idle past the published lifetime): broadcast must
  // deliver nothing further and terminate the stream.
  const sess = store.db.sessions.find((x) => x.token === t1);
  sess.lastSeen = new Date(Date.now() - (LIMITS.SESSION_DAYS + 1) * 86400000).toISOString();
  api.broadcast(ws.id, { type: "message", text: "two" });
  assert.ok(!s1.res.writes.some((w) => w.includes("two")), "an expired session receives nothing");
  assert.equal(s1.res.ended, true, "the expired stream is terminated");
  assert.ok(!api.streams.has(s1));

  // Periodic maintenance ends expired streams too, and never refreshes
  // session activity merely by pinging.
  api.heartbeat();
  assert.ok(!s1.res.writes.some((w) => w.includes("ping")));
  assert.equal(store.db.sessions.find((x) => x.token === t1).lastSeen, sess.lastSeen, "heartbeat did not refresh the expired session");

  // The valid session keeps receiving across all of it.
  api.broadcast(ws.id, { type: "message", text: "three" });
  assert.ok(s2.res.writes.some((w) => w.includes("three")), "the valid session is unaffected");
  assert.equal(s2.res.ended, false);

  // Logout removes the session and its stream with it.
  store.dropSession(t2);
  api.endStreamsFor(t2);
  assert.equal(s2.res.ended, true, "logout terminates the stream");
  assert.ok(!api.streams.has(s2));
});

test("server shuts down cleanly", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
