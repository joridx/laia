// MCP server mode — exposes 'agent' tool via stdio JSON-RPC transport
// Usage: node bin/claudia.js --mcp
// Claude Code: claude mcp add claudia -- node /path/to/bin/claudia.js --mcp
//
// CRITICAL: nothing may write to process.stdout except MCP protocol frames.
// All internal logs, worker output, and debug info → process.stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentTool } from './tools/agent.js';
import { registerBuiltinTools } from './tools/index.js';
import { startBrain, stopBrain } from './brain/client.js';

export async function startMcpServer({ config, logger }) {
  // Workers in MCP mode never recurse back through MCP (disable swarm in worker config)
  const workerConfig = { ...config, swarm: false };

  // Brain: start once, owned by server — workers never call startBrain/stopBrain
  try { await startBrain({ brainPath: config.brainPath }); } catch (e) {
    process.stderr.write(`[mcp] brain start failed: ${e.message}\n`);
  }

  // Register builtin tools so workers can use them
  await registerBuiltinTools(workerConfig);

  const agentTool = createAgentTool({ config: workerConfig });

  const server = new Server(
    { name: 'claudia', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'agent',
      description: agentTool.schema.description,
      inputSchema: agentTool.schema.parameters,
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== 'agent') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    try {
      const result = await agentTool.execute(args ?? {});
      return {
        content: [{ type: 'text', text: result.success ? result.text : `Error: ${result.error}` }],
        isError: !result.success,
      };
    } catch (err) {
      process.stderr.write(`[mcp] uncaught error: ${err.message}\n`);
      return { content: [{ type: 'text', text: `Fatal: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[claudia MCP server] running on stdio\n');

  const shutdown = async () => {
    try { await stopBrain(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
