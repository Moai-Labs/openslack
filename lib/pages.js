// Server-rendered HTML shells. All dynamic behaviour lives in public/app.js.
"use strict";

// Escapes text that the server interpolates into HTML attributes.
const ENTITIES = { 38: "amp", 60: "lt", 62: "gt", 34: "quot", 39: "#39" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => "&" + ENTITIES[c.charCodeAt(0)] + ";");

const head = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>`;

module.exports = {
  home: () =>
    head("OpenSlack — private team chat") +
    `<main id="home" class="home">
  <header class="brand"><h1>OpenSlack</h1><p>Private team chat. Five members free.</p></header>
  <section id="auth" class="card hidden">
    <div class="tabs">
      <button id="tab-signin" class="tab active" type="button">Sign in</button>
      <button id="tab-signup" class="tab" type="button">Create account</button>
    </div>
    <form id="form-signup" class="hidden">
      <label>Handle<input name="handle" autocomplete="username" required placeholder="e.g. sam"></label>
      <label>Password<input name="password" type="password" autocomplete="new-password" required placeholder="8+ characters"></label>
      <p class="hint">Accounts are private: your handle and a password. No wallet, no token needed.</p>
      <button type="submit">Create account</button>
    </form>
    <form id="form-signin" class="hidden">
      <label>Handle<input name="handle" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
    <p id="auth-error" class="error hidden"></p>
  </section>
  <section id="dash" class="card hidden">
    <div class="row"><h2 id="hello"></h2><button id="logout" type="button">Sign out</button></div>
    <h3>Your workspaces</h3>
    <ul id="ws-list" class="ws-list"></ul>
    <h3>Create a workspace</h3>
    <form id="form-ws">
      <label>Workspace name<input name="name" required maxlength="60" placeholder="e.g. Acme Rockets"></label>
      <button type="submit">Create</button>
    </form>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`,

  // The invitation token travels in a data attribute, not an inline script:
  // the server's Content-Security-Policy forbids inline script, and app.js
  // reads the attribute when it boots.
  join: (token) =>
    head("Join a workspace") +
    `<main id="join" class="home" data-token="${escapeHtml(token)}">
  <section class="card">
    <h1>Join a workspace</h1>
    <p id="invite-info">Checking this invitation…</p>
    <div id="join-actions" class="hidden">
      <p id="join-hint"></p>
      <button id="join-btn" type="button">Join</button>
    </div>
    <p id="join-error" class="error hidden"></p>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`,

  chat: (slug) =>
    head(`${slug} — OpenSlack`) +
    `<main id="chat" class="chat" data-slug="${escapeHtml(slug)}">
  <aside class="side">
    <div class="side-head"><strong id="ws-name"></strong><span id="ws-role"></span></div>
    <ul id="channels"></ul>
    <form id="form-channel" class="side-form"><input name="name" placeholder="new-channel" required pattern="[a-z0-9][a-z0-9_-]{0,29}"><button type="submit">+</button></form>
    <h4>Members <span id="member-count"></span></h4>
    <ul id="members"></ul>
    <div class="side-actions">
      <button id="invite-btn" type="button">Invite link</button>
      <a id="export-btn" href="#" hidden>Export history</a>
      <button id="delete-btn" type="button" hidden>Delete workspace</button>
    </div>
    <p id="invite-out" class="hint"></p>
  </aside>
  <section class="msgs">
    <header class="msgs-head"><h2 id="ch-name"></h2><span id="conn" class="conn">connecting…</span></header>
    <div id="log" class="log" aria-live="polite"></div>
    <form id="form-msg" class="composer">
      <textarea name="text" rows="2" maxlength="4000" placeholder="Message #general" required></textarea>
      <button type="submit">Send</button>
    </form>
    <p id="msg-error" class="error hidden"></p>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`
};
