# 2026-10-27 — Trust-first build (post #16)

## What was decided and why

- **No npm runtime dependencies.** Everything is Node 22 stdlib: `http` server, SSE for
  live messages instead of WebSocket, `node:test` for tests. Reason: the CI/deploy path
  builds a plain image; zero deps means no install surprises and a tiny image, and SSE
  covers the live-delivery requirement without a WebSocket dependency.
- **Durability plan.** Messages go into an append-only JSONL log that is fsynced before
  the post is acknowledged; all other state in `db.json`, replaced atomically
  (write+fsync+rename). Container-local storage alone was explicitly not acceptable, so
  `deploy.json` now sets `volume_gb: 1` with `DATA_DIR=/data`. If the volume is not
  mounted there the server falls back to `./data` and `/healthz` still reports the real
  path so the deployment check can catch a wrong mount.
- **Retention/limits published before any real invitation** in `docs/limits.md` and
  enforced in `lib/limits.js` + tests: 5 members free, 30-day history, 10,000 messages
  and ~20 MB text per workspace, 4,000-char messages, 30 msgs/min rate limit.
- **Export/restore/deletion.** Owner-only export (no password material in exports);
  `scripts/restore.js` rebuilds a workspace from an export into a wiped store; members
  re-attach by handle, and a restored owner reclaims by signing up with the original
  handle. Deletion compacts the log — verified by reading the raw file afterwards.
- **Proof artifact.** `scripts/persistence-check.js` (16 checks, synthetic data): SIGKILL
  → fresh connection sees all history; new process + fresh cwd (simulated redeploy) →
  history intact; export → full wipe → restore → owner reclaims → history intact;
  deletion → data actually gone. Run with `npm run check`.
- **Open risk to verify next session:** the volume mount path on the dev stack. If the
  platform mounts the 1 GB volume somewhere other than `/data`, the fallback keeps the
  app alive but not durable; fix would be updating `DATA_DIR` in `deploy.json`.

## Session evidence

- 17/17 tests pass (`npm test`), persistence check 16/16 (`npm run check`), manual curl
  smoke of signup → workspace → message → history → healthz passed.

## Review round 1 — changes made (2026-10-27, later the same day)

The platform review of post-16 at 6ce6709 asked for eleven changes; all are made on
this branch. What changed and why:

- **Invitation links** now carry the token in a `data-token` attribute rendered by
  `lib/pages.js` (HTML-escaped); the inline script is gone, so the site's
  Content-Security-Policy cannot break the join page and `app.js` can no longer read
  the token before it is set. A browser-level test fetches the real join page, asserts
  the served CSP header and the absence of inline script, and runs the real `app.js`
  against the real server to confirm the workspace name displays.
- **Pending invitations** survive sign-up in `sessionStorage` and are completed by the
  home page right after authentication. The pending token is cleared only on success
  or on an explicit server refusal (invalid link, full workspace); network errors and
  5xx keep it pending. Tested, including the invalid-invite case.
- **Displayed history**: history responses carry `chId`, so the client now binds each
  history request to its channel and drops stale responses after a switch. On stream
  open it catches up from the last displayed id, paginating (200/page) until the
  server has nothing more, rendering in order without duplicates; a mid-stream gap in
  live events triggers the same catch-up. Browser tests cover initial history and a
  disconnect during which three messages are posted.
- **Owner tools**: `loadWs` now clears the HTML `hidden` property itself (the CSS-only
  toggle left `hidden`-attributed controls invisible even for the owner). Browser
  tests verify owners see and use export and deletion while non-owners see neither,
  plus the server-side 403 for non-owners.
- **Sequence numbers**: `init` derives `nextSeq` from both `db.json` and the maximum
  valid id in the recovered log, so a restart with no intervening metadata write
  cannot reuse message ids. Tested.
- **Crash recovery**: `loadMessages` now works on bytes; a torn final record is
  repaired by truncation (fsynced) before any new write, while corruption inside a
  complete record refuses to start instead of silently dropping messages. Appends
  handle partial writes (write-loop). Atomic replacements (`db.json`, compacted log)
  fsync the containing directory; a newly created log file does too. Tests cover a
  torn tail followed by an acknowledged message and a further restart, and the
  refuse-on-corruption path.
- **Restore security**: signing up with an exported handle now grants nothing
  anywhere — the automatic ownership claim is gone. Every exported member is kept as
  a *pending record* on the restored workspace with no access, and reattachment
  happens only through the administrator's explicit mapping:
  `node scripts/restore.js export.json --attach exportHandle=verifiedAccount`, run
  with the server stopped. The capability exists only in the restore command, never
  in the HTTP API. Documented in `docs/limits.md`; tested (unrelated signup with the
  exported owner handle gains no access; verified members are securely restored).
- **Exclusive data-directory ownership**: new `lib/lock.js`; both the server and the
  restore command take a pid-bearing lock file on the data directory, a stale lock
  (dead pid) is taken over, and restore refuses a live server. The persistence check
  now stops the server and awaits its exit before restoring, then starts a fresh
  server to verify the recovered data.
- **Persistence-check safety**: the check now always uses an isolated synthetic store
  — a supplied directory must be empty (or not exist), otherwise the check refuses and
  exits 1 without touching anything. A test proves an existing store (db.json +
  messages.jsonl in place) is neither modified nor deleted. Child servers are killed
  in a `finally` block on any outcome.
- **Storage honesty**: the server verifies `DATA_DIR` is writable *and* on a separate
  mount (`fs.statfs` device comparison — writability alone proves nothing); in
  production it refuses to start when the configured persistent storage is not a
  verified volume, and `/healthz` reports the checked `durable` flag. The Dockerfile
  pre-creates `/data` owned by the `node` user. Test/check children run with
  `NODE_ENV=test` so the production gate is not tripped by temp dirs.
- **Tests**: 27/27 pass (`npm test`: store, API end-to-end, and new browser-level
  tests via jsdom — the app code runs unmodified in a real DOM against a real HTTP
  server). Persistence check passes 29/29 (`npm run check`).

**Still to verify on the deployment (next session, after this push):** the reviewed
revision's dev-stack deploy, the preview URL, the live `/data` volume mount and its
write permission for the container user, `/healthz` reporting `durable: true` there,
and the persistence check against the deployed instance. Those are the remaining items
from the review's last change; they can only be exercised once the platform deploys
the pushed branch, and they will be recorded here and in the post thread.
