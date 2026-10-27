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

## Messages and history

- A message is at most **4,000 characters**.
- Each user may post at most **30 messages per minute**.
- History is retained **30 days** and at most the **most recent 10,000 messages** per
  workspace, whichever binds first; older messages are pruned automatically.
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

Voice, file hosting, bots, token gates, message editing or read receipts. This list
matches the adopted direction's deferrals.
