# History, storage and retention limits

Published before any real user is invited, as the trust step of the private-team-chat
direction requires. The product enforces these in code (`lib/limits.js`); tests cover each one.

## Accounts

- One account per handle. A handle is 2–30 characters: letters, digits, dots, dashes,
  underscores. Sign-up needs a password of at least 8 characters.
- Passwords are stored as salted scrypt hashes, never in plain text.
- Signing in sets a session cookie that lasts 30 days from your last visit, then expires.
- Accounts are private: no wallet, token or email is needed to join or to chat.

## Workspaces (free tier)

- A workspace holds at most **5 members** while the service is free.
- At most **100 channels** per workspace.
- Only the workspace owner can export or delete a workspace; any member can create
  channels and invite people while there is room.

## Workspaces (paid tier — verified test payments only)

- A workspace can be moved to the paid tier for **$12 per 30 days**, granting up to
  **25 members** and history kept searchable for **365 days** (instead of the free
  tier's 30 days).
- **How a test payment is verified.** The owner opens a payment request in the
  product, which shows exactly what to send: **12 test-USDC** (12,000,000 raw
  units, 6 decimals) of Circle's USDC contract
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` on **Base Sepolia** (chain id
  84532), to the workspace's payment address. The owner sends that transfer from
  any wallet and pastes the transaction hash; the server then verifies the
  receipt read-only through a public JSON-RPC node — the chain id, the asset
  contract (its code is checked to exist on that chain), the recipient, the exact
  amount, and that the transaction settled (receipt status success, transfer log
  present and not reorged away). Only a
  verified, settled transfer grants anything; an unmined or reverted one leaves
  the workspace on the free tier with a clear error, and the request stays open
  for a retry.
- **These payments are labelled tests.** Every record is kind `test` and counts as
  **zero revenue**: the tokens on the test chain have no value and no real money
  moves. The tier line in the product always says "test payment".
- **One transfer, one entitlement.** The verified transaction hash is stored with
  the payment and is refused if it was ever used before, in any workspace, so
  replaying it cannot grant a second entitlement.
- **Real payments stay blocked** until a supported checkout with verified settlement
  exists. There is no way to pay real money in this version.
- The entitlement is per workspace, starts when the transfer verifies, and
  stacks: paying again while the tier is active extends it by 30 more days. When it
  expires the workspace returns to the free tier limits on its own.
- Exports do not carry the entitlement; a restored workspace starts on the free tier.
- Deleting a workspace deletes its payment records with it.

## Search

- Every member can search their workspace's retained history from the product:
  matches across **all channels**, newest first, each hit showing its channel,
  with paging for older matches. Search covers everything retained for the
  workspace (30 days free, 365 days paid), not just the newest page of a
  channel, and never reaches outside the workspace.

## Messages and history

- A message is at most **4,000 characters**.
- Each user may post at most **30 messages per minute**.
- History is retained **30 days** (free tier) or **365 days** (paid tier) and at most
  the **most recent 10,000** (free) or **100,000** (paid) messages per workspace,
  whichever binds first; older messages are pruned automatically.
- Storage is capped at roughly **20 MB of message text per workspace**; when the cap is
  reached the oldest messages are dropped first.
- Deleted messages cannot be recovered once pruned or once the workspace is deleted.

## What is stored, where

- All state lives on the server in one data directory on a persistent volume — not only
  in the running container. A restart or redeploy keeps every message.
- Writes are fsynced before they are acknowledged, so a hard crash loses nothing that
  was confirmed to the sender. A crash mid-write can tear the final log record; the
  next start repairs it (the incomplete tail is dropped, acknowledged messages stay)
  before accepting new writes.
- The deployment refuses to start on storage it cannot verify as a persistent volume:
  `/healthz` reports the checked `durable` flag, and a container-local data path fails
  the deployment instead of silently holding private data it would lose at the next
  deploy.

## Export, restore, deletion

- The owner can download a full JSON export of a workspace (channels, members by
  handle, full message history). Exports contain no password material.
- A workspace can be rebuilt from an export with `node scripts/restore.js
  <export.json>`. The restore command takes exclusive ownership of the data
  directory and refuses to run while the server holds it — a restore against a
  live server would be overwritten by the server's stale in-memory state.
- **Membership recovery is administrator-controlled.** A handle is a public
  identifier, not proof of identity, so signing up (or signing in) with a
  handle from an export grants no access to a restored workspace. Every
  exported member is preserved on the restored workspace as a *pending record*
  with no access. The administrator attaches each pending member to an account
  in the store they have verified out of band, naming both handles:

      node scripts/restore.js export.json --attach alice=alice --attach bob=bob

  (left side: the handle in the export; right side: an account that already
  exists in the store). The first attached owner becomes the workspace owner.
  Pending records are kept until they are attached this way; nothing expires
  them and nothing else can attach them — the capability exists only in the
  restore command, never in the HTTP API.
- Deleting a workspace removes its channels, membership, invites and messages from the
  server immediately; this cannot be undone (keep an export first).

## What this version does not have

Real payments (test-USDC only, zero revenue), voice, file hosting, bots, token gates,
message editing or read receipts. This list matches the adopted direction's deferrals.
