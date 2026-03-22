// Tool registry and dispatcher
// Tools are defined with JSON Schema for the LLM and an execute function for the runtime.

export function createToolRegistry() {
  const reg = new Map();
  let frozen = false;
  return {
    set(name, def) {
      if (frozen) throw new Error(`Registry is frozen — cannot register '${name}'`);
      reg.set(name, { name, ...def });
    },
    get(name) { return reg.get(name); },
    delete(name) {
      if (frozen) throw new Error(`Registry is frozen — cannot delete '${name}'`);
      return reg.delete(name);
    },
    has(name) { return reg.has(name); },
    getSchemas(opts = {}) {
      let schemas = [...reg.values()];
      if (opts.exclude?.length) {
        const excluded = new Set(opts.exclude);
        schemas = schemas.filter(t => !excluded.has(t.name));
      }
      return schemas.map(t => ({
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
    freeze() { frozen = true; },
    get frozen() { return frozen; },
  };
}

// Default singleton — used by REPL and one-shot mode
export const defaultRegistry = createToolRegistry();

// Backwards-compat: delegate to defaultRegistry
export function registerTool(name, def) { defaultRegistry.set(name, def); }
export function getToolSchemas(opts) { return defaultRegistry.getSchemas(opts); }
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

  // Freeze: no more registrations after bootstrap (architecture review finding #1)
  // Exception: REPL /swarm toggle needs to add/remove agent tool → only freeze in non-REPL modes
  if (config.freeze !== false) registry.freeze();
}
