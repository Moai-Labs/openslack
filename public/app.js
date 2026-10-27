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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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

// ---- home page (auth + workspace list) ----

function initHome() {
  const auth = $("#auth"), dash = $("#dash");
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

function initJoin() {
  const token = window.__INVITE__;
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
          location.href = `/w/${joined.slug}`;
        } catch (err) {
          const e = $("#join-error"); e.textContent = err.message; show("#join-error", true);
        }
      };
    })
    .catch((err) => {
      $("#invite-info").textContent = err.message;
    });
}

// ---- chat page ----

function initChat() {
  const slug = document.querySelector("#chat").dataset.slug;
  let current = "general";
  let lastId = 0;
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
  const append = (m) => {
    if (m.channel !== current) return;
    if (log.querySelector(`[data-id="${m.id}"]`)) return;
    log.append(msgNode(m));
    lastId = Math.max(lastId, Number(m.id));
    log.scrollTop = log.scrollHeight;
  };

  async function loadHistory(after) {
    const q = after != null ? `?after=${after}&limit=200` : "?limit=100";
    const data = await api(`/api/ws/${slug}/channels/${current}/messages${q}`);
    for (const m of data.messages) append(m);
    if (after == null) log.scrollTop = log.scrollHeight;
  }

  async function switchChannel(name) {
    current = name;
    lastId = 0;
    log.textContent = "";
    $("#ch-name").textContent = "#" + name;
    document.querySelectorAll("#channels button").forEach((b) => b.classList.toggle("active", b.textContent === "#" + name));
    await loadHistory(null);
  }

  function connect() {
    conn.textContent = "connecting…"; conn.classList.remove("live");
    const es = new EventSource(`/api/ws/${slug}/stream`);
    es.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "message") {
        loadHistory(m.id - 1).catch(() => {}); // catch anything missed while away
        append(m);
      }
    });
    es.onopen = () => { conn.textContent = "live"; conn.classList.add("live"); };
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
      await api(`/api/ws/${slug}/channels/${current}/messages`, { method: "POST", body: { text } });
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

  // Clearly labelled test payment: grants the 30-day paid tier but is never
  // real money and counts as zero revenue. Real payments stay blocked.
  $("#pay-test-btn").onclick = async () => {
    if (!confirm("Send a TEST payment of $12 in test-USDC for the 30-day paid tier?\n\nThis is a labelled test: no real money moves and it counts as zero revenue.")) return;
    try {
      await api(`/api/ws/${slug}/pay-test`, { method: "POST" });
      await loadWs();
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
    if (role === "owner") {
      show("#export-btn", true), ($("#export-btn").href = `/api/ws/${slug}/export`), show("#delete-btn", true);
      show("#pay-test-btn", info.tier !== "paid");
    }
  }

  loadWs()
    .then(() => switchChannel("general"))
    .then(connect)
    .catch((err) => {
      log.append(el("p", "error", err.message));
    });

  // An invite followed us through sign-up on the home page.
  const pending = sessionStorage.getItem("pendingInvite");
  if (pending) {
    sessionStorage.removeItem("pendingInvite");
    api(`/api/invites/${encodeURIComponent(pending)}/join`, { method: "POST" })
      .then((j) => { location.href = `/w/${j.slug}`; })
      .catch(() => {});
  }
}

// boot
if (document.querySelector("#home")) initHome();
else if (document.querySelector("#join")) initJoin();
else if (document.querySelector("#chat")) initChat();
