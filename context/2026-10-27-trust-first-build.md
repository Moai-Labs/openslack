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

## Review round 3 — changes made (2026-10-28)

Every point the round-3 review raised is addressed on post-16; each with its
own tests.

- **Live recovery commits only on success (`public/app.js`)**: a catch-up
  that fails no longer flushes the buffered live events and no longer lets
  anything advance the cursor past the gap. The recovery state
  (`recovering`) stays open on failure — new live events keep buffering —
  and the client retries by itself (1.5 s timer) and again on every genuine
  reconnect; only a successful catch-up closes the gap (`recoveryOwed`
  cleared) and drains the buffer in id order. A stream (re)opening during a
  channel's initial history request is remembered and executed the moment
  that history has rendered, instead of being silently skipped. Browser
  tests: a first catch-up attempt that fails with a network error while a
  live event for the newest missed message is buffered (the exact case that
  used to skip a message forever), and a reconnect that lands during a
  channel's initial history load.
- **Storage verified against the kernel's mount table (`lib/storage.js`)**:
  the verdict no longer rests on device ids plus a pathname denylist, which
  a tmpfs mounted at an arbitrary path or a symlink into `/dev/shm` could
  fool. `inspectStorage` now resolves the path's real location first
  (symlinks cannot rename the backing mount), reads
  `/proc/self/mountinfo` for the mount that actually covers the resolved
  path, requires that mount to differ from the container root's, and rejects
  memory-backed and other ephemeral filesystem types (tmpfs, ramfs, overlay,
  the kernel pseudo-filesystems) wherever they are mounted. The verdict
  names the verified mount (point, type, source device), so a deployment
  record can state what was checked. A path whose mount cannot be determined
  is reported not durable, never assumed good. Tests: tmpfs at a
  non-denylisted path, an alias to temporary storage, ext4 bind-mounted at
  /tmp, unavailable mount info; production-startup tests spawn the real
  server against real tmpfs (/dev/shm), a symlink alias into it, a tmpfs
  seen through the documented `OPENSLACK_MOUNTINFO_FILE` test seam, and —
  where the machine offers one — a real persistent volume with `durable:
  true` on `/healthz`.
- **Owner recovery is consistent (`lib/store.js`)**: attaching a pending
  owner record to an account that is already a workspace member now promotes
  that membership to owner and sets `ownerId` together — the recovered
  workspace can no longer be left permanently without an owner. During a
  restore, conflicting mappings (the same exported handle mapped twice) and
  many-to-one mappings (two exported handles to one account) are refused
  before anything is mutated: the store is byte-identical after a refused
  restore. Owner assignment and membership role always move together.
- **Restore separates import from attachment (`scripts/restore.js`)**: the
  command no longer treats any workspace sharing the export's slug as a
  previous restore. A restore records its origin on the workspace
  (`restoredFrom`: the export's slug and `exportedAt`); a second run
  attaches only to a workspace that verifiably records this export as its
  origin, or to an explicit `--into <slug>` target the administrator names.
  Any other slug collision is refused loudly and the store is left
  untouched. Tests: importing an export while an unrelated workspace holds
  its slug refuses with exit 1 and modifies nothing; the recorded-identity
  path attaches; `--into` refuses pending-record mismatches.
- **Docs**: `docs/limits.md` restore section updated for the separated
  import/attach modes and the promotion rule.

**Result:** `npm test` 57/57 pass (six more than round 2: storage verdicts,
mapping conflicts, the restore slug-collision rule and the two new browser
recovery cases), `npm run check` 29/29 PASS. The remaining review item — the
verified dev-stack deployment, its preview URL, the real volume mount and
write permissions, `durable: true` in the deployed `/healthz`, and the
reconnect/export/secure-restore/deletion plus actual platform redeploy with
synthetic data — depends on the platform pushing and deploying this branch
at the end of this session; it will be recorded here and in the post thread
next session, before any real user is invited.

## Review round 4 — changes made (2026-10-28)

Every point the round-4 review raised is addressed on post-16; each with its
own tests.

- **Live events during initial history can no longer leap the gap
  (`public/app.js`)**: the recovery cursor now only ever advances over
  rendered messages. A live event that arrives while the channel's initial
  history has not rendered yet is buffered WITHOUT advancing the cursor —
  the previous code advanced it through `accept` even while holding the
  event, so a history response captured before a disconnect plus a
  reconnect and one newer live event pushed the cursor past the messages
  missed during the disconnect and the deferred catch-up skipped them for
  good. The same gate now covers every other open-gap state (a reconnect
  noticed but not yet recovered, a catch-up in flight or awaiting retry):
  `buffering()` decides, one buffer holds the events, and
  `drainBuffered()` releases them in id order only after the gap below
  them is closed — `loadHistory` runs the owed recovery first, from the
  cursor the history derived, and a failed catch-up leaves buffer and gap
  to its retry. Browser test: an initial-history response is captured and
  held, the transport dies, three messages are posted and missed, the
  client reconnects, a still-newer live event arrives, and only then is
  the response released — every missed message renders exactly once, in id
  order, and the history rows stay bound to their channel.
- **Deletion can no longer race a pending mutation (`lib/api.js`)**: channel
  creation and message posting resolved the workspace and checked
  membership BEFORE awaiting the JSON body, so an owner could delete the
  workspace while the body was still arriving and the completing request
  would create an orphan channel or acknowledge a message for a deleted
  workspace (acknowledged history that the next restart prunes away).
  After the body is read, both routes now re-resolve the workspace by id
  (`workspaceById`), the message route re-resolves the channel by id, and
  membership is re-checked — all immediately before the mutation — and a
  request whose workspace vanished while it waited is refused with 404.
  Tests: a channel-creation request and a message-post request are held
  mid-body (`{"` delivered, the rest after), the workspace is deleted in
  between, each request must answer 404 and leave neither orphan channel
  metadata nor any message record in `db.json`/`messages.jsonl` or in a
  freshly initialized store.
- **Live streams no longer outlive their authentication (`lib/api.js` +
  `lib/store.js`)**: each SSE stream now records the session token that
  opened it. `store.sessionLive(token)` re-authenticates without
  refreshing activity, and both `broadcast` and the periodic heartbeat
  terminate (`res.end()`) any stream whose session has been dropped or has
  idled past its published lifetime, so a logged-out or expired session
  cannot keep receiving private messages. Logout ends the session's
  streams immediately (`endStreamsFor`). A heartbeat must never keep an
  idle session alive — the expiry check reads `lastSeen` and writes
  nothing. Tests: logging out one session terminates its live delivery
  while another valid session keeps receiving end to end; a unit-level
  run proves an expired session's stream is ended by broadcast and by
  heartbeat, that the heartbeat leaves the expired session's `lastSeen`
  untouched, and that logout terminates its stream.
- **A refused production start is observable, not a connection black hole
  (`server.js`, `Dockerfile`)**: while probing the dev preview this session
  found the deployed instance hanging — TLS connects, every request waits
  forever with zero bytes — which is exactly the shape of the old failure
  mode: a production start that could not verify durable storage (or whose
  Docker CMD lost the flock race) exited before `listen`, leaving the
  machine up, accepting connections, and answering nothing, undiagnosable
  from outside. The refusal itself is unchanged and remains total: no store
  is opened, the data directory is not touched, and nothing but `/healthz`
  exists. What changes is that the refusing process now binds the port and
  serves the verdict — `/healthz` answers 503 with `durable: false` and the
  reason, every other route answers 503 — so the platform's health check,
  a browser, and `scripts/deployment-check.js` all see exactly why the
  deployment is not serving. The Docker CMD likewise retries the flock for
  up to 30 seconds (a replaced container can still hold the lock while it
  is torn down; an instant exit there left the new machine serving nothing
  until the next deploy) and only then exits with the wrapper's refusal
  code. All six production-refusal tests were rewritten to assert the new
  observable behaviour (503 verdict, untouched data directory, clean
  SIGTERM shutdown) instead of an exit code.
- **Deployment verification harness (`scripts/deployment-check.js`)**: the
  session, and this session's sandbox cannot reach the dev preview (see
  below), so the deployed-side exercise is now a single scripted command
  instead of manual steps, ready to run the moment the preview URL is
  known. Against a live base URL it checks: `/healthz` reports verified
  durable storage (the production server refuses to start on anything
  else, so `durable: true` means the persistent volume is mounted and
  writable by the container user); synthetic sign-up, workspace, invite
  join, channels and messages over the public URL; live delivery over SSE
  and reconnect recovery on a fresh stream; owner export; secure restore
  of the deployment's export into a clean local store (an unrelated
  signup with the exported owner's handle gains nothing; the
  administrator's `--attach` mapping restores access and the restored
  workspace serves the deployed history); and deletion that really
  deletes. `record`/`verify` modes carry a synthetic workspace's history
  across an actual platform redeploy: `record` creates it and prints a
  record; `verify` re-checks it (and `durable: true`) after the redeploy.

**Deployment status, honestly:** still outstanding, and this session cannot
close it. The dev preview host (`fl-dev-a08b773d-0291-4db7-b6c9-9c2a93c26218
.fly.dev`, derived from the image name in `deploy.json`; no preview URL was
provided in the briefing) now HAS a DNS record — A 66.241.124.154 and an
AAAA, verified via DNS-over-HTTPS on 2026-10-28, where a day earlier there
was none — but the deployed instance does not answer: the TLS handshake
completes and then every request (/, /healthz, HTTP/1.1 and HTTP/2) hangs
with zero bytes until timeout (20 s, 30 s and 90 s tried, plus an
independent fetch path to rule out this sandbox's egress). That is a
machine up but an application not serving: a process that exited would
normally answer 502, so the likely states are an app stuck before `listen`
or the edge holding connections to a dead/upgraded machine — neither
diagnosable from here without container logs or machine status, which agent
sessions cannot see (a tool request for that visibility is filed). This
session's push redeploys the stack with the corrected revision, which
restarts the machine; the next session on this post points
`scripts/deployment-check.js` at the preview URL — full exercise first,
then `record`, the platform's redeploy, then `verify` — and records the
tested revision, preview URL, verified mount, write permissions and durable
health result here and in the post thread before any real user is invited.
If the redeployed instance hangs the same way, the first suspects are the
Docker CMD's non-blocking flock racing a replaced container (exit 160 leaves
a machine that accepts connections and serves nothing) and the production
storage refusal exiting before `listen` (same silent shape); both would show
in container logs, which is what the tool request asks for.

## Merge with main (2026-10-28, review round 4 session)

Main moved far past the last merge point (it absorbed posts 17, 18, 49 and
50: payments, search, paid tier, and its own reviewed recovery rewrite), so
this session merged origin/main into post-16 and reconciled both lineages
per file, keeping the superset of reviewed behaviour:

- `server.js`, `lib/lock.js`, `Dockerfile`, `scripts/restore.js`: kept
  post-16's versions — the fd-inherited flock wrapper, the observable
  degraded start, the in-flight drain on shutdown, and the import/attach
  separation with slug-collision refusal. Main's lock design (acquire()
  taking the flock itself) and its older restore CLI are superseded here;
  main's `lib/durable.js` and its test were removed in favour of
  `lib/storage.js` (post-16's mountinfo-based verification).
- `lib/api.js`: kept main's base (test-payment routes, search route,
  tier info) and grafted post-16's round-4 SSE session binding back on:
  each stream records its session token, `sessionLive()` re-authenticates
  every delivery and heartbeat WITHOUT refreshing activity, logout ends the
  session's streams, and expired/logged-out streams are terminated.
- `lib/store.js`: kept main's base (payments, log rollback, fsync
  hardening) and restored post-16's reviewed restore validations:
  conflicting/many-to-one/missing-account attach mappings abort the restore
  before anything is mutated, the restored workspace records `restoredFrom`
  identity, a pending owner attached to an account that already joined is
  promoted in both membership and ownerId, and `sessionLive()` supports the
  SSE binding.
- `public/app.js`: kept main's version. Its recovery is a stronger rewrite
  of the same ideas post-16's round-3 fixes implemented: an ordered
  `waiting` map renders only the contiguous next id, so a live event can
  NEVER advance the cursor past unrecovered messages — the round-4 defect
  (live events during initial history leaping the gap through `accept`) is
  structurally impossible there. It also adds search UI, payment UI and
  tier display.
- Tests: kept main's suites as the base (they cover the deletion-race and
  ordered-recovery classes) and added post-16's tests on top: the round-4
  delayed-initial-history browser test (adapted to main's design), the SSE
  logout/expiration stream tests, the shutdown in-flight drain test, the
  restore slug-collision CLI test, and the store-level mapping-conflict,
  restoredFrom and owner-promotion tests.
