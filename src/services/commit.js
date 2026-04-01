// src/quick-wins/commit.js — /commit slash command
// Inspired by Claude Code's src/commands/commit.ts
// Generates a commit message from staged/unstaged changes via LLM.

/**
 * Build the /commit prompt.
 * Uses !`cmd` syntax that gets expanded by executeShellCommandsInPrompt.
 * For LAIA, we pre-execute and inject the results directly.
 */
export function getCommitPrompt() {
  return `## Context

- Current git status: {{git_status}}
- Current git diff (staged and unstaged changes): {{git_diff}}
- Current branch: {{git_branch}}
- Recent commits: {{git_log}}

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- CRITICAL: ALWAYS create NEW commits. NEVER use git commit --amend, unless the user explicitly requests it
- Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Based on the above changes, create a single git commit:

1. Analyze all staged changes and draft a commit message:
   - Look at the recent commits above to follow this repository's commit message style
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.)
   - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"

2. Stage relevant files and create the commit using HEREDOC syntax:
\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
\`\`\`

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.`;
}

/**
 * Build the prompt with actual git data injected.
 * @param {object} gitData - { status, diff, branch, log }
 */
export function buildCommitPrompt(gitData) {
  return getCommitPrompt()
    .replace('{{git_status}}', gitData.status || '(empty)')
    .replace('{{git_diff}}', gitData.diff || '(no changes)')
    .replace('{{git_branch}}', gitData.branch || '(unknown)')
    .replace('{{git_log}}', gitData.log || '(no history)');
}

/**
 * Gather git data for the commit prompt.
 * Returns an object with status, diff, branch, log.
 */
export async function gatherGitData() {
  const { execSync } = await import('child_process');
  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim(); }
    catch { return ''; }
  };

  return {
    status: run('git status'),
    diff: run('git diff HEAD'),
    branch: run('git branch --show-current'),
    log: run('git log --oneline -10'),
  };
}
