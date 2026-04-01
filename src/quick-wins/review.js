// src/quick-wins/review.js — /review slash command
// Inspired by Claude Code's src/commands/review.ts
// Code review of Pull Requests using gh CLI.

/**
 * Build the /review prompt for a given PR.
 * @param {string} args - PR number or empty for list
 */
export function buildReviewPrompt(args) {
  const prNum = args?.trim();

  if (!prNum) {
    return `Run \`gh pr list\` to show open Pull Requests. Display them in a clean table format.`;
  }

  return `You are an expert code reviewer. Follow these steps:

1. Run \`gh pr view ${prNum}\` to get PR details
2. Run \`gh pr diff ${prNum}\` to get the diff
3. Analyze the changes and provide a thorough code review that includes:
   - Overview of what the PR does
   - Analysis of code quality and style
   - Specific suggestions for improvements
   - Any potential issues or risks

Keep your review concise but thorough. Focus on:
- Code correctness
- Following project conventions
- Performance implications
- Test coverage
- Security considerations

Format your review with clear sections and bullet points.

PR number: ${prNum}`;
}
