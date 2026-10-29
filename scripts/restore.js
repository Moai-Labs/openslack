// Rebuild a workspace from an OpenSlack export into the store at DATA_DIR.
//
//   node scripts/restore.js <export.json> [--attach <exportHandle>=<storeHandle> ...]
//                                  [--into <slug>]
//
// Administrator tool. It takes exclusive ownership of the data directory and
// refuses to run while the server holds it: the server would overwrite the
// restored workspace from its stale in-memory state on its next save. The
// exclusivity is an OS-backed flock(2) held by this process for its whole
// lifetime — the kernel grants it to exactly one process and drops it the
// moment that process dies, so there is no stale lock and no pid to misread.
//
// Two distinct operations, never confused:
//   - importing an export: a workspace is rebuilt; every member becomes a
//     pending record with no access. Refused if ANY workspace already uses
//     the export's slug — an unrelated workspace with the same slug must
//     never be mistaken for a previous restore of this export.
//   - attaching pending members (--into <slug>, or a workspace that records
//     a matching restoration identity for this export): the --attach
//     mappings are applied to the named workspace's pending records.
//
// Access is never granted by handle alone — a handle is a public identifier,
// not proof of identity. --attach maps an exported handle to an account that
// already exists in this store and that you have verified out of band belongs
// to that person. Attachment targets must be explicit or verifiably restored
// from the same export; nothing is inferred from a slug alone.
//
// Example: the store was wiped and only the export survives. Recreate
// verified accounts for the members, then:
//   node scripts/restore.js export.json --attach alice=alice --attach bob=bob
// and, if the restored workspace is already there under a changed slug:
//   node scripts/restore.js export.json --into old-name --attach bob=bob
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Store, ApiError } = require("../lib/store");
const lock = require("../lib/lock");

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
const attachArgs = [];
let intoSlug = null;
let file = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--attach") {
    if (!argv[i + 1] || !argv[i + 1].includes("=")) {
      console.error("--attach needs <exportHandle>=<storeHandle>");
      process.exit(1);
    }
    attachArgs.push(argv[++i]);
  } else if (argv[i] === "--into") {
    if (!argv[i + 1]) {
      console.error("--into needs the slug of the workspace to attach to");
      process.exit(1);
    }
    intoSlug = argv[++i];
  } else if (!file) {
    file = argv[i];
  }
}
if (!file) {
  console.error("usage: node scripts/restore.js <export.json> [--attach <exportHandle>=<storeHandle> ...] [--into <slug>]");
  process.exit(1);
}

const dataDir = resolveDataDir();

// Is this workspace verifiably the earlier restore of exactly this export?
// Only a recorded restoration identity counts; a shared slug alone proves
// nothing, since any workspace can hold any slug.
function isRestoredFrom(ws, exported) {
  const r = ws.restoredFrom;
  return !!(r && r.slug === exported.workspace.slug && r.exportedAt && exported.exportedAt && r.exportedAt === exported.exportedAt);
}

function main() {
  const store = new Store(dataDir).init();
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

  // Decide import or attachment — never by slug alone.
  let ws = null;
  let mode = null;
  if (intoSlug) {
    ws = store.workspaceBySlug(intoSlug);
    if (!ws) {
      console.error(`no workspace with slug "${intoSlug}" in this store: --into must name an existing workspace.`);
      process.exit(1);
    }
    mode = "attached into";
  } else {
    const existing = store.workspaceBySlug(exported.workspace.slug);
    if (!existing) {
      mode = "restored";
    } else if (isRestoredFrom(existing, exported)) {
      ws = existing;
      mode = "attached";
    } else {
      console.error(`a workspace with the slug "${exported.workspace.slug}" already exists in this store, and it is not a recorded restore of this export.`);
      console.error("Refusing to guess: an unrelated workspace with the same slug must not be modified or shadowed.");
      console.error(`To attach pending members to an explicit target, re-run with --into <slug>. To import anyway, the export's slug must be free.`);
      process.exit(1);
    }
  }
  if (!ws) ws = store.restoreExport(exported, { attach });
  else {
    if (!attach.length) {
      console.error("nothing to attach: give --attach exportHandle=storeAccount mappings.");
      process.exit(1);
    }
    // The whole batch is validated before anything is applied: a duplicate
    // handle, a many-to-one account, a missing pending record, a seat that
    // does not fit or a second owner must refuse the batch whole, leaving
    // the workspace's metadata and pending memberships untouched.
    try {
      store.attachMembers(ws, attach);
    } catch (err) {
      console.error(err.message);
      console.error("The attachment batch was refused: nothing was attached and no pending record was consumed.");
      process.exit(1);
    }
  }
  const messages = store.messages.filter((m) => m.wsId === ws.id).length;
  const pending = ws.pendingMembers || [];
  console.log(`${mode}: workspace "${ws.name}" as /w/${ws.slug}`);
  console.log(`channels: ${store.channelsFor(ws.id).map((c) => "#" + c.name).join(", ")}`);
  console.log(`messages restored: ${messages}`);
  const ownerName = ws.ownerId ? "@" + (store.db.users.find((u) => u.id === ws.ownerId) || {}).handle : "none yet";
  console.log(`owner: ${ownerName}`);
  if (pending.length) {
    console.log("members kept as pending (no access until attached with --attach):");
    for (const p of pending) console.log(`  @${p.handle} (${p.role})`);
  }
}

if (lock.alreadyHeld(dataDir)) {
  // Re-entered as the flock'd child: hold the lock for the whole run. The
  // kernel releases it when this process exits, so nothing releases it early.
  lock.watchSupervisor();
  try {
    main();
  } catch (err) {
    if (err instanceof ApiError) console.error(err.message);
    else console.error(err);
    process.exitCode = 1;
  }
} else {
  // Started bare: re-run under flock and supervise. If the lock is taken the
  // probe inside runUnderLock throws before anything is touched.
  try {
    lock.runUnderLock(dataDir, "restore");
  } catch (err) {
    console.error(err instanceof lock.LockError ? err.message : err);
    console.error("restore refuses to touch a data directory that a running server owns:");
    console.error("the server would overwrite the restored workspace on its next save. Stop the server first.");
    process.exit(1);
  }
  // The supervisor waits for the flock'd child and exits with its code.
}