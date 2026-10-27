// Tests for the labelled test-USDC payment path: a $12 test payment grants a
// 30-day paid entitlement (25 members, 365-day retained history). Test
// payments count as zero revenue and real payments stay blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store } from "../lib/store.js";
import LIMITS from "../lib/limits.js";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-pay-"));
  return new Store(dir).init();
}

test("a test payment grants the paid entitlement and counts as zero revenue", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Paid Test");
  assert.equal(s.tier(ws), "free");
  assert.equal(ws.paidUntil, null);

  const result = s.recordTestPayment(ws, a);
  assert.equal(result.kind, "test"); // labelled as a test, never real money
  assert.equal(result.amountUsdc, LIMITS.PAID_PRICE_USDC);
  assert.equal(result.tier, "paid");
  assert.equal(s.tier(ws), "paid");

  const days = (Date.parse(ws.paidUntil) - Date.now()) / 86400000;
  assert.ok(days > LIMITS.PAID_DAYS - 0.01 && days <= LIMITS.PAID_DAYS, "entitlement is 30 days");

  const [rec] = s.paymentHistory(ws.id);
  assert.equal(rec.kind, "test");
  assert.equal(rec.revenue, 0); // zero revenue: no real money moves
  assert.equal(rec.amountUsdc, LIMITS.PAID_PRICE_USDC);
  assert.equal(rec.paidUntil, ws.paidUntil);

  // The entitlement survives a reload (it lives in db.json).
  const s2 = new Store(s.dir).init();
  const ws2 = s2.workspaceBySlug(ws.slug);
  assert.equal(s2.tier(ws2), "paid");
  assert.equal(s2.paymentHistory(ws.id).length, 1);
});

test("only the workspace owner can pay", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const b = s.createUser("bob", "longenough1");
  const ws = s.createWorkspace(a, "Owners Only");
  s.joinWorkspace(ws, b);
  assert.throws(() => s.recordTestPayment(ws, b), (e) => e.status === 403 && /owner/.test(e.message));
  assert.equal(s.tier(ws), "free");
});

test("paying again while the tier is active extends the entitlement", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Stacking");
  s.recordTestPayment(ws, a);
  const first = Date.parse(ws.paidUntil);
  s.recordTestPayment(ws, a);
  const days = (Date.parse(ws.paidUntil) - first) / 86400000;
  assert.ok(days > LIMITS.PAID_DAYS - 0.01 && days <= LIMITS.PAID_DAYS, "extension is 30 days from the current end");
  assert.equal(s.paymentHistory(ws.id).length, 2);
});

test("the paid tier holds 25 members, the free tier 5", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Cap Test");
  const users = [];
  for (let i = 0; i < LIMITS.PAID_MAX_MEMBERS; i++) {
    users.push(s.createUser(`member${i}`, "longenough1"));
  }
  // free tier: full at 5
  for (let i = 0; i < LIMITS.FREE_MAX_MEMBERS - 1; i++) s.joinWorkspace(ws, users[i]);
  assert.throws(() => s.joinWorkspace(ws, users[LIMITS.FREE_MAX_MEMBERS - 1]), /free tier/);

  // pay: the cap rises to 25 and the blocked joiner gets in
  s.recordTestPayment(ws, a);
  assert.equal(s.maxMembers(ws), LIMITS.PAID_MAX_MEMBERS);
  for (let i = LIMITS.FREE_MAX_MEMBERS - 1; i < LIMITS.PAID_MAX_MEMBERS - 1; i++) {
    assert.equal(s.joinWorkspace(ws, users[i]), true);
  }
  assert.equal(s.memberCount(ws.id), LIMITS.PAID_MAX_MEMBERS);
  assert.throws(() => s.joinWorkspace(ws, users[LIMITS.PAID_MAX_MEMBERS - 1]), /paid tier/);

  // expiry returns the workspace to the free tier
  ws.paidUntil = new Date(Date.now() - 1000).toISOString();
  assert.equal(s.tier(ws), "free");
  assert.equal(s.maxMembers(ws), LIMITS.FREE_MAX_MEMBERS);
});

test("paid workspaces keep history longer; free workspaces prune at 30 days", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const free = s.createWorkspace(a, "Free Retention");
  const paid = s.createWorkspace(a, "Paid Retention");
  s.recordTestPayment(paid, a);
  const old = new Date(Date.now() - (LIMITS.RETENTION_DAYS + 10) * 86400000).toISOString(); // beyond free, inside paid
  for (const ws of [free, paid]) {
    const ch = s.channelByName(ws.id, "general");
    const m = s.postMessage(ws, ch, a, "older than the free window");
    m.at = old;
  }
  s.pruneWorkspace(free.id);
  s.pruneWorkspace(paid.id);
  assert.equal(s.messages.some((m) => m.wsId === free.id), false, "free tier prunes beyond 30 days");
  assert.equal(s.messages.some((m) => m.wsId === paid.id), true, "paid tier keeps the same message");
});

// ---- over the API ----

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-pay-api-"));
process.env.PORT = "0";
const server = (await import("../server.js")).default;

const port = await (async () => {
  for (let i = 0; i < 100 && !server.address(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!server.address()) throw new Error("server never started listening");
  return server.address().port;
})();

const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
async function call(method, p, body, cookie) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { res, body: await res.json().catch(() => ({})) };
}

test("the labelled test-payment endpoint verifies in-product, owner only", async () => {
  const owner = cookieOf((await call("POST", "/api/signup", { handle: "owner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Pay API" }, owner);
  const slug = ws.body.slug;

  // anonymous and non-owner calls are rejected
  assert.equal((await call("POST", `/api/ws/${slug}/pay-test`)).res.status, 401);
  const guest = cookieOf((await call("POST", "/api/signup", { handle: "guest", password: "longenough1" })).res);
  assert.equal((await call("POST", `/api/ws/${slug}/pay-test`, null, guest)).res.status, 403);

  // free tier state before paying
  let info = (await call("GET", `/api/ws/${slug}`, null, owner)).body;
  assert.equal(info.tier, "free");
  assert.equal(info.maxMembers, LIMITS.FREE_MAX_MEMBERS);
  assert.equal(info.paidUntil, null);

  // the owner's test payment grants the tier, visibly in the product
  const pay = await call("POST", `/api/ws/${slug}/pay-test`, null, owner);
  assert.equal(pay.res.status, 200);
  assert.equal(pay.body.testPayment, true); // labelled as a test
  assert.equal(pay.body.kind, "test");
  assert.equal(pay.body.tier, "paid");
  assert.equal(pay.body.amountUsdc, LIMITS.PAID_PRICE_USDC);

  info = (await call("GET", `/api/ws/${slug}`, null, owner)).body;
  assert.equal(info.tier, "paid");
  assert.equal(info.maxMembers, LIMITS.PAID_MAX_MEMBERS);
  assert.ok(info.paidUntil);
  const [rec] = info.payments;
  assert.equal(rec.kind, "test");
  assert.equal(rec.revenue, 0); // zero revenue, as published

  // the raised cap is real: 24 more members can join over the API
  const inv = await call("POST", "/api/invites", { slug }, owner);
  for (let i = 0; i < LIMITS.PAID_MAX_MEMBERS - 1; i++) {
    const c = cookieOf((await call("POST", "/api/signup", { handle: `joiner${i}`, password: "longenough1" })).res);
    const r = await call("POST", `/api/invites/${inv.body.token}/join`, null, c);
    assert.equal(r.res.status, 200, `joiner ${i} should fit in the paid tier`);
  }
  const oneMore = cookieOf((await call("POST", "/api/signup", { handle: "onemore", password: "longenough1" })).res);
  const overflow = await call("POST", `/api/invites/${inv.body.token}/join`, null, oneMore);
  assert.equal(overflow.res.status, 403);
});

test("server shuts down cleanly", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
