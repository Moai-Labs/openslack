// Pilot report: turns a workspace export (openslack-export-v1) into the
// numbers the measured pilot is judged on.
//
//   node scripts/pilot-report.js <export.json> [prompts.json]
//
// Definitions (stated here so the numbers are reproducible, not vibes):
// - A participant is a member handle that posted at least one message.
// - A day is a UTC calendar date (the day a message's timestamp falls on).
// - A participant is "active across 3 separate days" when they posted on at
//   least 3 distinct UTC days.
// - A participant "returned" when they were active on a day later than their
//   first active day.
// - A return on day D is "prompted" when an organiser prompt (a timestamp in
//   the optional prompts file) falls within the 48 hours ending at that
//   participant's first message on day D. Every other return is unprompted.
//   A prompts file is {"prompts": ["<ISO timestamp>", ...]} — the moments a
//   nudge to come back was sent in the workspace.
//
// Output is JSON on stdout: per-participant lines and the summary the pilot
// post asks for. Exit code 0 always; the pilot's own thresholds are checked
// by the reader (or test/pilot.test.mjs), not baked in here.
"use strict";

const fs = require("node:fs");

function utcDay(iso) {
  return String(iso).slice(0, 10);
}

// Load organiser prompts file (may be absent).
function loadPrompts(file) {
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Accept a prompts file object, a bare array, or null; return epoch ms array.
function normalizePrompts(prompts) {
  if (!prompts) return null;
  const list = Array.isArray(prompts) ? prompts : prompts.prompts;
  return (list || []).map((p) => new Date(p).getTime());
}

function pilotReport(exp, prompts) {
  if (!exp || exp.format !== "openslack-export-v1") {
    throw new Error("Not an openslack-export-v1 snapshot.");
  }
  prompts = normalizePrompts(prompts);
  const members = new Set((exp.members || []).map((m) => m.handle));
  const byHandle = new Map();
  for (const m of exp.messages || []) {
    const handle = m.handle;
    if (!handle) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, []);
    byHandle.get(handle).push(m.at);
  }

  const participants = [];
  for (const [handle, times] of byHandle) {
    const sorted = times.slice().sort();
    const days = [...new Set(sorted.map(utcDay))];
    const firstDay = days[0];
    // First activity timestamp per day, for the prompt window check.
    const firstOnDay = new Map();
    for (const t of sorted) {
      const d = utcDay(t);
      if (!firstOnDay.has(d)) firstOnDay.set(d, new Date(t).getTime());
    }
    const returningDays = days.filter((d) => d > firstDay);
    const unpromptedDays = returningDays.filter((d) => {
      if (!prompts) return true;
      const at = firstOnDay.get(d);
      const from = at - 48 * 3600 * 1000;
      return !prompts.some((p) => p >= from && p <= at);
    });
    participants.push({
      handle,
      isMember: members.has(handle),
      firstDay,
      days,
      returningDays,
      unpromptedDays,
      messages: times.length
    });
  }
  participants.sort((a, b) => (a.firstDay < b.firstDay ? -1 : a.firstDay > b.firstDay ? 1 : 0));

  const dayCounts = new Map();
  for (const [handle, times] of byHandle) {
    for (const d of new Set(times.map(utcDay))) dayCounts.set(d, (dayCounts.get(d) || 0) + 1);
  }

  return {
    workspace: exp.workspace ? { slug: exp.workspace.slug, name: exp.workspace.name, createdAt: exp.workspace.createdAt } : null,
    exportedAt: exp.exportedAt,
    promptsRecorded: prompts ? prompts.length : null,
    summary: {
      participants: participants.length,
      activeAcross3Days: participants.filter((p) => p.days.length >= 3).length,
      returned: participants.filter((p) => p.returningDays.length > 0).length,
      returnedUnprompted: participants.filter((p) => p.unpromptedDays.length > 0).length,
      messages: (exp.messages || []).length,
      distinctDays: [...dayCounts.keys()].sort(),
      perDay: [...dayCounts.entries()].sort().map(([day, n]) => ({ day, activeParticipants: n }))
    },
    participants
  };
}

module.exports = { pilotReport, utcDay };

if (require.main === module) {
  const [, , exportFile, promptsFile] = process.argv;
  if (!exportFile) {
    console.error("usage: node scripts/pilot-report.js <export.json> [prompts.json]");
    process.exit(2);
  }
  const exp = JSON.parse(fs.readFileSync(exportFile, "utf8"));
  const prompts = loadPrompts(promptsFile);
  process.stdout.write(JSON.stringify(pilotReport(exp, prompts), null, 2) + "\n");
}
