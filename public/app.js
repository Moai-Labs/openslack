// OpenSlack client. Plain fetch + EventSource; all rendered text goes through
// textContent so message content is never interpreted as HTML.
"use strict";

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function show(sel, on) {
  $(sel).classList.toggle("hidden", !on);
}

// A pending invitation survives sign-up in sessionStorage. It is cleared only
// once the join succeeded or the server explicitly refused it (invalid link,
// workspace full); a network failure or a server crash keeps it pending so a
// later visit still resumes it.
async function resumePendingInvite(onError) {
  const token = sessionStorage.getItem("pendingInvite");
  if (!token) return false;
  try {
    const joined = await api(`/api/invites/${encodeURIComponent(token)}/join`, { method: "POST" });
    sessionStorage.removeItem("pendingInvite");
    location.href = `/w/${joined.slug}`;
    return true;
  } catch (err) {
    if (err instanceof TypeError || (err.status >= 500 && err.status < 600)) return false; // still pending
    sessionStorage.removeItem("pendingInvite"); // refused: invalid link, full workspace, signed out
    if (onError) onError(`Your invitation could not be completed: ${err.message}`);
    return false;
  }
}

// ---- home page (auth + workspace list) ----

function initHome() {
  const setError = (msg) => { const e = $("#auth-error"); e.textContent = msg || ""; show("#auth-error", !!msg); };

  $("#tab-signin").onclick = () => {
    $("#tab-signin").classList.add("active"); $("#tab-signup").classList.remove("active");
    show("#form-signin", true); show("#form-signup", false);
  };
  $("#tab-signup").onclick = () => {
    $("#tab-signup").classList.add("active"); $("#tab-signin").classList.remove("active");
    show("#form-signup", true); show("#form-signin", false);
  };
  $("#tab-signin").click();

  $("#form-signup").onsubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const f = new FormData(e.target);
      await api("/api/signup", { method: "POST", body: { handle: f.get("handle"), password: f.get("password") } });
      await refresh();
    } catch (err) { setError(err.message); }
  };
  $("#form-signin").onsubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const f = new FormData(e.target);
      await api("/api/login", { method: "POST", body: { handle: f.get("handle"), password: f.get("password") } });
      await refresh();
    } catch (err) { setError(err.message); }
  };
  $("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); location.reload(); };
  $("#form-ws").onsubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const f = new FormData(e.target);
      const ws = await api("/api/workspaces", { method: "POST", body: { name: f.get("name") } });
      location.href = `/w/${ws.slug}`;
    } catch (err) { setError(err.message); }
  };

  async function refresh() {
    const me = await api("/api/me");
    show("#auth", !me.user);
    show("#dash", !!me.user);
    if (!me.user) return;
    $("#hello").textContent = `@${me.user.handle}`;
    // An invitation followed us through sign-up or sign-in: complete it now.
    await resumePendingInvite(setError);
    const list = $("#ws-list");
    list.textContent = "";
    if (!me.workspaces.length) {
      list.append(el("li", "hint", "No workspaces yet — create one below."));
    }
    for (const ws of me.workspaces) {
      const li = el("li"), a = el("a", null, ws.name);
      a.href = `/w/${ws.slug}`;
      li.append(a);
      list.append(li);
    }
  }

  refresh().catch(() => {});
}

// ---- join page ----
// The token is server-rendered into a data attribute (inline script is
// blocked by the site's Content-Security-Policy).

function initJoin() {
  const token = document.querySelector("#join").dataset.token || "";
  api(`/api/invites/${encodeURIComponent(token)}`)
    .then((info) => {
      $("#invite-info").textContent = `You are invited to “${info.workspace.name}”.`;
      show("#join-actions", true);
      $("#join-btn").onclick = async () => {
        try {
          const me = await api("/api/me");
          if (!me.user) {
            sessionStorage.setItem("pendingInvite", token);
            location.href = "/";
            return;
          }
          const joined = await api(`/api/invites/${encodeURIComponent(token)}/join`, { method: "POST" });
          sessionStorage.removeItem("pendingInvite");
          location.href = `/w/${joined.slug}`;
        } catch (err) {
          const e = $("#join-error"); e.textContent = err.message; show("#join-error", true);
          if (err.status === 404 || err.status === 403) sessionStorage.removeItem("pendingInvite");
        }
      };
    })
    .catch((err) => {
      $("#invite-info").textContent = err.message;
      sessionStorage.removeItem("pendingInvite"); // an invalid invitation is dead; do not carry it along
    });
}

// ---- chat page ----

function initChat() {
  const slug = document.querySelector("#chat").dataset.slug;
  let current = "general";
  // The recovery cursor: the highest message id fully accounted for the
  // current channel. It advances only when a message is rendered through
  // accept — which happens only once the cursor is known to be contiguous —
  // or when a fetched history page advances it. A live event that arrives
  // while the cursor is not contiguous (initial history still loading, or a
  // gap open) waits in the buffer and never touches the cursor.
  let cursor = 0;
  let historyGen = 0; // bumped on every switch; stale history responses are dropped
  let channelReady = false; // the current channel's initial history has rendered
  let streamOpen = false; // the SSE transport's state, kept honest for recovery decisions
  let recoveryOwed = false; // the stream may have missed events; no successful catch-up has closed the gap yet
  let recovering = null; // { channel, gen, active } while a catch-up attempt is open or awaiting retry
  let buffer = []; // live events held while the recovery cursor is not yet trustworthy
  let recoveryRetry = null; // timer for the next catch-up attempt after a failure
  let role = "member";

  const conn = $("#conn");
  const setError = (msg) => { const e = $("#msg-error"); e.textContent = msg || ""; show("#msg-error", !!msg); };

  const msgNode = (m) => {
    const div = el("div", "msg");
    const head = el("div");
    head.append(el("span", "who", "@" + (m.handle || "former member")));
    const t = el("span", "when", new Date(m.at).toLocaleString());
    head.append(t);
    div.append(head);
    div.append(el("div", "text", m.text));
    div.dataset.id = m.id;
    return div;
  };

  const log = $("#log");
  const renderRow = (m) => {
    if (log.querySelector(`[data-id="${m.id}"]`)) return false; // duplicate
    log.append(msgNode(m));
    log.scrollTop = log.scrollHeight;
    return true;
  };

  // A live event whose whole past is already accounted for: render it and
  // advance the cursor. Only ever called while the cursor is known to be
  // contiguous — never while events are being buffered.
  const accept = (m) => {
    const id = Number(m.id);
    if (id > cursor) cursor = id;
    renderRow(m);
  };

  // The cursor may only advance over rendered messages, so it is not
  // trustworthy — and live events must wait in the buffer — while
  //   - the channel's initial history has not rendered yet: the cursor comes
  //     from that history, and a live event arriving during the load may be
  //     newer than messages the history response — possibly captured before
  //     a disconnect — never contained, or
  //   - a gap is open: a reconnect was noticed, or a catch-up is in flight
  //     or awaiting retry.
  // Committing such an event would push the cursor past messages the owed
  // recovery has not fetched yet, and they would be skipped for good.
  const buffering = () => !channelReady || recovering || recoveryOwed;
  const ingest = (m) => {
    if (m.channel !== current) return;
    if (buffering()) buffer.push(m);
    else accept(m);
  };

  // Drain the buffer in id order (the stream delivers per-workspace events
  // in id order, so sorting restores the true order). Rows already recovered
  // by a catch-up dedupe here; anything newer than the cursor renders after
  // everything rendered so far.
  const drainBuffered = () => {
    const held = buffer.splice(0).sort((a, b) => Number(a.id) - Number(b.id));
    for (const m of held) accept(m);
  };

  async function fetchHistory(channel, after, limit) {
    const q = after != null ? `after=${after}&limit=${limit}` : `limit=${limit}`;
    return api(`/api/ws/${slug}/channels/${encodeURIComponent(channel)}/messages?${q}`);
  }

  // Initial fill: the newest page of the channel's history. History rows carry
  // chId, not a channel name, so the requested channel is bound here and every
  // response is checked against it before rendering. When a recovery request
  // was made while this history was loading (the stream opened or reopened
  // mid-load), it is executed only now — never skipped.
  async function loadHistory(channel) {
    const gen = ++historyGen;
    channelReady = false;
    const data = await fetchHistory(channel, null, 100);
    if (gen !== historyGen) return; // the user switched channels meanwhile
    for (const m of data.messages || []) {
      if (Number(m.id) > cursor) cursor = Number(m.id);
      renderRow(m);
    }
    channelReady = true;
    log.scrollTop = log.scrollHeight;
    // Owed recovery runs first, from the cursor this history derived — never
    // from a buffered event's id. The buffered events drain only once the gap
    // below them is closed: a failed catch-up leaves them (and the gap) to its
    // retry, so nothing can render ahead of messages still being recovered.
    if (recoveryOwed && streamOpen) {
      await catchUp(channel).catch(() => {});
      if (gen !== historyGen || channel !== current) return; // switched during recovery
    } else {
      drainBuffered();
    }
    log.scrollTop = log.scrollHeight;
  }

  // Catch up on everything missed while the stream was down, oldest first,
  // paginating from the recovery cursor until the server has nothing more.
  // The gap closes only when the whole catch-up succeeded: a failed attempt
  // leaves the cursor and the buffered live events untouched and retries, so
  // no message is ever skipped and no live event can advance past it. Each
  // fetched page advances the cursor itself; live events arriving during the
  // catch-up wait in the buffer and are drained, in id order, on success.
  async function catchUp(channel) {
    if (channel !== current || !channelReady) return;
    if (recovering && recovering.active) return; // one attempt at a time
    const gen = historyGen;
    recovering = { channel, gen, active: true };
    try {
      for (;;) {
        const data = await fetchHistory(channel, cursor, 50);
        if (gen !== historyGen || channel !== current) return;
        const missed = data.messages || [];
        for (const m of missed) {
          const id = Number(m.id);
          if (id > cursor) {
            cursor = id; // the fetched page advances the pagination cursor
            renderRow(m);
          }
        }
        if (missed.length < 50) break;
      }
    } catch (err) {
      // The gap stays open: keep buffering live events and retry shortly.
      recovering = { channel, gen, active: false };
      if (!recoveryRetry) {
        recoveryRetry = setTimeout(() => {
          recoveryRetry = null;
          catchUp(current).catch(() => {});
        }, 1500);
      }
      return;
    }
    // Success is the only path that commits recovery and releases the buffer.
    if (recovering && recovering.channel === channel && recovering.gen === gen && gen === historyGen && channel === current) {
      recovering = null;
      recoveryOwed = false;
      drainBuffered();
    }
  }

  async function switchChannel(name) {
    historyGen++; // anything in flight for the old channel is now stale
    recovering = null;
    if (recoveryRetry) { clearTimeout(recoveryRetry); recoveryRetry = null; }
    current = name;
    cursor = 0;
    buffer = [];
    log.textContent = "";
    $("#ch-name").textContent = "#" + name;
    document.querySelectorAll("#channels button").forEach((b) => b.classList.toggle("active", b.textContent === "#" + name));
    await loadHistory(name);
  }

  function connect() {
    conn.textContent = "connecting…"; conn.classList.remove("live");
    const es = new EventSource(`/api/ws/${slug}/stream`);
    es.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type !== "message") return;
      ingest(m);
    });
    es.onopen = () => {
      const wasOpen = streamOpen;
      streamOpen = true;
      conn.textContent = "live"; conn.classList.add("live");
      if (!wasOpen) {
        // A first connection or a reconnect may have missed events. If the
        // channel's history is still loading, the recovery runs the moment
        // that history has rendered — it is remembered, not skipped.
        recoveryOwed = true;
        if (channelReady) catchUp(current).catch(() => {});
      }
    };
    es.onerror = () => {
      streamOpen = false;
      recoveryOwed = true;
      conn.textContent = "reconnecting…"; conn.classList.remove("live");
      es.close();
      setTimeout(connect, 1500); // EventSource reconnects on its own too; this keeps the label honest
    };
  }

  $("#form-msg").onsubmit = async (e) => {
    e.preventDefault();
    setError("");
    const input = e.target.text;
    const text = input.value;
    input.value = "";
    try {
      await api(`/api/ws/${slug}/channels/${encodeURIComponent(current)}/messages`, { method: "POST", body: { text } });
    } catch (err) {
      input.value = text;
      setError(err.message);
    }
  };

  $("#form-channel").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(e.target);
      await api(`/api/ws/${slug}/channels`, { method: "POST", body: { name: f.get("name") } });
      e.target.reset();
      await loadWs();
      await switchChannel(f.get("name"));
    } catch (err) { setError(err.message); }
  };

  $("#invite-btn").onclick = async () => {
    try {
      const inv = await api("/api/invites", { method: "POST", body: { slug } });
      const out = $("#invite-out");
      out.textContent = inv.url;
      try { await navigator.clipboard.writeText(inv.url); } catch { /* clipboard may be blocked; the link is shown anyway */ }
      $("#invite-out").append(el("div", null, "Anyone with this link and an account can join (free tier: 5 members)."));
    } catch (err) { setError(err.message); }
  };

  $("#delete-btn").onclick = async () => {
    if (!confirm("Delete this workspace and all of its history? This cannot be undone.")) return;
    try {
      await api(`/api/ws/${slug}`, { method: "DELETE" });
      location.href = "/";
    } catch (err) { setError(err.message); }
  };

  async function loadWs() {
    const info = await api(`/api/ws/${slug}`);
    $("#ws-name").textContent = info.name;
    role = info.role;
    $("#ws-role").textContent = info.role;
    $("#member-count").textContent = `${info.members.length}/${info.maxMembers}`;
    const ul = $("#members");
    ul.textContent = "";
    for (const mem of info.members) {
      ul.append(el("li", null, `@${mem.handle} (${mem.role}${mem.pending ? ", awaiting recovery" : ""})`));
    }
    const chans = await api(`/api/ws/${slug}/channels`);
    const list = $("#channels");
    list.textContent = "";
    for (const c of chans.channels) {
      const li = el("li"), b = el("button", null, "#" + c.name);
      b.onclick = () => switchChannel(c.name).catch(() => {});
      li.append(b);
      list.append(li);
    }
    // Owner tools use the HTML hidden attribute, so revealing them means
    // clearing the property itself; a CSS class alone would leave them hidden.
    const isOwner = role === "owner";
    $("#export-btn").hidden = !isOwner;
    $("#delete-btn").hidden = !isOwner;
    if (isOwner) $("#export-btn").href = `/api/ws/${slug}/export`;
  }

  loadWs()
    .then(() => switchChannel("general"))
    .then(connect)
    .catch((err) => {
      log.append(el("p", "error", err.message));
    });
}

// boot
if (document.querySelector("#home")) initHome();
else if (document.querySelector("#join")) initJoin();
else if (document.querySelector("#chat")) initChat();
