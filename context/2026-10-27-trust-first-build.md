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

## Review round 2 — changes made (2026-10-27)

Commit d8c6811 on post-16. Every point the round-2 review raised is addressed;
each with its own tests.

- **Mount durability (`server.js` → new `lib/storage.js`)**: the broken
  `statfsSync(...).dev` comparison is gone (Node's StatFs has no `dev`).
  `inspectStorage(dataDir)` now compares `fs.statSync(dataDir).dev` against
  `/`'s device id — a separate mounted filesystem — and rejects the known
  temporary roots (`/tmp`, `/var/tmp`, `/dev/shm`, `/run`, `os.tmpdir()`) so a
  separate-but-ephemeral mount never counts as persistent. Verdict:
  `{ onOwnFilesystem, temp, durable, reason }`; an uninspectable path is
  "not usable". Production still refuses to start on anything not writable
  and durable; non-production warns and reports `durable=false`. Tests:
  injected-stat unit tests for each verdict, plus production-startup child
  tests — refuse without DATA_DIR, refuse a temp dir, refuse `/dev/shm`,
  refuse an unwritable directory (chmod 555), and a positive test that starts
  on a real persistent mount when the machine offers one (here: /data) and
  must report `durable: true` on `/healthz`.
- **Exclusive ownership (`lib/lock.js` rewritten)**: the pid-file lock is
  gone entirely. Ownership is now an OS advisory lock (`flock(2)`) held by the
  *serving process itself* for its lifetime: a shell wrapper opens the lock
  file on fd 9, takes the non-blocking exclusive flock and `exec`s the entry
  point, which inherits the locked descriptor — the kernel drops the lock the
  moment the owner dies (clean exit, SIGKILL, replaced container), so there is
  no stale lock, no pid to misread, no takeover to get wrong, and nothing to
  unlink. A crucial pitfall found and avoided: the `flock FILE COMMAND` form
  *forks* the command, so killing the flock parent leaves the orphaned child
  holding the lock — the fd-inheritance form (verified against
  `/proc/self/fdinfo` and inode matching) makes the direct child the owner.
  `alreadyHeld` verifies the inherited lock via `fstatSync` dev/ino plus the
  fdinfo lock line; a READ lock does not count. Tests: concurrent acquisition
  (exactly one winner), leftover pid-bearing files neither block nor grant
  (pid-reuse / replacement-container scenario), crashed owner releases the
  lock immediately, restore refuses a live owner before touching anything.
  The Dockerfile CMD uses the same wrapper; `OPENSLACK_LOCK_*` env stays
  per-process so a `docker exec` restore still acquires the lock itself.
- **Shutdown ordering (`server.js`)**: shutdown no longer releases anything —
  it ends the SSE streams, stops accepting new requests, and waits (deadline
  3 s) until every in-flight request has finished before `closeAllConnections`
  and `process.exit`; the kernel drops the advisory lock only then. A request
  whose JSON body is still arriving is drained (completed) rather than
  abandoned. Test: a server under the real wrapper receives a partially
  delivered mutation, SIGTERM arrives, a concurrent restore is refused with
  "owned by another live process", the request then completes with 201, the
  server exits 0, a restarted server acquires the directory and the message is
  in the history.
- **Reconnect catch-up (`public/app.js`)**: a contiguous recovery cursor is
  now separate from live delivery. `ingest` buffers live events (per channel)
  while a catch-up/recovery is in flight and never advances the cursor;
  pagination advances only from *fetched* rows, so a live event cannot push
  the next page's cursor past unseen rows; `lastId` is no longer advanced
  before the catch-up query. Recovered and buffered messages render in id
  order with dedupe. Tests: a live event arriving before the reconnect
  catch-up completes, and a 60-message outage forcing multi-page recovery with
  a live event buffered across it (jsdom, real server, rate-limit-budgeted
  across three accounts; catch-up page 50).
- **Pending memberships (`lib/store.js`)**: pending recovered records are now
  included in `workspaceMembers` (shown as pending, no access) and in
  `buildExport`, so a partially recovered workspace round-trips through
  restore without losing them. `attachMember` validates everything (pending
  record exists, target account exists, workspace capacity) *before* any
  mutation, and removes the pending record only once attachment succeeds — a
  failed attach into a full workspace leaves the record in place across saves
  and restarts. Tests: partial-attach export/restore round trip (twice over),
  failed full-workspace attach followed by save and restart, nonexistent-user
  attach, already-member attach.
- **`fsyncDir` (`lib/store.js`)**: directory open/fsync failures now
  propagate — a genuine I/O failure is never acknowledged as success. Only
  explicitly recognized unsupported-operation codes (EINVAL/ENOTSUP/
  EOPNOTSUPP/ENOSYS) are tolerated, and only outside production. Failure
  injection tests: an EIO on the directory fsync makes `saveDb` throw and
  leaves `db.json` unchanged; the same EINVAL is tolerated outside production
  and throws in production.
- **Docs**: `docs/limits.md` restore/membership sections updated to describe
  the kernel lock, the drain-before-release shutdown and the pending-member
  recovery rules.

**Result:** `npm test` 45/45 pass (31 s, no hangs), `npm run check`
29/29 PASS. Deployment verification (dev-stack deploy, preview URL, real
volume mount and permissions, `durable: true` in deployed `/healthz`,
reconnect/export/restore/deletion plus an actual platform redeploy with
synthetic data) still depends on the platform pushing and deploying this
branch — it happens next session, and the results will be recorded here and
in the post thread before any real user is invited.
