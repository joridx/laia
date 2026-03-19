// Git auto-commit: tracks files modified by agent tools and commits after each turn.
// Opt-in via config.autoCommit or /autocommit toggle.

import { execFileSync } from 'child_process';

const COMMIT_PREFIX = 'claudia: ';
const MAX_MSG_LEN = 120;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
}

function isGitRepo(cwd) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch { return false; }
}

// Extract a short commit message from the agent's response text
function makeCommitMessage(agentText, changedFiles) {
  // Try to use first meaningful line from agent response
  if (agentText) {
    const lines = agentText.split('\n').map(l => l.replace(/^[#*\->\s]+/, '').trim()).filter(Boolean);
    const first = lines[0];
    if (first && first.length >= 5 && first.length <= MAX_MSG_LEN) {
      return COMMIT_PREFIX + first;
    }
    if (first && first.length > MAX_MSG_LEN) {
      return COMMIT_PREFIX + first.substring(0, MAX_MSG_LEN - 3) + '...';
    }
  }
  // Fallback: list changed files
  if (!changedFiles || !changedFiles.length) return COMMIT_PREFIX + 'update files';
  const fileList = changedFiles.map(f => f.split('/').pop()).join(', ');
  return COMMIT_PREFIX + `update ${fileList}`.substring(0, MAX_MSG_LEN);
}

export function createAutoCommitter({ cwd }) {
  const changedFiles = new Set();
  let enabled = false;

  return {
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; },

    // Called by tool dispatch when write/edit completes successfully
    trackFile(filePath) {
      if (filePath) changedFiles.add(filePath);
    },

    // Called after a turn completes — commits tracked files if any
    commitIfNeeded(agentText) {
      if (!enabled || changedFiles.size === 0) return null;
      if (!isGitRepo(cwd)) { changedFiles.clear(); return null; }

      const files = [...changedFiles];

      try {
        // Stage only agent-modified files (not user's other changes)
        git(['add', '--', ...files], cwd);

        // Check if there's actually anything staged for these files
        const staged = git(['diff', '--cached', '--name-only', '--', ...files], cwd).trim();
        if (!staged) { changedFiles.clear(); return null; }

        const msg = makeCommitMessage(agentText, files);
        // --only: commit ONLY these files, ignoring other staged content
        git(['commit', '--only', '-m', msg, '--no-verify', '--', ...files], cwd);

        const hash = git(['rev-parse', '--short', 'HEAD'], cwd).trim();
        changedFiles.clear(); // clear only after successful commit
        return { hash, message: msg, files: staged.split('\n') };
      } catch (err) {
        // Don't crash the agent if commit fails — keep files tracked for next turn
        return { error: err.message };
      }
    },

    // Reset tracked files (e.g. on /clear)
    clear() { changedFiles.clear(); },
  };
}

// Export for testing
export { makeCommitMessage, isGitRepo };
