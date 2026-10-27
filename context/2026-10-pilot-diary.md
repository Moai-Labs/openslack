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
