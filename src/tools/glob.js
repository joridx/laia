import fg from 'fast-glob';
import { registerTool } from './index.js';

export function registerGlobTool(config) {
  registerTool('glob', {
    description: 'Find files matching a glob pattern. Returns list of matching paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.js")' },
        cwd: { type: 'string', description: 'Base directory (default: workspace root)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute({ pattern, cwd }) {
      const base = cwd || config.workspaceRoot;
      const files = await fg(pattern, { cwd: base, dot: false, onlyFiles: true });
      return { pattern, cwd: base, files, count: files.length };
    },
  });
}
