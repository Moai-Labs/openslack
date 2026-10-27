# 2026-10-27 — Test payments (post #17)

## What was decided and why

- **A verified transfer, not a simulated switch.** The paid tier is granted only
  after a real test-USDC transfer is verified on a public test chain. The flow is
  two steps, both owner-only: `POST /api/ws/<slug>/pay-test/start` opens a payment
  request bound to the workspace (chain, asset contract, recipient, exact raw
  amount, expiry), and `POST /api/ws/<slug>/pay-test/confirm` takes the
  transaction hash and verifies settlement through read-only JSON-RPC calls
  (`eth_chainId`, `eth_getCode`, `eth_getTransactionReceipt`) before any
  entitlement is granted.
  The old one-step `POST /pay-test` route — which granted on the owner's say-so —
  is gone. Verification lives in `lib/payments.js`; entitlement bookkeeping in
  `lib/store.js`.
- **What is verified, per the review:** the test environment (the configured chain
  id must be one of the supported test chains — 84532 = Base Sepolia — or payment
  start refuses outright, and every confirm re-checks `eth_chainId`), the asset
  (the log's emitting contract must equal the configured USDC address, whose code
  existence is checked on-chain at verification time), the recipient (the Transfer log's `to`
  topic must equal the workspace's payment address), the amount (exactly
  12,000,000 raw units = $12 at 6 decimals), and settlement (receipt present with
  status success, and the transfer log not marked removed). An unmined or reverted
  transaction leaves the tier free and explains why in the product; the request
  stays open for a retry with a corrected hash.
- **Replay cannot grant more.** The verified transaction hash (lowercased, with
  block and log index) is persisted on the payment record and refused if the same
  transfer ever funded a payment before — in the same workspace or any other. The
  payment request itself is persisted, so a restart cannot lose an in-flight
  payment.
- **Real payments stay blocked.** There is no route that records any other kind of
  payment; every record is kind `test` with `revenue: 0`. Product copy says "Real
  payments are not accepted yet" wherever the tier is shown.
- **The recipient is a keyless sink** (`0x4282d8578cd38d216efa7a3976d03f0542c40ea3`,
  generated 2026-10-27, private key never created). Test-USDC sent there is
  unrecoverable, which is correct for labelled tests worth zero. When a supported
  checkout with verified settlement exists, its own recipient replaces this one.
  Configuration is env-overridable (`PAY_RPC_URL`, `PAY_CHAIN_ID`,
  `PAY_USDC_ADDRESS`, `PAY_RECIPIENT`); only test chains are accepted.
- **Entitlement lives on the workspace row** (`ws.paidUntil`, ISO timestamp), so
  expiry needs no cron: `tier(ws)` is derived and the workspace falls back to
  free limits the moment the timestamp passes. Paying again while active stacks 30
  days from the current end.
- **Paid tier = 25 members + 365-day retained searchable history**; free stays
  5 members / 30 days / 10,000 messages. Search is a workspace-wide,
  member-only endpoint (`GET /api/ws/<slug>/search`) plus an in-product search
  bar: matches across all channels, newest first, each hit labelled with its
  channel, paginated past the first page by id cursor. It covers everything
  retained for the workspace and nothing outside it.
- **Deleting a workspace deletes its payment records** (and open payment
  requests) in memory and on disk — they carry the payer's handle.
- **Exports do not carry the entitlement**; a restored workspace starts free.

## Chain constants, verified live on 2026-10-27

Fetched from `https://sepolia.base.org` (Base Sepolia public RPC) this session:

- `eth_chainId` → `0x14a34` = 84532 (Base Sepolia, a test chain).
- `eth_call symbol()` on `0x036CbD53842c5426634e7929541eC2318f3dCF7e` → `USDC`;
  `decimals()` → `6`; `eth_getCode` non-empty (contract exists).
- A live USDC `Transfer` log carries topic0
  `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
  (keccak256 of "Transfer(address,address,uint256)"), topics[1] = from,
  topics[2] = to, data = raw amount; `eth_getTransactionReceipt` returns
  `status: "0x1"` for settled transactions.

## Shared fixes merged from post-16 (same review findings, already fixed there)

Owner tools now clear the HTML `hidden` property; history responses are bound to
the channel requested (rows carry `chId`, not a channel name) with stale-response
drops on channel switch; the invite token travels in a data attribute instead of
an inline script (CSP-safe); a pending invitation is resumed after sign-up/sign-in
and cleared only on success or explicit refusal; `nextSeq` recovers from the log
(at least one above the highest valid logged id) and a torn final log line is
repaired by truncation before new appends.

## Session evidence

- Full suite passes (`npm test`): 39 tests across API, store, payments and
  browser suites, including a browser-level test that opens the chat page as the
  owner, sees the payment control (hidden property cleared), completes the
  two-step flow against a scripted payment node — first with an unmined hash
  (refused, stays free), then with a settled one (entitlement shown) — and
  browser-level tests for workspace search (matches beyond the newest page,
  channel context, back to channel) and history after reload and channel switch.
- Preview verification: recorded below once the dev deploy is verified.

## Preview verification

- Preview URL: (pending — filled in after the push deploys the dev stack)
- What was verified there: (pending)
