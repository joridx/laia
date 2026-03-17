// Brain tools — interface to claude-brain via MCP
// These tools let the LLM search and store memories

import { brainSearch, brainRemember, brainGetContext } from '../brain/client.js';
import { registerTool } from './index.js';

export function registerBrainTools(config) {
  registerTool('brain_search', {
    description: 'Search the local brain memory for learnings, patterns, sessions, and knowledge. Use to find prior context before acting.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        scope: { type: 'string', enum: ['all', 'learnings', 'sessions', 'knowledge'], description: 'Where to search (default: all)' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute({ query, scope, limit }) {
      const result = await brainSearch(query, { scope, limit });
      return { query, result };
    },
  });

  registerTool('brain_remember', {
    description: 'Store a learning, pattern, or warning in the local brain memory. Use for durable, useful insights (not transient noise).',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['learning', 'pattern', 'warning', 'principle'], description: 'Type of memory' },
        title: { type: 'string', description: 'Short title' },
        description: { type: 'string', description: 'Full description with context' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Relevant tags' },
      },
      required: ['type', 'title', 'description', 'tags'],
      additionalProperties: false,
    },
    async execute({ type, title, description, tags }) {
      const result = await brainRemember({
        learnings: [{ type, title, description, tags }],
      });
      return { stored: true, result };
    },
  });

  registerTool('brain_get_context', {
    description: 'Get brain context: user prefs, recent sessions, relevant learnings for the current project.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name to filter context' },
      },
      additionalProperties: false,
    },
    async execute({ project }) {
      const result = await brainGetContext({ project, cwd: process.cwd() });
      return { result };
    },
  });
}
