// Rebuild a workspace from an OpenSlack export into the store at DATA_DIR.
//
//   node scripts/restore.js <export.json> [--attach <exportHandle>=<storeHandle> ...]
//
// Administrator tool. It takes exclusive ownership of the data directory and
// refuses to run while the server holds it: the server would overwrite the
// restored workspace from its stale in-memory state on its next save.
//
// Access is never granted by handle alone — a handle is a public identifier,
// not proof of identity. Exported members without an --attach mapping are
// preserved on the workspace as pending records and gain no access. --attach
// maps an exported handle to an account that already exists in this store and
// that you have verified out of band belongs to that person; the first
// attached owner becomes the workspace owner.
//
// Example: the store was wiped and only the export survives. Recreate
// verified accounts for the members, then:
//   node scripts/restore.js export.json --attach alice=alice --attach bob=bob
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Store, ApiError } = require("../lib/store");
const { acquire, LockError } = require("../lib/lock");

function resolveDataDir() {
  const wanted = process.env.DATA_DIR;
  if (wanted) {
    fs.mkdirSync(wanted, { recursive: true });
    return wanted;
  }
  const local = path.join(process.cwd(), "data");
  fs.mkdirSync(local, { recursive: true });
  return local;
}

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node scripts/restore.js <export.json> [--attach <exportHandle>=<storeHandle> ...]");
  process.exit(1);
}
const attachArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--attach") {
    if (!argv[i + 1] || !argv[i + 1].includes("=")) {
      console.error("--attach needs <exportHandle>=<storeHandle>");
      process.exit(1);
    }
    attachArgs.push(argv[++i]);
  }
}

let dirLock;
try {
  dirLock = acquire(resolveDataDir(), "restore", {
    // An unexpected loss (the holder dying without a release) means another
    // process can own the directory while this script is mid-restore. The
    // rewrite must not continue beside a new owner: abort loudly at once.
    // release() in the finally block below is an intentional release and
    // reports nothing.
    onLost: () => {
      console.error("FATAL: the data-directory lock was lost unexpectedly; aborting the restore so the new owner's data cannot be clobbered.");
      process.exit(1);
    }
  });
} catch (err) {
  console.error(err instanceof LockError ? err.message : err);
  console.error("restore refuses to touch a data directory that a running server owns:");
  console.error("the server would overwrite the restored workspace on its next save. Stop the server first.");
  process.exit(1);
}

try {
  // The rewrite below is one synchronous block — nothing can interleave with
  // it — but the holder dying just before it starts would leave us writing
  // beside a new owner, so the liveness is re-checked on the spot.
  if (!dirLock.alive()) throw new Error("the data-directory lock was lost before the restore could start; nothing was written");
  const store = new Store(resolveDataDir()).init();
  const exported = JSON.parse(fs.readFileSync(file, "utf8"));

  // Resolve the administrator's mapping against the accounts in this store.
  const attach = [];
  for (const pair of attachArgs) {
    const eq = pair.indexOf("=");
    const exportHandle = pair.slice(0, eq).trim().toLowerCase().replace(/^@/, "");
    const storeHandle = pair.slice(eq + 1).trim().toLowerCase().replace(/^@/, "");
    const user = store.db.users.find((u) => u.handle === storeHandle);
    if (!user) {
      console.error(`no account "@${storeHandle}" in this store: create and verify the account first, then attach it.`);
      process.exit(1);
    }
    attach.push({ exportHandle, userId: user.id });
  }

  // If the workspace was already restored (a second run with mappings), the
  // command attaches the verified accounts to its pending members instead of
  // creating a duplicate.
  const existing = store.workspaceBySlug(exported.workspace.slug);
  const ws = existing || store.restoreExport(exported, { attach });
  if (existing) {
    for (const a of attach) store.attachMember(ws, a.exportHandle, store.db.users.find((u) => u.id === a.userId));
  }
  const messages = store.messages.filter((m) => m.wsId === ws.id).length;
  const pending = ws.pendingMembers || [];
  console.log(`${existing ? "attached" : "restored"}: workspace "${ws.name}" as /w/${ws.slug}`);
  console.log(`channels: ${store.channelsFor(ws.id).map((c) => "#" + c.name).join(", ")}`);
  console.log(`messages restored: ${messages}`);
  const ownerName = ws.ownerId ? "@" + (store.db.users.find((u) => u.id === ws.ownerId) || {}).handle : "none yet";
  console.log(`owner: ${ownerName}`);
  if (pending.length) {
    console.log("members kept as pending (no access until attached with --attach):");
    for (const p of pending) console.log(`  @${p.handle} (${p.role})`);
  }
} catch (err) {
  if (err instanceof ApiError) console.error(err.message);
  else console.error(err);
  process.exitCode = 1;
} finally {
  dirLock.release();
}
