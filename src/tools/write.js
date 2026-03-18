import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { defaultRegistry } from './index.js';
import { unifiedDiff } from '../diff.js';

export function registerWriteTool(config, registry = defaultRegistry) {
  registry.set('write', {
    description: 'Write content to a file. Creates directories if needed. Overwrites existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    execute({ path: filePath, content }) {
      const abs = resolve(config.workspaceRoot, filePath);
      let original = '';
      try { original = readFileSync(abs, 'utf8'); } catch { /* new file */ }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      const relPath = relative(config.workspaceRoot, abs).split('\\').join('/');
      const diff = unifiedDiff(original, content, { path: relPath });
      return { path: abs, bytes: Buffer.byteLength(content, 'utf8'), diff };
    },
  });
}
