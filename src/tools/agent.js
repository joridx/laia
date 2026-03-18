// Agent tool — delegates subtasks to worker LLM instances
// Registered only when config.swarm is true or /swarm toggle is ON

import { defaultRegistry } from './index.js';

export function registerAgentTool(config, registry = defaultRegistry) {
  // Placeholder — tool schema only, execute is a stub for now
  registry.set('agent', {
    description: 'Delegate a subtask to a worker agent. The worker has access to all tools (read, write, edit, bash, glob, grep, git) but cannot spawn sub-agents. Use for independent, well-scoped tasks that can run in isolation.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Clear, self-contained task description for the worker' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to include as context for the worker',
        },
        model: { type: 'string', description: 'Override model for this worker (default: same as orchestrator)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 60000)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async execute({ prompt, files, model, timeout }) {
      return { error: true, message: 'Agent tool not yet implemented. Schema registered for testing.' };
    },
  });
}
