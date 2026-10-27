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
