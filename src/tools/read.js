import { readFileSync } from 'fs';
import { resolve } from 'path';
import { defaultRegistry } from './index.js';

export function registerReadTool(config, registry = defaultRegistry) {
  registry.set('read', {
    description: 'Read the contents of a file. Returns the text content with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
        offset: { type: 'number', description: 'Start line (1-based)' },
        limit: { type: 'number', description: 'Max lines to return' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute({ path: filePath, offset, limit }) {
      const abs = resolve(config.workspaceRoot, filePath);
      const content = readFileSync(abs, 'utf8');
      let lines = content.split('\n');

      if (offset) lines = lines.slice(offset - 1);
      if (limit) lines = lines.slice(0, limit);

      const numbered = lines.map((l, i) => `${(offset || 1) + i}:${l}`).join('\n');
      return { path: abs, lines: lines.length, content: numbered };
    },
  });
}
