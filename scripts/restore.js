// Rebuild a workspace from an OpenSlack export into the store at DATA_DIR.
//
//   node scripts/restore.js <export.json>
//
// Members are re-attached by handle to accounts that exist; the owner can
// reclaim the workspace by signing up with the original owner handle.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("../lib/store");

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

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/restore.js <export.json>");
  process.exit(1);
}

const store = new Store(resolveDataDir()).init();
const exported = JSON.parse(fs.readFileSync(file, "utf8"));
const ws = store.restoreExport(exported);
const messages = store.messages.filter((m) => m.wsId === ws.id).length;
console.log(`restored workspace "${ws.name}" as /w/${ws.slug}`);
console.log(`channels: ${store.channelsFor(ws.id).map((c) => "#" + c.name).join(", ")}`);
console.log(`messages restored: ${messages}`);
console.log(`owner: ${ws.ownerHandle ? `@${ws.ownerHandle} (must sign up to claim)` : "@" + (store.db.users.find((u) => u.id === ws.ownerId) || {}).handle}`);
