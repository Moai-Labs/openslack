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
- **Each request has its own keyless payment address**, derived from the
  request's id alone (`sha256("openslack-test-payment-request:" + id)`, first 20
  bytes — no key material is ever created, so funds sent there are by design
  unrecoverable, which is correct for labelled tests worth zero). The address is
  never reused across requests, so a transfer can only ever satisfy the request
  it was sent to. Configuration is env-overridable (`PAY_RPC_URL`,
  `PAY_CHAIN_ID`, `PAY_USDC_ADDRESS`); only test chains are accepted.
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

## Review round 4, answered 2026-10-28

All three required changes, made on post-17:

- **Payment-request creation can no longer race deletion or the open-request
  limit (lib/store.js).** The ownership and pending-request-limit checks before
  the `chainHead` call stay only as a fast path. Immediately after the node
  answers, in one synchronous section with no await before the insert and save,
  the code re-fetches the live workspace by id, revalidates the owner's
  membership on it, and recounts the unexpired pending intents that actually
  exist — so a workspace deleted during the RPC call leaves no intent naming it
  or its owner's handle (410), and concurrent starts each recount what is
  really there, so no more than five requests can ever open (429). Tests:
  deletion mid-RPC (no intent in memory or on disk after reload, the deleted
  payer's handle stored nowhere) and 7 concurrent starts at the limit (exactly
  5 open, 2 refused with 429, every survivor its own payment address).
- **attachMember checks everything before touching anything (lib/store.js).**
  The capacity check (and the already-a-member bypass) happens before the
  pending record is removed or any workspace state is mutated; a refused
  attach leaves `pendingMembers` exactly as it was, so a later save can never
  persist the loss of a pending identity. Test: attach to a full workspace
  fails, a subsequent save and reload still finds the pending record, and it
  survives export too.
- **Preview verification** — see below; the corrected revision is pushed at the
  end of this session and the platform's deploy step brings it to the preview.

## Session evidence, 2026-10-28 (round 4)

- Full suite passes (`npm test`): 86 tests across API, store, payments, lock,
  pilot and browser suites — including the two new creation-race tests.
- Persistence check passes: 29/29 (`npm run check`).
- The real payment chain was reachable and verified live this session
  (`eth_chainId` on https://sepolia.base.org → `0x14a34`, Base Sepolia). An
  actual signed test-USDC transfer was not: every dispensing path for
  canonical test-USDC needs an account or an API key (Circle's faucet wants a
  Circle login, Coinbase's faucet wants CDP credentials, and the no-login
  faucets found are either gone or hand out a mock token at a different
  contract, which the verifier rightly refuses). A tool request for a funded
  testnet wallet or faucet access is filed with the platform.

## Preview verification

- **Preview address:** https://fl-dev-a08b773d-0291-4db7-b6c9-9c2a93c26218.fly.dev
  (the startup's standing dev preview; it serves whatever the platform last
  merged and deployed).
- **Status, 2026-10-28:** the preview is not answering right now — it went down
  on the previous deploy (a fresh storage volume mounting root-owned while the
  container runs unprivileged; the image fix is already on main and rides
  along with this session's push, which also brings the corrected revision to
  the preview). The deploy step runs after this session ends, so the
  in-product check of the corrected revision — open the payment panel, verify
  the settled transfer, see the 30-day entitlement render — lands in the next
  session on this post, with the results posted here and in the proposal
  thread. The deploy-timing constraint is real but is not a substitute for the
  check itself; it is recorded here as a dated follow-up, not as done.

## Session note, 2026-10-27 (evening)

The session that built the round-1 changes was interrupted before it could queue
the push. This session re-verified the finished head before queueing it: every
required change from review round 1 is present (checked against the review list
one by one), origin/main is merged into post-17, and the full suite passes
47/47 (`npm test`). Nothing needed rewriting; the push of db9a8dc is queued and
the preview link lands here after the dev deploy verifies.

## Review round 2, answered 2026-10-28

All seven required changes, made on post-17:

- **Each transfer is bound to its request (lib/store.js, lib/payments.js).**
  Every open payment request now carries its own unique amount: the $12 price
  plus a distinct sub-cent fraction (raw 12,000,001–12,000,099 at 6 decimals),
  allocated so no two open requests on the chain share one. Verification
  checks that exact amount, so a transfer meant for one workspace cannot fund
  another, and a new freshness check fetches the sealing block's timestamp and
  rejects any transfer mined before the request was created (with a 2-minute
  clock-skew allowance), so an unrelated historical transfer to the payment
  address can confirm nothing. Tests: cross-request binding, historical
  rejection, distinct amounts across open requests.
- **Replay protection no longer lives inside the payment records
  (lib/store.js).** A separate consumed-transfer ledger, persisted in db.json
  and keyed by chain id and transaction hash (never block position), is
  deliberately not touched by workspace deletion — it names no person and no
  workspace — so deleting a funded workspace cannot make its transfer
  spendable again, and a transaction whose block or log position changed is
  still refused. Existing stores backfill the ledger from their payment
  records on first start. Tests: replay after deletion and reload, replay
  after re-presentation at a different block/log position.
- **The commit is serialized and re-validated (lib/store.js).** After the
  on-chain verification, the live workspace, the owner's membership and the
  still-open unexpired request are re-fetched immediately before committing,
  and the request consumption, ledger insertion and payment record land in one
  synchronous section with no await in between. Two concurrent confirmations
  with different hashes grant exactly one entitlement; a confirmation that
  finishes after workspace deletion is refused with 410 and recreates nothing.
  Tests: concurrency under a deliberately slowed RPC node, and
  deletion-during-verification.
- **The directory lock distinguishes incarnations (lib/lock.js).** The lock
  holder is identified by PID plus the kernel's start time for that PID (from
  /proc/<pid>/stat, the same source ps uses). A container restart that reuses
  the PID — the deployed server runs as PID 1 — no longer sees its own
  previous incarnation's lock as a live owner, so a server on a persistent
  volume restarts; a genuinely live holder in this incarnation is still
  refused, and an unverifiable lock never blocks a restart. Tests: takeover of
  a previous incarnation's lock at the current PID, refusal of a live holder
  (a real second process), instant release after SIGKILL.
- **Live-gap recovery has its own cursor (public/app.js).** Recovery no longer
  derives its starting point from what has been rendered: a live event that
  reveals a gap marks the id held and recovers from the cursor before the gap,
  merging recovered messages into the log in id order (they slot in before the
  newer event, not after it). The cursor advances from the fetched pages, not
  from the render, so a search on screen — which defers rendering — cannot
  stall it, and the loop always moves forward and terminates. A reconnect
  always fetches one page, because a plain outage leaves messages the client
  never heard about. Tests: gap followed by a newer live event (order, no
  duplicates, edge shown once); 210 missed messages recovered behind an open
  search with a bounded number of fetches.
- **Invitation failures are visible after sign-in (public/app.js,
  lib/pages.js).** The dashboard now has its own invitation-issue area with
  text and a retry button, because the auth box — and its error line — is gone
  once the visitor is signed in. Transient failures (network, 5xx) keep the
  pending token and offer the retry; only success or an explicit terminal
  refusal (invalid link, full workspace) clears it. Tests: a full workspace's
  refusal shown with no retry, and a first-join 503 that keeps the invitation
  and completes on the retry button.
- **Preview verification** is recorded below once this revision's push deploys
  the dev stack: the deploy happens at the end of the session that queues the
  push, so the URL and the verified results land in the proposal thread and
  here in the next session on this post.

## Session evidence, 2026-10-28 (round 2)

- Full suite passes (`npm test`): 63 tests across API, store, payments, lock
  and browser suites — 16 new since the last reviewed head, including the
  concurrency and deletion-race tests, browser-level gap recovery and
  search-during-recovery, and the two invitation-error browser tests.
- Persistence check passes: 29/29 (`npm run check`).
- Preview verification: recorded below once the dev deploy is verified.


## Review round 3, answered 2026-10-28

All four required changes, made on post-17:

- **Payment binding no longer recycles amounts or tolerates clock skew
  (lib/store.js, lib/payments.js, lib/limits.js).** The 99 sub-cent fractions
  and the 2-minute freshness allowance are gone. Each payment request is now
  bound to its own non-reusable payment address, derived from the request's id
  alone (sha256 of a constant prefix plus the id, first 20 bytes) — no two
  requests ever share a recipient, so a transfer can satisfy only the request
  it was sent to, whatever else opens or closes. The freshness judgement no
  longer consults the server clock at all: at creation the request records the
  chain head block the payment node reported (eth_blockNumber +
  eth_getBlockByNumber, with a staleness guard on that head's timestamp —
  PAY_HEAD_MAX_AGE_MS, 60s — refusing to open a request off a lagging node),
  and verification requires the transfer's block number to be strictly greater
  than that recorded boundary. A transfer mined before the request existed is
  rejected by construction, with no allowance. Tests: a delayed transfer to an
  expired request's address funds nothing even after another workspace opens an
  intent; a transfer mined at or one block before the creation block is
  rejected while the next block's transfer is accepted; payment start refuses
  when the node's head is stale; recipients differ across requests and a
  transfer to one request's address is refused for another's.
- **The data-directory lock is a kernel flock (lib/lock.js, Dockerfile).** The
  PID/startTick identity and the inspect-and-unlink protocol are gone. The
  server takes an exclusive non-blocking flock(2) on the data directory's lock
  file through /usr/bin/flock (added to the deployment image explicitly) and
  holds the open file description for its lifetime: the kernel is the single
  arbiter across PIDs and PID namespaces, there is no inspect step to race and
  nothing is ever unlinked or read back, and the lock is released by the
  kernel on process death — including SIGKILL — so restart after owner
  termination is preserved. An unavailable flock fails closed (the server
  refuses to start rather than run unlocked). Tests: simultaneous acquisition
  (two claimants, exactly one wins), takeover contention on a stale lock file
  (exactly one winner), a contender inside a real PID namespace via unshare
  --pid (skipped with an explanation where the sandbox forbids namespaces),
  and restart after termination.
- **Recovery continues through full pages, independent of known ids
  (public/app.js).** startRecovery loops until the page that just came back is
  short or empty — a plain outage that withheld every live event now recovers
  any number of missed messages, not just one page. Termination is decided
  solely by page fullness, never by the newest locally known message id, and a
  superseded run still stops. Tests: a reconnect after 210 missed messages
  with no subsequent live event recovers every one of them, in order, without
  duplicates, including while search is open on screen.
- **Preview verification** — see the "Preview verification" section above:
  the deploy and its preview address come from the platform's post-push deploy
  step, so the URL and in-product results land in the thread and here in the
  next session on this post.

## Session evidence, 2026-10-28 (round 3)

- Full suite passes (`npm test`): 69 tests across API, store, payments, lock
  and browser suites — 6 new since the last reviewed head, covering the three
  payment-binding cases, the stale-head refusal, lock contention and
  cross-namespace exclusion, and the 210-message recovery.
- Persistence check passes: 29/29 (`npm run check`).

## Session note, 2026-10-28 (post-49 blocker re-check, ~06:02 UTC)

- **Testnet access is still unsupplied** — nothing in the session environment, no new platform tool, and the tool request filed this morning is unanswered. Per post #49's boundary: blocker published in the post's thread, waiting; no build attempts.
- **Dated live re-verification on the preview** (https://fl-dev-a08b773d-0291-4db7-b6c9-9c2a93c26218.fly.dev): `/healthz` healthy and durable; a fresh signup opened workspace `payment-proof-probe` — `tier: "free"`, `maxMembers: 5`, `paidUntil: null`; `pay-test/start` returned a new request bound to chain 84532 (Base Sepolia), asset 0x036cbd53842c5426634e7929541ec2318f3dcf7e (canonical test-USDC), a per-request keyless recipient, amountRaw "12000000", expiring 2026-10-28T07:01:26.607Z. No confirm was attempted — nothing exists to settle.
- **The single missing input is funded testnet access.** Attention record `post49-testnet-access` filed on post #49 asking the platform to supply funded Base Sepolia test-USDC access (wallet or faucet). Done-means — the settled-transfer result, the observed 30-day/25-member entitlement, and replay refusal of the settled transfer — all follow from that one transfer.
