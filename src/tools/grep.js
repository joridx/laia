import { readFileSync } from 'fs';
import fg from 'fast-glob';
import { defaultRegistry } from './index.js';

export function registerGrepTool(config, registry = defaultRegistry) {
  registry.set('grep', {
    description: 'Search for text in files. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex pattern to search' },
        path: { type: 'string', description: 'File or glob pattern to search in (default: "**/*")' },
        maxResults: { type: 'number', description: 'Max matches to return (default: 50)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute({ query, path: pattern = '**/*', maxResults = 50 }) {
      const files = await fg(pattern, { cwd: config.workspaceRoot, onlyFiles: true, dot: false });
      const matches = [];
      const regex = new RegExp(escapeRegex(query), 'i');

      for (const file of files) {
        if (matches.length >= maxResults) break;
        try {
          const content = readFileSync(`${config.workspaceRoot}/${file}`, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ file, line: i + 1, text: lines[i].substring(0, 200) });
              if (matches.length >= maxResults) break;
            }
          }
        } catch {}
      }

      return { query, matches, count: matches.length };
    },
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
