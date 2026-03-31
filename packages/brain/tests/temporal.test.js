/**
 * Tests for temporal.js — date parsing and filtering
 */
import { createSuite } from "./harness.js";
import { parseTemporalFilter, filterByDateRange, extractSessionDate } from "../temporal.js";

const t = createSuite("temporal");

// Fixed reference date: Thursday 2026-03-26
const NOW = new Date(2026, 2, 26, 14, 30, 0); // March 26, 2026 14:30

// ─── parseTemporalFilter: Explicit since/until ─────────────────────────────

t.section("Explicit since/until");

{
  const r = parseTemporalFilter("jenkins since:2026-03-20", NOW);
  t.assert(r.since === "2026-03-20", "since:2026-03-20 → since");
  t.assert(r.until === null, "since only → until null");
  t.assert(r.cleanQuery === "jenkins", "since removed from query");
}

{
  const r = parseTemporalFilter("jenkins since:2026-03-01 until:2026-03-15", NOW);
  t.assert(r.since === "2026-03-01", "since + until → since");
  t.assert(r.until === "2026-03-15", "since + until → until");
  t.assert(r.cleanQuery === "jenkins", "both removed from query");
}

// ─── Today / Yesterday ──────────────────────────────────────────────────────

t.section("Today / Yesterday");

{
  const r = parseTemporalFilter("jenkins today", NOW);
  t.assert(r.since === "2026-03-26", "today → since");
  t.assert(r.until === "2026-03-26", "today → until");
  t.assert(r.cleanQuery === "jenkins", "today removed");
}

{
  const r = parseTemporalFilter("què he après avui", NOW);
  t.assert(r.since === "2026-03-26", "avui → since");
  t.assert(r.cleanQuery === "què he après", "avui removed");
}

{
  const r = parseTemporalFilter("errors yesterday", NOW);
  t.assert(r.since === "2026-03-25", "yesterday → since");
  t.assert(r.until === "2026-03-25", "yesterday → until");
}

{
  const r = parseTemporalFilter("jenkins ahir", NOW);
  t.assert(r.since === "2026-03-25", "ahir → since");
  t.assert(r.until === "2026-03-25", "ahir → until");
}

{
  const r = parseTemporalFilter("errores ayer", NOW);
  t.assert(r.since === "2026-03-25", "ayer → since");
}

// ─── Last N days/weeks/months ───────────────────────────────────────────────

t.section("Last N units");

{
  const r = parseTemporalFilter("jenkins last 3 days", NOW);
  t.assert(r.since === "2026-03-23", "last 3 days → since");
  t.assert(r.until === "2026-03-26", "last 3 days → until");
  t.assert(r.cleanQuery === "jenkins", "last 3 days removed");
}

{
  const r = parseTemporalFilter("què he après últims 7 dies", NOW);
  t.assert(r.since === "2026-03-19", "últims 7 dies → since");
  t.assert(r.until === "2026-03-26", "últims 7 dies → until");
}

{
  const r = parseTemporalFilter("deployments last 2 weeks", NOW);
  t.assert(r.since === "2026-03-12", "last 2 weeks → since");
  t.assert(r.until === "2026-03-26", "last 2 weeks → until");
}

{
  const r = parseTemporalFilter("errors last 1 month", NOW);
  t.assert(r.since === "2026-02-26", "last 1 month → since");
  t.assert(r.until === "2026-03-26", "last 1 month → until");
}

// ─── This week / Last week ──────────────────────────────────────────────────

t.section("This week / Last week");

{
  const r = parseTemporalFilter("jenkins this week", NOW);
  // March 26 is Thursday → week starts Monday March 23
  t.assert(r.since === "2026-03-23", "this week → since (Mon)");
  t.assert(r.until === "2026-03-26", "this week → until (today)");
  t.assert(r.cleanQuery === "jenkins", "this week removed");
}

{
  const r = parseTemporalFilter("errors aquesta setmana", NOW);
  t.assert(r.since === "2026-03-23", "aquesta setmana → since");
  t.assert(r.until === "2026-03-26", "aquesta setmana → until");
}

{
  const r = parseTemporalFilter("jenkins last week", NOW);
  t.assert(r.since === "2026-03-16", "last week → since (prev Mon)");
  t.assert(r.until === "2026-03-22", "last week → until (prev Sun)");
}

{
  const r = parseTemporalFilter("deployments la setmana passada", NOW);
  t.assert(r.since === "2026-03-16", "la setmana passada → since");
  t.assert(r.until === "2026-03-22", "la setmana passada → until");
}

// ─── This month / Last month ────────────────────────────────────────────────

t.section("This month / Last month");

{
  const r = parseTemporalFilter("jenkins this month", NOW);
  t.assert(r.since === "2026-03-01", "this month → since");
  t.assert(r.until === "2026-03-26", "this month → until");
}

{
  const r = parseTemporalFilter("errors aquest mes", NOW);
  t.assert(r.since === "2026-03-01", "aquest mes → since");
}

{
  const r = parseTemporalFilter("errors last month", NOW);
  t.assert(r.since === "2026-02-01", "last month → since");
  t.assert(r.until === "2026-02-28", "last month → until");
}

{
  const r = parseTemporalFilter("deployments el mes passat", NOW);
  t.assert(r.since === "2026-02-01", "el mes passat → since");
  t.assert(r.until === "2026-02-28", "el mes passat → until");
}

// ─── Month YYYY ─────────────────────────────────────────────────────────────

t.section("Month YYYY");

{
  const r = parseTemporalFilter("jenkins march 2026", NOW);
  t.assert(r.since === "2026-03-01", "march 2026 → since");
  t.assert(r.until === "2026-03-31", "march 2026 → until");
  t.assert(r.cleanQuery === "jenkins", "month year removed");
}

{
  const r = parseTemporalFilter("errors març 2026", NOW);
  t.assert(r.since === "2026-03-01", "març 2026 → since");
  t.assert(r.until === "2026-03-31", "març 2026 → until");
}

{
  const r = parseTemporalFilter("jenkins febrero 2026", NOW);
  t.assert(r.since === "2026-02-01", "febrero 2026 → since");
  t.assert(r.until === "2026-02-28", "febrero 2026 → until");
}

{
  const r = parseTemporalFilter("errors 2026 january", NOW);
  t.assert(r.since === "2026-01-01", "2026 january → since");
  t.assert(r.until === "2026-01-31", "2026 january → until");
}

// ─── No temporal filter ─────────────────────────────────────────────────────

t.section("No temporal filter");

{
  const r = parseTemporalFilter("jenkins deployment errors", NOW);
  t.assert(r.since === null, "no temporal → since null");
  t.assert(r.until === null, "no temporal → until null");
  t.assert(r.cleanQuery === "jenkins deployment errors", "query unchanged");
}

// ─── Edge: query is only temporal ───────────────────────────────────────────

t.section("Edge cases");

{
  const r = parseTemporalFilter("last week", NOW);
  t.assert(r.since === "2026-03-16", "only temporal → since");
  t.assert(r.until === "2026-03-22", "only temporal → until");
  t.assert(r.cleanQuery === "", "only temporal → empty query");
}

// ─── filterByDateRange ──────────────────────────────────────────────────────

t.section("filterByDateRange");

const items = [
  { id: 1, date: "2026-03-25" },
  { id: 2, date: "2026-03-20" },
  { id: 3, date: "2026-03-15" },
  { id: 4, date: "2026-02-28" },
  { id: 5, date: null },
];
const getDate = i => i.date;

{
  const r = filterByDateRange(items, getDate, "2026-03-16", null);
  t.assert(r.length === 2, "since only → 2 items");
  t.assert(r[0].id === 1 && r[1].id === 2, "since only → correct items");
}

{
  const r = filterByDateRange(items, getDate, null, "2026-03-15");
  t.assert(r.length === 2, "until only → 2 items");
  t.assert(r[0].id === 3 && r[1].id === 4, "until only → correct items");
}

{
  const r = filterByDateRange(items, getDate, "2026-03-15", "2026-03-20");
  t.assert(r.length === 2, "range → 2 items");
}

{
  const r = filterByDateRange(items, getDate, "2026-01-01", "2026-12-31");
  t.assert(r.length === 4, "null date excluded when filter active");
}

{
  const r = filterByDateRange(items, getDate, null, null);
  t.assert(r.length === 5, "no filter → all items");
}

// ─── extractSessionDate ─────────────────────────────────────────────────────

t.section("extractSessionDate");

t.assert(extractSessionDate("2026-03-25_claude-local-brain.md") === "2026-03-25", "session filename");
t.assert(extractSessionDate("memory/sessions/2026-03-25_project.md") === "2026-03-25", "session with path");
t.assert(extractSessionDate("knowledge/allianz/something.md") === null, "no date → null");

// ─── Summary ────────────────────────────────────────────────────────────────

const { passed, failed } = t.summary();
process.exit(failed > 0 ? 1 : 0);
