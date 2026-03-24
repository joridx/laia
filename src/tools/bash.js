import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { defaultRegistry } from './index.js';
import { compactBashOutput } from './bash-compact.js';

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

export function registerBashTool(config, registry = defaultRegistry) {
  registry.set('bash', {
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

        const rawStdout = execSync(command, opts);
        const compact = compactBashOutput(rawStdout);
        return { exitCode: 0, stdout: compact.stdout, ...(compact.rawFile && { rawFile: compact.rawFile }) };
      } catch (err) {
        const rawStdout = err.stdout ?? '';
        const rawStderr = err.stderr ?? '';
        const compact = compactBashOutput(rawStdout, rawStderr);
        return {
          exitCode: err.status ?? 1,
          stdout: compact.stdout,
          stderr: compact.stderr,
          ...(compact.rawFile && { rawFile: compact.rawFile }),
        };
      }
    },
  });
}
