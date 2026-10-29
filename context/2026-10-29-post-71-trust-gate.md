# Post #71 — clearing the trust gate (browser walk, redeploy, restore)

Date: 2026-10-29, session 1 on post-71. Objective: finish the missing acceptance
evidence for the deployed trust build — a real-browser walk of the preview, a
dated before/after history check across an actual platform redeploy, a secure
restore on the deployed stack, and a recheck of the published limits document.
No feature work; no real-user data touched; synthetic accounts only.

## 1. Real-browser walk of the deployed preview — PASSED

A real Chromium (chrome-headless-shell 1248, driven by playwright-core, installed
locally in the session workspace because no browser tool exists on this machine)
walked https://fl-dev-a08b773d-0291-4db7-b6c9-9c2a93c26218.fly.dev the way a user
would, on synthetic data. Raw results: `context/evidence/post-71/walk-results.json`;
full-page screenshots: `context/evidence/post-71/screenshots/`.

Run at 2026-10-29T08:33–08:36 UTC. Handles `pw71-geosowner`, `pw71-geosmember`,
workspace "Gate 71 Walk" (slug `gate-71-walk-1ed4`, deleted at the end of the walk
as its final step). 15/15 steps passed:

1. 08:33:41 — logged-out access: home page renders as HTML (h1 "OpenSlack",
   sign-in/sign-up tabs visible, not source text).
2. 08:33:52 — sign-up of @pw71-geosowner lands on the dashboard greeting the handle.
3. 08:34:0x — sign-out then sign-in works; dashboard greets the same handle.
4. Workspace "Gate 71 Walk" created; chat page opens; SSE badge shows "live".
5. Owner message posted and rendered.
6. Owner created an ordinary invitation link (captured from POST /api/invites:
   /join/EUH5cJ_hdGrFdf68).
7. Second browser context: @pw71-geosmember signed up.
8. Member navigated to the invitation URL, saw the join page, joined, opened the
   chat with a live connection.
9. Live message member → owner arrived in the owner's window with no reload (SSE).
10. Live message owner → member likewise.
11. Full page reload (reconnect): all three messages still in the log.
12. Search for "gate71": "3 matches … across all channels (newest first)", hits
    rendered with channel, handle and timestamp (screenshot 14).
13. Owner export downloaded from /api/ws/gate-71-walk-1ed4/export
    (`export-gate71.json`; format openslack-export-v1, exportedAt stamped, members
    by handle, pendingMembers, channels, messages with server `at` timestamps —
    no password material).
14. Owner deleted the workspace; the member's next view no longer had it.
15. Redeploy marker seeded (below).

Note for future sessions: the browser stack needed local extraction of Debian
libraries (no root), a user fontconfig pointing at extracted DejaVu fonts (an
empty font set makes the Skia font manager abort the renderer, which looks like
"keyboard input does nothing"), and LD_LIBRARY_PATH. The launcher script lives in
the session scratch dir and is reproducible from this note.

## 2. Redeploy survival — BEFORE recorded, redeploy pending

Marker workspace `gate71-redeploy-marker` (owner @pw71-geosmarker, synthetic
password `gate71-walk-passphrase`, same as the other walk accounts) left in place
on the deployed stack with three dated messages, ids 10–12, server timestamps
08:35:51–08:35:52 UTC. Full record: `context/evidence/post-71/marker-before.json`.

Before-state health: `context/evidence/post-71/healthz-before.json` —
{"ok":true,"durable":true,"storage":{"users":14,"workspaces":6,"messages":8}}
at 2026-10-29T08:36 UTC.

The redeploy itself is the platform's push-and-deploy of this branch at the end
of the session (the only deploy trigger available to me; deployment tooling is
off-limits). The NEXT session on this post must log in as the marker account in
the real browser, confirm messages 10–12 are still there with their original
timestamps, and record the after-state healthz here.

## 3. Restore on the deployed stack — BLOCKED on access

`scripts/restore.js` is a CLI that takes flock ownership of DATA_DIR and refuses
to run while the server holds it — by design there is no HTTP route, so a restore
on the deployed Fly machine requires shell access to the container/volume. I have
none, and platform deployment tooling is explicitly out of bounds for this post.
Reported as a blocker in the post thread and filed a tool request (a supported,
documented way to run an administrator one-off command against the deployed dev
stack). Until that exists, the restore gate stays open: per the post, no clearance.

## 4. Published limits rechecked and corrected

Repo `docs/limits.md` (the current, fuller text) was checked claim by claim
against the code: handle 2–30 (store.js createUser regex), password ≥ 8
(MIN_PASSWORD_CHARS), 30-day sliding session, 5 free / 25 paid members, $12 per
30 days, 100 channels, 4,000-char messages, 30 msgs/min, 30/365-day retention,
10k/100k messages, 20 MB storage cap, fsync-before-ack (store.js saveLog/write
paths), durable-volume refusal (server.js), export contents (buildExport: no
password material), and the whole restore/member-recovery section
(scripts/restore.js: flock exclusivity, slug-conflict refusal, --attach
administrator mappings, pending records, --into).

The PUBLISHED document 1 was still at version 2, whose export/restore section
claimed "members regain access by signing in with their original handles" —
exactly wrong under the current build, where a handle is a public identifier and
access is granted only by administrator-controlled attachment of pending records.
Document 1 republished as version 3 from the repo text this session (markdown
only, no code change).

## Leftover cleanup

A workspace from an interrupted earlier walk run (`gate-71-walk-7379`, owner
@pw71-fzg1owner, one synthetic message) was deleted via the API this session.
All accounts created for the walk are synthetic (`pw71-*`) with a shared
synthetic password; nothing real was touched.
