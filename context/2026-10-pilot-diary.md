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
