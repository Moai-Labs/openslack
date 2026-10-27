// HTTP layer: routing, auth, JSON body handling, SSE fan-out.
"use strict";

const { ApiError } = require("./store");
const LIMITS = require("./limits");

const COOKIE = "sid";

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > LIMITS.MAX_BODY_BYTES) {
        reject(new ApiError(413, "Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError(400, "Body must be JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store"
  });
  res.end(data);
}

function isHttps(req) {
  return (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || req.socket.encrypted === true;
}

function setSessionCookie(res, token, https) {
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LIMITS.SESSION_DAYS * 86400}${https ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// One API object per running server; it owns the live SSE connections.
class Api {
  constructor(store, baseUrlFor) {
    this.store = store;
    this.baseUrlFor = baseUrlFor || null; // (req) => invite link base
    this.streams = new Set(); // {res, wsId, userId}
  }

  broadcast(wsId, event) {
    const payload = `event: message\ndata: ${JSON.stringify(event)}\n\n`;
    for (const s of this.streams) {
      if (s.wsId !== wsId) continue;
      try {
        s.res.write(payload);
      } catch {
        this.streams.delete(s);
      }
    }
  }

  heartbeat() {
    for (const s of this.streams) {
      try {
        s.res.write(": ping\n\n");
      } catch {
        this.streams.delete(s);
      }
    }
  }

  closeAll() {
    for (const s of this.streams) {
      try {
        s.res.end();
      } catch {
        /* already gone */
      }
    }
    this.streams.clear();
  }

  user(req) {
    return this.store.userForToken(parseCookies(req)[COOKIE] || null);
  }

  // Route an API request. Returns true if handled.
  async handle(req, res, pathname, search) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const method = req.method;
    if (!p.startsWith("/api/") && p !== "/healthz") return false;

    if (p === "/healthz" && method === "GET") {
      sendJson(res, 200, { ok: true, storage: this.store.stats() });
      return true;
    }

    try {
      await this.route(req, res, method, p, url.searchParams);
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error("api error:", err);
        sendJson(res, 500, { error: "Something went wrong." });
      }
    }
    return true;
  }

  requireUser(req) {
    const user = this.user(req);
    if (!user) throw new ApiError(401, "Sign in first.");
    return user;
  }

  workspaceParam(slug) {
    const ws = this.store.workspaceBySlug(slug);
    if (!ws) throw new ApiError(404, "No such workspace.");
    return ws;
  }

  async route(req, res, method, p, q) {
    const store = this.store;

    // ---- auth ----
    if (p === "/api/signup" && method === "POST") {
      const body = await readJson(req);
      const user = store.createUser(body.handle, body.password);
      const token = store.createSession(user.id);
      setSessionCookie(res, token, isHttps(req));
      sendJson(res, 201, { handle: user.handle });
      return;
    }
    if (p === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const user = store.checkPassword(body.handle, body.password);
      if (!user) throw new ApiError(401, "Wrong handle or password.");
      const token = store.createSession(user.id);
      setSessionCookie(res, token, isHttps(req));
      sendJson(res, 200, { handle: user.handle });
      return;
    }
    if (p === "/api/logout" && method === "POST") {
      store.dropSession(parseCookies(req)[COOKIE] || null);
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (p === "/api/me" && method === "GET") {
      const user = this.user(req);
      const workspaces = user
        ? store.db.workspaces
            .filter((w) => store.membership(w.id, user.id))
            .map((w) => ({ slug: w.slug, name: w.name, role: (store.membership(w.id, user.id) || {}).role }))
        : [];
      sendJson(res, 200, { user: user ? { handle: user.handle } : null, workspaces });
      return;
    }

    // ---- workspaces ----
    if (p === "/api/workspaces" && method === "POST") {
      const user = this.requireUser(req);
      const body = await readJson(req);
      const ws = store.createWorkspace(user, body.name);
      sendJson(res, 201, { slug: ws.slug, name: ws.name });
      return;
    }
    if (p === "/api/invites" && method === "POST") {
      const user = this.requireUser(req);
      const body = await readJson(req);
      const ws = this.workspaceParam(body.slug);
      store.requireMembership(ws.id, user);
      const token = store.createInvite(ws, user);
      const base = this.baseUrlFor ? this.baseUrlFor(req) : "";
      sendJson(res, 201, { token, url: `${base}/join/${token}` });
      return;
    }
    if (/^\/api\/invites\/[^/]+$/.test(p) && method === "GET") {
      const inv = store.inviteByToken(p.split("/")[3]);
      if (!inv) throw new ApiError(404, "This invite link is not valid.");
      const ws = store.db.workspaces.find((w) => w.id === inv.wsId);
      if (!ws) throw new ApiError(404, "This invite link is not valid.");
      sendJson(res, 200, { workspace: { name: ws.name, slug: ws.slug, members: store.memberCount(ws.id) } });
      return;
    }
    if (/^\/api\/invites\/[^/]+\/join$/.test(p) && method === "POST") {
      const user = this.requireUser(req);
      const inv = store.inviteByToken(p.split("/")[3]);
      if (!inv) throw new ApiError(404, "This invite link is not valid.");
      const ws = store.db.workspaces.find((w) => w.id === inv.wsId);
      if (!ws) throw new ApiError(404, "This invite link is not valid.");
      store.joinWorkspace(ws, user);
      sendJson(res, 200, { slug: ws.slug, name: ws.name });
      return;
    }
    if (/^\/api\/invites\/[^/]+\/revoke$/.test(p) && method === "POST") {
      const user = this.requireUser(req);
      store.revokeInvite(p.split("/")[3], user);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- per-workspace ----
    let m = p.match(/^\/api\/ws\/([^/]+)(\/.*)?$/);
    if (m) {
      const ws = this.workspaceParam(decodeURIComponent(m[1]));
      const rest = m[2] || "";

      if (rest === "" && method === "GET") {
        store.requireMembership(ws.id, this.requireUser(req));
        sendJson(res, 200, {
          slug: ws.slug,
          name: ws.name,
          role: (store.membership(ws.id, this.user(req).id) || {}).role,
          members: store.workspaceMembers(ws.id),
          maxMembers: LIMITS.FREE_MAX_MEMBERS
        });
        return;
      }
      if (rest === "/export" && method === "GET") {
        const user = this.requireUser(req);
        const mem = store.requireMembership(ws.id, user);
        if (mem.role !== "owner") throw new ApiError(403, "Only the workspace owner can export.");
        const body = JSON.stringify(store.buildExport(ws), null, 2);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${ws.slug}-export.json"`,
          "cache-control": "no-store"
        });
        res.end(body);
        return;
      }
      if (rest === "" && method === "DELETE") {
        const user = this.requireUser(req);
        const mem = store.requireMembership(ws.id, user);
        if (mem.role !== "owner") throw new ApiError(403, "Only the workspace owner can delete it.");
        store.deleteWorkspace(ws);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (rest === "/channels" && method === "GET") {
        store.requireMembership(ws.id, this.requireUser(req));
        sendJson(res, 200, { channels: store.channelsFor(ws.id).map((c) => ({ name: c.name, topic: c.topic })) });
        return;
      }
      if (rest === "/channels" && method === "POST") {
        const user = this.requireUser(req);
        store.requireMembership(ws.id, user);
        const body = await readJson(req);
        const ch = store.createChannel(ws, body.name);
        sendJson(res, 201, { name: ch.name });
        return;
      }

      m = rest.match(/^\/channels\/([^/]+)\/messages$/);
      if (m && method === "GET") {
        const user = this.requireUser(req);
        store.requireMembership(ws.id, user);
        const ch = store.channelByName(ws.id, decodeURIComponent(m[1]));
        if (!ch) throw new ApiError(404, "No such channel.");
        const rows = store.history(ws.id, ch.id, {
          before: q.get("before"),
          after: q.get("after"),
          limit: q.get("limit")
        });
        sendJson(res, 200, { messages: rows });
        return;
      }
      if (m && method === "POST") {
        const user = this.requireUser(req);
        store.requireMembership(ws.id, user);
        const ch = store.channelByName(ws.id, decodeURIComponent(m[1]));
        if (!ch) throw new ApiError(404, "No such channel.");
        const body = await readJson(req);
        const msg = store.postMessage(ws, ch, user, body.text);
        this.broadcast(ws.id, { type: "message", id: msg.id, channel: ch.name, handle: msg.handle, text: msg.text, at: msg.at });
        sendJson(res, 201, { message: msg });
        return;
      }
      if (rest === "/stream" && method === "GET") {
        const user = this.requireUser(req);
        store.requireMembership(ws.id, user);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        res.write(": connected\n\n");
        const stream = { res, wsId: ws.id, userId: user.id };
        this.streams.add(stream);
        req.on("close", () => this.streams.delete(stream));
        return;
      }
    }

    throw new ApiError(404, "No such API route.");
  }
}

module.exports = { Api, parseCookies, sendJson, isHttps, COOKIE };
