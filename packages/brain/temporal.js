/**
 * Temporal query parsing and filtering for brain_search.
 *
 * Supports:
 *   - Explicit params: since/until (ISO date strings)
 *   - Natural language in query: "last week", "yesterday", "this month",
 *     "març 2026", "march 2026", "last 3 days", "últims 7 dies"
 *
 * Bilingual: English + Catalan/Spanish
 */

// ─── Natural-language date patterns ──────────────────────────────────────────

const MONTH_MAP = {
  // English
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  // Catalan
  gener: 0, febrer: 1, març: 2, abril: 3, maig: 4, juny: 5,
  juliol: 6, agost: 7, setembre: 8, octubre: 9, novembre: 10, desembre: 11,
  // Spanish
  enero: 0, febrero: 1, marzo: 2, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

/**
 * Parse temporal filters from a query string.
 * Returns { cleanQuery, since, until } where since/until are ISO date strings (YYYY-MM-DD)
 * or null if no temporal filter was found.
 *
 * @param {string} query - Raw query string
 * @param {Date} [now] - Reference date (for testing). Defaults to new Date().
 * @returns {{ cleanQuery: string, since: string|null, until: string|null }}
 */
export function parseTemporalFilter(query, now = new Date()) {
  let since = null;
  let until = null;
  let cleanQuery = query;

  const today = startOfDay(now);

  // Helper: format Date to YYYY-MM-DD using LOCAL time (not UTC)
  function fmt(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ─── Pattern: "since:YYYY-MM-DD" / "until:YYYY-MM-DD" (explicit) ──────────
  cleanQuery = cleanQuery.replace(/\bsince:(\d{4}-\d{2}-\d{2})\b/gi, (_, d) => {
    since = d;
    return "";
  });
  cleanQuery = cleanQuery.replace(/\buntil:(\d{4}-\d{2}-\d{2})\b/gi, (_, d) => {
    until = d;
    return "";
  });
  if (since || until) return _result(cleanQuery, since, until);

  // ─── Pattern: "today" / "avui" ────────────────────────────────────────────
  if (/\b(today|avui|hoy)\b/i.test(cleanQuery)) {
    since = fmt(today);
    until = fmt(today);
    cleanQuery = cleanQuery.replace(/\b(today|avui|hoy)\b/gi, "");
    return _result(cleanQuery, since, until);
  }

  // ─── Pattern: "yesterday" / "ahir" / "ayer" ──────────────────────────────
  if (/\b(yesterday|ahir|ayer)\b/i.test(cleanQuery)) {
    const d = addDays(today, -1);
    since = fmt(d);
    until = fmt(d);
    cleanQuery = cleanQuery.replace(/\b(yesterday|ahir|ayer)\b/gi, "");
    return _result(cleanQuery, since, until);
  }

  // ─── Pattern: "last N days/weeks" / "últims N dies/setmanes" ──────────────
  const lastNMatch = cleanQuery.match(
    /(?:^|\s)(?:last|últims?|últimes?|passat[sa]?)\s+(\d+)\s+(days?|dies?|weeks?|setmanes?|months?|mesos?)(?:\s|$)/i
  );
  if (lastNMatch) {
    const n = parseInt(lastNMatch[1], 10);
    const unit = lastNMatch[2].toLowerCase();
    if (/^(days?|dies?)$/.test(unit)) {
      since = fmt(addDays(today, -n));
    } else if (/^(weeks?|setmanes?)$/.test(unit)) {
      since = fmt(addDays(today, -n * 7));
    } else if (/^(months?|mesos?)$/.test(unit)) {
      since = fmt(addMonths(today, -n));
    }
    until = fmt(today);
    cleanQuery = cleanQuery.replace(lastNMatch[0], "");
    return _result(cleanQuery, since, until);
  }

  // ─── Pattern: "this week" / "aquesta setmana" / "esta semana" ─────────────
  if (/\b(this\s+week|aquesta\s+setmana|esta\s+semana)\b/i.test(cleanQuery)) {
    since = fmt(startOfWeek(today));
    until = fmt(today);
    cleanQuery = cleanQuery.replace(/\b(this\s+week|aquesta\s+setmana|esta\s+semana)\b/gi, "");
    return _result(cleanQuery, since, until);
  }

  // ─── Pattern: "last week" / "la setmana passada" / "la semana pasada" ─────
  if (/\b(last\s+week|(?:la\s+)?setmana\s+passada|(?:la\s+)?semana\s+pasada)\b/i.test(cleanQuery)) {
    const thisWeekStart = startOfWeek(today);
    since = fmt(addDays(thisWeekStart, -7));
    until = fmt(addDays(thisWeekStart, -1));
    cleanQuery = cleanQuery.replace(/\b(last\s+week|(?:la\s+)?setmana\s+passada|(?:la\s+)?semana\s+pasada)\b/gi, "");
    return _result(cleanQuery, since, until);
  }

  // ─── Pattern: "this month" / "aquest mes" / "este mes" ────────────────────
  if (/\b(this\s+month|aquest\s+mes|este\s+mes)\b/i.test(cleanQuery)) {
    since = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    until = fmt(today);
    cleanQuery = cleanQuery.replace(/\b(this\s+month|aquest\s+mes|este\s+mes)\b/gi, "");
    return _result(cleanQuery, since, until);
  }

  // ─── Pattern: "last month" / "el mes passat" / "el mes pasado" ────────────
  if (/\b(last\s+month|(?:el\s+)?mes\s+passat|(?:el\s+)?mes\s+pasado)\b/i.test(cleanQuery)) {
    const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const firstOfLastMonth = addMonths(firstOfThisMonth, -1);
    since = fmt(firstOfLastMonth);
    until = fmt(addDays(firstOfThisMonth, -1));
    cleanQuery = cleanQuery.replace(/\b(last\s+month|(?:el\s+)?mes\s+passat|(?:el\s+)?mes\s+pasado)\b/gi, "");
    return _result(cleanQuery, since, until);
  }

  // ─── Pattern: "Month YYYY" / "YYYY Month" (e.g., "març 2026", "march 2026") ─
  const monthYearCandidates = [
    cleanQuery.match(/\b([a-zA-ZçàèéíòóúïüÇÀÈÉÍÒÓÚÏÜ]+)\s+(20\d{2})\b/i),
    cleanQuery.match(/\b(20\d{2})\s+([a-zA-ZçàèéíòóúïüÇÀÈÉÍÒÓÚÏÜ]+)\b/i),
  ];
  for (const monthYearMatch of monthYearCandidates) {
    if (!monthYearMatch) continue;
    let monthStr, yearStr;
    if (/^\d{4}$/.test(monthYearMatch[1])) {
      yearStr = monthYearMatch[1];
      monthStr = monthYearMatch[2];
    } else {
      monthStr = monthYearMatch[1];
      yearStr = monthYearMatch[2];
    }
    const monthIdx = MONTH_MAP[monthStr.toLowerCase()];
    if (monthIdx !== undefined) {
      const year = parseInt(yearStr, 10);
      since = fmt(new Date(year, monthIdx, 1));
      const nextMonth = new Date(year, monthIdx + 1, 0); // last day of month
      until = fmt(nextMonth);
      cleanQuery = cleanQuery.replace(monthYearMatch[0], "");
      return _result(cleanQuery, since, until);
    }
  }

  return _result(cleanQuery, null, null);
}

/**
 * Filter an array of items by date range.
 *
 * @param {Array} items - Items to filter
 * @param {Function} getDate - Function to extract date string (YYYY-MM-DD) from item
 * @param {string|null} since - Start date (inclusive), or null
 * @param {string|null} until - End date (inclusive), or null
 * @returns {Array} Filtered items
 */
export function filterByDateRange(items, getDate, since, until) {
  if (!since && !until) return items;
  return items.filter(item => {
    const d = getDate(item);
    if (!d) return false; // no date → exclude when temporal filter active
    if (since && d < since) return false;
    if (until && d > until) return false;
    return true;
  });
}

/**
 * Extract date from a session filename like "2026-03-25_project.md"
 */
export function extractSessionDate(filename) {
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// ─── Date arithmetic helpers ─────────────────────────────────────────────────

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(d) {
  const day = d.getDay();
  // Monday-based week (ISO)
  const diff = day === 0 ? 6 : day - 1;
  return addDays(d, -diff);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function _result(cleanQuery, since, until) {
  // Clean up extra whitespace left after removing temporal tokens
  cleanQuery = cleanQuery.replace(/\s{2,}/g, " ").trim();
  return { cleanQuery, since, until };
}
