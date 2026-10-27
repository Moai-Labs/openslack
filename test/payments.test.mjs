// Tests for the labelled test-USDC payment path: an entitlement is granted
// only after a settled on-chain transfer of exactly $12 in test-USDC to the
// workspace's payment address is verified against a JSON-RPC node. The RPC
// here is a local fake that serves scripted receipts, so every branch —
// settled, unsettled, reverted, wrong recipient/amount/asset, replay — is
// deterministic. Test payments count as zero revenue and real payments stay
// blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// The fake RPC the server will be pointed at. Scripted per test below.
let chainId = "0x14a34"; // 84532 = Base Sepolia
let assetCode = "0x6080"; // non-empty: the asset contract exists
let receipts = new Map(); // txHash (lowercase) -> receipt object (or null: not yet mined)
const fakeRpc = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { method, params } = JSON.parse(body);
    let result = null;
    if (method === "eth_chainId") result = chainId;
    else if (method === "eth_getCode") result = assetCode;
    else if (method === "eth_getTransactionReceipt") result = receipts.get(String(params[0]).toLowerCase()) ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
});
await new Promise((resolve) => fakeRpc.listen(0, "127.0.0.1", resolve));
process.env.PAY_RPC_URL = `http://127.0.0.1:${fakeRpc.address().port}`;

// Imported only after the environment points at the fake RPC: limits.js and
// the server read PAY_* once at module load.
const { Store } = await import("../lib/store.js");
const LIMITS = (await import("../lib/limits.js")).default;
const { TRANSFER_TOPIC } = await import("../lib/payments.js");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-pay-"));
  return new Store(dir).init();
}

// A receipt for one ERC-20 Transfer log, shaped the way the live chain's
// receipts look (verified against Base Sepolia; see context evidence file).
function transferReceipt({ txHash, from, to, value = LIMITS.PAID_PRICE_USDC, asset = LIMITS.PAY_USDC_ADDRESS, status = "0x1", topic0 = TRANSFER_TOPIC, amountRaw = null, logIndex = "0x0", removed = false }) {
  const raw = amountRaw ?? (BigInt(value) * 10n ** 6n); // 6 decimals on this asset
  const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().slice(2);
  return {
    blockHash: "0x" + "ab".repeat(32),
    blockNumber: "0x30a3797",
    status,
    logs: [
      {
        address: asset,
        topics: [topic0, pad(from || "0x1111000000000000000000000000000000000001"), pad(to || LIMITS.PAY_RECIPIENT)],
        data: "0x" + raw.toString(16).padStart(64, "0"),
        blockNumber: "0x30a3797",
        logIndex,
        removed,
        transactionHash: txHash
      }
    ]
  };
}

// Unique 64-hex hashes, one per test number (a number-padded construction
// collides: "1" and "31" padded with 3s are the same string).
const TX = (n) => "0x" + String(n).padStart(2, "0") + "0".repeat(62);
const RECIPIENT = LIMITS.PAY_RECIPIENT.toLowerCase();
const ASSET = LIMITS.PAY_USDC_ADDRESS.toLowerCase();

function paidOwner(store, name) {
  const user = store.createUser(name, "longenough1");
  const ws = store.createWorkspace(user, "Paid " + name);
  return { user, ws };
}

// ---- unit level: the store verifies before it grants ----

test("start opens an owner-only payment request bound to the workspace", async () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const b = s.createUser("bob", "longenough1");
  const ws = s.createWorkspace(a, "Start Test");
  s.joinWorkspace(ws, b);
  assert.throws(() => s.startTestPayment(ws, b), (e) => e.status === 403 && /owner/.test(e.message));

  const intent = s.startTestPayment(ws, a);
  assert.equal(intent.kind, "test"); // labelled as a test, never as real money
  assert.equal(intent.wsId, ws.id); // bound to this workspace
  assert.equal(intent.chainId, 84532); // a supported test chain
  assert.equal(intent.asset, ASSET);
  assert.equal(intent.recipient, RECIPIENT);
  assert.equal(intent.amountUsdc, 12);
  assert.equal(intent.amountRaw, "12000000"); // 6 decimals
  assert.ok(Date.parse(intent.expiresAt) > Date.now());
  // the request is persisted, so a restart cannot lose an owner's in-flight payment
  const s2 = new Store(s.dir).init();
  assert.ok(s2.paymentIntent(ws.id, intent.id));
});

test("a verified settled transfer grants the entitlement and counts as zero revenue", async () => {
  const s = freshStore();
  const { user: a, ws } = paidOwner(s, "settled");
  assert.equal(s.tier(ws), "free");
  assert.equal(ws.paidUntil, null);

  const intent = s.startTestPayment(ws, a);
  receipts.set(TX(1), transferReceipt({ txHash: TX(1), to: RECIPIENT }));
  const result = await s.completeTestPayment(ws, a, intent.id, TX(1));
  assert.equal(result.kind, "test");
  assert.equal(result.tier, "paid");
  assert.equal(s.tier(ws), "paid");
  const days = (Date.parse(ws.paidUntil) - Date.now()) / 86400000;
  assert.ok(days > LIMITS.PAID_DAYS - 0.01 && days <= LIMITS.PAID_DAYS, "entitlement is 30 days");

  const [rec] = s.paymentHistory(ws.id);
  assert.equal(rec.kind, "test");
  assert.equal(rec.revenue, 0); // zero revenue: a labelled test, no real money
  assert.equal(rec.amountUsdc, LIMITS.PAID_PRICE_USDC);
  assert.equal(rec.txHash, TX(1)); // the unique identifier is persisted
  assert.equal(rec.paidUntil, ws.paidUntil);

  // The entitlement and its audit trail survive a reload.
  const s2 = new Store(s.dir).init();
  const ws2 = s2.workspaceBySlug(ws.slug);
  assert.equal(s2.tier(ws2), "paid");
  assert.equal(s2.paymentHistory(ws.id).length, 1);
  assert.equal(s2.paymentHistory(ws.id)[0].txHash, TX(1));
});

test("an unsettled, reverted or wrong transfer never grants anything", async () => {
  const s = freshStore();
  const { user: a, ws } = paidOwner(s, "rejects");

  const cases = [
    {
      what: "not yet mined (no receipt)",
      receipt: null,
      tx: TX(10),
      want: 422,
      note: /not settled/
    },
    {
      what: "reverted transaction",
      receipt: transferReceipt({ txHash: TX(11), status: "0x0" }),
      tx: TX(11),
      want: 422,
      note: /reverted/
    },
    {
      what: "wrong recipient",
      receipt: transferReceipt({ txHash: TX(12), to: "0x9999000000000000000000000000000000000999" }),
      tx: TX(12),
      want: 422,
      note: /does not carry/
    },
    {
      what: "wrong amount (11.999999 USDC)",
      receipt: transferReceipt({ txHash: TX(13), amountRaw: 11999999n }),
      tx: TX(13),
      want: 422,
      note: /does not carry/
    },
    {
      what: "wrong asset contract",
      receipt: transferReceipt({ txHash: TX(14), asset: "0x2222000000000000000000000000000000000022" }),
      tx: TX(14),
      want: 422,
      note: /does not carry/
    },
    {
      what: "not a Transfer event",
      receipt: transferReceipt({ txHash: TX(15), topic0: "0x" + "7".repeat(64) }),
      tx: TX(15),
      want: 422,
      note: /does not carry/
    },
    {
      what: "not a transaction hash at all",
      receipt: null,
      tx: "cash-in-an-envelope",
      want: 400,
      note: /transaction hash/
    },
    {
      what: "a log the chain has dropped (reorged away)",
      receipt: transferReceipt({ txHash: TX(16), removed: true }),
      tx: TX(16),
      want: 422,
      note: /does not carry/
    }
  ];

  for (const c of cases) {
    if (c.receipt) receipts.set(c.tx.toLowerCase(), c.receipt);
    else receipts.delete(c.tx.toLowerCase());
  }
  // One open request is enough: a failed verification leaves it payable, so
  // the owner can retry with a correct transaction hash on the same request.
  const intent = s.startTestPayment(ws, a);
  for (const c of cases) {
    await assert.rejects(
      () => s.completeTestPayment(ws, a, intent.id, c.tx),
      (e) => e.status === c.want && c.note.test(e.message),
      c.what
    );
    assert.equal(s.tier(ws), "free", `${c.what}: the tier must stay free`);
    assert.equal(s.paymentHistory(ws.id).length, 0, `${c.what}: no payment record`);
    assert.equal(intent.status, "pending", `${c.what}: the request stays open for a retry`);
  }
});

test("a settled transfer cannot fund a second entitlement (replay)", async () => {
  const s = freshStore();
  const { user: a, ws } = paidOwner(s, "replay");
  receipts.set(TX(20), transferReceipt({ txHash: TX(20), to: RECIPIENT }));

  const intent1 = s.startTestPayment(ws, a);
  await s.completeTestPayment(ws, a, intent1.id, TX(20));
  assert.equal(s.tier(ws), "paid");
  const first = Date.parse(ws.paidUntil);

  // replay on a fresh request, same workspace
  const intent2 = s.startTestPayment(ws, a);
  await assert.rejects(() => s.completeTestPayment(ws, a, intent2.id, TX(20)), (e) => e.status === 409);
  assert.equal(Date.parse(ws.paidUntil), first, "the replayed transfer extends nothing");

  // replay across workspaces, same owner
  const ws2 = s.createWorkspace(a, "Replay Two");
  const intent3 = s.startTestPayment(ws2, a);
  await assert.rejects(() => s.completeTestPayment(ws2, a, intent3.id, TX(20)), (e) => e.status === 409);
  assert.equal(s.tier(ws2), "free");

  // paying again with a different settled transfer stacks 30 more days
  receipts.set(TX(21), transferReceipt({ txHash: TX(21), to: RECIPIENT }));
  const intent4 = s.startTestPayment(ws, a);
  await s.completeTestPayment(ws, a, intent4.id, TX(21));
  const days = (Date.parse(ws.paidUntil) - first) / 86400000;
  assert.ok(days > LIMITS.PAID_DAYS - 0.01 && days <= LIMITS.PAID_DAYS, "a second verified transfer stacks 30 days");
});

test("only the workspace owner can confirm, and only against a live request", async () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const b = s.createUser("bob", "longenough1");
  const ws = s.createWorkspace(a, "Owner Only");
  s.joinWorkspace(ws, b);
  receipts.set(TX(30), transferReceipt({ txHash: TX(30), to: RECIPIENT }));

  const intent = s.startTestPayment(ws, a);
  await assert.rejects(() => s.completeTestPayment(ws, b, intent.id, TX(30)), (e) => e.status === 403);
  assert.equal(s.tier(ws), "free");

  await assert.rejects(() => s.completeTestPayment(ws, a, "no-such-intent", TX(30)), (e) => e.status === 404);
  await assert.rejects(() => s.completeTestPayment(ws, a, intent.id, TX(31)), (e) => e.status === 422, "a hash with no receipt is unsettled, not granted");
  assert.equal(s.tier(ws), "free");

  // an expired request is not payable
  const stale = s.startTestPayment(ws, a);
  stale.expiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(() => s.completeTestPayment(ws, a, stale.id, TX(30)), (e) => e.status === 404);
});

test("a workspace cannot drown in open payment requests", async () => {
  const s = freshStore();
  const { user: a, ws } = paidOwner(s, "intents");
  for (let i = 0; i < LIMITS.MAX_PENDING_PAYMENT_INTENTS; i++) s.startTestPayment(ws, a);
  assert.throws(() => s.startTestPayment(ws, a), (e) => e.status === 429 && /open payment requests/.test(e.message));
});

test("the paid tier holds 25 members, the free tier 5", async () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Cap Test");
  receipts.set(TX(40), transferReceipt({ txHash: TX(40), to: RECIPIENT }));
  const intent = s.startTestPayment(ws, a);

  const users = [];
  for (let i = 0; i < LIMITS.PAID_MAX_MEMBERS; i++) users.push(s.createUser(`member${i}`, "longenough1"));
  // free tier: full at 5
  for (let i = 0; i < LIMITS.FREE_MAX_MEMBERS - 1; i++) s.joinWorkspace(ws, users[i]);
  assert.throws(() => s.joinWorkspace(ws, users[LIMITS.FREE_MAX_MEMBERS - 1]), /free tier/);

  // pay: the cap rises to 25 and the blocked joiner gets in
  await s.completeTestPayment(ws, a, intent.id, TX(40));
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
  receipts.set(TX(41), transferReceipt({ txHash: TX(41), to: RECIPIENT }));
  const intent = s.startTestPayment(paid, a);
  return s.completeTestPayment(paid, a, intent.id, TX(41)).then(() => {
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
});

test("deleting a workspace removes its payment records, in memory and on disk", async () => {
  const s = freshStore();
  const { user: a, ws } = paidOwner(s, "deletion");
  receipts.set(TX(50), transferReceipt({ txHash: TX(50), to: RECIPIENT }));
  const intent = s.startTestPayment(ws, a);
  await s.completeTestPayment(ws, a, intent.id, TX(50));
  assert.equal(s.paymentHistory(ws.id).length, 1);

  s.startTestPayment(ws, a); // an open request must go too
  assert.ok((s.db.paymentIntents || []).some((i) => i.wsId === ws.id));

  s.deleteWorkspace(ws);
  assert.equal(s.paymentHistory(ws.id).length, 0, "payments gone from memory");
  assert.equal((s.db.paymentIntents || []).some((i) => i.wsId === ws.id), false, "open requests gone from memory");
  assert.equal((s.db.payments || []).some((p) => p.wsId === ws.id), false, "no payment row left anywhere");

  const s2 = new Store(s.dir).init(); // and none of it returns after a reload
  assert.equal(s2.db.workspaces.some((w) => w.id === ws.id), false);
  assert.equal((s2.db.payments || []).some((p) => p.wsId === ws.id), false);
  assert.equal((s2.db.paymentIntents || []).some((i) => i.wsId === ws.id), false);
});

// ---- search over retained history ----

test("search finds messages across channels, paginates past the newest page, and stays inside the workspace", async () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Search WS");
  const other = s.createWorkspace(a, "Other WS");
  const general = s.channelByName(ws.id, "general");
  const random = s.createChannel(ws, "random");
  const otherCh = s.channelByName(other.id, "general");

  // 150 matching messages spread over two channels, plus decoys that must not
  // match and a match in the other workspace that must never be returned.
  // (The per-minute rate limit is per user and irrelevant here.)
  for (let i = 0; i < 150; i++) {
    if (i % 25 === 0) s.rateBuckets.clear();
    s.postMessage(ws, i % 2 ? random : general, a, `zebra number ${i} here`);
  }
  s.postMessage(ws, general, a, "nothing to see");
  s.postMessage(other, otherCh, a, "zebra in another workspace");

  const page1 = s.searchMessages(ws.id, "ZEBRA", { limit: 100 }); // case-insensitive
  assert.equal(page1.length, 100, "the newest 100 matches come first");
  assert.ok(Number(page1[0].id) > Number(page1[1].id), "newest first");
  assert.ok(page1.every((r) => r.channel === "general" || r.channel === "random"), "each row names its channel");
  assert.ok(page1.every((r) => r.text.includes("zebra")), "rows are the matches");

  const page2 = s.searchMessages(ws.id, "zebra", { limit: 100, before: page1[page1.length - 1].id });
  assert.equal(page2.length, 50, "the older matches come after the cursor");
  assert.ok(Number(page2[0].id) < Number(page1[page1.length - 1].id), "the cursor keeps pages from overlapping");
  assert.ok(!page2.some((r) => r.channel === "unknown"));

  const ids = [...page1, ...page2].map((r) => r.id);
  assert.equal(new Set(ids).size, 150, "no duplicates across pages, nothing missed");
  assert.ok(!page1.concat(page2).some((r) => r.text.includes("another workspace")), "other workspaces are never searched");

  // member-only and shape-checked at the API level below
  assert.throws(() => s.searchMessages(ws.id, "   "), (e) => e.status === 400);
});

test("search reaches older paid-tier history that the free tier would have pruned", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const free = s.createWorkspace(a, "Free Search");
  const paid = s.createWorkspace(a, "Paid Search");
  receipts.set(TX(70), transferReceipt({ txHash: TX(70), to: RECIPIENT }));
  const intent = s.startTestPayment(paid, a);
  return s.completeTestPayment(paid, a, intent.id, TX(70)).then(async () => {
    const old = new Date(Date.now() - (LIMITS.RETENTION_DAYS + 20) * 86400000).toISOString(); // beyond free, inside paid
    for (const ws of [free, paid]) {
      const ch = s.channelByName(ws.id, "general");
      const m = s.postMessage(ws, ch, a, "ancient needle in the archive");
      m.at = old;
    }
    s.pruneWorkspace(free.id);
    s.pruneWorkspace(paid.id);
    assert.equal(s.searchMessages(free.id, "needle").length, 0, "the free workspace pruned it: nothing to find");
    const hit = s.searchMessages(paid.id, "needle");
    assert.equal(hit.length, 1, "the paid workspace still searches its 365-day history");
    assert.equal(hit[0].channel, "general");
  });
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

test("the two-step test-payment endpoint verifies in-product, owner only", async () => {
  const owner = cookieOf((await call("POST", "/api/signup", { handle: "owner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Pay API" }, owner);
  const slug = ws.body.slug;

  const guest = cookieOf((await call("POST", "/api/signup", { handle: "guest", password: "longenough1" })).res);
  assert.equal((await call("POST", `/api/ws/${slug}/pay-test/start`, null, guest)).res.status, 403);
  assert.equal((await call("POST", `/api/ws/${slug}/pay-test/start`)).res.status, 401);

  // free tier state before paying
  let info = (await call("GET", `/api/ws/${slug}`, null, owner)).body;
  assert.equal(info.tier, "free");
  assert.equal(info.maxMembers, LIMITS.FREE_MAX_MEMBERS);
  assert.equal(info.paidUntil, null);

  // step 1: the request shows exactly what to send, labelled as a test
  const start = await call("POST", `/api/ws/${slug}/pay-test/start`, null, owner);
  assert.equal(start.res.status, 201);
  assert.equal(start.body.testPayment, true);
  assert.equal(start.body.kind, "test");
  assert.equal(start.body.chainId, 84532);
  assert.equal(start.body.chainName, "Base Sepolia");
  assert.equal(start.body.asset, ASSET);
  assert.equal(start.body.recipient, RECIPIENT);
  assert.equal(start.body.amountUsdc, LIMITS.PAID_PRICE_USDC);
  assert.equal(start.body.amountRaw, "12000000");

  // step 2: an unverified hash cannot be confirmed into an entitlement
  const bad = await call("POST", `/api/ws/${slug}/pay-test/confirm`, { intentId: start.body.intentId, txHash: TX(60) }, owner);
  assert.equal(bad.res.status, 422);
  info = (await call("GET", `/api/ws/${slug}`, null, owner)).body;
  assert.equal(info.tier, "free", "an unverified payment grants nothing");

  // the real, settled transfer verifies and grants the tier
  receipts.set(TX(61), transferReceipt({ txHash: TX(61), to: RECIPIENT }));
  const pay = await call("POST", `/api/ws/${slug}/pay-test/confirm`, { intentId: start.body.intentId, txHash: TX(61) }, owner);
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

  // the same transfer cannot be confirmed again on a new request
  const start2 = await call("POST", `/api/ws/${slug}/pay-test/start`, null, owner);
  const replay = await call("POST", `/api/ws/${slug}/pay-test/confirm`, { intentId: start2.body.intentId, txHash: TX(61) }, owner);
  assert.equal(replay.res.status, 409);

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

  // the old one-step grant route is gone: no entitlement without verification
  assert.equal((await call("POST", `/api/ws/${slug}/pay-test`, null, owner)).res.status, 404);
});

test("search over the API: member-only, workspace-scoped, paginated", async () => {
  const owner = cookieOf((await call("POST", "/api/signup", { handle: "sowner", password: "longenough1" })).res);
  const ws = await call("POST", "/api/workspaces", { name: "Search API" }, owner);
  const slug = ws.body.slug;
  const outsider = cookieOf((await call("POST", "/api/signup", { handle: "outsider", password: "longenough1" })).res);

  assert.equal((await call("GET", `/api/ws/${slug}/search?q=x`)).res.status, 401, "anonymous is rejected");
  assert.equal((await call("GET", `/api/ws/${slug}/search?q=x`, null, outsider)).res.status, 403, "non-members are rejected");

  await call("POST", `/api/ws/${slug}/channels/general/messages`, { text: "needle one" }, owner);
  await call("POST", `/api/ws/${slug}/channels`, { name: "random" }, owner);
  await call("POST", `/api/ws/${slug}/channels/random/messages`, { text: "needle two here" }, owner);

  const other = await call("POST", "/api/workspaces", { name: "Elsewhere" }, owner);
  await call("POST", `/api/ws/${other.body.slug}/channels/general/messages`, { text: "needle in another workspace" }, owner);

  const hit = await call("GET", `/api/ws/${slug}/search?q=needle`, null, owner);
  assert.equal(hit.res.status, 200);
  assert.equal(hit.body.messages.length, 2, "only this workspace's messages come back");
  assert.deepEqual(hit.body.messages.map((m) => m.channel).sort(), ["general", "random"], "each hit names its channel");
  assert.ok(hit.body.messages.every((m) => !m.text.includes("another workspace")));

  const empty = await call("GET", `/api/ws/${slug}/search?q=`, null, owner);
  assert.equal(empty.res.status, 400, "an empty term is refused");
});

test("server shuts down cleanly", async () => {
  fakeRpc.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
