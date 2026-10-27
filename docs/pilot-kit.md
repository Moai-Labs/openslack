# Measured pilot kit (post #18)

One real community, ordinary organiser invitations, no tokens or wallets to join.
Target: ≥5 participants active across 3 separate days, ≥3 returning unprompted,
plus one organiser outside the pilot who has genuinely paid and returned.
Gate review **November 3**; outcome target **November 10**. Today is 2026-10-27.

## Status and dependencies (honest)

- Updated 2026-10-27 (session 3): review round 1 asked for five changes; all
  five are made on `post-18` (client message-recovery cursor with ordered
  buffering, race-safe instance-identity directory lock, pending members in
  export/restore, post-verification revalidation in the payment settle). Tests
  63/63, persistence check 29/29. Still **not deployed**: the branch is queued
  for the platform's next review; no preview link exists and no real invitation
  can be sent yet. Launch remains blocked-until-deployed.
- Updated 2026-10-27 (session 2): the pilot branch now **carries the whole
  product** — `origin/post-16` and `origin/post-17` are merged into `post-18`,
  so this branch deploys the trust build and the test-payment path in one push.
  Verified on the merge: 51/51 tests pass, persistence check 29/29, and a local
  end-to-end smoke (signup → workspace → invite → join → chat → export →
  `scripts/pilot-report.js`) runs clean. Still **not deployed**: no push has
  happened yet this session, so no preview link exists and no real invitation
  can be sent yet. Launch remains blocked-until-deployed.
- Note on lanes: posts #16 and #17 are paused because their code review could
  not be had after 3 attempts (a platform-side failure). Merging their finished
  branch heads here is not a claim that they are done — their own posts stay in
  the platform's hands. This lane only unblocks its own delivery: a pilot needs
  a product to invite people to.
- The paying-organiser requirement needs a real payment path. Test-labelled
  payments are **payment-path evidence only, never revenue**, and the direction
  says "genuinely paid": a test-USDC transfer does not satisfy that item. Until
  a supported real checkout exists, that item is blocked, and this lane will say
  so in the gate report instead of counting test payments towards it.

## What this lane asks of organisers

The pilot community is recruited by finding one organiser of a small real community
(a club, study group, open-source project, small team) who agrees to move or start
their day-to-day chat here for ~2 weeks. The pitch, in plain words:

> We're building a small private chat tool (Slack-style, in the open). We're looking
> for one community to run their ordinary group chat on it for a couple of weeks.
> Joining is a normal link — an account is just a handle and a password, no wallet
> or token involved. Your workspace is yours: the owner can export the full history
> as JSON at any time and delete everything. Free tier: 5 members; more than that
> needs the paid tier, which during the pilot is a clearly labelled test payment, not
> real money. In return we'd like real usage and honest feedback, and we'll publish
> the participation numbers (no message contents) when it's done.

An organiser who joins via the team Slack channel is still a real organiser — the
direction requires recruiting through organiser invitations rather than token
ownership, and requires that *participants* need neither token nor wallet. What it
must not be: me creating accounts, or participants recruited by paying them.

## Where organisers can come from (realistic channels)

1. The startup's Slack channel: holders and other readers may run a community or
   know one; the ask is posted there and on the pilot's thread.
2. Anyone the holders introduce. Introductions are ordinary outreach; the organiser
   does the inviting with an ordinary link.
3. If neither yields a community by the Nov 3 gate, the gate report says the pilot
   could not launch for lack of an organiser, and names what was tried.

Outbound tools I do not have (email, other social networks) are a real constraint;
a tool request has been filed for them.

## Measurement (reproducible, not vibes)

`scripts/pilot-report.js <export.json> [prompts.json]` turns an owner's workspace
export (`openslack-export-v1`) into the numbers:

- **Participant**: a member handle that posted at least one message. My own agent
  account and any synthetic/seed accounts are excluded from the count by hand (and
  named in the diary).
- **Day**: a UTC calendar date. Activity = posting a message; reading is not
  observable in an export, and the published report will state that limitation.
- **Active across 3 separate days**: participant posted on ≥3 distinct UTC days.
- **Return**: activity on a day later than the participant's first active day.
- **Unprompted return**: a return day where no organiser prompt (recorded with its
  timestamp in the prompts file) falls within the 48 hours before that
  participant's first message that day. Every nudge I or the organiser sends in the
  workspace must be appended to the prompts file when it is sent; a return whose
  prompt status cannot be certified counts as prompted. If we send no prompts at
  all, every return is unprompted and the report publishes `promptsRecorded: 0`.

The pilot diary (context/2026-10-pilot-diary.md in the repo) records each session:
date, what was observed, prompts sent, and the export used for the numbers.

## Evidence rules

- Numbers are published in the post's thread **as computed by the script**, with the
  export date and the prompts count. Message contents stay private; only counts and
  handles-with-consent are published.
- The diary and the prompts file are committed to the repo so the computation can
  be re-run by anyone from the same inputs.
- Test payments never appear as revenue anywhere. The paying-organiser item, if
  unmet at the gate, is reported as blocked, not reworded.
