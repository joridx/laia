import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { registerTool } from './index.js';

export function registerWriteTool(config) {
  registerTool('write', {
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
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      return { path: abs, bytes: Buffer.byteLength(content, 'utf8') };
    },
  });
}
