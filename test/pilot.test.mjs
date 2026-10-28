// Tests for the pilot measurement: participants, distinct-day activity,
// returns, and the prompted/unprompted distinction, all on synthetic data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pilotReport } from "../scripts/pilot-report.js";

function ts(date, time) {
  return new Date(`${date}T${time || "12:00"}:00Z`).toISOString();
}

function exportWith(messages, members) {
  return {
    format: "openslack-export-v1",
    exportedAt: ts("2026-11-10", "18:00"),
    workspace: { slug: "pilot", name: "Pilot", ownerId: "o", createdAt: ts("2026-11-01") },
    members: members.map((h) => ({ handle: h, role: "member" })),
    channels: [{ name: "general", topic: "", createdAt: ts("2026-11-01") }],
    messages
  };
}

function msg(handle, date, time) {
  return { id: `m-${handle}-${date}-${time || "1200"}`, channel: "general", handle, text: "hello", at: ts(date, time) };
}

test("pilot report counts participants, days and returns", () => {
  const exp = exportWith(
    [
      msg("ann", "2026-11-01"),
      msg("ann", "2026-11-02"),
      msg("ann", "2026-11-03"), // ann: 3 distinct days, returned unprompted
      msg("bob", "2026-11-01"),
      msg("bob", "2026-11-02", "09:00"),
      msg("bob", "2026-11-02", "10:00"), // bob: 2 distinct days, returned
      msg("cat", "2026-11-01") // cat: 1 day, never returned
    ],
    ["ann", "bob", "cat", "idle"] // idle is a member but never posted
  );
  const r = pilotReport(exp, null);
  assert.equal(r.summary.participants, 3); // idle never posted: not a participant
  assert.equal(r.summary.activeAcross3Days, 1); // ann only
  assert.equal(r.summary.returned, 2); // ann and bob
  assert.equal(r.summary.returnedUnprompted, 2); // no prompts recorded
  assert.equal(r.summary.messages, 7);
  assert.deepEqual(r.summary.perDay, [
    { day: "2026-11-01", activeParticipants: 3 },
    { day: "2026-11-02", activeParticipants: 2 },
    { day: "2026-11-03", activeParticipants: 1 }
  ]);
  const ann = r.participants.find((p) => p.handle === "ann");
  assert.deepEqual(ann.days, ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.equal(ann.isMember, true);
  assert.equal(r.participants.find((p) => p.handle === "idle"), undefined);
});

test("day boundary is UTC, not local", () => {
  const exp = exportWith(
    [
      msg("dee", "2026-11-01", "23:30"),
      msg("dee", "2026-11-02", "00:30") // 60 minutes apart, different UTC days
    ],
    ["dee"]
  );
  const r = pilotReport(exp, null);
  assert.equal(r.participants[0].days.length, 2);
  assert.equal(r.summary.activeAcross3Days, 0);
});

test("a prompt within 48h before the first message makes that return prompted", () => {
  const exp = exportWith(
    [
      msg("eli", "2026-11-01"),
      msg("eli", "2026-11-04", "10:00"), // prompted: prompt at 11-03 09:00 is inside 48h
      msg("eli", "2026-11-06", "10:00") // unprompted: no prompt near it
    ],
    ["eli"]
  );
  const prompts = { prompts: [ts("2026-11-03", "09:00")] };
  const r = pilotReport(exp, prompts);
  const eli = r.participants[0];
  assert.deepEqual(eli.returningDays, ["2026-11-04", "2026-11-06"]);
  assert.deepEqual(eli.unpromptedDays, ["2026-11-06"]);
  assert.equal(r.summary.returned, 1);
  assert.equal(r.summary.returnedUnprompted, 1);
  assert.equal(r.promptsRecorded, 1);
});

test("returns before any prompt still count unprompted; bad format throws", () => {
  const exp = exportWith([msg("fay", "2026-11-01"), msg("fay", "2026-11-05")], ["fay"]);
  const r = pilotReport(exp, { prompts: [ts("2026-11-09", "09:00")] });
  assert.deepEqual(r.participants[0].unpromptedDays, ["2026-11-05"]);
  assert.throws(() => pilotReport({ format: "other" }), /openslack-export-v1/);
});
