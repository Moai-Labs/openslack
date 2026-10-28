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

// fs.writeSync may accept fewer bytes than asked; a partial write here would
// leave a torn record behind, so loop until the whole buffer is out.
function writeAll(fd, data) {
  let off = 0;
  while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
}

// A rename is only durable once the containing directory entry is on disk too.
// Opening a directory read-only and fsyncing it works on Linux, which is the
// deployment platform. A failure is propagated — a directory entry that could
// not be synchronized must not be acknowledged as durable. Only outside
// production, and only for errors that mean "this platform does not fsync
// directories", is the file-level fsync accepted as the best available.
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function fsyncDir(dir) {
  const production = process.env.NODE_ENV === "production";
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
  } catch (err) {
    if (!production && DIR_FSYNC_UNSUPPORTED.has(err.code)) return;
    throw new Error(`could not open the data directory to sync its entries (${dir}): ${err.message}`);
  }
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    if (!production && DIR_FSYNC_UNSUPPORTED.has(err.code)) return; // unsupported platform, dev only
    throw new Error(`could not fsync the data directory ${dir}: ${err.message} — the last metadata replacement is NOT acknowledged as durable`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
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
      this.db = { users: [], sessions: [], workspaces: [], members: [], channels: [], invites: [], nextSeq: 1 };
      this.saveDb();
      this.saveLog([]); // create the log file eagerly so its presence is observable
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

  // Whether a session token is valid right now, WITHOUT refreshing it: SSE
  // streams are re-authenticated with this on every delivery and every
  // heartbeat, and neither may keep an idle session alive past its published
  // lifetime (that is userForToken's job, on real requests only).
  sessionLive(token) {
    if (!token) return false;
    const s = this.db.sessions.find((x) => x.token === token);
    if (!s) return false;
    return (Date.now() - Date.parse(s.lastSeen)) / 86400000 <= LIMITS.SESSION_DAYS;
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
    const ws = { id: uid(), slug, name, ownerId: owner.id, createdAt: nowIso() };
    this.db.workspaces.push(ws);
    this.db.members.push({ wsId: ws.id, userId: owner.id, role: "owner", joinedAt: nowIso() });
    this.db.channels.push({ id: uid(), wsId: ws.id, name: "general", topic: "", createdAt: nowIso() });
    this.saveDb();
    return ws;
  }

  workspaceBySlug(slug) {
    return this.db.workspaces.find((w) => w.slug === slug) || null;
  }

  workspaceById(id) {
    return this.db.workspaces.find((w) => w.id === id) || null;
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
    const rows = this.db.members
      .filter((m) => m.wsId === wsId)
      .map((m) => {
        const u = this.db.users.find((x) => x.id === m.userId);
        return { handle: u ? u.handle : "(left)", role: m.role, joinedAt: m.joinedAt };
      });
    // Pending records are recovered memberships waiting for the
    // administrator's verified attachment. They are part of the workspace's
    // membership record — exports must carry them, or a partially recovered
    // workspace could lose them for good — but they are not members and hold
    // no access.
    const ws = this.db.workspaces.find((w) => w.id === wsId);
    for (const p of (ws && ws.pendingMembers) || []) {
      rows.push({ handle: p.handle, role: p.role, joinedAt: p.joinedAt || null, pending: true });
    }
    return rows;
  }

  joinWorkspace(ws, user) {
    if (this.membership(ws.id, user.id)) return false; // already a member
    if (this.memberCount(ws.id) >= LIMITS.FREE_MAX_MEMBERS) {
      throw new ApiError(403, `This workspace is full: the free tier holds ${LIMITS.FREE_MAX_MEMBERS} members.`);
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

  channelById(id) {
    return this.db.channels.find((c) => c.id === id) || null;
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

  // Enforce the published retention limits for one workspace.
  pruneWorkspace(wsId) {
    const rows = this.messages.filter((m) => m.wsId === wsId);
    const cutoff = Date.now() - LIMITS.RETENTION_DAYS * 86400000;
    let kept = rows.filter((m) => Date.parse(m.at) >= cutoff);
    if (kept.length > LIMITS.MAX_MESSAGES_PER_WORKSPACE) {
      kept = kept.slice(kept.length - LIMITS.MAX_MESSAGES_PER_WORKSPACE);
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
  // supply it. The workspace also records where it came from
  // (`restoredFrom`), so a later attachment run can verify it is really the
  // restored one and not an unrelated workspace that happens to share the
  // slug. Returns the restored workspace.
  restoreExport(exported, { attach = [] } = {}) {
    if (!exported || exported.format !== "openslack-export-v1") {
      throw new ApiError(400, "Not an openslack-export-v1 snapshot.");
    }
    // Validate every mapping before anything is mutated: a conflicting or
    // many-to-one mapping must abort the restore, never half-apply it.
    const seenHandles = new Set();
    const seenUsers = new Set();
    for (const a of attach) {
      if (!a || !a.exportHandle || !a.userId) throw new ApiError(400, "Every attach mapping needs an exportHandle and a userId.");
      if (seenHandles.has(a.exportHandle)) {
        throw new ApiError(400, `Conflicting mapping: @${a.exportHandle} is mapped more than once.`);
      }
      if (seenUsers.has(a.userId)) {
        throw new ApiError(400, `Conflicting mapping: one account is mapped to more than one exported handle.`);
      }
      if (!this.db.users.some((u) => u.id === a.userId)) {
        throw new ApiError(404, `The account mapped to @${a.exportHandle} does not exist in this store.`);
      }
      seenHandles.add(a.exportHandle);
      seenUsers.add(a.userId);
    }
    let slug = exported.workspace.slug;
    if (this.db.workspaces.some((w) => w.slug === slug)) slug = slug + "-restored-" + crypto.randomBytes(2).toString("hex");
    const ws = {
      id: uid(),
      slug,
      name: exported.workspace.name,
      ownerId: null,
      createdAt: exported.workspace.createdAt || nowIso(),
      restoredFrom: {
        slug: exported.workspace.slug,
        name: exported.workspace.name,
        ownerId: exported.workspace.ownerId ?? null,
        createdAt: exported.workspace.createdAt || null,
        exportedAt: exported.exportedAt || null
      }
    };
    const pending = [];
    const attached = new Set();
    for (const m of exported.members) {
      const att = attach.find((a) => a.exportHandle === m.handle);
      if (att && !attached.has(m.handle)) {
        attached.add(m.handle);
        const role = m.role === "owner" && !ws.ownerId ? "owner" : "member";
        if (role === "owner") ws.ownerId = att.userId;
        const existing = this.membership(ws.id, att.userId);
        if (existing) {
          // The account is already a member of the workspace (two exported
          // handles resolved to one verified account). Promote rather than
          // skip: an owner role must end in both ownerId and the membership,
          // never in membership alone — and never downgrade a member.
          if (role === "owner") existing.role = "owner";
        } else {
          this.db.members.push({ wsId: ws.id, userId: att.userId, role, joinedAt: m.joinedAt || nowIso() });
        }
      } else if (!attached.has(m.handle)) {
        // Unattached: kept as a pending record with no access, until the
        // administrator reattaches it to a verified account.
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
    if (!user || !this.db.users.some((u) => u.id === user.id)) {
      throw new ApiError(404, "The account to attach does not exist in this store.");
    }
    // Validate everything before anything is removed: a failed attachment
    // must leave the pending record in place (it survives saves and restarts
    // and can be attached later), never dropped by the failed attempt.
    const existing = this.membership(ws.id, user.id);
    if (!existing && this.memberCount(ws.id) >= LIMITS.FREE_MAX_MEMBERS) {
      throw new ApiError(403, `This workspace is full: the free tier holds ${LIMITS.FREE_MAX_MEMBERS} members.`);
    }
    if (existing) {
      // The account is already a member (it joined by invitation after the
      // restore). The verified identity takes over the exported role: a
      // pending owner becomes the owner in both the membership and ownerId —
      // the workspace must not be left permanently without an owner.
      if (rec.role === "owner" && !ws.ownerId) {
        existing.role = "owner";
        ws.ownerId = user.id;
      }
    } else {
      const role = rec.role === "owner" && !ws.ownerId ? "owner" : "member";
      if (role === "owner") ws.ownerId = user.id;
      this.db.members.push({ wsId: ws.id, userId: user.id, role, joinedAt: rec.joinedAt || nowIso() });
    }
    // Only now is the removal committed, alongside the attachment.
    ws.pendingMembers = pending.filter((p) => p !== rec);
    if (!ws.pendingMembers.length) delete ws.pendingMembers;
    this.saveDb();
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

module.exports = { Store, ApiError, hashPassword, fsyncDir };
