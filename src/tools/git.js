// Git tools — diff, status, log for the LLM
// Read-only operations only. No auto-commit, no push, no destructive ops.

import { execFileSync } from 'child_process';
import { registerTool } from './index.js';

const MAX_DIFF = 15_000;   // truncate large diffs
const MAX_STAT = 3_000;
const MAX_LOG = 5_000;

// Sanitize ref/path args: reject shell metacharacters
const SAFE_ARG = /^[\w.\-\/~@{}^:]+$/;
function sanitize(arg) {
  if (typeof arg !== 'string') return arg;
  if (!SAFE_ARG.test(arg)) throw new Error(`Unsafe git argument: ${arg}`);
  return arg;
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    // Non-zero exit with stdout is still an error — don't silently swallow
    if (err.status !== 0 && err.stderr?.trim()) {
      throw new Error(err.stderr.trim());
    }
    if (err.stdout) return err.stdout;
    throw new Error(err.stderr || err.message || 'git command failed');
  }
}

export function registerGitTools(config) {
  const cwd = config.workspaceRoot;

  // --- git_diff ---
  registerTool('git_diff', {
    description: 'Show git diff (unstaged changes, staged changes, or diff between refs). Returns structured output with file-level stats and patch content.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged (--cached) changes instead of unstaged. Default: false' },
        path: { type: 'string', description: 'Limit diff to specific file or directory' },
        ref: { type: 'string', description: 'Compare against ref (e.g. "HEAD~3", "main", "abc123")' },
        stat: { type: 'boolean', description: 'Show only file-level stats (additions/deletions per file), no patch. Default: false' },
      },
      required: [],
      additionalProperties: false,
    },
    execute({ staged = false, path: diffPath, ref, stat = false }) {
      try {
        const args = ['diff', '--no-color'];
        if (staged) args.push('--cached');
        if (ref) args.push(sanitize(ref));
        if (stat) args.push('--stat');
        if (diffPath) args.push('--', sanitize(diffPath));

        const diff = git(args, cwd);
        if (!diff.trim()) return { empty: true, message: 'No changes' };

        // Always include stat summary alongside diff (unless stat-only mode)
        let statSummary = '';
        if (!stat) {
          const statArgs = ['diff', '--no-color', '--stat'];
          if (staged) statArgs.push('--cached');
          if (ref) statArgs.push(sanitize(ref));
          if (diffPath) statArgs.push('--', sanitize(diffPath));
          statSummary = git(statArgs, cwd).substring(0, MAX_STAT);
        }

        return {
          diff: diff.substring(0, MAX_DIFF),
          stat: statSummary || diff.substring(0, MAX_STAT),
          truncated: diff.length > MAX_DIFF,
        };
      } catch (err) {
        return { error: true, message: err.message };
      }
    },
  });

  // --- git_status ---
  registerTool('git_status', {
    description: 'Show git working tree status: branch, staged, unstaged, untracked files, ahead/behind counts.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute() {
      try {
        const short = git(['status', '--short'], cwd);
        const branch = git(['branch', '--show-current'], cwd).trim();

        // ahead/behind — may fail if no upstream
        let ahead = 0, behind = 0;
        try {
          ahead = parseInt(git(['rev-list', '--count', '@{u}..HEAD'], cwd).trim()) || 0;
          behind = parseInt(git(['rev-list', '--count', 'HEAD..@{u}'], cwd).trim()) || 0;
        } catch { /* no upstream configured */ }

        // Parse short status into structured data
        const files = short.split('\n').filter(Boolean).map(line => ({
          status: line.substring(0, 2).trim(),
          path: line.substring(3),
        }));

        const staged = files.filter(f => /^[MADRCU]/.test(f.status)).length;
        const modified = files.filter(f => f.status.includes('M')).length;
        const untracked = files.filter(f => f.status === '??').length;
        const deleted = files.filter(f => f.status.includes('D')).length;

        return {
          branch,
          ahead,
          behind,
          files,
          summary: `${staged} staged, ${modified} modified, ${deleted} deleted, ${untracked} untracked`,
        };
      } catch (err) {
        return { error: true, message: err.message };
      }
    },
  });

  // --- git_log ---
  registerTool('git_log', {
    description: 'Show recent git commit history.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'Number of commits to show. Default: 10' },
        path: { type: 'string', description: 'Filter commits affecting a specific file or directory' },
        oneline: { type: 'boolean', description: 'Use one-line format. Default: true' },
      },
      required: [],
      additionalProperties: false,
    },
    execute({ count = 10, path: logPath, oneline = true }) {
      try {
        const n = Math.min(Math.max(1, count), 100); // clamp 1-100
        const args = ['log', `-${n}`];
        if (oneline) args.push('--oneline');
        else args.push('--format=%h %ai %an: %s');
        if (logPath) args.push('--', sanitize(logPath));

        const log = git(args, cwd);
        if (!log.trim()) return { empty: true, message: 'No commits' };

        return { log: log.substring(0, MAX_LOG), truncated: log.length > MAX_LOG };
      } catch (err) {
        return { error: true, message: err.message };
      }
    },
  });
}
