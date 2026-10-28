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
import http from "node:http";
import { JSDOM, VirtualConsole } from "jsdom";

// The test-USDC payment node, scripted: the browser tests exercise the real
// payment flow (request, verify, entitlement) against these receipts.
let chainId = "0x14a34"; // 84532 = Base Sepolia
let assetCode = "0x6080"; // non-empty: the asset contract exists
let headNumber = "0x30a3796"; // the chain head the node reports to payment start; receipts sit in a later block
let receipts = new Map(); // txHash (lowercase) -> receipt object
let blocks = new Map(); // blockNumber (lowercase) -> { timestamp } in seconds; unset blocks are "now"
const fakeRpc = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { method, params } = JSON.parse(body);
    let result = null;
    if (method === "eth_chainId") result = chainId;
    else if (method === "eth_getCode") result = assetCode;
    else if (method === "eth_blockNumber") result = headNumber;
    else if (method === "eth_getTransactionReceipt") result = receipts.get(String(params[0]).toLowerCase()) ?? null;
    else if (method === "eth_getBlockByNumber") {
      const key = String(params[0]).toLowerCase();
      const ts = blocks.has(key) ? blocks.get(key).timestamp : Math.floor(Date.now() / 1000);
      result = { number: params[0], timestamp: "0x" + BigInt(ts).toString(16) };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
});
await new Promise((resolve) => fakeRpc.listen(0, "127.0.0.1", resolve));

process.env.PAY_RPC_URL = `http://127.0.0.1:${fakeRpc.address().port}`;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-browser-"));
process.env.PORT = "0";
process.env.NODE_ENV = "test";
const server = (await import("../server.js")).default;
const LIMITS = (await import("../lib/limits.js")).default;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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
    let res;
    try {
      res = await fetch(target, { ...opts, headers, redirect: "manual" });
    } catch (err) {
      // A real browser silently retries an idempotent request whose pooled
      // socket the server closed before any bytes arrived (the default 5s
      // keep-alive timeout bites whenever a slow step like scrypt leaves a
      // longer gap); undici's raw fetch surfaces it as ECONNRESET instead.
      // Retry once on a fresh connection, and only for a safe method —
      // a POST that resets may already have run.
      const safe = !opts.method || opts.method === "GET";
      if (!(safe && err?.cause?.code === "ECONNRESET")) throw err;
      res = await fetch(target, { ...opts, headers, redirect: "manual" });
    }
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
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const submit = (page, form) => form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));

let ownerCookie, guestCookie, slug, inviteToken;

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

// ---- the labelled test-USDC payment, driven through the real product ----

const TX = (n) => "0x" + String(n).padStart(2, "0") + "0".repeat(62); // unique per number
// The receipt carries the exact amount an open payment request asked for —
// that request's own unique amount is what the server verifies against.
const receiptFor = (txHash, amountRaw = BigInt(LIMITS.PAID_PRICE_USDC) * 10n ** 6n, to) => {
  const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().slice(2);
  return {
    blockHash: "0x" + "ab".repeat(32),
    blockNumber: "0x30a3797",
    status: "0x1",
    logs: [
      {
        address: LIMITS.PAY_USDC_ADDRESS,
        topics: [TRANSFER_TOPIC, pad("0x1111000000000000000000000000000000000001"), pad(to)],
        data: "0x" + BigInt(amountRaw).toString(16).padStart(64, "0"),
        blockNumber: "0x30a3797",
        logIndex: "0x0",
        removed: false,
        transactionHash: txHash
      }
    ]
  };
};

let paySlug, payOwnerCookie;

test("seed: a workspace an owner will pay for, with a member beside them", async () => {
  payOwnerCookie = cookieOf((await call("POST", "/api/signup", { handle: "payowner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Payment Browser" }, payOwnerCookie);
  paySlug = ws.body.slug;
  await call("POST", `/api/ws/${paySlug}/channels/general/messages`, { text: "hello before paying" }, payOwnerCookie);
});

test("an owner sees the test-payment control, completes the verified flow, and sees the entitlement", async () => {
  const html = await (await fetch(`${base}/w/${paySlug}`)).text();
  const page = browser(html, { url: `${base}/w/${paySlug}`, sid: payOwnerCookie.split("=")[1] });
  const doc = page.document;

  // the control is revealed by clearing the HTML hidden property itself
  await until(() => doc.querySelector("#pay-test-btn").hidden === false, "pay control revealed for the owner");
  assert.equal(doc.querySelector("#tier-info").textContent.includes("Free tier"), true, "starts on the free tier");

  // step 1: the product shows the exact payment request, labelled as a test —
  // the request the panel itself opened, whose id and address it carries
  doc.querySelector("#pay-test-btn").onclick();
  await until(() => doc.querySelector("#pay-panel").hidden === false, "payment panel opened");
  const details = doc.querySelector("#pay-details").textContent;
  assert.match(details, /TEST payment/);
  const shownRecipient = details.match(/payment address (0x[0-9a-f]{40})/i)[1]; // the request's own payment address
  assert.ok(shownRecipient, "the panel shows the request's own payment address");
  const shownIntentId = doc.querySelector("#pay-tx").dataset.intentId;
  assert.ok(shownIntentId, "the panel holds the request it opened");
  assert.match(details, new RegExp(LIMITS.PAY_USDC_ADDRESS, "i"));
  assert.match(details, /exactly 12 test-USDC/, "the exact price is shown");
  assert.match(details, /Base Sepolia/);
  assert.match(details, /zero revenue/);

  // step 2 with a hash the test chain has never seen: the product refuses and
  // explains, and nothing is granted
  receipts.delete(TX(70));
  doc.querySelector("#pay-tx").value = TX(70);
  doc.querySelector("#form-pay").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => doc.querySelector("#pay-error").textContent.includes("not settled"), "unsettled hash explained in the product");
  assert.equal(doc.querySelector("#tier-info").textContent.includes("Free tier"), true, "still free after a failed verification");

  // the real, settled transfer to the request's own address verifies and the
  // entitlement appears
  receipts.set(TX(70), receiptFor(TX(70), BigInt(LIMITS.PAID_PRICE_USDC) * 10n ** 6n, shownRecipient));
  doc.querySelector("#form-pay").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => doc.querySelector("#tier-info").textContent.includes("Paid tier (test payment)"), "paid tier shown");
  assert.match(doc.querySelector("#tier-info").textContent, /365-day history/);
  assert.equal(doc.querySelector("#pay-panel").hidden, true, "panel closes after success");

  // server-side: the entitlement is real and carries the verified hash
  const info = await call("GET", `/api/ws/${paySlug}`, null, payOwnerCookie);
  assert.equal(info.body.tier, "paid");
  assert.equal(info.body.payments[0].txHash, TX(70));
  assert.equal(info.body.payments[0].revenue, 0);
  page.window.close();
});

test("a non-owner never sees the payment control", async () => {
  const guest = cookieOf((await call("POST", "/api/signup", { handle: "payguest", password: "longenough1" })).res);
  const inv = await call("POST", "/api/invites", { slug: paySlug }, payOwnerCookie);
  await call("POST", `/api/invites/${inv.body.token}/join`, null, guest);
  const html = await (await fetch(`${base}/w/${paySlug}`)).text();
  const page = browser(html, { url: `${base}/w/${paySlug}`, sid: guest.split("=")[1] });
  await until(() => page.document.querySelector("#log").children.length >= 1, "history rendered");
  assert.equal(page.document.querySelector("#pay-test-btn").hidden, true, "no payment control for a member");
  assert.equal((await call("POST", `/api/ws/${paySlug}/pay-test/start`, null, guest)).res.status, 403);
  page.window.close();
});

// ---- searchable history, driven through the real product ----

let searchSlug, searchOwnerCookie;

test("seed: a workspace with older history beyond the newest page", async () => {
  searchOwnerCookie = cookieOf((await call("POST", "/api/signup", { handle: "searchowner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Search Browser" }, searchOwnerCookie);
  searchSlug = ws.body.slug;
  await call("POST", `/api/ws/${searchSlug}/channels`, { name: "random" }, searchOwnerCookie);
  // 120 matching messages: the workspace fills its free tier (owner + 4), and
  // four senders at 24 each stays inside every sender's per-minute budget
  const posters = [searchOwnerCookie];
  for (let i = 0; i < 4; i++) posters.push(cookieOf((await call("POST", "/api/signup", { handle: `p${i}`, password: "longenough1" })).res));
  const inv = await call("POST", "/api/invites", { slug: searchSlug }, searchOwnerCookie);
  for (const cookie of posters.slice(1)) await call("POST", `/api/invites/${inv.body.token}/join`, null, cookie);
  for (let i = 0; i < 24; i++) {
    for (const cookie of posters) {
      const r = await call("POST", `/api/ws/${searchSlug}/channels/general/messages`, { text: `pearl ${i} of ${cookie.slice(-6)}` }, cookie);
      assert.equal(r.res.status, 201, "every seeded message lands");
    }
  }
  await call("POST", `/api/ws/${searchSlug}/channels/random/messages`, { text: "a treasure hidden in another channel" }, searchOwnerCookie);
});

test("search finds matches beyond the latest page, names the channel of each hit, and can go back", async () => {
  const html = await (await fetch(`${base}/w/${searchSlug}`)).text();
  const page = browser(html, { url: `${base}/w/${searchSlug}`, sid: searchOwnerCookie.split("=")[1] });
  const doc = page.document;
  await until(() => doc.querySelector("#log").children.length >= 1, "initial history rendered");

  // search across the workspace: the first page holds 100 of the 120 matches,
  // newest first — already more than the channel view ever shows
  doc.querySelector('#form-search input[name="q"]').value = "pearl";
  doc.querySelector("#form-search").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => doc.querySelector("#search-info").textContent.includes("100 matches"), "first page of matches counted");
  assert.match(doc.querySelector("#search-info").textContent, /older matches load below/);
  assert.ok(
    [...doc.querySelector("#log").querySelectorAll("[data-id]")].every((n) => n.textContent.includes("#general")),
    "each hit shows its channel"
  );

  // page deeper, past what the channel's newest page holds
  doc.querySelector(".load-more").onclick();
  await until(() => doc.querySelector("#log").querySelectorAll("[data-id]").length >= 120, "older matches loaded");

  // a hit in another channel carries that channel's name
  doc.querySelector('#form-search input[name="q"]').value = "treasure";
  doc.querySelector("#form-search").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("#random")), "the random-channel hit names its channel");

  // back to the live channel: the log is the channel again
  doc.querySelector("#search-back").onclick();
  await until(() => doc.querySelector("#search-bar").hidden === true, "search bar hidden");
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("pearl")), "channel history restored");
  page.window.close();
});

test("history renders again after a reload and when switching channels", async () => {
  // a fresh page (what a reload is) renders the channel's stored history,
  // which the API returns as chId rows without a channel name
  const html = await (await fetch(`${base}/w/${searchSlug}`)).text();
  const page = browser(html, { url: `${base}/w/${searchSlug}`, sid: searchOwnerCookie.split("=")[1] });
  const doc = page.document;
  await until(() => doc.querySelector("#log").children.length >= 1, "history after reload");

  // switch to #random and its message renders; switch back and #general's does
  const randomBtn = [...doc.querySelectorAll("#channels button")].find((b) => b.textContent === "#random");
  randomBtn.onclick();
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("treasure")), "random channel history renders after the switch");
  const generalBtn = [...doc.querySelectorAll("#channels button")].find((b) => b.textContent === "#general");
  generalBtn.onclick();
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("pearl")), "general history renders after switching back");
  assert.ok(
    [...doc.querySelector("#log").children].every((n) => !n.textContent.includes("treasure")),
    "the other channel's message does not linger"
  );
  page.window.close();
});

// ---- recovery: gaps, paginated backlogs, and search during catch-up ----
//
// A workspace paid for through the labelled test path, so enough members can
// join to post a backlog of more than one recovery page (200) within the
// per-minute rate limit.
let recSlug, recOwnerCookie;
const recPosters = [];

test("seed: a paid workspace with enough posters to outrun the rate limit", async () => {
  recOwnerCookie = cookieOf((await call("POST", "/api/signup", { handle: "recowner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Recovery Test" }, recOwnerCookie);
  recSlug = ws.body.slug;
  const start = await call("POST", `/api/ws/${recSlug}/pay-test/start`, null, recOwnerCookie);
  receipts.set(TX(90), receiptFor(TX(90), BigInt(LIMITS.PAID_PRICE_USDC) * 10n ** 6n, start.body.recipient));
  const confirm = await call("POST", `/api/ws/${recSlug}/pay-test/confirm`, { intentId: start.body.intentId, txHash: TX(90) }, recOwnerCookie);
  assert.equal(confirm.res.status, 200, "the workspace is on the paid tier so 25 members can join");
  const inv = await call("POST", "/api/invites", { slug: recSlug }, recOwnerCookie);
  for (let i = 0; i < 15; i++) {
    const c = cookieOf((await call("POST", "/api/signup", { handle: `rec${i}`, password: "longenough1" })).res);
    await call("POST", `/api/invites/${inv.body.token}/join`, null, c);
    recPosters.push(c);
  }
  for (let i = 0; i < 2; i++) await postBacklog(1, "baseline");
});

// Posts n messages spread across the member posters; returns the message ids.
async function postBacklog(n, text) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const cookie = recPosters[i % recPosters.length];
    const r = await call("POST", `/api/ws/${recSlug}/channels/general/messages`, { text: `${text} ${i}` }, cookie);
    assert.equal(r.res.status, 201, "every backlog message lands");
    ids.push(r.body.message.id);
  }
  return ids;
}

test("a live event that jumps a gap recovers the missed batch before itself", async () => {
  const oc = cookieOf((await call("POST", "/api/signup", { handle: "gapowner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Gap Test" }, oc);
  const gslug = ws.body.slug;
  await call("POST", `/api/ws/${gslug}/channels/general/messages`, { text: "gap baseline" }, oc);
  const html = await (await fetch(`${base}/w/${gslug}`)).text();
  const page = browser(html, { url: `${base}/w/${gslug}`, sid: oc.split("=")[1] });
  const doc = page.document;
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("gap baseline")), "initial history rendered");

  // Five messages the page never hears about; only the last one arrives
  // live, so ids baseline+1..baseline+4 would be skipped forever if the
  // client recovered from the live event's id instead of its covered cursor.
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await call("POST", `/api/ws/${gslug}/channels/general/messages`, { text: `missed ${i}` }, oc);
    ids.push(r.body.message.id);
  }
  const es = FakeEventSource.last;
  es.emit("message", JSON.stringify({ type: "message", id: ids[4], channel: "general", handle: "gapowner", text: "missed 4", at: new Date().toISOString() }));
  await until(
    () => [...doc.querySelector("#log").children].filter((n) => /missed \d/.test(n.textContent)).length === 5,
    "the whole gap recovered, not just the live tail"
  );
  const logIds = [...doc.querySelector("#log").children].map((n) => Number(n.dataset.id));
  assert.deepEqual(logIds, [...logIds].sort((a, b) => a - b), "messages render in message order");
  assert.equal(new Set(logIds).size, logIds.length, "no duplicates");
  page.window.close();
});

test("live events arriving during paginated recovery merge in order and nothing is lost", async () => {
  const html = await (await fetch(`${base}/w/${recSlug}`)).text();
  const page = browser(html, { url: `${base}/w/${recSlug}`, sid: recOwnerCookie.split("=")[1] });
  const doc = page.document;
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("baseline")), "initial history rendered");

  // A backlog beyond one recovery page (200), then live events emitted while
  // the client is still paginating: they must wait in message order, not
  // jump ahead of the pages still to come.
  const backlog = await postBacklog(210, "backlog");
  const live = [];
  for (let i = 0; i < 3; i++) {
    const r = await call("POST", `/api/ws/${recSlug}/channels/general/messages`, { text: `live during recovery ${i}` }, recOwnerCookie);
    live.push(r.body.message);
  }
  const es = FakeEventSource.last;
  es.open(); // recovery starts: page one, page two…
  es.emit("message", JSON.stringify({ type: "message", id: live[0].id, channel: "general", handle: "recowner", text: live[0].text, at: live[0].at }));
  es.emit("message", JSON.stringify({ type: "message", id: live[2].id, channel: "general", handle: "recowner", text: live[2].text, at: live[2].at }));

  const expected = [...backlog, live[0].id, live[2].id];
  await until(() => {
    const got = [...doc.querySelector("#log").children].map((n) => n.dataset.id);
    return expected.every((id) => got.includes(String(id)));
  }, "every backlog page and every live event rendered");
  const logIds = [...doc.querySelector("#log").children].map((n) => Number(n.dataset.id));
  assert.deepEqual(logIds, [...logIds].sort((a, b) => a - b), "message order kept across the whole recovery");
  assert.equal(new Set(logIds).size, logIds.length, "no duplicates across pages and live events");
  page.window.close();
});

test("catching up on 200+ missed messages while search results are on screen terminates and resumes", async () => {
  const html = await (await fetch(`${base}/w/${recSlug}`)).text();
  const page = browser(html, { url: `${base}/w/${recSlug}`, sid: recOwnerCookie.split("=")[1] });
  const doc = page.document;
  await until(() => doc.querySelector("#log").children.length >= 1, "initial history rendered");

  // Count recovery fetches so a catch-up loop that never advances its cursor
  // cannot hide: the same page fetched forever would grow this without end.
  let historyFetches = 0;
  const inner = page.window.fetch;
  page.window.fetch = (p, opts) => {
    if (typeof p === "string" && p.includes("/messages?after=")) historyFetches++;
    return inner(p, opts);
  };

  // Search view on; the log no longer shows the channel.
  doc.querySelector('#form-search input[name="q"]').value = "needle";
  doc.querySelector("#form-search").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => doc.querySelector("#search-info").textContent.includes("0 match"), "search results on screen");

  // More than a full recovery page is missed while searching, then the
  // stream reopens and a live event arrives — all while search results,
  // not the channel, are displayed.
  await postBacklog(210, "while searching");
  const live = await call("POST", `/api/ws/${recSlug}/channels/general/messages`, { text: "live while searching" }, recOwnerCookie);
  const es = FakeEventSource.last;
  es.open();
  es.emit("message", JSON.stringify({ type: "message", id: live.body.message.id, channel: "general", handle: "recowner", text: live.body.message.text, at: live.body.message.at }));

  // Recovery must terminate: wait until the fetch count stops moving.
  await until(async () => {
    const a = historyFetches;
    await new Promise((r) => setTimeout(r, 300));
    return historyFetches === a && a > 0;
  }, "recovery fetches settle instead of looping");

  // Back to the channel: history re-renders from the server, including the
  // backlog and the live message, and the covered cursor resumes cleanly.
  doc.querySelector("#search-back").onclick();
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("live while searching")), "the channel shows the live message again");
  await until(() => [...doc.querySelector("#log").children].some((n) => n.textContent.includes("while searching 209")), "the oldest of the missed backlog is present too");
  assert.ok(historyFetches < 10, `recovery paginated a bounded number of pages (${historyFetches}), it did not loop`);
  const logIds = [...doc.querySelector("#log").children].map((n) => Number(n.dataset.id));
  assert.deepEqual(logIds, [...logIds].sort((a, b) => a - b), "channel renders in message order after returning");
  assert.equal(new Set(logIds).size, logIds.length, "no duplicates after returning from search");
  page.window.close();
});

test("cleanup: server shuts down", async () => {
  fakeRpc.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
