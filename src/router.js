// Per-turn model auto-router for claudia
// Priority: explicit override > corporate keyword > coding keyword > tie > quick > sticky > default
// Based on gpt-5.3-codex design recommendation.

// Returns true if strings differ by at most 1 edit (insert/delete/substitute)
function withinEditDistance1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  if (a.length === b.length) {
    let diffs = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (++diffs > 1) return false; }
    return diffs === 1;
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, diff = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] !== longer[j]) { if (++diff > 1) return false; j++; }
    else { i++; j++; }
  }
  return true;
}

const CORPORATE_KEYWORDS = [
  'confluence', 'jira', 'teams', 'sharepoint', 'jenkins', 'github',
  'outlook', 'sonarqube', 'servicenow', 'dynatrace', 'powerbi', 'power bi',
  'giam', 'linkedin', 'nextcloud', 'controlm', 'control-m', 'flexera',
  'onenote', 'hybo', 'clocking', 'ppm', 'create ticket', 'update page',
  'pipeline', 'incident', 'dashboard', 'pull request', 'open pr',
];

const CODING_KEYWORDS = [
  'debug', 'fix', 'bug', 'refactor', 'implement', 'write', 'function',
  'class', 'test', 'error', 'exception', 'sql', 'algorithm', 'performance',
  'code', 'stack trace', 'compile', 'build', 'failing', 'typeerror',
  'syntax', 'import', 'module', 'async', 'regex', 'query', 'schema',
  'migration', 'deploy', 'lint', 'typescript', 'javascript', 'python',
];

// Canonical model IDs
export const MODEL_IDS = {
  codex: 'gpt-5.3-codex',
  claude: 'claude-opus-4.6',
  mini: 'gpt-5-mini',
};

const QUICK_CHAR_LIMIT = 60;
const STICKY_TURNS = 2;

export function createRouter() {
  let lastDomain = null;       // 'corporate' | 'coding' | 'quick' | null
  let lastToolDomain = null;   // domain inferred from tools actually used
  let turnsSinceDomainSwitch = 0;

  function route(input) {
    const text = input.toLowerCase().replace(/[^\w\s]/g, ' ');
    const words = text.split(/\s+/);

    // Fuzzy match single-word corporate keywords (handles typos like "conflucence")
    const corpMatches = CORPORATE_KEYWORDS.filter(k => {
      if (text.includes(k)) return true;
      if (!k.includes(' ') && k.length >= 5) {
        return words.some(w => w.length >= 4 && withinEditDistance1(w, k));
      }
      return false;
    });
    const codeMatches = CODING_KEYWORDS.filter(k => words.includes(k) || text.includes(k));
    const corpScore = corpMatches.length;
    const codeScore = codeMatches.length;
    const isSticky = (lastToolDomain === 'corporate' || lastDomain === 'corporate' || lastDomain === 'coding') && turnsSinceDomainSwitch <= STICKY_TURNS;
    const isQuick = input.length < QUICK_CHAR_LIMIT && corpScore === 0 && codeScore === 0 && !isSticky;

    let model, domain, reason, confidence;

    if (corpScore > codeScore && corpScore > 0) {
      model = MODEL_IDS.claude;
      domain = 'corporate';
      reason = 'corporate_keyword';
      confidence = 0.9;
    } else if (codeScore > corpScore && codeScore > 0) {
      model = MODEL_IDS.codex;
      domain = 'coding';
      reason = 'coding_keyword';
      confidence = 0.9;
    } else if (corpScore > 0 && codeScore > 0) {
      // Tie: use stickiness or default codex
      if (lastDomain === 'corporate' && turnsSinceDomainSwitch <= STICKY_TURNS) {
        model = MODEL_IDS.claude;
        domain = 'corporate';
        reason = 'tie_sticky_corporate';
        confidence = 0.7;
      } else {
        model = MODEL_IDS.codex;
        domain = 'coding';
        reason = 'tie_default_codex';
        confidence = 0.6;
      }
    } else if (isQuick) {
      model = MODEL_IDS.mini;
      domain = 'quick';
      reason = 'quick_short';
      confidence = 0.8;
    } else if (lastToolDomain === 'corporate' && turnsSinceDomainSwitch <= STICKY_TURNS) {
      model = MODEL_IDS.claude;
      domain = 'corporate';
      reason = 'tool_sticky_corporate';
      confidence = 0.65;
    } else if (lastDomain === 'corporate' && turnsSinceDomainSwitch <= STICKY_TURNS) {
      model = MODEL_IDS.claude;
      domain = 'corporate';
      reason = 'sticky_corporate';
      confidence = 0.65;
    } else if (lastDomain === 'coding' && turnsSinceDomainSwitch <= STICKY_TURNS) {
      model = MODEL_IDS.codex;
      domain = 'coding';
      reason = 'sticky_coding';
      confidence = 0.65;
    } else {
      model = MODEL_IDS.codex;
      domain = 'coding';
      reason = 'default_codex';
      confidence = 0.5;
    }

    // Update state for next turn
    if (domain !== lastDomain) {
      turnsSinceDomainSwitch = 0;
    } else {
      turnsSinceDomainSwitch++;
    }
    lastDomain = domain;

    return {
      model,
      domain,
      reason,
      confidence,
      matched: [...corpMatches, ...codeMatches],
      corporateHint: domain === 'corporate' && corpMatches.length > 0
        ? corpMatches[0]   // primary matched service name for prompt injection
        : null,
    };
  }

  // Call after a turn completes with the tool names that were actually used
  function recordToolsUsed(toolNames) {
    const corporateTools = ['run_command', 'bash'];
    // If bash was used (likely executing corporate API scripts), reinforce corporate domain
    const hadRunCommand = toolNames.includes('run_command');
    if (hadRunCommand && lastDomain === 'corporate') {
      lastToolDomain = 'corporate';
      turnsSinceDomainSwitch = 0;
    } else if (!hadRunCommand) {
      lastToolDomain = null;
    }
  }

  function reset() {
    lastDomain = null;
    lastToolDomain = null;
    turnsSinceDomainSwitch = 0;
  }

  return { route, recordToolsUsed, reset };
}

// Friendly label for the routing reason
export function routeLabel(decision) {
  const labels = {
    corporate_keyword: 'corporate task',
    coding_keyword: 'coding task',
    tie_sticky_corporate: 'mixed (sticky corporate)',
    tie_default_codex: 'mixed (default)',
    quick_short: 'quick question',
    tool_sticky_corporate: 'sticky (prev corporate tools)',
    sticky_corporate: 'sticky (prev corporate)',
    sticky_coding: 'sticky (prev coding)',
    default_codex: 'default',
  };
  return labels[decision.reason] ?? decision.reason;
}
