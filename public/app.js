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
// later visit — or the retry button — still resumes it. `report` is called
// with (message, retryable): retryable means the token is still pending and
// trying again may work.
async function resumePendingInvite(report) {
  const token = sessionStorage.getItem("pendingInvite");
  if (!token) return "none";
  try {
    const joined = await api(`/api/invites/${encodeURIComponent(token)}/join`, { method: "POST" });
    sessionStorage.removeItem("pendingInvite");
    location.href = `/w/${joined.slug}`;
    return "joined";
  } catch (err) {
    if (err instanceof TypeError || (err.status >= 500 && err.status < 600)) {
      if (report) report(`We could not complete your invitation just now${err.message ? `: ${err.message}` : ""}. It is saved — try again.`, true);
      return "retry";
    }
    sessionStorage.removeItem("pendingInvite"); // refused: invalid link, full workspace, signed out
    if (report) report(`Your invitation could not be completed: ${err.message}`, false);
    return "refused";
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
    // An invitation followed us through sign-up or sign-in: complete it now,
    // in a place the signed-in visitor can actually see — the auth box with
    // its error line is gone at this point.
    const issue = $("#invite-issue");
    const showIssue = (msg, retryable) => {
      $("#invite-issue-text").textContent = msg;
      $("#invite-retry").hidden = !retryable;
      issue.classList.remove("hidden");
    };
    $("#invite-retry").onclick = async () => {
      $("#invite-retry").disabled = true;
      const state = await resumePendingInvite(showIssue);
      if (state === "joined" || state === "none") issue.classList.add("hidden");
      $("#invite-retry").disabled = false;
    };
    const state = await resumePendingInvite(showIssue);
    if (state === "joined" || state === "none") issue.classList.add("hidden");
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
  let lastId = 0; // last message id shown for the current channel
  let recoverFrom = 0; // everything after this id still has to be fetched and merged
  let recoverRun = 0; // which recovery loop owns the cursor; a new one supersedes it
  let historyGen = 0; // bumped on every switch; stale history responses are dropped
  let channelReady = false; // the current channel's initial history has rendered
  let role = "member";
  let tier = "free";
  let maxMembers = 0;

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
  // While a workspace search is on screen the log holds search results, not
  // the channel, so live messages must not land in it. Recovery that runs
  // during a search still advances its cursors — only the rendering waits.
  let searchView = false;
  const append = (m, channel) => {
    if (searchView || channel !== current) return;
    lastId = Math.max(lastId, Number(m.id)); // even for duplicates: the id is now covered
    if (log.querySelector(`[data-id="${m.id}"]`)) return;
    // Insert in id order: a recovered gap must slot in before newer messages
    // that were already rendered, never after them.
    const node = msgNode(m);
    const id = Number(m.id);
    for (const child of log.children) {
      const cid = Number(child.dataset && child.dataset.id);
      if (Number.isFinite(cid) && cid > id) {
        log.insertBefore(node, child);
        log.scrollTop = log.scrollHeight;
        return;
      }
    }
    log.append(node);
    log.scrollTop = log.scrollHeight;
  };

  // Search results read with their channel: a hit from another channel means
  // little without "#where" next to it.
  const resultNode = (m) => {
    const div = msgNode(m);
    const head = div.firstChild;
    head.insertBefore(el("span", "who", "#" + m.channel + " · "), head.firstChild);
    return div;
  };

  // Workspace-wide search over retained history: every channel, newest first,
  // paging deeper than the first response with the `before` cursor.
  const searchBar = $("#search-bar");
  function exitSearch() {
    if (!searchView) return;
    searchView = false;
    searchBar.hidden = true;
  }

  async function runSearch(query) {
    searchView = true;
    searchBar.hidden = false;
    $("#search-info").textContent = `Searching for “${query}”…`;
    let data;
    try {
      data = await api(`/api/ws/${slug}/search?q=${encodeURIComponent(query)}&limit=100`);
    } catch (err) {
      $("#search-info").textContent = err.message;
      return;
    }
    if (!searchView) return; // the user went back to a channel meanwhile
    log.textContent = "";
    const n = data.messages.length;
    $("#search-info").textContent =
      `${n} match${n === 1 ? "" : "es"} for “${query}” across all channels (newest first)` +
      (n === 100 ? " — older matches load below" : "");
    if (!n) log.append(el("p", "hint", "Nothing retained matches. Search covers everything kept for this workspace, not just the newest page."));
    for (const m of data.messages) log.append(resultNode(m));
    log.scrollTop = 0;

    // Page deeper: the next batch continues below the oldest id shown.
    const addOlder = async (before) => {
      const more = await api(`/api/ws/${slug}/search?q=${encodeURIComponent(query)}&limit=100&before=${before}`);
      if (!searchView) return;
      for (const m of more.messages) log.append(resultNode(m));
      if (more.messages.length === 100) {
        const btn = el("button", "load-more", "Load older matches");
        btn.onclick = () => addOlder(more.messages[more.messages.length - 1].id).catch((err) => setError(err.message));
        log.append(btn);
      }
      return more.messages.length;
    };
    if (n === 100) {
      const btn = el("button", "load-more", "Load older matches");
      btn.onclick = () => addOlder(data.messages[data.messages.length - 1].id).catch((err) => setError(err.message));
      log.append(btn);
    }
  }

  $("#form-search").onsubmit = async (e) => {
    e.preventDefault();
    setError("");
    const q = new FormData(e.target).get("q").trim();
    if (q) await runSearch(q);
  };

  $("#search-back").onclick = () => {
    exitSearch();
    switchChannel(current).catch(() => {});
  };

  async function fetchHistory(channel, after, limit) {
    const q = after != null ? `after=${after}&limit=${limit}` : `limit=${limit}`;
    return api(`/api/ws/${slug}/channels/${encodeURIComponent(channel)}/messages?${q}`);
  }

  // Initial fill: the newest page of the channel's history. History rows carry
  // chId, not a channel name, so the requested channel is bound here and every
  // response is checked against it before rendering.
  async function loadHistory(channel) {
    const gen = ++historyGen;
    channelReady = false;
    const data = await fetchHistory(channel, null, 100);
    if (gen !== historyGen) return; // the user switched channels meanwhile
    for (const m of data.messages) append(m, channel);
    channelReady = true;
    recoverFrom = lastId; // everything up to the newest rendered id is held
    log.scrollTop = log.scrollHeight;
  }

  // Recover everything missed while the stream was down — a live gap or a full
  // outage — oldest first, paginating until the server has nothing left.
  //
  // The cursor is the recovery's own, not the render's: appending a live event
  // that revealed a gap must not move the cursor past the messages inside it,
  // and a search on screen (which defers rendering) must not stall it either.
  // Whether to keep going is decided by the page that just came back, never by
  // the newest locally known id: a full page means more may exist on the
  // server even when nothing newer has been seen locally, so a full page is
  // always followed up, and a short or empty page ends the run. The cursor
  // strictly advances on every non-empty page, so the loop always moves
  // forward and always terminates. A newer recovery supersedes a running one
  // at the next page boundary; the cursor carries over, so no range is skipped.
  function startRecovery(channel, fromId) {
    if (!channelReady) return; // the initial load has not set the cursors yet
    if (fromId != null) recoverFrom = Math.min(recoverFrom, Number(fromId)); // recover from before the gap
    const run = ++recoverRun;
    (async () => {
      for (;;) {
        if (run !== recoverRun || channel !== current) return;
        const data = await fetchHistory(channel, recoverFrom, 200);
        if (run !== recoverRun || channel !== current) return;
        const missed = data.messages || [];
        for (const m of missed) append(m, channel); // rendering defers during a search; the cursor does not
        if (missed.length) {
          recoverFrom = Math.max(recoverFrom, Number(missed[missed.length - 1].id));
          lastId = Math.max(lastId, recoverFrom);
        } else {
          recoverFrom = lastId; // nothing between the cursor and the newest held id
        }
        if (missed.length < 200) return;
      }
    })().catch(() => {}); // a failed page leaves the cursor behind; the next live event or reconnect retries
  }

  async function switchChannel(name) {
    historyGen++; // anything in flight for the old channel is now stale
    recoverRun++; // an old recovery loop stops at its next page boundary
    current = name;
    lastId = 0;
    recoverFrom = 0;
    log.textContent = "";
    exitSearch();
    $("#ch-name").textContent = "#" + name;
    document.querySelectorAll("#channels button").forEach((b) => b.classList.toggle("active", b.textContent === "#" + name));
    await loadHistory(name);
  }

  function connect() {
    conn.textContent = "connecting…"; conn.classList.remove("live");
    const es = new EventSource(`/api/ws/${slug}/stream`);
    es.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type !== "message" || m.channel !== current) return;
      const id = Number(m.id);
      const from = lastId; // recovery must start before any gap this event reveals
      lastId = Math.max(lastId, id); // the id is held now, rendered or not — a search on screen defers rendering, not recovery
      if (id > from + 1) startRecovery(current, from); // fetch everything that was missed in between
      append(m, m.channel);
    });
    es.onopen = () => {
      conn.textContent = "live"; conn.classList.add("live");
      startRecovery(current); // recover anything missed while away
    };
    es.onerror = () => {
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
      $("#invite-out").append(el("div", null, `Anyone with this link and an account can join (${tier} tier: ${maxMembers} members).`));
    } catch (err) { setError(err.message); }
  };

  // Clearly labelled test payment, in two steps: the product shows the exact
  // payment request (test chain, asset, recipient, amount), the owner sends
  // that transfer from any wallet on the test chain, and the product verifies
  // the settled transaction before showing the entitlement. It is never real
  // money and counts as zero revenue; real payments stay blocked.
  $("#pay-test-btn").onclick = async () => {
    const panel = $("#pay-panel");
    setError("");
    try {
      const req = await api(`/api/ws/${slug}/pay-test/start`, { method: "POST" });
      $("#pay-details").textContent =
        `TEST payment — $12 in test-USDC (this is a labelled test, zero revenue; real payments are not accepted yet).\n` +
        `Send exactly ${req.amountUsdc} test-USDC of the USDC contract ${req.asset} on ${req.chainName} (chain id ${req.chainId})\n` +
        `to this request's own payment address ${req.recipient}, then paste the transaction hash below.\n` +
        `Each request gets its own address, so your transfer can only ever pay this request — and only a transfer\n` +
        `sent after the request was created can confirm it.`;
      $("#pay-error").textContent = "";
      $("#pay-tx").value = "";
      $("#pay-tx").dataset.intentId = req.intentId;
      panel.hidden = false;
    } catch (err) {
      setError(err.message);
    }
  };

  $("#pay-cancel").onclick = () => {
    $("#pay-panel").hidden = true;
  };

  $("#form-pay").onsubmit = async (e) => {
    e.preventDefault();
    const errEl = $("#pay-error");
    errEl.textContent = "";
    try {
      await api(`/api/ws/${slug}/pay-test/confirm`, {
        method: "POST",
        body: { intentId: $("#pay-tx").dataset.intentId, txHash: $("#pay-tx").value.trim() }
      });
      $("#pay-panel").hidden = true;
      await loadWs();
    } catch (err) {
      errEl.textContent = err.message; // e.g. not settled yet, wrong amount, already used
    }
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
    tier = info.tier;
    maxMembers = info.maxMembers;
    $("#member-count").textContent = `${info.members.length}/${info.maxMembers}`;
    // The tier is always visible, and the paid tier is always labelled as a
    // test payment — it is never presented as revenue.
    $("#tier-info").textContent =
      info.tier === "paid"
        ? `Paid tier (test payment) — up to ${info.maxMembers} members, 365-day history, through ${new Date(info.paidUntil).toLocaleDateString()}.`
        : `Free tier — up to ${info.maxMembers} members, 30-day history. Real payments are not accepted yet.`;
    const ul = $("#members");
    ul.textContent = "";
    for (const mem of info.members) ul.append(el("li", null, `@${mem.handle} (${mem.role})`));
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
    $("#pay-test-btn").hidden = !isOwner || info.tier === "paid";
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
