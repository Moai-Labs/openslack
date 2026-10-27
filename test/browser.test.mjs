// Browser-level tests: the real public/app.js runs in a real DOM (jsdom)
// against a real HTTP server, on the same pages and under the same CSP the
// deployment serves. No test double for the app code — only the browser's
// network stack is substituted, with a cookie jar (the app relies on cookies
// for auth) and an EventSource the test can drive, so client behaviour —
// invitation handling, history rendering, reconnect catch-up, owner tools —
// is exercised end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-browser-"));
process.env.PORT = "0";
process.env.NODE_ENV = "test";
const server = (await import("../server.js")).default;

async function onceReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server not ready");
}
await onceReady();
const base = `http://127.0.0.1:${server.address().port}`;

const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

async function call(method, p, body, cookie) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { res, ...(await j(res)) };
}

const APP_JS = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

// EventSource stand-in: the transport itself is covered by the API tests;
// here the test drives open() and emit() to model connections and outages.
class FakeEventSource {
  constructor(u) {
    this.url = u;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.last = this;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  close() {
    this.closed = true;
  }
  open() {
    if (this.onopen) this.onopen();
  }
  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn({ data });
  }
}

// A browser session against the real server: relative-URL fetch with a cookie
// jar, navigation attempts recorded instead of performed.
function browser(html, { url = `${base}/`, sid = null } = {}) {
  const navigations = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    if (/navigation/i.test(e.message)) navigations.push(e.message);
  });
  const dom = new JSDOM(html, { url, virtualConsole: vc, runScripts: "outside-only" });
  const win = dom.window;

  const jar = new Map();
  if (sid) jar.set("sid", sid);
  win.fetch = async (p, opts = {}) => {
    const target = p.startsWith("http") ? p : base + p;
    const headers = { ...(opts.headers || {}) };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(target, { ...opts, headers, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) {
      const [pair, ...attrs] = set.split(";");
      const [name, ...rest] = pair.split("=");
      if (rest.join("=") === "" || /max-age=0/i.test(attrs.join(";"))) jar.delete(name.trim());
      else jar.set(name.trim(), rest.join("=").trim());
    }
    return res;
  };

  win.EventSource = FakeEventSource;
  win.confirm = () => true;
  win.navigator.clipboard = { writeText: async () => {} };
  win.eval(APP_JS);
  return {
    window: win,
    document: win.document,
    navigations,
    cookie: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
  };
}

// Wait until fn() is truthy and hand back that value; the client is async all
// the way down.
async function until(fn, what, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const submit = (page, form) => form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));

let ownerCookie, guestCookie, visitorCookie, slug, inviteToken;

test("seed: owner signs up, creates a workspace, invites a guest", async () => {
  ownerCookie = cookieOf((await call("POST", "/api/signup", { handle: "owner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Browser Test" }, ownerCookie);
  slug = ws.body.slug;
  // a bit of history before any browser opens
  await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: "before the browser" }, ownerCookie);
  const inv = await call("POST", "/api/invites", { slug }, ownerCookie);
  inviteToken = inv.body.token;
  guestCookie = cookieOf((await call("POST", "/api/signup", { handle: "guest", password: "longenough1" })).res);
  const joined = await call("POST", `/api/invites/${inviteToken}/join`, null, guestCookie);
  assert.equal(joined.res.status, 200);
  assert.ok(slug && inviteToken);
});

test("an ordinary invitation URL displays the correct workspace under the deployed CSP", async () => {
  const res = await fetch(`${base}/join/${inviteToken}`);
  const html = await res.text();
  assert.equal(res.headers.get("content-security-policy"), "default-src 'self'; frame-ancestors 'none'");
  // The token travels in a data attribute; there is no inline script to block.
  assert.match(html, new RegExp(`data-token="${inviteToken}"`));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "no inline script on the join page");

  const page = browser(html, { url: `${base}/join/${inviteToken}` });
  const info = await until(
    () => { const t = page.document.querySelector("#invite-info").textContent; return t.includes("Browser Test") ? t : null; },
    "invite info"
  );
  assert.match(info, /Browser Test/);
  assert.equal(page.document.querySelector("#join-actions").classList.contains("hidden"), false);
});

test("an unauthenticated invitee is sent to sign up, and signing up completes the invitation", async () => {
  // A fresh visitor (no account, no session) opens the join page and clicks Join.
  const html = await (await fetch(`${base}/join/${inviteToken}`)).text();
  const page = browser(html, { url: `${base}/join/${inviteToken}` });
  await until(() => page.document.querySelector("#invite-info").textContent.includes("Browser Test"), "invite info");
  page.document.querySelector("#join-btn").onclick();
  await until(() => page.window.sessionStorage.getItem("pendingInvite") === inviteToken, "pending invite stored");
  await until(() => page.navigations.length > 0, "redirect to the home page attempted");

  // The home page: signing up resumes the pending invitation.
  const home = browser(await (await fetch(`${base}/`)).text(), { url: `${base}/` });
  home.window.sessionStorage.setItem("pendingInvite", inviteToken);
  home.document.querySelector("#tab-signup").click();
  home.document.querySelector('#form-signup input[name="handle"]').value = "visitor";
  home.document.querySelector('#form-signup input[name="password"]').value = "longenough1";
  submit(home, home.document.querySelector("#form-signup"));
  await until(() => !home.window.sessionStorage.getItem("pendingInvite"), "pending invite cleared after the join");

  // The join really happened server-side: the visitor is a member now.
  const me = await call("GET", "/api/me", null, home.cookie());
  assert.ok(me.body.workspaces.some((w) => w.slug === slug), "the visitor joined the invited workspace");
  visitorCookie = home.cookie();
});

test("an invalid invitation is cleared, never retried forever", async () => {
  const home = browser(await (await fetch(`${base}/`)).text(), { url: `${base}/` });
  home.window.sessionStorage.setItem("pendingInvite", "not-a-real-token");
  home.document.querySelector("#tab-signup").click();
  home.document.querySelector('#form-signup input[name="handle"]').value = "secondvisitor";
  home.document.querySelector('#form-signup input[name="password"]').value = "longenough1";
  submit(home, home.document.querySelector("#form-signup"));
  await until(() => !home.window.sessionStorage.getItem("pendingInvite"), "invalid invite cleared");
});

test("initial history renders, and reconnect catch-up recovers messages posted during a disconnect", async () => {
  const html = await (await fetch(`${base}/w/${slug}`)).text();
  const page = browser(html, { url: `${base}/w/${slug}`, sid: guestCookie.split("=")[1] });
  const doc = page.document;
  await until(() => doc.querySelector("#log").children.length >= 1, "initial history rendered");
  assert.ok(
    [...doc.querySelector("#log").children].some((n) => n.textContent.includes("before the browser")),
    "history rows (which carry chId, not channel) render for the requested channel"
  );

  // Disconnect: the page stops receiving stream events while others post.
  const es = FakeEventSource.last;
  await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: "missed one" }, ownerCookie);
  await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: "missed two" }, ownerCookie);
  await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: "missed three" }, ownerCookie);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal([...doc.querySelector("#log").children].filter((n) => n.textContent.includes("missed")).length, 0);

  // Reconnect: on open the client catches up from its last displayed id.
  es.open();
  await until(
    () => [...doc.querySelector("#log").children].filter((n) => n.textContent.includes("missed")).length === 3,
    "catch-up after reconnect"
  );
  const ids = [...doc.querySelector("#log").children].map((n) => n.dataset.id);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids, "messages render in order");
  assert.equal(new Set(ids).size, ids.length, "no duplicates");

  // A live event after the catch-up shows up exactly once.
  const live = await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: "live one" }, ownerCookie);
  es.emit(
    "message",
    JSON.stringify({ type: "message", id: live.body.message.id, channel: "general", handle: "owner", text: "live one", at: new Date().toISOString() })
  );
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("live one")), "live message");
  const ids2 = [...doc.querySelector("#log").children].map((n) => n.dataset.id);
  assert.equal(new Set(ids2).size, ids2.length, "still no duplicates after a live event");

  // Messages in other channels never leak into this channel's log.
  es.emit(
    "message",
    JSON.stringify({ type: "message", id: "9000", channel: "elsewhere", handle: "owner", text: "not for you", at: new Date().toISOString() })
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(![...doc.querySelector("#log").children].some((n) => n.textContent.includes("not for you")), "no cross-channel leakage");

  // Multi-page recovery with a live event in flight. The catch-up page is 50
  // rows, so 60 missed messages force more than one fetch; and a live event
  // that arrives while the catch-up is still running must wait for the gap
  // to be filled — never jump it or push the cursor past unseen rows.
  es.close(); // the outage: nothing is delivered while these are posted
  const bulk = [];
  for (let i = 0; i < 20; i++) {
    for (const [ck, who] of [[ownerCookie, "owner"], [guestCookie, "guest"], [visitorCookie, "visitor"]]) {
      const r = await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: `bulk ${who} ${i}` }, ck);
      bulk.push(r.body.message);
    }
  }
  assert.equal(bulk.length, 60, "all bulk posts accepted (rate limit allows 3 users x 20)");
  assert.equal([...doc.querySelector("#log").children].filter((n) => n.textContent.includes("bulk")).length, 0, "nothing delivered while offline");

  const origFetch = page.window.fetch;
  let catchUpFetches = 0;
  page.window.fetch = (p, o) => {
    if (typeof p === "string" && p.includes("after=")) catchUpFetches++;
    return origFetch(p, o);
  };
  const last = bulk[bulk.length - 1];
  es.open(); // reconnect: the catch-up starts and live delivery is held back
  es.emit("message", JSON.stringify({ type: "message", id: last.id, channel: "general", handle: last.handle, text: last.text, at: last.at }));
  await until(
    () => [...doc.querySelector("#log").children].filter((n) => n.textContent.includes("bulk")).length === 60,
    "multi-page catch-up with a live event buffered"
  );
  assert.ok(catchUpFetches >= 2, `catch-up paginated past one page (${catchUpFetches} fetches)`);
  const ids3 = [...doc.querySelector("#log").children].map((n) => n.dataset.id);
  assert.deepEqual([...ids3].sort((a, b) => a - b), ids3, "recovered and buffered messages render in id order");
  assert.equal(new Set(ids3).size, ids3.length, "no duplicates across pages and buffered live events");
  page.window.fetch = origFetch;
  page.window.close();
});

test("owner tools appear for the owner and work; non-owners never see them", async () => {
  const html = await (await fetch(`${base}/w/${slug}`)).text();

  // Owner: export and delete controls are revealed (the HTML hidden property
  // itself must be cleared, not just a CSS class).
  const ownerPage = browser(html, { url: `${base}/w/${slug}`, sid: ownerCookie.split("=")[1] });
  const od = ownerPage.document;
  await until(() => od.querySelector("#export-btn").hidden === false, "owner export revealed");
  assert.equal(od.querySelector("#delete-btn").hidden, false, "owner delete revealed");
  assert.equal(od.querySelector("#export-btn").href, `${base}/api/ws/${slug}/export`);

  // Non-owner: both stay hidden.
  const guestPage = browser(html, { url: `${base}/w/${slug}`, sid: guestCookie.split("=")[1] });
  const gd = guestPage.document;
  await until(() => gd.querySelector("#log").children.length >= 1, "guest history rendered");
  assert.equal(gd.querySelector("#export-btn").hidden, true, "guest cannot see export");
  assert.equal(gd.querySelector("#delete-btn").hidden, true, "guest cannot see delete");
  // and the server enforces it even if the control were forced visible
  assert.equal((await call("GET", `/api/ws/${slug}/export`, null, guestCookie)).res.status, 403);

  // The owner can actually delete: clicking removes the workspace server-side.
  od.querySelector("#delete-btn").onclick();
  await until(async () => (await call("GET", `/api/ws/${slug}`, null, ownerCookie)).status === 404, "workspace deleted");
  ownerPage.window.close();
  guestPage.window.close();
});

test("cleanup: server shuts down", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
