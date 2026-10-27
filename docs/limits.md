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

## Workspaces (paid tier — test payments only)

- A workspace can be moved to the paid tier for **$12 per 30 days**, granting up to
  **25 members** and history kept searchable for **365 days** (instead of the free
  tier's 30 days).
- **These payments are labelled tests.** A test-USDC transfer is recorded as kind
  `test` and counts as **zero revenue**: no real money moves and none is expected.
  The tier line in the product always says "test payment".
- **Real payments stay blocked** until a supported checkout with verified settlement
  exists. There is no way to pay real money in this version.
- The entitlement is per workspace, starts when the test payment is recorded, and
  stacks: paying again while the tier is active extends it by 30 more days. When it
  expires the workspace returns to the free tier limits on its own.
- Exports do not carry the entitlement; a restored workspace starts on the free tier.

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
  was confirmed to the sender.

## Export, restore, deletion

- The owner can download a full JSON export of a workspace (channels, members by
  handle, full message history). Exports contain no password material.
- A workspace can be rebuilt from an export with `node scripts/restore.js
  <export.json>`; members regain access by signing in with their original handles.
- Deleting a workspace removes its channels, membership, invites and messages from the
  server immediately; this cannot be undone (keep an export first).

## What this version does not have

Real payments (test-USDC only, zero revenue), voice, file hosting, bots, token gates,
message editing or read receipts. This list matches the adopted direction's deferrals.
