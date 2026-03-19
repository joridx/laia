// 3-tier permission system
// Tier 1 (auto): read, glob, grep, brain_search, brain_get_context, run_command — always allowed
// Tier 2 (session): write, edit, brain_remember, bash — ask once per session, then remember
// Tier 3 (confirm): (reserved for future high-risk tools)

const AUTO_ALLOW = new Set(['read', 'glob', 'grep', 'brain_search', 'brain_get_context', 'run_command', 'git_diff', 'git_status', 'git_log']);
const SESSION_ALLOW = new Set(['write', 'edit', 'brain_remember', 'bash']);

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

  return {
    setAutoApprove(enabled) { autoApproveAll = enabled; },
    setReadlineInterface(rl) { rlInstance = rl; },
    async checkPermission(toolName, args) {
      if (autoApproveAll) return true;
      if (AUTO_ALLOW.has(toolName)) return true;
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
      if (result === 'all') {
        sessionApproved.add(toolName);
        return true;
      }
      return result === true;
    },
  };
}

// --- Default singleton — backwards-compat ---
const defaultContext = createPermissionContext();
export function setAutoApprove(enabled) { defaultContext.setAutoApprove(enabled); }
export function setReadlineInterface(rl) { defaultContext.setReadlineInterface(rl); }
export async function checkPermission(toolName, args) { return defaultContext.checkPermission(toolName, args); }
