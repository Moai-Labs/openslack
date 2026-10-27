# OpenSlack

Private team chat: sign-up accounts, workspaces, channels, live messages and ordinary
invitation links, with server-side history that survives redeploys. Built in the open by
an autonomous agent together with the people who hold its token.

## What works today

- Private accounts: handle + password (salted scrypt), session cookie, no wallet needed.
- Workspaces with a 5-member free tier, invitation links anyone can share.
- Channels (a `#general` is created with every workspace) and live messages over SSE.
- Durable history: every message is fsynced to an append-only log before the sender's
  request is acknowledged; metadata is stored in an atomically replaced JSON file. The
  data directory lives on a mounted volume (`deploy.json`) — a deployment refuses to
  start on storage it cannot verify as a persistent volume, and `/healthz` reports the
  verified `durable` flag — so messages survive SIGKILL, restart and redeploy.
- Owner tools: full JSON export of a workspace, deletion of a workspace and its history.
  `scripts/restore.js` rebuilds a workspace from an export (it takes exclusive
  ownership of the data directory and refuses to run against a live server); members
  regain access only through the administrator's verified `--attach` mapping — handles
  alone never grant access.
- Published limits (history, storage, retention): [docs/limits.md](docs/limits.md).
- `scripts/persistence-check.js` proves the durability story end to end on synthetic
  data: SIGKILL recovery, redeploy survival, restore from export, real deletion. It
  only ever touches an empty (or freshly created) data directory, so it cannot damage
  a live store.

## Running

- `npm test` — unit, end-to-end API and browser-level (jsdom) tests. The server itself
  has no npm dependencies; Node 22 standard library only (jsdom is a dev dependency for
  the browser tests).
- `npm run check` — the persistence check described above.
- `npm start` — serves on `$PORT` (default 3000), storing data in `$DATA_DIR` (default
  `./data`; in production this is the mounted volume, and `/healthz` reports the path).

## How it deploys

- `Dockerfile` builds the product into one container image serving port 3000.
- `deploy.json` runs one public web service with a 1 GB persistent volume mounted for
  message storage.
- `.github/workflows/build.yml` builds, tests and publishes the image per commit and
  records the verdict as `refs/ci/pass|fail/<sha>`.

## What is deliberately out

Voice, file hosting, bots and token gates (deferred by the adopted direction), message
editing, read receipts, real payments (a labelled test-USDC path is the next step).
