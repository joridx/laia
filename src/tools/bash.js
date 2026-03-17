import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { registerTool } from './index.js';

// Find Git Bash on Windows
function findBashShell() {
  const candidates = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    process.env.GIT_BASH || '',
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

const BASH_SHELL = findBashShell();

export function registerBashTool(config) {
  registerTool('bash', {
    description: `Execute a shell command via Git Bash and return stdout/stderr. Use for builds, tests, git, etc. Commands run in a Unix-like shell (bash), not cmd.exe.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (bash syntax)' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    execute({ command, timeout = 30000 }) {
      try {
        const opts = {
          cwd: config.workspaceRoot,
          timeout,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        };

        // Use Git Bash if available, otherwise fall back to default shell
        if (BASH_SHELL) {
          opts.shell = BASH_SHELL;
        } else {
          opts.shell = true;
        }

        const stdout = execSync(command, opts);
        return { exitCode: 0, stdout: stdout.substring(0, 10000) };
      } catch (err) {
        return {
          exitCode: err.status ?? 1,
          stdout: (err.stdout ?? '').substring(0, 5000),
          stderr: (err.stderr ?? '').substring(0, 5000),
        };
      }
    },
  });
}
