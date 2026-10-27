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

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
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
      this.loadMessages();
    } else {
      this.db = { users: [], sessions: [], workspaces: [], members: [], channels: [], invites: [], payments: [], nextSeq: 1 };
      this.saveDb();
      this.saveLog([]); // create the log file eagerly so its presence is observable
    }
    this.nextSeq = this.db.nextSeq || 1;
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
      fs.writeFileSync(fd, JSON.stringify(this.db));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.dbPath);
  }

  loadMessages() {
    this.messages = [];
    if (!fs.existsSync(this.logPath)) return;
    const raw = fs.readFileSync(this.logPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        this.messages.push(JSON.parse(line));
      } catch {
        // A torn final line from a crash mid-write is dropped, never fatal.
        continue;
      }
    }
  }

  appendMessage(m) {
    const line = JSON.stringify(m) + "\n";
    const fd = fs.openSync(this.logPath, "a");
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.messages.push(m);
  }

  // Rewrite the log with only the kept messages (retention pruning, deletion).
  saveLog(kept) {
    const tmp = this.logPath + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      for (const m of kept) fs.writeSync(fd, JSON.stringify(m) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.logPath);
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
    // Claim restored workspaces whose owner had no account in this store yet.
    for (const ws of this.db.workspaces) {
      if (!ws.ownerId && ws.ownerHandle === handle) {
        ws.ownerId = user.id;
        delete ws.ownerHandle;
        this.db.members.push({ wsId: ws.id, userId: user.id, role: "owner", joinedAt: nowIso() });
      }
    }
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

  // Record a clearly labelled test-USDC payment and grant PAID_DAYS days of
  // the paid tier. No real money moves and the payment counts as zero
  // revenue; the record exists so the entitlement is auditable.
  recordTestPayment(ws, user) {
    if (this.membership(ws.id, user.id)?.role !== "owner") {
      throw new ApiError(403, "Only the workspace owner can pay for a workspace.");
    }
    const from = ws.paidUntil && Date.parse(ws.paidUntil) > Date.now() ? Date.parse(ws.paidUntil) : Date.now();
    const paidUntil = new Date(from + LIMITS.PAID_DAYS * 86400000).toISOString();
    ws.paidUntil = paidUntil;
    if (!this.db.payments) this.db.payments = [];
    this.db.payments.push({
      id: uid(),
      wsId: ws.id,
      handle: user.handle,
      amountUsdc: LIMITS.PAID_PRICE_USDC,
      kind: "test",
      revenue: 0,
      createdAt: nowIso(),
      paidUntil
    });
    this.saveDb();
    return { tier: this.tier(ws), paidUntil, amountUsdc: LIMITS.PAID_PRICE_USDC, kind: "test" };
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

  // Rebuild a workspace from an export. Members are re-attached by handle to
  // accounts that exist in this store; handles with no account yet are kept as
  // placeholders and become real members when someone signs up with that
  // handle. Returns the restored workspace.
  restoreExport(exported) {
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
      ownerHandle: null,
      createdAt: exported.workspace.createdAt || nowIso(),
      paidUntil: null
    };
    const byHandle = new Map(this.db.users.map((u) => [u.handle, u]));
    for (const m of exported.members) {
      const u = byHandle.get(m.handle);
      if (!u) continue;
      const role = m.role === "owner" && !ws.ownerId ? "owner" : "member";
      if (role === "owner") ws.ownerId = u.id;
      this.db.members.push({ wsId: ws.id, userId: u.id, role, joinedAt: m.joinedAt || nowIso() });
    }
    if (!ws.ownerId) ws.ownerHandle = (exported.members.find((m) => m.role === "owner") || {}).handle || null;
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

  deleteWorkspace(ws) {
    const id = ws.id;
    this.db.workspaces = this.db.workspaces.filter((w) => w.id !== id);
    this.db.members = this.db.members.filter((m) => m.wsId !== id);
    this.db.channels = this.db.channels.filter((c) => c.wsId !== id);
    this.db.invites = this.db.invites.filter((i) => i.wsId !== id);
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
