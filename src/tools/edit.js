import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { registerTool } from './index.js';

export function applyEdit(content, oldText, newText) {
  if (!oldText || typeof newText !== 'string') return null;

  const normalize = s => s.trimEnd().replace(/\t/g, '  ');
  const contentLines = content.split('\n');
  const oldLines = oldText.split('\n');
  const nOld = oldLines.length;

  // Line-level match first (handles exact and fuzzy trailing-whitespace/tab cases)
  for (let i = 0; i <= contentLines.length - nOld; i++) {
    if (oldLines.every((ol, j) => normalize(contentLines[i + j]) === normalize(ol))) {
      const wasExact = oldLines.every((ol, j) => contentLines[i + j] === ol);
      const start = i === 0 ? 0 : contentLines.slice(0, i).join('\n').length + 1;
      const matchedBlock = contentLines.slice(i, i + nOld).join('\n');
      return {
        result: content.slice(0, start) + newText + content.slice(start + matchedBlock.length),
        fuzzy: !wasExact,
      };
    }
  }

  // Fallback: substring exact match (for mid-line patterns like 'console.log')
  const idx = content.indexOf(oldText);
  if (idx !== -1) {
    return { result: content.slice(0, idx) + newText + content.slice(idx + oldText.length), fuzzy: false };
  }

  return null;
}

export function registerEditTool(config) {
  registerTool('edit', {
    description: 'Apply search/replace edits to a file. Trailing whitespace and tab/space differences are normalized automatically (status: fuzzy_applied). Exact match returns applied. No match returns not_found.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Text to find. Trailing whitespace and tab/space normalization applied automatically if exact match fails.' },
              newText: { type: 'string', description: 'Replacement text. Used verbatim — not normalized.' },
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
        const r = applyEdit(content, oldText, newText);
        if (!r) {
          results.push({ oldText: oldText?.substring(0, 60) ?? '', status: 'not_found' });
          continue;
        }
        content = r.result;
        results.push({ oldText: oldText.substring(0, 60), status: r.fuzzy ? 'fuzzy_applied' : 'applied' });
      }

      writeFileSync(abs, content, 'utf8');
      return { path: abs, edits: results };
    },
  });
}
