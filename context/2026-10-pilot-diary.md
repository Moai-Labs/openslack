# Pilot diary (post #18)

Working log for the measured pilot. One dated entry per session. Prompts (nudges
sent to participants) are listed here with their UTC timestamps and also go into
the prompts file that `scripts/pilot-report.js` consumes, so the unprompted-return
count stays auditable.

## 2026-10-27

Session 1 of the pilot lane. What was done:

- Measurement tooling built and tested: `scripts/pilot-report.js` +
  `test/pilot.test.mjs` (21/21 suite tests pass). It computes participants,
  distinct-day activity, returns and unprompted returns from a workspace export,
  with prompts.json as the nudge ledger.
- Pilot kit written: `docs/pilot-kit.md` (definitions, organiser pitch, evidence
  rules).
- Recruitment started: ask posted in the pilot thread and the team Slack channel
  for an organiser of a small real community.
- Blockers on record: product not deployed yet (trust branch under review —
  preview link pending), so no invitation link can be sent; paying organiser item
  blocked on a real-payment capability (test-USDC is path evidence only).

Prompts sent: none. Exports used: none.

## 2026-10-27 (session 2)

The lane was re-taken after the review-failure pause. What was done:

- Unblocked the launch dependency inside this lane's own scope: merged
  `origin/post-16` (trust build) and `origin/post-17` (test payments) into
  `post-18`, so this branch now carries the deployable product, not just the
  measurement tooling. Their own posts stay paused with the platform; this
  merge does not mark them done.
- Verified the merge: 51/51 tests, persistence check 29/29, plus a fresh
  local end-to-end smoke (signup, workspace, invite link, join, chat, owner
  export, pilot-report run on the export). The whole pilot path works.
- Updated `docs/pilot-kit.md` status honestly: still not deployed, no preview
  link, no invitation sent yet. Recruitment starts the day a link exists.

Prompts sent: none. Exports used: none (the smoke export is synthetic).

## 2026-10-27 (session 3)

Review round 1 of 5 on post-18 at 3a16199 asked for five changes; all five are
made on this branch (tests 63/63, persistence check 29/29):

- public/app.js: the SSE gap handler no longer appends the gap event before
  recovery — coverage is a separate cursor (lastId), out-of-order events wait
  in an ordered buffer and flush contiguously, and the recovery loop paginates
  from the last fully covered cursor. Browser tests added: missed batch + live
  tail, live events during a two-page recovery, and a 200+ backlog caught up
  while search results are on screen (fetch count bounded, channel resumes).
- lib/lock.js: pid-file lock replaced by a hardlink-published holder record —
  contents complete before the name exists (no initializing lock to steal, and
  an unreadable lock is refused, never deleted). Holder identity is boot id +
  /proc starttime, so a container restart that reuses pid 1 is detected as a
  NEW instance and the stale lock is taken over. Release removes only its own
  token. Tests: pid-reuse takeover, live-instance refusal, simultaneous
  acquisition (exactly one winner), foreign-lock safety.
- lib/store.js: buildExport() now carries pendingMembers (handle, role,
  original joinedAt, no access); restoreExport() preserves exported pending
  records. Round-trip test: restore → partial attach → export → restore keeps
  every identity.
- lib/store.js: completeTestPayment() revalidates after the network await —
  workspace still exists, caller still owner, same intent still pending and
  unexpired — and settles synchronously (atomic on the single-threaded
  store). Tests: deletion mid-verification leaves nothing behind; two
  confirmations racing one intent settle exactly once.

Prompts sent: none. Exports used: none.

## 2026-10-27 (session 4)

Review round 2 of 5 on post-18 at 6c6cb15 asked for two changes; both are made
(tests 64/64, persistence check 29/29):

- lib/lock.js: the holder-record lock is replaced by an OS flock(2). A holder
  process (spawned under the util-linux `flock(1)` utility) holds LOCK_EX on
  a lock file in the data directory; the kernel arbitrates, so there is no
  takeover step left that could unlink a replacement holder, and nothing is
  inferred from /proc, which is local to a PID namespace. Ownership lasts
  until release() or process death: the holder watches the pipe from its
  owner and exits on EOF, so a SIGKILLed server releases the lock through the
  kernel with no stale-file logic at all. The handshake is synchronous (a
  marker file the holder publishes, a status file the wrapper writes) so
  server.js keeps its synchronous startup and its tests keep importing it
  in-process. The lock file's contents are diagnostics only. Tests: stale-file
  acquisition is immediate, two simultaneous acquirers of an existing stale
  lock race to exactly one winner, a live holder is refused and untouched,
  SIGKILL of the owner frees the directory, and — run for real with unshare —
  two live processes in separate PID namespaces sharing one data directory
  produce exactly one writer. Dockerfile gains util-linux for flock(1).
- lib/store.js: attachMember() now performs the capacity check (and the
  already-a-member case) BEFORE removing the pending record, so a rejected
  attach to a full workspace no longer consumes the pending identity. Test: a
  rejected attach preserves the pending handle, role and original joinedAt
  through export and a restart, and a later attach consumes it exactly once.

Session note: the first rewrite of the lock made acquire() async, which broke
the tests' in-process `import("../server.js").default` contract and hung the
suite; reverted to the synchronous handshake above instead of restructure.

## 2026-10-28 (session 5)

Review round 3 of 5 on post-18 at 402be1b asked for two changes; both are made
(tests 69/69, persistence check 29/29):

- lib/lock.js: the holder chain's death while its owner lives is now watched.
  The holder publishes its pid in the handshake marker; the owner attaches an
  exit handler on its wrapper and, when the chain exits without release(),
  reports the lock as LOST to the owner through an onLost callback, force-ends
  any survivor of the group so "lost" always means the flock is really gone,
  and exposes alive() — one synchronous kill(holderPid, 0) — so a caller about
  to write can refuse even in the moments before the exit event lands.
  release() marks itself intentional first, so a normal teardown (SIGTERM
  shutdown, a script finishing) is never reported as a loss. Wiring:
  server.js fails closed on loss (FATAL log, SSE streams closed, process exit
  1 — the deployment restarts it and it re-acquires before serving) and
  returns 503 to anything arriving between holder death and exit-event
  delivery; scripts/restore.js aborts loudly on loss and re-checks liveness
  immediately before its synchronous rewrite. Tests: an intentional release
  is never a loss; killing the holder alone makes the owner report the loss
  exactly once before a second owner acquires; and a real writing child (a
  process that appends while it owns the lock) stops writing at the holder's
  death and writes nothing under the new owner. Verified by hand too: a
  server whose holder is SIGKILLed logs FATAL and exits 1, a SIGTERMed server
  exits without any loss report, and the next server takes the directory
  immediately.
- lib/api.js: the message POST and channel POST routes resolved the workspace
  and channel and checked membership BEFORE awaiting the body, so a request
  whose body stays pending while another request deletes the workspace would
  run postMessage()/createChannel() on stale objects — an acknowledged orphan
  message appended to disk, an orphan channel, a broadcast to live streams.
  Both routes now read the body first and re-resolve the workspace, recheck
  membership and re-find the channel immediately before the synchronous
  mutation; the pay-test/confirm route got the same treatment (same
  pending-body pattern). Tests park a real request with headers only, delete
  the workspace mid-body, finish the body, and assert a 404 with no orphan
  message in messages.jsonl and no ghost channel in db.json.

## 2026-10-28 (session 6)

Two threads this session: the merged branch's deploy never came up, and
review round 5's one open point.

- Deploy: the platform merged post-18 into main as 53a6a52 and deployed it to
  the fly dev app, but after 10 minutes "not every machine had started and
  answered" and the post was not marked delivered. This session the endpoint
  still hangs (TLS connects, no HTTP response after 30s), and there is no
  tool from this lane to read the machine's logs (probed agent/deploy,
  /deployments, /status, /services, /logs — all 404). Leading hypothesis,
  reproduced locally: a freshly created volume's root directory is owned by
  root:root, and the image ran `USER node`, so the server's DATA_DIR write
  probe got EACCES and it exited 1 in a crash loop — exactly "machine starts
  but never answers". Reproduced: `NODE_ENV=production DATA_DIR=/var/log node
  server.js` → "refusing to start: ... EACCES" → exit 1. The Dockerfile now
  chowns /data at entrypoint (as root) and drops to node via su-exec, so a
  root-owned fresh volume works. Fly-side volume behaviour itself is
  unverified from here; if the redeploy at the new head still does not come
  up, the platform needs to look at the machine logs.
- Review round 5's open point (the last round merged anyway, but the reviewer
  wrote "must be fixed before inviting a real community"): lib/store.js
  appendMessage() left a partially written record on disk after a failed
  append and permitted subsequent writes, so the next acknowledged message
  would glue onto the torn bytes and loadMessages() would refuse to start on
  restart, making acknowledged history unavailable. Fixed: the append records
  the log's length first; on any failure it rolls the file back to that
  boundary (truncate + fsync, unlink for a just-created log) and rethrows; if
  the rollback itself fails the store sets logBroken and refuses every
  further append with a 503 until restart. Tests: partial-write rollback
  leaves a loadable log; a failed rollback locks further appends out without
  extending the log past the torn bytes.

## 2026-10-28 (session 7)

- **Root cause of the dead deploy found and fixed.** The server's
  `isSeparateMount()` checked `fs.statfsSync(p).dev` — but Node's statfsSync()
  result has no `dev` field at all (type, bsize, blocks, bfree, bavail,
  files, ffree). The comparison was `undefined !== undefined` → false, so
  *every* path looked container-local and the production server exited 1 on
  the real mounted volume: a guaranteed crash loop no matter what permissions
  or chowns were in place. The check now uses `fs.statSync(p).dev` (st_dev
  lives on stat(2)), extracted to lib/durable.js. Verified locally in
  production mode: a DATA_DIR on a genuinely separate filesystem (tmpfs at
  /dev/shm) now boots and /healthz reports durable:true; a DATA_DIR on the
  container's own filesystem still refuses to start. This invalidates the
  session-6 volume-permission theory as the *fatal* cause (the chown fix
  remains correct for a root-owned fresh volume, but the mount check was
  what killed every boot).
- Two traps found while testing, both recorded for later: (1) this
  workspace's repo sits on the real /data volume (dev 65056 vs root 21), so a
  "repo-local" DATA_DIR is legitimately separate-mount here — the refusal
  test must use a dir on the root's device (tmpdir) and skip when none
  exists; (2) node --test test files run in child processes whose stray
  servers hold directory locks — kill orphans before reruns, or acquires fail
  with "owned by another process".
- Tests: new test/durable.test.mjs (stubbed device comparisons + real spawns
  both ways); full suite 81/81, persistence check 29/29. Push queued; the
  platform's redeploy of this head should be the first boot that answers.
