// Tool registry and dispatcher
// Tools are defined with JSON Schema for the LLM and an execute function for the runtime.

export function createToolRegistry() {
  const reg = new Map();
  return {
    set(name, def) { reg.set(name, { name, ...def }); },
    get(name) { return reg.get(name); },
    delete(name) { return reg.delete(name); },
    has(name) { return reg.has(name); },
    getSchemas() {
      return [...reg.values()].map(t => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    },
    async execute(name, args, callId) {
      const tool = reg.get(name);
      if (!tool) return { error: true, message: `Unknown tool: ${name}` };
      return tool.execute(args, callId);
    },
    getNames() { return [...reg.keys()]; },
  };
}

// Default singleton — used by REPL and one-shot mode
export const defaultRegistry = createToolRegistry();

// Backwards-compat: delegate to defaultRegistry
export function registerTool(name, def) { defaultRegistry.set(name, def); }
export function getToolSchemas() { return defaultRegistry.getSchemas(); }
export async function executeTool(name, args, callId) { return defaultRegistry.execute(name, args, callId); }
export function getToolNames() { return defaultRegistry.getNames(); }

// Register all built-in tools
export async function registerBuiltinTools(config, registry = defaultRegistry) {
  const { registerReadTool } = await import('./read.js');
  const { registerWriteTool } = await import('./write.js');
  const { registerEditTool } = await import('./edit.js');
  const { registerBashTool } = await import('./bash.js');
  const { registerGlobTool } = await import('./glob.js');
  const { registerGrepTool } = await import('./grep.js');

  registerReadTool(config, registry);
  registerWriteTool(config, registry);
  registerEditTool(config, registry);
  registerBashTool(config, registry);
  registerGlobTool(config, registry);
  registerGrepTool(config, registry);

  // Brain tools (MCP)
  const { registerBrainTools } = await import('./brain.js');
  registerBrainTools(config, registry);

  // Command registry tool (lets LLM discover and run slash commands)
  const { registerCommandTool } = await import('./command.js');
  registerCommandTool(config, registry);

  // Git tools (read-only: diff, status, log)
  const { registerGitTools } = await import('./git.js');
  registerGitTools(config, registry);

  // Swarm: agent tool (optional, only when config.swarm is true)
  if (config.swarm) {
    const { registerAgentTool } = await import('./agent.js');
    registerAgentTool(config, registry);
  }
}
