// src/quick-wins/debug.js — /debug slash command
// Inspired by Claude Code's src/skills/bundled/debug.ts
// Self-service debugging of LAIA sessions.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOGS_DIR = join(homedir(), '.laia', 'logs');
const TAIL_LINES = 30;

/**
 * Get the most recent log file.
 */
function getLatestLog() {
  if (!existsSync(LOGS_DIR)) return null;

  const files = readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  return files.length > 0 ? join(LOGS_DIR, files[0]) : null;
}

/**
 * Tail last N lines of a file efficiently.
 */
function tailFile(filePath, lines = TAIL_LINES) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '(could not read file)';
  }
}

/**
 * Build the /debug prompt.
 * @param {string} args - Issue description
 */
export function buildDebugPrompt(args) {
  const latestLog = getLatestLog();

  let logInfo;
  if (latestLog) {
    const stats = statSync(latestLog);
    const sizeKb = (stats.size / 1024).toFixed(1);
    const tail = tailFile(latestLog);
    logInfo = `Log file: ${latestLog}\nLog size: ${sizeKb} KB\n\n### Last ${TAIL_LINES} lines\n\n\`\`\`\n${tail}\n\`\`\``;
  } else {
    logInfo = 'No log files found in ~/.laia/logs/';
  }

  // Check for tool-stats logs
  const toolStatsDir = join(LOGS_DIR, 'tool-stats');
  let toolStatsInfo = '';
  if (existsSync(toolStatsDir)) {
    const tsFiles = readdirSync(toolStatsDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (tsFiles.length > 0) {
      const latestTs = join(toolStatsDir, tsFiles[0]);
      const tsTail = tailFile(latestTs, 10);
      toolStatsInfo = `\n\n### Recent Tool Stats\n\n\`\`\`\n${tsTail}\n\`\`\``;
    }
  }

  return `# Debug LAIA Session

Help diagnose an issue with the current LAIA session.

## Session Log

${logInfo}${toolStatsInfo}

## Configuration

- Config dir: ~/.laia/
- Brain data: ~/laia-data/
- Skills: ~/.laia/skills/
- Agents: ~/.laia/agents/

## Issue Description

${args || 'The user did not describe a specific issue. Read the log and summarize any errors, warnings, or notable issues.'}

## Instructions

1. Review the user's issue description
2. Look for [ERROR], [WARN], stack traces, and failure patterns in the logs
3. Check if the issue relates to:
   - Brain server connectivity
   - Provider API errors (rate limits, auth)
   - Tool execution failures
   - Session corruption
4. Explain what you found in plain language
5. Suggest concrete fixes or next steps`;
}
