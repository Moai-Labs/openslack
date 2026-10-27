// End-to-end API tests over a real HTTP server on an ephemeral port.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

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

test("pages and static assets are served", async () => {
  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await home.text(), /OpenSlack/);
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(js.status, 200);
  const css = await fetch(`http://127.0.0.1:${port}/style.css`);
  assert.equal(css.status, 200);
  const joinPage = await fetch(`http://127.0.0.1:${port}/join/abc123`);
  assert.match(await joinPage.text(), /Join a workspace/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/w/UPPER`)).status, 404);
  assert.equal((await call("POST", "/api/nope")).res.status, 404);
});

test("server shuts down cleanly", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
