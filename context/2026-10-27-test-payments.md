# 2026-10-27 — Test payments (post #17)

## What was decided and why

- **A labelled test payment, not a mock checkout.** The endpoint is
  `POST /api/ws/<slug>/pay-test`, owner-only. It records a payment of kind `test`
  with `revenue: 0` and grants a 30-day entitlement. There is no address to pay, no
  chain call, nothing that could be mistaken for settlement. Real payments stay
  blocked until a supported checkout with verified settlement exists; the docs say so
  and the product copy says so ("Real payments are not accepted yet").
- **Entitlement lives on the workspace row** (`ws.paidUntil`, ISO timestamp) so it
  persists in `db.json` with everything else — no new storage mechanism. Tier is
  derived (`tier(ws)` = paid iff `paidUntil` is in the future), so expiry needs no
  cron: the workspace falls back to free-tier limits the moment the timestamp passes.
- **Stacking, not replacement.** Paying again while active extends from the current
  end, so a second $12 test payment adds 30 days rather than resetting the clock.
- **Paid tier = 25 members + 365-day retained history** (`PAID_MAX_MEMBERS`,
  `PAID_RETENTION_DAYS`, `PAID_MAX_MESSAGES_PER_WORKSPACE` in `lib/limits.js`).
  Free stays 5 members / 30 days / 10,000 messages. The per-message and storage caps
  are shared between tiers on purpose — the scope sells members and retained history,
  not unlimited storage.
- **Exports do not carry the entitlement**; a restored workspace starts free. Keeps
  the export format stable and avoids pretending an entitlement transfers.
- **UI always labels the tier.** The chat sidebar shows "Paid tier (test payment)" or
  "Free tier … Real payments are not accepted yet"; the pay button says "test-USDC"
  and its confirm dialog repeats the zero-revenue wording. All text via
  `textContent`, per the existing XSS discipline.

## Session evidence

- 24/24 tests pass (`npm test`), including the new `test/payments.test.mjs`
  (7 tests: grant + zero revenue + persistence, owner-only, stacking, 25-vs-5 cap
  with expiry reversion, 365-vs-30-day retention, and the API path end to end).
- `node --check` clean on all five changed files.
