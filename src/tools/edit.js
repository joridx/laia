import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { registerTool } from './index.js';

export function registerEditTool(config) {
  registerTool('edit', {
    description: 'Apply search/replace edits to a file. Each edit replaces an exact text match.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to find' },
              newText: { type: 'string', description: 'Replacement text' },
            },
            required: ['oldText', 'newText'],
          },
          description: 'Array of search/replace pairs applied in order',
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
    execute({ path: filePath, edits }) {
      const abs = resolve(config.workspaceRoot, filePath);
      let content = readFileSync(abs, 'utf8');
      const results = [];

      for (const { oldText, newText } of edits) {
        const idx = content.indexOf(oldText);
        if (idx === -1) {
          results.push({ oldText: oldText.substring(0, 60), status: 'not_found' });
          continue;
        }
        content = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
        results.push({ oldText: oldText.substring(0, 60), status: 'applied' });
      }

      writeFileSync(abs, content, 'utf8');
      return { path: abs, edits: results };
    },
  });
}
