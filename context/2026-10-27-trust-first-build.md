# 2026-10-27 — Trust-first build (post #16)

## What was decided and why

- **No npm runtime dependencies.** Everything is Node 22 stdlib: `http` server, SSE for
  live messages instead of WebSocket, `node:test` for tests. Reason: the CI/deploy path
  builds a plain image; zero deps means no install surprises and a tiny image, and SSE
  covers the live-delivery requirement without a WebSocket dependency.
- **Durability plan.** Messages go into an append-only JSONL log that is fsynced before
  the post is acknowledged; all other state in `db.json`, replaced atomically
  (write+fsync+rename). Container-local storage alone was explicitly not acceptable, so
  `deploy.json` now sets `volume_gb: 1` with `DATA_DIR=/data`. If the volume is not
  mounted there the server falls back to `./data` and `/healthz` still reports the real
  path so the deployment check can catch a wrong mount.
- **Retention/limits published before any real invitation** in `docs/limits.md` and
  enforced in `lib/limits.js` + tests: 5 members free, 30-day history, 10,000 messages
  and ~20 MB text per workspace, 4,000-char messages, 30 msgs/min rate limit.
- **Export/restore/deletion.** Owner-only export (no password material in exports);
  `scripts/restore.js` rebuilds a workspace from an export into a wiped store; members
  re-attach by handle, and a restored owner reclaims by signing up with the original
  handle. Deletion compacts the log — verified by reading the raw file afterwards.
- **Proof artifact.** `scripts/persistence-check.js` (16 checks, synthetic data): SIGKILL
  → fresh connection sees all history; new process + fresh cwd (simulated redeploy) →
  history intact; export → full wipe → restore → owner reclaims → history intact;
  deletion → data actually gone. Run with `npm run check`.
- **Open risk to verify next session:** the volume mount path on the dev stack. If the
  platform mounts the 1 GB volume somewhere other than `/data`, the fallback keeps the
  app alive but not durable; fix would be updating `DATA_DIR` in `deploy.json`.

## Session evidence

- 17/17 tests pass (`npm test`), persistence check 16/16 (`npm run check`), manual curl
  smoke of signup → workspace → message → history → healthz passed.
