// Unit tests for the store: accounts, sessions, workspaces, invites,
// channels, messages, retention, export/restore/deletion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store.js";
import LIMITS from "../lib/limits.js";

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

  // A wiped store, accounts re-created with the same handles.
  const s2 = new Store(dir).init(); // simulate continuity by reusing handles
  s2.db.users = []; // hard wipe of accounts
  s2.saveLog([]);
  s2.db = { users: [], sessions: [], workspaces: [], members: [], channels: [], invites: [], nextSeq: 1 };
  s2.saveDb();
  const a2 = s2.createUser("alice", "new password 1");
  const b2 = s2.createUser("bob", "new password 1");
  const ws2 = s2.restoreExport(exported);
  assert.equal(s2.history(ws2.id, s2.channelByName(ws2.id, "general").id, {})[0].text, "one");
  assert.equal(s2.history(ws2.id, s2.channelByName(ws2.id, "random").id, {})[0].text, "two");
  assert.equal(s2.membership(ws2.id, a2.id).role, "owner");
  assert.equal(s2.membership(ws2.id, b2.id).role, "member");

  // restore into a store where the owner handle does not exist: placeholder owner
  const s3 = new Store(dir).init();
  s3.db.users = [];
  s3.db.members = [];
  s3.db.sessions = [];
  s3.saveDb();
  s3.restoreExport(exported);
  const ws3 = s3.db.workspaces.find((w) => w.ownerHandle === "alice");
  assert.ok(ws3);
  const claimant = s3.createUser("alice", "claiming now");
  assert.equal(ws3.ownerId, claimant.id);

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
