// 3-tier permission system
// Tier 1 (auto): read, glob, grep, brain_search, brain_get_context, run_command — always allowed
// Tier 2 (session): write, edit, brain_remember — ask once per session, then remember
// Tier 3 (confirm): bash — ask every time (or press 'a' to approve all for session)

const AUTO_ALLOW = new Set(['read', 'glob', 'grep', 'brain_search', 'brain_get_context', 'run_command', 'git_diff', 'git_status', 'git_log']);
const SESSION_ALLOW = new Set(['write', 'edit', 'brain_remember']);
const sessionApproved = new Set();
let autoApproveAll = false;
let rlInstance = null;

export function setAutoApprove(enabled) {
  autoApproveAll = enabled;
}

// Register readline so we can pause it during permission prompts (prevents yy ghost)
export function setReadlineInterface(rl) {
  rlInstance = rl;
}

export async function checkPermission(toolName, args) {
  if (autoApproveAll) return true;
  if (AUTO_ALLOW.has(toolName)) return true;
  if (sessionApproved.has(toolName)) return true;

  if (SESSION_ALLOW.has(toolName)) {
    const result = await askUser(`Allow tool "${toolName}" for this session?`);
    if (result) sessionApproved.add(toolName);
    return !!result;
  }

  // Tier 3: always confirm (press 'a' to approve all for session)
  const desc = formatToolCall(toolName, args);
  const result = await askUser(`Execute ${desc}?`);
  if (result === 'all') {
    sessionApproved.add(toolName);
    return true;
  }
  return result === true;
}

function formatToolCall(name, args) {
  if (name === 'bash') return `bash: ${args?.command ?? '(unknown)'}`;
  return `${name}(${JSON.stringify(args).substring(0, 100)})`;
}

// Read a single keypress (y/a/n) without leaking extra chars to the REPL
async function askUser(question) {
  process.stderr.write(`\x1b[33m${question} [y/a/N] \x1b[0m`);

  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stderr.write('n (non-interactive)\n');
      return resolve(false);
    }

    const wasRaw = process.stdin.isRaw;

    // Pause readline to prevent it from consuming our keypress
    if (rlInstance) rlInstance.pause();

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      const ch = data.toString()[0]?.toLowerCase() ?? 'n';

      if (ch === 'a') {
        process.stderr.write('a (approve all for session)\n');
      } else {
        process.stderr.write(ch === 'y' ? 'y\n' : 'n\n');
      }

      process.stdin.setRawMode(wasRaw ?? false);

      // Resume readline
      if (rlInstance) rlInstance.resume();

      if (ch === 'a') return resolve('all');
      resolve(ch === 'y');
    });
  });
}
