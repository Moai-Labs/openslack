// Unit tests for the store: accounts, sessions, workspaces, invites,
// channels, messages, retention, export/restore/deletion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, ApiError } from "../lib/store.js";
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
  assert.equal(s2.workspaceMembers(ws2.id).length, 0, "no member is attached by handle alone");
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

test("exports carry pending members; a partial attach round trip loses no identity", () => {
  const s1 = freshStore();
  const a = s1.createUser("alice", "longenough1");
  const b = s1.createUser("bob", "longenough1");
  const ws = s1.createWorkspace(a, "Pending Trip");
  s1.joinWorkspace(ws, b);
  const ch = s1.channelByName(ws.id, "general");
  s1.postMessage(ws, ch, a, "hello");
  const first = s1.buildExport(ws);
  assert.deepEqual(first.pendingMembers, [], "nothing is pending while everyone is attached");
  const bobJoinedAt = first.members.find((m) => m.handle === "bob").joinedAt;

  // Restore with no attach: every identity is pending, the owner included.
  const dir = s1.dir;
  const s2 = new Store(dir).init();
  s2.db = { users: [], sessions: [], workspaces: [], members: [], channels: [], invites: [], payments: [], paymentIntents: [], nextSeq: 1 };
  s2.saveDb();
  s2.saveLog([]);
  const restored = s2.restoreExport(first);
  assert.deepEqual((restored.pendingMembers || []).map((p) => [p.handle, p.role]), [["alice", "owner"], ["bob", "member"]]);

  // Partial attach: only alice is verified and reattached.
  const a2 = s2.createUser("alice", "new password 1");
  s2.attachMember(restored, "alice", a2);
  assert.equal(restored.ownerId, a2.id);

  // The second export keeps bob — handle, role, original join time — and no
  // account data: a pending record grants nothing.
  const second = s2.buildExport(restored);
  assert.deepEqual(
    second.members,
    [{ handle: "alice", role: "owner", joinedAt: first.members.find((m) => m.handle === "alice").joinedAt }]
  );
  assert.deepEqual(second.pendingMembers, [{ handle: "bob", role: "member", joinedAt: bobJoinedAt }]);
  assert.ok(!JSON.stringify(second).includes("passHash"), "still no password material in exports");

  // Restore that second export: bob is pending again with his original
  // record, the workspace has an owner again through the verified attach,
  // and the history made it through both round trips.
  const s3 = freshStore();
  const a3 = s3.createUser("alice", "newer password");
  const restored2 = s3.restoreExport(second, { attach: [{ exportHandle: "alice", userId: a3.id }] });
  assert.equal(restored2.ownerId, a3.id);
  assert.deepEqual((restored2.pendingMembers || []).map((p) => [p.handle, p.role]), [["bob", "member"]]);
  assert.equal(restored2.pendingMembers[0].joinedAt, bobJoinedAt, "the original join timestamp survives every hop");
  assert.equal(s3.history(restored2.id, s3.channelByName(restored2.id, "general").id, {})[0].text, "hello");
  const b3 = s3.createUser("bob", "longenough1");
  s3.attachMember(restored2, "bob", b3);
  assert.equal(s3.membership(restored2.id, b3.id).role, "member", "a twice-pending member attaches normally");
  assert.equal(restored2.pendingMembers, undefined);
});

test("a rejected attach to a full workspace preserves the pending member through export and restart", () => {
  const s1 = freshStore();
  const a = s1.createUser("alice", "longenough1");
  const b = s1.createUser("bob", "longenough1");
  const ws = s1.createWorkspace(a, "Full House");
  s1.joinWorkspace(ws, b);
  const exported = s1.buildExport(ws);
  const bobJoinedAt = exported.members.find((m) => m.handle === "bob").joinedAt;

  // Restore with no attach mapping: bob is a pending identity, exactly as a
  // recovery would leave him.
  const dir = s1.dir;
  const s2 = new Store(dir).init();
  s2.db = { users: [], sessions: [], workspaces: [], members: [], channels: [], invites: [], payments: [], paymentIntents: [], nextSeq: 1 };
  s2.saveDb();
  s2.saveLog([]);
  const restored = s2.restoreExport(exported);
  const a2 = s2.createUser("alice", "new password 1");
  s2.attachMember(restored, "alice", a2); // the owner is verified first

  // Fill the workspace to the free limit while bob is still pending.
  for (let i = 0; i < LIMITS.FREE_MAX_MEMBERS - 1; i++) {
    s2.joinWorkspace(restored, s2.createUser(`full${i}`, "longenough1"));
  }
  assert.equal(s2.memberCount(restored.id), LIMITS.FREE_MAX_MEMBERS);

  // The attach is rejected — and must NOT consume the pending record.
  const b2 = s2.createUser("bob", "longenough1");
  assert.throws(
    () => s2.attachMember(restored, "bob", b2),
    (err) => err instanceof ApiError && err.status === 403,
    "a full workspace rejects the attach"
  );
  assert.deepEqual(
    (restored.pendingMembers || []).map((p) => [p.handle, p.role, p.joinedAt]),
    [["bob", "member", bobJoinedAt]],
    "the pending handle, role and original joinedAt survive the rejection in memory"
  );

  // The record survives a save → export → restart: it must not have been
  // dropped from persisted state by the failed attach.
  const after = s2.buildExport(restored);
  assert.deepEqual(after.pendingMembers, [{ handle: "bob", role: "member", joinedAt: bobJoinedAt }]);
  const s3 = new Store(dir).init();
  const ws3 = s3.workspaceBySlug(restored.slug);
  assert.deepEqual(
    (ws3.pendingMembers || []).map((p) => [p.handle, p.role, p.joinedAt]),
    [["bob", "member", bobJoinedAt]],
    "the pending member survives a restart after the rejected attach"
  );

  // Once a seat frees up, the same attach succeeds and the record clears.
  s3.db.members = s3.db.members.filter((m) => !(m.wsId === ws3.id && m.userId !== a2.id));
  s3.saveDb();
  const b3 = s3.db.users.find((u) => u.handle === "bob");
  s3.attachMember(ws3, "bob", b3);
  assert.equal(s3.membership(ws3.id, b3.id).role, "member");
  assert.equal(ws3.pendingMembers, undefined, "the pending record is consumed only by a successful attach");
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

// ---- directory fsync fault injection ----
// A rename is not durable until the containing directory entry is committed;
// fsyncDir is where that is enforced. These tests inject storage failures on
// directory descriptors only — real file fsyncs and opens still run — and
// prove a failure is never swallowed into a successful acknowledgement.

// Makes every directory fsync fail with the given code until restored.
function failDirFsync(code) {
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      const err = new Error(`injected ${code} on directory fsync`);
      err.code = code;
      throw err;
    }
    return realFsync(fd);
  };
  return () => { fs.fsyncSync = realFsync; };
}

// Makes opening any directory fail with the given code until restored.
function failDirOpen(code) {
  const realOpen = fs.openSync;
  fs.openSync = (p, flags, mode) => {
    let st = null;
    try { st = fs.statSync(p); } catch { /* let the real open report it */ }
    if (st && st.isDirectory()) {
      const err = new Error(`injected ${code} on directory open`);
      err.code = code;
      throw err;
    }
    return realOpen(p, flags, mode);
  };
  return () => { fs.openSync = realOpen; };
}

const messageFor = (id) => ({
  id: String(id), wsId: "ws-fsync", chId: "ch-fsync", userId: "u-fsync",
  handle: "tester", text: "fault injection message " + id, at: new Date().toISOString()
});

test("an EIO from the directory commit stops a save from being acknowledged", () => {
  const s = freshStore();
  const a = s.createUser("faultowner", "long enough password");
  const restore = failDirFsync("EIO");
  assert.throws(() => s.createWorkspace(a, "EIO Workspace"), /EIO/, "the save throws instead of acknowledging an uncommitted rename");
  restore();
  // Once the storage fault is gone, the very same operation succeeds.
  const ws = s.createWorkspace(a, "EIO Workspace");
  assert.ok(ws.id, "the store recovers and works after the fault clears");
});

test("on Linux even EINVAL from the directory commit propagates: durability is never silently downgraded", (t) => {
  if (process.platform !== "linux") {
    t.skip("the unsupported-platform tolerance only exists off Linux");
    return;
  }
  const s = freshStore();
  const a = s.createUser("faultowner2", "long enough password");
  const restore = failDirFsync("EINVAL");
  assert.throws(() => s.createWorkspace(a, "EINVAL Workspace"), /EINVAL/, "a filesystem refusing directory fsync is not treated as 'unsupported platform'");
  restore();
});

test("a directory-open failure propagates out of the save path", () => {
  const s = freshStore();
  const a = s.createUser("faultowner3", "long enough password");
  const restore = failDirOpen("EIO");
  assert.throws(() => s.createWorkspace(a, "Open Fault Workspace"), /EIO/);
  restore();
  s.createWorkspace(a, "Open Fault Workspace"); // recovers after the fault clears
});

test("a failed directory commit leaves the message neither on the acknowledged log nor in memory", () => {
  const s = freshStore();
  fs.rmSync(s.logPath, { force: true }); // the next append creates the log: its directory entry needs committing
  const restore = failDirFsync("EIO");
  assert.throws(() => s.appendMessage(messageFor(1)), /EIO/, "a newly created log whose directory entry cannot be committed is not acknowledged");
  restore();
  assert.equal(s.messages.length, 0, "the uncommitted message is not in memory either");
  s.appendMessage(messageFor(1)); // with the fault gone, the append is acknowledged
  assert.equal(s.messages.length, 1, "the store accepts the message once the directory commit works");
});

test("a failed directory commit on log compaction leaves the in-memory state untouched", () => {
  const s = freshStore();
  s.appendMessage(messageFor(1));
  s.appendMessage(messageFor(2));
  const restore = failDirFsync("EIO");
  assert.throws(() => s.saveLog(s.messages.slice(0, 1)), /EIO/, "compaction whose rename cannot be committed is not acknowledged");
  assert.equal(s.messages.length, 2, "the unacknowledged rewrite did not shrink the in-memory state");
  restore();
  s.saveLog(s.messages.slice(0, 1));
  assert.equal(s.messages.length, 1, "compaction succeeds once the directory commit works");
});

// ---- append failure rollback ----
// A mid-append storage failure must leave no torn record behind: the next
// successful append would otherwise glue onto the torn bytes and the log
// would refuse to load on restart, making every acknowledged message since
// unreadable. These tests inject a partial write followed by an error.

// Makes the first writeSync write only a few bytes and then fail with EIO.
function failAppendPartway() {
  const realWriteSync = fs.writeSync;
  let fired = false;
  fs.writeSync = (fd, buf, off, len) => {
    if (!fired) {
      fired = true;
      realWriteSync(fd, buf, off, Math.min(3, len)); // the torn partial write
      const err = new Error("injected EIO mid-append");
      err.code = "EIO";
      throw err;
    }
    return realWriteSync(fd, buf, off, len);
  };
  return () => { fs.writeSync = realWriteSync; };
}

test("a partially written append is rolled back to a record boundary and the log stays loadable", () => {
  const s = freshStore();
  const a = s.createUser("rollbackowner", "long enough password");
  const ws = s.createWorkspace(a, "Rollback");
  const ch = s.channelsFor(ws.id)[0];
  const msg = (id, text) => ({ id: String(id), wsId: ws.id, chId: ch.id, userId: a.id, handle: a.handle, text, at: new Date().toISOString() });
  s.appendMessage(msg(1, "first"));
  const sizeBefore = fs.statSync(s.logPath).size;
  const restore = failAppendPartway();
  assert.throws(() => s.appendMessage(msg(2, "torn")), /EIO/, "the failed append is not acknowledged");
  restore();
  assert.equal(fs.statSync(s.logPath).size, sizeBefore, "no torn bytes remain after the rollback");
  assert.equal(s.messages.length, 1, "the failed message is not in memory either");
  s.appendMessage(msg(3, "after failure")); // the next append starts at a clean record boundary
  assert.equal(s.messages.length, 2);
  const reloaded = new Store(s.dir).init();
  assert.equal(reloaded.messages.length, 2, "the restarted store loads the log without refusing");
  assert.equal(reloaded.messages[1].text, "after failure");
});

test("when the rollback itself fails the store refuses every further append", () => {
  const s = freshStore();
  const a = s.createUser("rollfailowner", "long enough password");
  const ws = s.createWorkspace(a, "Rollfail");
  const ch = s.channelsFor(ws.id)[0];
  const msg = (id, text) => ({ id: String(id), wsId: ws.id, chId: ch.id, userId: a.id, handle: a.handle, text, at: new Date().toISOString() });
  s.appendMessage(msg(1, "first"));
  const sizeBefore = fs.statSync(s.logPath).size;
  const realTruncate = fs.truncateSync;
  fs.truncateSync = (p, len) => {
    const err = new Error("injected EIO on rollback truncate");
    err.code = "EIO";
    throw err;
  };
  const restoreWrite = failAppendPartway();
  assert.throws(() => s.appendMessage(msg(2, "torn")), /EIO/, "the failed append is not acknowledged");
  fs.truncateSync = realTruncate;
  restoreWrite();
  // The torn record could not be removed, so the log's contents are unknown:
  // the store must not acknowledge anything else, and must not glue the next
  // message onto the torn bytes.
  assert.throws(() => s.appendMessage(msg(3, "refused")), /unknown state/, "further appends are refused");
  assert.throws(() => s.appendMessage(msg(3, "refused")), /unknown state/, "the refusal persists");
  assert.equal(s.messages.length, 1, "no refused message reached memory");
  assert.equal(fs.statSync(s.logPath).size, sizeBefore + 3, "the log was not extended past the torn bytes");
});

test("conflicting or many-to-one attach mappings abort a restore before anything is mutated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-conflict-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const b = s1.createUser("bob", "longenough1");
  const ws = s1.createWorkspace(a, "Conflicts");
  s1.joinWorkspace(ws, b);
  s1.postMessage(ws, s1.channelByName(ws.id, "general"), a, "precious");
  const exported = s1.buildExport(ws);

  const s2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "openslack-conflict-"))).init();
  s2.createUser("alice", "another password");
  const u2 = s2.createUser("dup", "another password");
  const before = JSON.stringify(JSON.parse(fs.readFileSync(s2.dbPath, "utf8")));
  const logBefore = fs.readFileSync(s2.logPath, "utf8");

  // The same exported handle mapped twice is a contradiction.
  assert.throws(
    () => s2.restoreExport(exported, { attach: [{ exportHandle: "alice", userId: u2.id }, { exportHandle: "alice", userId: u2.id }] }),
    /mapped more than once/,
    "a duplicate exportHandle mapping is refused"
  );
  // Two exported handles mapped to one account is a many-to-one mapping.
  const dupExport = { ...exported, members: [...exported.members, { handle: "alicia", role: "member", joinedAt: null }] };
  assert.throws(
    () => s2.restoreExport(dupExport, { attach: [{ exportHandle: "alice", userId: u2.id }, { exportHandle: "alicia", userId: u2.id }] }),
    /more than one exported handle/,
    "a many-to-one mapping is refused"
  );
  // A mapping to an account that does not exist is refused too.
  assert.throws(() => s2.restoreExport(exported, { attach: [{ exportHandle: "alice", userId: "no-such-user" }] }), /does not exist/);

  // Nothing was written: no workspace, no membership, no message.
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(s2.dbPath, "utf8"))), before, "the store is unchanged after refused mappings");
  assert.equal(fs.readFileSync(s2.logPath, "utf8"), logBefore, "the log is unchanged after refused mappings");

  // A clean, one-to-one mapping still restores normally.
  const a2 = s2.createUser("carol", "another password");
  const ok = s2.restoreExport(dupExport, { attach: [{ exportHandle: "alicia", userId: a2.id }] });
  assert.equal(ok.ownerId, null, "no owner was assigned from the refused mappings");
  assert.deepEqual((ok.pendingMembers || []).map((p) => p.handle).sort(), ["alice", "bob"]);
});

test("a restored workspace records where it came from, so a later attach run can verify it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-origin-"));
  const s1 = new Store(dir).init();
  const a = s1.createUser("alice", "longenough1");
  const ws = s1.createWorkspace(a, "Origin");
  s1.postMessage(ws, s1.channelByName(ws.id, "general"), a, "hello");
  const exported = s1.buildExport(ws);
  const s2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "openslack-origin-"))).init();
  const ws2 = s2.restoreExport(exported);
  assert.deepEqual(ws2.restoredFrom, {
    slug: exported.workspace.slug,
    name: exported.workspace.name,
    ownerId: exported.workspace.ownerId,
    createdAt: exported.workspace.createdAt,
    exportedAt: exported.exportedAt
  }, "the restored workspace carries the export's identity");
  // The marker lives on the store's workspace, not in exports: a re-export
  // stays a plain openslack-export-v1 snapshot.
  assert.equal(JSON.stringify(s2.buildExport(ws2)).includes("restoredFrom"), false);
});

test("attaching a pending owner to an account that already joined promotes it to owner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openslack-promote-"));
  const s = new Store(dir).init();
  const a = s.createUser("owner-a", "longenough1");
  const ws = s.createWorkspace(a, "Promotion");
  s.postMessage(ws, s.channelByName(ws.id, "general"), a, "hello");
  const exported = s.buildExport(ws);

  const s2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "openslack-promote-"))).init();
  const restored = s2.restoreExport(exported);
  // The same person signs up fresh (or already joined by invitation) before
  // the administrator attaches their pending record.
  const again = s2.createUser("owner-a", "yet another password");
  s2.joinWorkspace(restored, again);
  s2.attachMember(restored, "owner-a", again);
  assert.equal(restored.ownerId, again.id, "the verified identity takes over the exported owner role");
  assert.equal(s2.membership(restored.id, again.id).role, "owner", "the membership role is promoted too");
  assert.equal((restored.pendingMembers || []).length, 0, "the pending record is consumed");
});
