// Storage for OpenSlack.
//
// Durability plan: message text lives in an append-only JSONL log that is
// fsync()ed on every write, and all other state in db.json replaced atomically
// (write to a temp file, fsync, rename). Both files live in the data directory,
// which the deploy mounts on a persistent volume (see deploy.json). A killed
// process loses nothing: on restart the store replays the log and prunes to
// the published retention limits. Exports are single JSON snapshots a fresh
// store can be rebuilt from (scripts/restore.js); deletion removes a
// workspace's rows and compacts the log.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const LIMITS = require("./limits");
const { paymentConfig, verifyTransfer } = require("./payments");

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

// fs.writeSync may accept fewer bytes than asked; a partial write here would
// leave a torn record behind, so loop until the whole buffer is out.
function writeAll(fd, data) {
  let off = 0;
  while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
}

// A rename is only durable once the containing directory entry is on disk too.
// Opening a directory read-only and fsyncing it works on Linux; platforms that
// refuse it keep the file-level fsyncs, which is the best they can do.
function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* directory fsync unsupported here */
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.dbPath = path.join(dir, "db.json");
    this.logPath = path.join(dir, "messages.jsonl");
    this.db = null;
    this.messages = []; // [{id, wsId, chId, userId, handle, text, at}]
    this.nextSeq = 1;
    this.rateBuckets = new Map(); // userId -> array of recent timestamps
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.dbPath)) {
      this.db = JSON.parse(fs.readFileSync(this.dbPath, "utf8"));
      this.loadMessages(); // repairs a torn tail before any new write is accepted
    } else {
      this.db = { users: [], sessions: [], workspaces: [], members: [], channels: [], invites: [], payments: [], paymentIntents: [], consumedTransfers: [], nextSeq: 1 };
      this.saveDb();
      this.saveLog([]); // create the log file eagerly so its presence is observable
    }
    // Stores written before replay protection got its own ledger: seed the
    // consumed-transfer ledger from the payment records and settled requests
    // that already exist, so nothing a store granted once can be granted twice.
    if (!Array.isArray(this.db.consumedTransfers)) {
      const seen = new Set();
      this.db.consumedTransfers = [];
      for (const r of [
        ...(this.db.payments || []),
        ...(this.db.paymentIntents || []).filter((i) => i.status === "settled")
      ]) {
        const txHash = (r.txHash || "").toLowerCase();
        if (txHash && !seen.has(txHash)) {
          seen.add(txHash);
          this.db.consumedTransfers.push({ chainId: r.chainId ?? null, txHash, at: r.createdAt || nowIso() });
        }
      }
      this.saveDb();
    }
    // The next id comes from both the persisted metadata and the recovered
    // log: a message appended just before a crash is in the log even when the
    // metadata write that would have recorded its sequence never happened.
    let maxId = 0;
    for (const m of this.messages) {
      const n = Number(m.id);
      if (!Number.isFinite(n)) throw new Error(`message log holds a record with a non-numeric id (${JSON.stringify(m.id)})`);
      if (n > maxId) maxId = n;
    }
    this.nextSeq = Math.max(this.db.nextSeq || 1, maxId + 1);
    this.dropIdleSessions();
    this.prune();
    return this;
  }

  // ---- low-level persistence ----

  saveDb() {
    this.db.nextSeq = this.nextSeq;
    const tmp = this.dbPath + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      writeAll(fd, Buffer.from(JSON.stringify(this.db), "utf8"));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.dbPath);
    fsyncDir(this.dir); // the rename itself must survive a storage-level crash
  }

  loadMessages() {
    this.messages = [];
    if (!fs.existsSync(this.logPath)) return;
    const raw = fs.readFileSync(this.logPath);
    // Everything up to and including the last newline is a complete record.
    // A crash mid-append leaves a shorter torn tail, which is repaired by
    // truncation before any new write is accepted; corruption inside a
    // complete record is unexpected and refuses to start rather than
    // silently dropping acknowledged messages.
    let end = raw.length;
    if (end && raw[end - 1] !== 0x0a) end = raw.lastIndexOf(0x0a) + 1;
    const records = [];
    let offset = 0;
    while (offset < end) {
      const nl = raw.indexOf(0x0a, offset);
      const line = raw.subarray(offset, nl);
      offset = nl + 1;
      if (!line.length) continue;
      let row;
      try {
        row = JSON.parse(line.toString("utf8"));
      } catch (err) {
        throw new Error(`messages log is corrupt at byte ${offset}: ${err.message} — refusing to start on ${this.logPath}`);
      }
      if (!row || typeof row !== "object" || row.id == null || row.wsId == null || row.chId == null) {
        throw new Error(`messages log holds a malformed record at byte ${offset} — refusing to start on ${this.logPath}`);
      }
      records.push(row);
    }
    if (end !== raw.length) {
      fs.truncateSync(this.logPath, end);
      const fd = fs.openSync(this.logPath, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fsyncDir(this.dir);
      console.error(`repaired a torn final record in ${this.logPath} (${raw.length - end} bytes dropped)`);
    }
    this.messages = records;
  }

  appendMessage(m) {
    const data = Buffer.from(JSON.stringify(m) + "\n", "utf8");
    const created = !fs.existsSync(this.logPath);
    const fd = fs.openSync(this.logPath, "a");
    try {
      writeAll(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (created) fsyncDir(this.dir); // a newly created file needs its directory entry on disk
    this.messages.push(m);
  }

  // Rewrite the log with only the kept messages (retention pruning, deletion).
  saveLog(kept) {
    const tmp = this.logPath + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      for (const m of kept) writeAll(fd, Buffer.from(JSON.stringify(m) + "\n", "utf8"));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.logPath);
    fsyncDir(this.dir);
    this.messages = kept;
  }

  // ---- users and sessions ----

  createUser(handle, password) {
    handle = String(handle || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{1,29}$/.test(handle)) {
      throw new ApiError(400, "Handle must be 2-30 chars: letters, digits, dots, dashes or underscores.");
    }
    if (typeof password !== "string" || password.length < LIMITS.MIN_PASSWORD_CHARS) {
      throw new ApiError(400, `Password must be at least ${LIMITS.MIN_PASSWORD_CHARS} characters.`);
    }
    if (this.db.users.some((u) => u.handle === handle)) {
      throw new ApiError(409, "That handle is already taken.");
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const user = { id: uid(), handle, salt, passHash: hashPassword(password, salt), createdAt: nowIso() };
    this.db.users.push(user);
    // Signing up with a handle never grants workspace access: handles are
    // public identifiers, not proof of identity. Restored workspaces wait for
    // the administrator-controlled attachMember() recovery step instead.
    this.saveDb();
    return user;
  }

  checkPassword(handle, password) {
    const user = this.db.users.find((u) => u.handle === String(handle || "").trim().toLowerCase());
    if (!user) return null;
    const candidate = hashPassword(String(password || ""), user.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.passHash, "hex"));
    return ok ? user : null;
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    this.db.sessions.push({ token, userId, createdAt: nowIso(), lastSeen: nowIso() });
    this.saveDb();
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    const s = this.db.sessions.find((x) => x.token === token);
    if (!s) return null;
    const ageDays = (Date.now() - Date.parse(s.lastSeen)) / 86400000;
    if (ageDays > LIMITS.SESSION_DAYS) return null;
    s.lastSeen = nowIso();
    return this.db.users.find((u) => u.id === s.userId) || null;
  }

  dropSession(token) {
    const before = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter((s) => s.token !== token);
    if (this.db.sessions.length !== before) this.saveDb();
  }

  dropIdleSessions() {
    const cutoff = Date.now() - LIMITS.SESSION_DAYS * 86400000;
    const kept = this.db.sessions.filter((s) => Date.parse(s.lastSeen) >= cutoff);
    if (kept.length !== this.db.sessions.length) {
      this.db.sessions = kept;
      this.saveDb();
    }
  }

  // ---- workspaces, members, invites, channels ----

  createWorkspace(owner, name) {
    name = String(name || "").trim();
    if (name.length < 1 || name.length > 60) throw new ApiError(400, "Workspace name must be 1-60 characters.");
    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
    while (this.db.workspaces.some((w) => w.slug === slug)) slug = slug.slice(0, 32) + "-" + crypto.randomBytes(2).toString("hex");
    const ws = { id: uid(), slug, name, ownerId: owner.id, createdAt: nowIso(), paidUntil: null };
    this.db.workspaces.push(ws);
    this.db.members.push({ wsId: ws.id, userId: owner.id, role: "owner", joinedAt: nowIso() });
    this.db.channels.push({ id: uid(), wsId: ws.id, name: "general", topic: "", createdAt: nowIso() });
    this.saveDb();
    return ws;
  }

  workspaceBySlug(slug) {
    return this.db.workspaces.find((w) => w.slug === slug) || null;
  }

  // The tier a workspace is on right now: "paid" only while its entitlement
  // (granted by a labelled test-USDC payment) is live, "free" otherwise.
  tier(ws) {
    return ws.paidUntil && Date.parse(ws.paidUntil) > Date.now() ? "paid" : "free";
  }

  maxMembers(ws) {
    return this.tier(ws) === "paid" ? LIMITS.PAID_MAX_MEMBERS : LIMITS.FREE_MAX_MEMBERS;
  }

  // ---- labelled test-USDC payments ----
  //
  // Two steps, both owner-only. startTestPayment() opens a payment request
  // bound to this workspace; completeTestPayment() grants the tier only after
  // lib/payments.js has verified a settled on-chain transfer — chain, asset,
  // recipient, exact amount, settled after the request was created — against a
  // public test-chain node. Each open request carries its own unique amount
  // (the $12 price plus a distinct sub-cent fraction), so a transfer is bound
  // on-chain to exactly one request: a transfer meant for one workspace can
  // never fund another, and no transfer sent before the request existed can
  // confirm it. The verified transaction hash is recorded in a consumed-
  // transfer ledger that is independent of workspace records, so replaying it
  // cannot grant anything more — not even after the workspace is deleted.
  // Every record is kind "test" with revenue 0; real payments stay blocked.

  startTestPayment(ws, user) {
    if (this.membership(ws.id, user.id)?.role !== "owner") {
      throw new ApiError(403, "Only the workspace owner can pay for a workspace.");
    }
    if (!this.db.paymentIntents) this.db.paymentIntents = [];
    const pending = this.db.paymentIntents.filter(
      (i) => i.wsId === ws.id && i.status === "pending" && Date.parse(i.expiresAt) > Date.now()
    );
    if (pending.length >= LIMITS.MAX_PENDING_PAYMENT_INTENTS) {
      throw new ApiError(429, "This workspace already has open payment requests. Use one of them before starting another.");
    }
    const cfg = paymentConfig(); // refuses outright unless the chain is a supported test chain
    // This request's unique amount: the price plus a distinct fraction no other
    // open request holds, so the transfer that satisfies it can only ever be
    // claimed for this request, in this workspace.
    const pendingAnywhere = this.db.paymentIntents.filter(
      (i) => i.status === "pending" && Date.parse(i.expiresAt) > Date.now() && i.chainId === cfg.chainId
    );
    const taken = new Set(pendingAnywhere.map((i) => i.cents));
    let cents = null;
    for (let c = 1; c <= LIMITS.PAYMENT_CENTS_RANGE; c++) {
      if (!taken.has(c)) { cents = c; break; }
    }
    if (cents == null) {
      throw new ApiError(503, "Every payment amount is in use by an open request right now. Wait for one to expire or be confirmed, then try again.");
    }
    const intent = {
      id: uid(),
      wsId: ws.id,
      handle: user.handle,
      status: "pending",
      kind: "test",
      chainId: cfg.chainId,
      chainName: cfg.chainName,
      asset: cfg.asset,
      recipient: cfg.recipient,
      amountUsdc: cfg.amountUsdc,
      cents, // the unique fraction that binds a transfer to this request
      amountRaw: (BigInt(cfg.amountRaw) + BigInt(cents)).toString(),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + LIMITS.PAYMENT_INTENT_TTL_MINUTES * 60000).toISOString()
    };
    this.db.paymentIntents.push(intent);
    this.saveDb();
    return intent;
  }

  paymentIntent(wsId, intentId) {
    return (
      (this.db.paymentIntents || []).find(
        (i) => i.id === intentId && i.wsId === wsId && i.status === "pending" && Date.parse(i.expiresAt) > Date.now()
      ) || null
    );
  }

  // Whether this chain has already seen this transaction fund a payment. The
  // ledger is keyed by chain and transaction hash — not by block position,
  // which a reorg can change without changing the transaction — and lives
  // outside the per-workspace payment records, so deleting a workspace cannot
  // make its transfers spendable again.
  transferConsumed(chainId, txHash) {
    const hash = String(txHash || "").toLowerCase();
    return (this.db.consumedTransfers || []).some(
      (t) => t.txHash === hash && (t.chainId == null || chainId == null || t.chainId === chainId)
    );
  }

  async completeTestPayment(ws, user, intentId, txHash) {
    if (this.membership(ws.id, user.id)?.role !== "owner") {
      throw new ApiError(403, "Only the workspace owner can pay for a workspace.");
    }
    if (!this.db.payments) this.db.payments = [];
    const intent = this.paymentIntent(ws.id, String(intentId || ""));
    if (!intent) throw new ApiError(404, "No open payment request like that — start a new one.");
    txHash = String(txHash || "").trim().toLowerCase();
    if (this.transferConsumed(intent.chainId, txHash)) {
      throw new ApiError(409, "That transaction was already used for a payment; each transfer can fund one entitlement only.");
    }

    // The slow part: settlement, asset, recipient, the request's unique amount
    // and the transfer's recency are all verified on-chain.
    const verified = await verifyTransfer({
      txHash,
      asset: intent.asset,
      recipient: intent.recipient,
      amountRaw: intent.amountRaw,
      chainId: intent.chainId,
      rpcUrl: LIMITS.PAY_RPC_URL,
      notBefore: intent.createdAt
    });

    // ---- commit section: synchronous, no await below this line ----
    // Anything could have changed while the chain was consulted: re-fetch the
    // live workspace, the owner's membership and the still-open request, and
    // consume the request and record the transfer as one indivisible step. Two
    // concurrent confirmations — or a confirmation racing a workspace
    // deletion — meet here, and exactly one outcome is possible.
    const live = this.db.workspaces.find((w) => w.id === ws.id);
    if (!live) throw new ApiError(410, "This workspace was deleted while the payment was being verified; nothing was granted.");
    if (this.membership(live.id, user.id)?.role !== "owner") {
      throw new ApiError(403, "Only the workspace owner can pay for a workspace.");
    }
    const liveIntent = this.paymentIntent(live.id, String(intentId || ""));
    if (!liveIntent) throw new ApiError(409, "This payment request is no longer open — it may have been confirmed or expired. Start a new one.");
    if (this.transferConsumed(liveIntent.chainId, verified.txHash)) {
      throw new ApiError(409, "That transaction was already used for a payment; each transfer can fund one entitlement only.");
    }

    const from = live.paidUntil && Date.parse(live.paidUntil) > Date.now() ? Date.parse(live.paidUntil) : Date.now();
    const paidUntil = new Date(from + LIMITS.PAID_DAYS * 86400000).toISOString();
    live.paidUntil = paidUntil;
    liveIntent.status = "settled";
    liveIntent.txHash = verified.txHash;
    liveIntent.blockNumber = verified.blockNumber;
    liveIntent.logIndex = verified.logIndex;
    liveIntent.settledAt = verified.settledAt;
    this.db.consumedTransfers.push({ chainId: liveIntent.chainId, txHash: verified.txHash, at: nowIso() });
    this.db.payments.push({
      id: liveIntent.id,
      wsId: live.id,
      handle: user.handle,
      txHash: verified.txHash,
      chainId: liveIntent.chainId,
      blockNumber: verified.blockNumber,
      logIndex: verified.logIndex,
      settledAt: verified.settledAt,
      from: verified.from,
      amountRaw: liveIntent.amountRaw,
      amountUsdc: liveIntent.amountUsdc,
      kind: "test",
      revenue: 0, // labelled test: never revenue, no real money moves
      createdAt: nowIso(),
      paidUntil
    });
    this.saveDb();
    return { tier: this.tier(live), paidUntil, amountUsdc: liveIntent.amountUsdc, kind: "test", txHash: verified.txHash };
  }

  paymentHistory(wsId) {
    return (this.db.payments || []).filter((p) => p.wsId === wsId);
  }

  membership(wsId, userId) {
    return this.db.members.find((m) => m.wsId === wsId && m.userId === userId) || null;
  }

  requireMembership(wsId, user) {
    if (!user) throw new ApiError(401, "Sign in first.");
    const m = this.membership(wsId, user.id);
    if (!m) throw new ApiError(403, "You are not a member of this workspace.");
    return m;
  }

  memberCount(wsId) {
    return this.db.members.filter((m) => m.wsId === wsId).length;
  }

  workspaceMembers(wsId) {
    return this.db.members
      .filter((m) => m.wsId === wsId)
      .map((m) => {
        const u = this.db.users.find((x) => x.id === m.userId);
        return { handle: u ? u.handle : "(left)", role: m.role, joinedAt: m.joinedAt };
      });
  }

  joinWorkspace(ws, user) {
    if (this.membership(ws.id, user.id)) return false; // already a member
    const max = this.maxMembers(ws);
    if (this.memberCount(ws.id) >= max) {
      throw new ApiError(
        403,
        this.tier(ws) === "paid"
          ? `This workspace is full: the paid tier holds ${max} members.`
          : `This workspace is full: the free tier holds ${max} members.`
      );
    }
    this.db.members.push({ wsId: ws.id, userId: user.id, role: "member", joinedAt: nowIso() });
    this.saveDb();
    return true;
  }

  createInvite(ws, user) {
    const token = crypto.randomBytes(12).toString("base64url");
    this.db.invites.push({ token, wsId: ws.id, createdBy: user.id, createdAt: nowIso(), revoked: false });
    this.saveDb();
    return token;
  }

  inviteByToken(token) {
    return this.db.invites.find((i) => i.token === token && !i.revoked) || null;
  }

  revokeInvite(token, user) {
    const inv = this.db.invites.find((i) => i.token === token);
    if (!inv) throw new ApiError(404, "No such invite.");
    const ws = this.db.workspaces.find((w) => w.id === inv.wsId);
    this.requireMembership(inv.wsId, user);
    if (ws.ownerId !== user.id) throw new ApiError(403, "Only the workspace owner can revoke invites.");
    inv.revoked = true;
    this.saveDb();
  }

  channelsFor(wsId) {
    return this.db.channels.filter((c) => c.wsId === wsId);
  }

  channelByName(wsId, name) {
    return this.db.channels.find((c) => c.wsId === wsId && c.name === name) || null;
  }

  createChannel(ws, name) {
    name = String(name || "").trim().toLowerCase().replace(/^#/, "");
    if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(name)) {
      throw new ApiError(400, "Channel names are lowercase letters, digits, dashes or underscores (max 30).");
    }
    if (this.channelByName(ws.id, name)) throw new ApiError(409, "That channel already exists.");
    if (this.channelsFor(ws.id).length >= LIMITS.MAX_CHANNELS_PER_WORKSPACE) {
      throw new ApiError(403, "This workspace has reached its channel limit.");
    }
    const ch = { id: uid(), wsId: ws.id, name, topic: "", createdAt: nowIso() };
    this.db.channels.push(ch);
    this.saveDb();
    return ch;
  }

  // ---- messages ----

  rateLimited(userId) {
    const now = Date.now();
    const bucket = (this.rateBuckets.get(userId) || []).filter((t) => now - t < 60000);
    if (bucket.length >= LIMITS.RATE_LIMIT_PER_MINUTE) {
      this.rateBuckets.set(userId, bucket);
      return true;
    }
    bucket.push(now);
    this.rateBuckets.set(userId, bucket);
    return false;
  }

  postMessage(ws, ch, user, text) {
    text = String(text || "");
    if (!text.trim()) throw new ApiError(400, "Message text is required.");
    if (text.length > LIMITS.MAX_MESSAGE_CHARS) {
      throw new ApiError(400, `Messages are limited to ${LIMITS.MAX_MESSAGE_CHARS} characters.`);
    }
    if (this.rateLimited(user.id)) throw new ApiError(429, "Slow down: at most 30 messages per minute.");
    const m = {
      id: String(this.nextSeq++),
      wsId: ws.id,
      chId: ch.id,
      userId: user.id,
      handle: user.handle,
      text,
      at: nowIso()
    };
    this.appendMessage(m); // fsynced before the write is acknowledged
    this.pruneWorkspace(ws.id);
    return m;
  }

  history(wsId, chId, { before, after, limit }) {
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    let rows = this.messages.filter((m) => m.wsId === wsId && m.chId === chId);
    if (before != null) rows = rows.filter((m) => Number(m.id) < Number(before));
    if (after != null) rows = rows.filter((m) => Number(m.id) > Number(after));
    rows.sort((a, b) => Number(a.id) - Number(b.id));
    if (after == null) rows = rows.slice(-limit);
    else rows = rows.slice(0, limit);
    return rows;
  }

  // Workspace-wide message search over everything retained for this
  // workspace — not just the latest page of one channel. Rows come back
  // newest-first with their channel name attached, paginated by `before`
  // (return only messages with a lower id), so a client can page deeper into
  // history. A workspace's rows only ever come from its own wsId.
  searchMessages(wsId, query, { before, limit } = {}) {
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const q = String(query || "").trim().toLowerCase();
    if (!q) throw new ApiError(400, "A search term is required.");
    const channelNames = new Map(this.channelsFor(wsId).map((c) => [c.id, c.name]));
    let rows = this.messages.filter(
      (m) => m.wsId === wsId && (m.text || "").toLowerCase().includes(q)
    );
    if (before != null) rows = rows.filter((m) => Number(m.id) < Number(before));
    rows.sort((a, b) => Number(b.id) - Number(a.id)); // newest first
    rows = rows.slice(0, limit);
    return rows.map((m) => ({
      id: m.id,
      channel: channelNames.get(m.chId) || "unknown",
      handle: m.handle,
      text: m.text,
      at: m.at
    }));
  }

  // Enforce the published retention limits for one workspace. Paid
  // workspaces keep their history searchable much longer.
  pruneWorkspace(wsId) {
    const ws = this.db.workspaces.find((w) => w.id === wsId);
    const paid = ws && this.tier(ws) === "paid";
    const retentionDays = paid ? LIMITS.PAID_RETENTION_DAYS : LIMITS.RETENTION_DAYS;
    const maxMessages = paid ? LIMITS.PAID_MAX_MESSAGES_PER_WORKSPACE : LIMITS.MAX_MESSAGES_PER_WORKSPACE;
    const rows = this.messages.filter((m) => m.wsId === wsId);
    const cutoff = Date.now() - retentionDays * 86400000;
    let kept = rows.filter((m) => Date.parse(m.at) >= cutoff);
    if (kept.length > maxMessages) {
      kept = kept.slice(kept.length - maxMessages);
    }
    while (kept.length && kept.reduce((n, m) => n + m.text.length, 0) > LIMITS.MAX_STORAGE_CHARS_PER_WORKSPACE) {
      kept.shift();
    }
    if (kept.length !== rows.length) {
      const rest = this.messages.filter((m) => m.wsId !== wsId);
      const all = rest.concat(kept).sort((a, b) => Number(a.id) - Number(b.id));
      this.saveLog(all);
      return rows.length - kept.length;
    }
    return 0;
  }

  prune() {
    let dropped = 0;
    for (const ws of this.db.workspaces) dropped += this.pruneWorkspace(ws.id);
    // Messages whose workspace no longer exists (e.g. an interrupted deletion).
    const known = new Set(this.db.workspaces.map((w) => w.id));
    const orphaned = this.messages.filter((m) => !known.has(m.wsId));
    if (orphaned.length) {
      this.saveLog(this.messages.filter((m) => known.has(m.wsId)));
      dropped += orphaned.length;
    }
    return dropped;
  }

  // ---- export, restore, deletion ----

  buildExport(ws) {
    return {
      format: "openslack-export-v1",
      exportedAt: nowIso(),
      workspace: { slug: ws.slug, name: ws.name, ownerId: ws.ownerId, createdAt: ws.createdAt },
      members: this.workspaceMembers(ws.id),
      channels: this.channelsFor(ws.id).map((c) => ({ name: c.name, topic: c.topic, createdAt: c.createdAt })),
      messages: this.messages
        .filter((m) => m.wsId === ws.id)
        .map((m) => ({ id: m.id, channel: (this.db.channels.find((c) => c.id === m.chId) || {}).name, handle: m.handle, text: m.text, at: m.at }))
    };
  }

  // Rebuild a workspace from an export.
  //
  // Members are NOT re-attached by handle: a handle is a public identifier,
  // not proof of identity, so matching one would hand the workspace — and its
  // private history — to whoever registered the handle first. Every exported
  // member is kept as a pending record on the workspace until the
  // administrator reattaches it with attachMember() to an account they have
  // verified out of band. `attach` is the administrator's verified mapping,
  // [{ exportHandle, userId }], passed by scripts/restore.js; nothing else may
  // supply it. Returns the restored workspace.
  restoreExport(exported, { attach = [] } = {}) {
    if (!exported || exported.format !== "openslack-export-v1") {
      throw new ApiError(400, "Not an openslack-export-v1 snapshot.");
    }
    let slug = exported.workspace.slug;
    if (this.db.workspaces.some((w) => w.slug === slug)) slug = slug + "-restored-" + crypto.randomBytes(2).toString("hex");
    const ws = {
      id: uid(),
      slug,
      name: exported.workspace.name,
      ownerId: null,
      createdAt: exported.workspace.createdAt || nowIso(),
      paidUntil: null // a restored workspace starts free; exports carry no entitlement
    };
    const pending = [];
    for (const m of exported.members) {
      const att = attach.find((a) => a.exportHandle === m.handle && this.db.users.some((u) => u.id === a.userId));
      if (att) {
        const role = m.role === "owner" && !ws.ownerId ? "owner" : "member";
        if (role === "owner") ws.ownerId = att.userId;
        if (!this.membership(ws.id, att.userId)) {
          this.db.members.push({ wsId: ws.id, userId: att.userId, role, joinedAt: m.joinedAt || nowIso() });
        }
      } else {
        pending.push({ handle: m.handle, role: m.role, joinedAt: m.joinedAt || null });
      }
    }
    if (pending.length) ws.pendingMembers = pending;
    this.db.workspaces.push(ws);

    const chIds = new Map();
    for (const c of exported.channels) {
      const ch = { id: uid(), wsId: ws.id, name: c.name, topic: c.topic || "", createdAt: c.createdAt || nowIso() };
      this.db.channels.push(ch);
      chIds.set(c.name, ch.id);
    }
    if (!chIds.size) chIds.set("general", (() => {
      const ch = { id: uid(), wsId: ws.id, name: "general", topic: "", createdAt: nowIso() };
      this.db.channels.push(ch);
      return ch.id;
    })());

    const restored = [];
    for (const m of exported.messages) {
      const chId = chIds.get(m.channel) || chIds.get("general");
      const row = { id: m.id, wsId: ws.id, chId, userId: null, handle: m.handle, text: m.text, at: m.at };
      restored.push(row);
    }
    restored.sort((a, b) => Number(a.id) - Number(b.id));
    for (const m of restored) this.appendMessage(m);
    for (const m of restored) if (Number(m.id) >= this.nextSeq) this.nextSeq = Number(m.id) + 1;
    this.saveDb();
    return ws;
  }

  // Administrator-controlled membership recovery: reattach a pending exported
  // member to a verified account in this store. This is never reachable over
  // the HTTP API — the operator runs it through scripts/restore.js after
  // verifying, out of band, that the account belongs to that person.
  attachMember(ws, exportHandle, user) {
    const pending = ws.pendingMembers || [];
    const rec = pending.find((p) => p.handle === exportHandle);
    if (!rec) throw new ApiError(404, `No pending member @${exportHandle} on this workspace.`);
    ws.pendingMembers = pending.filter((p) => p !== rec);
    if (!ws.pendingMembers.length) delete ws.pendingMembers;
    if (this.membership(ws.id, user.id)) {
      this.saveDb(); // already a member; only the pending record goes
      return;
    }
    if (this.memberCount(ws.id) >= LIMITS.FREE_MAX_MEMBERS) {
      throw new ApiError(403, `This workspace is full: the free tier holds ${LIMITS.FREE_MAX_MEMBERS} members.`);
    }
    const role = rec.role === "owner" && !ws.ownerId ? "owner" : "member";
    if (role === "owner") ws.ownerId = user.id;
    this.db.members.push({ wsId: ws.id, userId: user.id, role, joinedAt: rec.joinedAt || nowIso() });
    this.saveDb();
  }

  deleteWorkspace(ws) {
    const id = ws.id;
    this.db.workspaces = this.db.workspaces.filter((w) => w.id !== id);
    this.db.members = this.db.members.filter((m) => m.wsId !== id);
    this.db.channels = this.db.channels.filter((c) => c.wsId !== id);
    this.db.invites = this.db.invites.filter((i) => i.wsId !== id);
    // Payment records carry the payer's handle; deleting the workspace
    // deletes them, in memory and on disk. The consumed-transfer ledger is
    // deliberately not touched: it names no person and no workspace, and it is
    // what stops a deleted workspace's transfers from funding another one.
    this.db.payments = (this.db.payments || []).filter((p) => p.wsId !== id);
    this.db.paymentIntents = (this.db.paymentIntents || []).filter((i) => i.wsId !== id);
    this.saveLog(this.messages.filter((m) => m.wsId !== id));
    this.saveDb();
  }

  stats() {
    return {
      users: this.db.users.length,
      workspaces: this.db.workspaces.length,
      messages: this.messages.length,
      dataDir: this.dir
    };
  }
}

module.exports = { Store, ApiError, hashPassword };
