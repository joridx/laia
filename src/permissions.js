// 3-tier permission system
// Tier 1 (auto): read, glob, grep, brain_search, brain_get_context, run_command — always allowed
// Tier 2 (session): write, edit, brain_remember, bash, agent — ask once per session, then remember
// Tier 3 (confirm): (reserved for future high-risk tools)

const AUTO_ALLOW = new Set(['read', 'glob', 'grep', 'brain_search', 'brain_get_context', 'run_command', 'git_diff', 'git_status', 'git_log']);
const SESSION_ALLOW = new Set(['write', 'edit', 'brain_remember', 'bash', 'agent']);

function formatToolCall(name, args) {
  if (name === 'bash') return `bash: ${args?.command ?? '(unknown)'}`;
  return `${name}(${JSON.stringify(args).substring(0, 100)})`;
}

// Read a single keypress (y/a/n) without leaking extra chars to the REPL
function askUser(question, rlInstance) {
  process.stderr.write(`\x1b[33m${question} [y/a/N] \x1b[0m`);

  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stderr.write('n (non-interactive: auto-deny permission in headless mode)\n');
      console.warn('[permissions] Permission denied automatically: non-interactive (headless) session');
      return resolve(false);
    }

    const wasRaw = process.stdin.isRaw;

    // Pause readline to prevent it from consuming our keypress
    if (rlInstance) rlInstance.pause();

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      const ch = data.toString()[0]?.toLowerCase() ?? 'n';

      // \b \b erases any terminal-echoed character before writing ours
      if (ch === 'a') {
        process.stderr.write('\b \ba (approve all for session)\n');
      } else if (ch === 'y' || ch === 'n') {
        process.stderr.write('\b \b' + (ch === 'y' ? 'y\n' : 'n\n'));
      } else {
        process.stderr.write(`\b \b(unexpected input: '${ch}' — denied)\n`);
      }

      process.stdin.setRawMode(wasRaw ?? false);

      // Resume readline
      if (rlInstance) rlInstance.resume();

      if (ch === 'a') return resolve('all');
      resolve(ch === 'y');
    });
  });
}

// --- Factory: creates isolated permission context ---
export function createPermissionContext({ autoApprove = false } = {}) {
  const sessionApproved = new Set();
  let autoApproveAll = autoApprove;
  let rlInstance = null;
  // Serializes concurrent permission prompts so only one stdin prompt is active at a time.
  // Each call chains onto the tail; rechecks autoApproveAll/sessionApproved after queuing
  // so an 'a' answer on the first prompt auto-approves all queued ones.
  let promptQueue = Promise.resolve();

  return {
    setAutoApprove(enabled) { autoApproveAll = enabled; },
    setReadlineInterface(rl) { rlInstance = rl; },
    isAutoApproved() { return autoApproveAll; },
    isToolApproved(name) { return autoApproveAll || AUTO_ALLOW.has(name) || sessionApproved.has(name); },
    preApproveTools(names) { for (const n of names) sessionApproved.add(n); },
    async checkPermission(toolName, args) {
      // Fast-path: no prompting needed
      if (autoApproveAll) return true;
      if (AUTO_ALLOW.has(toolName)) return true;
      if (sessionApproved.has(toolName)) return true;

      // Queue the prompt — recheck state after waiting in case a prior prompt set autoApproveAll
      const queued = promptQueue.then(async () => {
        if (autoApproveAll) return true;
        if (sessionApproved.has(toolName)) return true;

        if (SESSION_ALLOW.has(toolName)) {
          const result = await askUser(`Allow tool "${toolName}" for this session?`, rlInstance);
          if (result === 'all') { autoApproveAll = true; return true; }
          if (result) sessionApproved.add(toolName);
          return !!result;
        }

        // Tier 3: always confirm (press 'a' to approve all for session)
        const desc = formatToolCall(toolName, args);
        const result = await askUser(`Execute ${desc}?`, rlInstance);
        if (result === 'all') { sessionApproved.add(toolName); return true; }
        return result === true;
      }).catch(() => false); // fail closed; keeps chain alive on unexpected errors

      promptQueue = queued.then(() => {}, () => {});
      return queued;
    },
  };
}

// --- Default singleton — backwards-compat ---
const defaultContext = createPermissionContext();
export function setAutoApprove(enabled) { defaultContext.setAutoApprove(enabled); }
export function setReadlineInterface(rl) { defaultContext.setReadlineInterface(rl); }
export async function checkPermission(toolName, args) { return defaultContext.checkPermission(toolName, args); }
export function isAutoApproved() { return defaultContext.isAutoApproved(); }
export function isToolApproved(name) { return defaultContext.isToolApproved(name); }
export function preApproveTools(names) { defaultContext.preApproveTools(names); }
