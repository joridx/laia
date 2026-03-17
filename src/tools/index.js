// Tool registry and dispatcher
// Tools are defined with JSON Schema for the LLM and an execute function for the runtime.

const registry = new Map();

export function registerTool(name, { description, parameters, execute }) {
  registry.set(name, { name, description, parameters, execute });
}

export function getToolSchemas() {
  return [...registry.values()].map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export async function executeTool(name, args, callId) {
  const tool = registry.get(name);
  if (!tool) return { error: true, message: `Unknown tool: ${name}` };
  return tool.execute(args, callId);
}

export function getToolNames() {
  return [...registry.keys()];
}

// Register all built-in tools
export async function registerBuiltinTools(config) {
  const { registerReadTool } = await import('./read.js');
  const { registerWriteTool } = await import('./write.js');
  const { registerEditTool } = await import('./edit.js');
  const { registerBashTool } = await import('./bash.js');
  const { registerGlobTool } = await import('./glob.js');
  const { registerGrepTool } = await import('./grep.js');

  registerReadTool(config);
  registerWriteTool(config);
  registerEditTool(config);
  registerBashTool(config);
  registerGlobTool(config);
  registerGrepTool(config);

  // Brain tools (MCP)
  const { registerBrainTools } = await import('./brain.js');
  registerBrainTools(config);

  // Command registry tool (lets LLM discover and run slash commands)
  const { registerCommandTool } = await import('./command.js');
  registerCommandTool(config);
}
