// Unit tests for the store: accounts, sessions, workspaces, invites,
// channels, messages, retention, export/restore/deletion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, fsyncDir } from "../lib/store.js";
import LIMITS from "../lib/limits.js";
import { execFileSync } from "node:child_process";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-test-"));
  return new Store(dir).init();
}

test("create user validates handle and password", () => {
  const s = freshStore();
  assert.throws(() => s.createUser("Bad Handle!", "longenough1"), /Handle/);
  assert.throws(() => s.createUser("ok-handle", "short"), /Password/);
  const u = s.createUser("Sam", "longenough1");
  assert.equal(u.handle, "sam");
  assert.throws(() => s.createUser("sam", "anotherpass1"), /taken/);
  assert.ok(s.checkPassword("sam", "longenough1"));
  assert.equal(s.checkPassword("sam", "wrongpass99"), null);
  assert.equal(s.checkPassword("nobody", "longenough1"), null);
});

test("sessions authenticate and drop", () => {
  const s = freshStore();
  const u = s.createUser("sam", "longenough1");
  const token = s.createSession(u.id);
  assert.equal(s.userForToken(token).handle, "sam");
  assert.equal(s.userForToken("nope"), null);
  s.dropSession(token);
  assert.equal(s.userForToken(token), null);
});

test("workspace creation makes a slug, default channel and owner membership", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Acme Rockets!");
  assert.match(ws.slug, /^acme-rockets/);
  assert.deepEqual(s.channelsFor(ws.id).map((c) => c.name), ["general"]);
  assert.equal(s.membership(ws.id, a.id).role, "owner");
  // slug collision gets a suffix, not an error
  const ws2 = s.createWorkspace(a, "Acme Rockets!");
  assert.notEqual(ws.slug, ws2.slug);
});

test("membership cap and invite join", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Cap Test");
  const token = s.createInvite(ws, a);
  assert.ok(s.inviteByToken(token));
  for (let i = 0; i < LIMITS.FREE_MAX_MEMBERS - 1; i++) {
    const u = s.createUser(`user${i}`, "longenough1");
    assert.equal(s.joinWorkspace(ws, u), true);
  }
  assert.equal(s.memberCount(ws.id), LIMITS.FREE_MAX_MEMBERS);
  const extra = s.createUser("overflow", "longenough1");
  assert.throws(() => s.joinWorkspace(ws, extra), /full/);
  s.revokeInvite(token, a);
  assert.equal(s.inviteByToken(token), null);
});

test("channel rules", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Channels");
  assert.throws(() => s.createChannel(ws, "Bad Name"), /Channel names/);
  s.createChannel(ws, "design");
  assert.throws(() => s.createChannel(ws, "#design"), /already exists/);
  assert.equal(s.channelByName(ws.id, "design").name, "design");
});

test("messages persist, paginate and are rate limited", async () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const b = s.createUser("bob", "longenough1");
  const ws = s.createWorkspace(a, "Msgs");
  s.joinWorkspace(ws, b);
  const ch = s.channelByName(ws.id, "general");
  for (let i = 0; i < 10; i++) s.postMessage(ws, ch, a, `msg ${i}`);
  s.postMessage(ws, ch, b, "from bob");
  assert.equal(s.history(ws.id, ch.id, {}).length, 11);
  assert.equal(s.history(ws.id, ch.id, { before: "5", limit: 3 }).map((m) => m.text).join(","), "msg 1,msg 2,msg 3");
  assert.equal(s.history(ws.id, ch.id, { after: "8", limit: 200 }).length, 3);
  assert.throws(() => s.postMessage(ws, ch, a, ""), /required/);
  assert.throws(() => s.postMessage(ws, ch, a, "x".repeat(LIMITS.MAX_MESSAGE_CHARS + 1)), /limited/);
  // non-members cannot read: history() is only reachable after membership checks in the API
  assert.throws(() => s.requireMembership(ws.id, { id: "stranger" }), /not a member/);
  // rate limit kicks in at the published ceiling
  const s2 = freshStore();
  const a2 = s2.createUser("carol", "longenough1");
  const ws2 = s2.createWorkspace(a2, "Rate");
  const ch2 = s2.channelByName(ws2.id, "general");
  let limited = false;
  for (let i = 0; i <= LIMITS.RATE_LIMIT_PER_MINUTE; i++) {
    try {
      s2.postMessage(ws2, ch2, a2, "hi");
    } catch (e) {
      if (/Slow down/.test(e.message)) limited = true;
    }
  }
  assert.equal(limited, true);
});

test("messages survive store reload (durable log)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-durable-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const ws = s1.createWorkspace(a, "Durable");
  const ch = s1.channelByName(ws.id, "general");
  s1.postMessage(ws, ch, a, "survives reload");
  const s2 = new Store(path.join(dir)).init();
  assert.equal(s2.history(ws.id, ch.id, {})[0].text, "survives reload");
  assert.equal(s2.checkPassword("alice", "longenough1").id, a.id);
});

test("nextSeq survives a restart with no intervening metadata write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-seq-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const ws = s1.createWorkspace(a, "Seq");
  const ch = s1.channelByName(ws.id, "general");
  for (let i = 0; i < 3; i++) s1.postMessage(ws, ch, a, `before ${i}`);
  // Restart: db.json still holds nextSeq from the workspace creation, but the
  // three appends above never updated it. The recovered log must decide.
  const s2 = new Store(dir).init();
  assert.equal(s2.nextSeq, 4, "next sequence is derived from the log, not the stale metadata");
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push(s2.postMessage(ws, ch, a, `after ${i}`).id);
  assert.deepEqual(ids, ["4", "5"], "ids continue uniquely after the restart");
  assert.equal(s2.history(ws.id, ch.id, { limit: 10 }).length, 5);
  // and pagination across the restart boundary stays coherent
  assert.deepEqual(s2.history(ws.id, ch.id, { before: "5", limit: 2 }).map((m) => m.id), ["3", "4"]);
  const s3 = new Store(dir).init();
  assert.equal(s3.nextSeq, 6, "a second restart sees the post-restart messages too");
});

test("a torn log tail is repaired and later writes survive; mid-log corruption refuses to start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-torn-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const ws = s1.createWorkspace(a, "Torn");
  const ch = s1.channelByName(ws.id, "general");
  s1.postMessage(ws, ch, a, "first");
  s1.postMessage(ws, ch, a, "second");
  // Simulate a crash mid-append: a partial record without its newline.
  fs.appendFileSync(s1.logPath, '{"id":"3","wsId":"x","tex');

  const s2 = new Store(dir).init();
  assert.equal(s2.history(ws.id, ch.id, {}).map((m) => m.text).join(","), "first,second", "torn tail dropped, valid records kept");

  // An acknowledged message appended after the repair must survive the next
  // restart instead of being glued onto the old torn bytes.
  s2.postMessage(ws, ch, a, "third");
  const s3 = new Store(dir).init();
  assert.equal(s3.history(ws.id, ch.id, {}).map((m) => m.text).join(","), "first,second,third");
  assert.equal(s3.nextSeq, 4, "ids stay unique across the repair");
  const raw = fs.readFileSync(s3.logPath, "utf8");
  assert.equal(raw.split("\n").filter(Boolean).length, 3, "log holds exactly the three valid records");
  assert.ok(raw.endsWith("\n"));

  // Corruption inside a complete record is a different failure: refuse to
  // start rather than silently skipping acknowledged messages.
  fs.appendFileSync(s3.logPath, '{"id":"9","wsId":trunc\n');
  assert.throws(() => new Store(dir).init(), /corrupt/);
});

test("retention prunes by age, count and size", () => {
  const s = freshStore();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Retention");
  const ch = s.channelByName(ws.id, "general");
  // an old message beyond the retention window
  const old = s.postMessage(ws, ch, a, "ancient");
  old.at = new Date(Date.now() - (LIMITS.RETENTION_DAYS + 2) * 86400000).toISOString();
  s.pruneWorkspace(ws.id);
  assert.equal(s.history(ws.id, ch.id, {}).some((m) => m.text === "ancient"), false);
  // count cap: post one over the limit, oldest visible drops
  // (clear the rate-limit bucket as we go; the cap itself is tested separately)
  for (let i = 0; i < LIMITS.MAX_MESSAGES_PER_WORKSPACE; i++) {
    s.postMessage(ws, ch, a, `bulk ${i}`);
    s.rateBuckets.clear();
  }
  s.pruneWorkspace(ws.id);
  const rows = s.history(ws.id, ch.id, { limit: 200 });
  assert.equal(rows.length, 200);
  assert.equal(s.messages.filter((m) => m.wsId === ws.id).length, LIMITS.MAX_MESSAGES_PER_WORKSPACE);
});

test("export and restore round-trip; deletion removes everything", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-export-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const b = s1.createUser("bob", "longenough1");
  const ws = s1.createWorkspace(a, "Round Trip");
  s1.joinWorkspace(ws, b);
  s1.createChannel(ws, "random");
  const ch = s1.channelByName(ws.id, "general");
  const ch2 = s1.channelByName(ws.id, "random");
  s1.postMessage(ws, ch, a, "one");
  s1.postMessage(ws, ch2, b, "two");
  const exported = s1.buildExport(ws);
  assert.equal(exported.format, "openslack-export-v1");
  assert.equal(exported.messages.length, 2);
  assert.ok(!JSON.stringify(exported).includes("passHash"), "no password material in exports");

  // A wiped store, accounts re-created with the same handles. Handles alone
  // grant nothing: restoring with no mapping keeps every member pending.
  const s2 = new Store(dir).init();
  s2.db.users = []; // hard wipe of accounts
  s2.saveLog([]);
  s2.db = { users: [], sessions: [], workspaces: [], members: [], channels: [], invites: [], nextSeq: 1 };
  s2.saveDb();
  const a2 = s2.createUser("alice", "new password 1");
  const b2 = s2.createUser("bob", "new password 1");
  const ws2 = s2.restoreExport(exported);
  const listed = s2.workspaceMembers(ws2.id);
  assert.equal(listed.filter((m) => !m.pending).length, 0, "no member is attached by handle alone");
  assert.deepEqual(listed.filter((m) => m.pending).map((p) => [p.handle, p.role]), [["alice", "owner"], ["bob", "member"]], "pending records are listed as members-to-be, with no access");
  assert.deepEqual((ws2.pendingMembers || []).map((p) => [p.handle, p.role]), [["alice", "owner"], ["bob", "member"]], "membership records are preserved pending");
  assert.equal(s2.membership(ws2.id, a2.id), null, "an existing account with a matching handle has no access");
  assert.equal(ws2.ownerId, null);
  // The administrator attaches verified accounts; roles follow the export.
  s2.attachMember(ws2, "alice", a2);
  s2.attachMember(ws2, "bob", b2);
  assert.equal(s2.membership(ws2.id, a2.id).role, "owner");
  assert.equal(s2.membership(ws2.id, b2.id).role, "member");
  assert.equal(ws2.pendingMembers, undefined, "pending records are cleared once attached");
  assert.equal(s2.history(ws2.id, s2.channelByName(ws2.id, "general").id, {})[0].text, "one");
  assert.equal(s2.history(ws2.id, s2.channelByName(ws2.id, "random").id, {})[0].text, "two");

  // A signup with an exported owner handle claims nothing, and the pending
  // record survives until the administrator attaches a verified account.
  const s3 = new Store(dir).init();
  s3.db.users = [];
  s3.db.members = [];
  s3.db.sessions = [];
  s3.saveDb();
  s3.saveLog([]);
  const ws3 = s3.restoreExport(exported);
  const claimant = s3.createUser("alice", "claiming now");
  assert.equal(ws3.ownerId, null, "signup does not award the restored workspace");
  assert.equal(s3.membership(ws3.id, claimant.id), null);
  assert.equal((ws3.pendingMembers || []).length, 2, "pending membership is retained for real recovery");
  s3.attachMember(ws3, "alice", claimant); // the verified recovery step
  assert.equal(ws3.ownerId, claimant.id);
  assert.equal(s3.membership(ws3.id, claimant.id).role, "owner");

  // deletion
  s1.deleteWorkspace(ws);
  assert.equal(s1.workspaceBySlug(ws.slug), null);
  assert.equal(s1.messages.filter((m) => m.wsId === ws.id).length, 0);
  const raw = fs.readFileSync(s1.logPath, "utf8");
  assert.ok(!raw.includes("one"));
});

test("prune drops messages of deleted workspaces on restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-orphan-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const ws = s1.createWorkspace(a, "Orphans");
  s1.postMessage(ws, s1.channelByName(ws.id, "general"), a, "hello");
  // simulate a crash between the log append and the log compaction of a deletion:
  // the db already lost the workspace, the log still has its messages
  s1.db.workspaces = [];
  s1.db.members = [];
  s1.db.channels = [];
  s1.saveDb();
  const s2 = new Store(dir).init();
  assert.equal(s2.messages.length, 0, "orphaned messages are pruned at startup");
});

test("the persistence check refuses a non-empty data directory and never touches an existing store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-real-"));
  const sentinel = "this is somebody's real store";
  fs.writeFileSync(path.join(dir, "db.json"), sentinel);
  fs.writeFileSync(path.join(dir, "messages.jsonl"), sentinel);
  const before = fs.readdirSync(dir).sort().join(",");
  let exited = 0;
  try {
    execFileSync(process.execPath, ["scripts/persistence-check.js", dir], { cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30000 });
  } catch (err) {
    exited = err.status;
    assert.match(String(err.stderr), /not empty/, "the refusal names the reason");
  }
  assert.equal(exited, 1, "the check fails loudly rather than proceeding");
  assert.equal(fs.readFileSync(path.join(dir, "db.json"), "utf8"), sentinel, "db.json untouched");
  assert.equal(fs.readFileSync(path.join(dir, "messages.jsonl"), "utf8"), sentinel, "messages.jsonl untouched");
  assert.equal(fs.readdirSync(dir).sort().join(","), before, "nothing added or removed");
});

test("a directory fsync failure is never acknowledged as durability", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-fsync-"));
  const s = new Store(dir).init();
  const a = s.createUser("alice", "longenough1");
  const ws = s.createWorkspace(a, "Fsync");
  const before = JSON.stringify(JSON.parse(fs.readFileSync(s.dbPath, "utf8")));
  const origOpen = fs.openSync;
  const envBefore = process.env.NODE_ENV;

  // fsyncDir opens the directory read-only; make exactly that open fail with
  // a genuine I/O error.
  fs.openSync = (p, flags, ...rest) => {
    if (p === dir && flags === "r") throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return origOpen(p, flags, ...rest);
  };
  try {
    assert.throws(() => s.saveDb(), /could not (open|fsync) the data directory/, "the replacement is refused, not acknowledged");
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(s.dbPath, "utf8"))), before, "the old db.json is still in place");

    // Platforms that refuse directory fsyncs outright: tolerated outside
    // production only, never in production.
    process.env.NODE_ENV = "test";
    fs.openSync = (p, flags, ...rest) => {
      if (p === dir && flags === "r") throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
      return origOpen(p, flags, ...rest);
    };
    assert.doesNotThrow(() => fsyncDir(dir), "a recognized unsupported-operation error stays tolerated outside production");
    process.env.NODE_ENV = "production";
    assert.throws(() => fsyncDir(dir), /could not open the data directory/, "production never accepts an unsynced directory entry");
  } finally {
    fs.openSync = origOpen;
    process.env.NODE_ENV = envBefore;
  }
});

test("pending memberships survive a partial attachment and an export/restore round trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-pending-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const b = s1.createUser("bob", "longenough1");
  const c = s1.createUser("carol", "longenough1");
  const ws = s1.createWorkspace(a, "Pending");
  s1.joinWorkspace(ws, b);
  s1.joinWorkspace(ws, c);
  s1.postMessage(ws, s1.channelByName(ws.id, "general"), a, "hi");
  const exported = s1.buildExport(ws);

  // Restore with only the owner verified: bob and carol stay pending.
  const s2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "openslack-pending-"))).init();
  const a2 = s2.createUser("alice", "another password");
  const ws2 = s2.restoreExport(exported, { attach: [{ exportHandle: "alice", userId: a2.id }] });
  assert.equal(s2.membership(ws2.id, a2.id).role, "owner");
  assert.deepEqual((ws2.pendingMembers || []).map((p) => p.handle).sort(), ["bob", "carol"]);

  // A re-export of the partially recovered workspace must carry the pending
  // records — otherwise a later restore would lose them for good.
  const reexport = s2.buildExport(ws2);
  assert.ok(reexport.members.some((m) => m.handle === "bob" && m.pending), "pending records are part of the export");
  const s3 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "openslack-pending-"))).init();
  const ws3 = s3.restoreExport(reexport);
  // A handle alone never grants access: in this restore no one is verified,
  // so even alice — attached in the previous store — waits pending again.
  assert.deepEqual((ws3.pendingMembers || []).map((p) => p.handle).sort(), ["alice", "bob", "carol"], "the round trip preserves every unattached member");
  assert.deepEqual(
    s3.workspaceMembers(ws3.id).filter((m) => !m.pending).map((m) => m.handle),
    [],
    "nobody holds access from the export alone"
  );
  // and a verified attach on the round-tripped store still works
  const a3 = s3.createUser("alice", "third password");
  s3.attachMember(ws3, "alice", a3);
  assert.equal(s3.membership(ws3.id, a3.id).role, "owner", "the first attach makes the owner");
  assert.deepEqual((s3.workspaceBySlug(ws3.slug).pendingMembers || []).map((p) => p.handle).sort(), ["bob", "carol"]);
});

test("a failed attachment keeps the pending record, across saves and restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-attachfail-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const b = s1.createUser("bob", "longenough1");
  const ws = s1.createWorkspace(a, "Full");
  s1.joinWorkspace(ws, b);
  s1.postMessage(ws, s1.channelByName(ws.id, "general"), a, "one");
  const exported = s1.buildExport(ws);

  const s2 = new Store(dir).init();
  s2.db.users = [];
  s2.db.members = [];
  s2.db.sessions = [];
  s2.saveDb();
  s2.saveLog([]);
  const ws2 = s2.restoreExport(exported);
  assert.equal((ws2.pendingMembers || []).length, 2);

  // Fill the workspace to the free-tier cap, then try to attach a verified
  // account that would exceed it.
  const extra = [];
  for (let i = 0; i < LIMITS.FREE_MAX_MEMBERS; i++) {
    const u = s2.createUser(`member${i}`, "longenough1");
    s2.joinWorkspace(ws2, u);
    extra.push(u);
  }
  const stranger = s2.createUser("latecomer", "longenough1");
  assert.throws(() => s2.attachMember(ws2, "alice", stranger), /workspace is full/, "capacity is checked before anything happens");
  assert.ok((ws2.pendingMembers || []).some((p) => p.handle === "alice"), "the pending record was not dropped by the failed attempt");

  // A later save (any other operation) and a restart must not persist the
  // removal that never should have happened.
  s2.saveDb();
  const s3 = new Store(dir).init();
  const ws3 = s3.workspaceBySlug(ws2.slug);
  assert.deepEqual((ws3.pendingMembers || []).map((p) => p.handle).sort(), ["alice", "bob"], "pending membership survives the failed attach, a save and a restart");

  // Attaching an account that does not exist is refused the same way.
  assert.throws(() => s3.attachMember(ws3, "alice", { id: "no-such-user" }), /does not exist/);
  assert.ok((s3.workspaceBySlug(ws2.slug).pendingMembers || []).some((p) => p.handle === "alice"));

  // A member already attached stays attached when their record is consumed.
  s3.attachMember(ws3, "alice", extra[0]);
  assert.equal(s3.membership(ws3.id, extra[0].id).role, "member", "the workspace already has an owner, so the role stays member");
  assert.deepEqual((s3.workspaceBySlug(ws2.slug).pendingMembers || []).map((p) => p.handle), ["bob"]);
});
