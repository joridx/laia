// run_command tool — lets the LLM discover and execute file-based commands
// Commands are .md files from ~/.claude/commands/ and ~/.claudia/commands/

import { loadFileCommands, expandCommand } from '../commands/loader.js';
import { registerTool } from './index.js';

let commandsCache = null;

function getCommands(config) {
  if (!commandsCache) commandsCache = loadFileCommands(config.commandDirs);
  return commandsCache;
}

export function registerCommandTool(config) {
  registerTool('run_command', {
    description: `Discover and execute local commands/skills (Jira, Confluence, GitHub, Teams, Jenkins, etc). Actions: "list" to see all commands, "search" to find by keyword, "run" to execute a command with arguments. ALWAYS search or list first if unsure which command to use.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'run'],
          description: 'Action: list all, search by keyword, or run a command',
        },
        name: {
          type: 'string',
          description: 'Command name (for run action), e.g. "jira", "confluence", "github"',
        },
        args: {
          type: 'string',
          description: 'Arguments to pass to the command template (replaces {{args}} / $ARGUMENTS)',
        },
        query: {
          type: 'string',
          description: 'Search query (for search action)',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute({ action, name, args, query }) {
      const commands = getCommands(config);

      if (action === 'list') {
        const list = [...commands.values()].map(c => ({
          name: c.name,
          description: c.description || '(no description)',
        }));
        return { commands: list, count: list.length };
      }

      if (action === 'search') {
        if (!query) return { error: true, message: 'query is required for search' };
        const q = query.toLowerCase();
        const results = [...commands.values()]
          .filter(c => {
            const haystack = `${c.name} ${c.description} ${c.tags.join(' ')}`.toLowerCase();
            return q.split(/\s+/).some(word => haystack.includes(word));
          })
          .map(c => ({ name: c.name, description: c.description || '(no description)' }));
        return { query, results, count: results.length };
      }

      if (action === 'run') {
        if (!name) return { error: true, message: 'name is required for run' };
        const cmd = commands.get(name);
        if (!cmd) return { error: true, message: `Command not found: ${name}. Use action=list to see available commands.` };
        const expanded = expandCommand(cmd, args || '');
        return { name: cmd.name, expandedPrompt: expanded };
      }

      return { error: true, message: `Unknown action: ${action}` };
    },
  });
}
