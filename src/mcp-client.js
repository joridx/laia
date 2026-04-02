// MCP Client — connects to external MCP servers defined in --mcp-config <path>
// Reads Claude Code-style JSON: { mcpServers: { "name": { command, args, env } } }
// Spawns each server, lists tools, registers them in LAIA's tool registry.
// Tool names are namespaced as mcp__<server>__<tool> (matching Claude Code convention).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { registerTool } from './tools/index.js';

/**
 * Connect to all MCP servers defined in a config file.
 * @param {string} configPath - Path to JSON file with { mcpServers: { ... } }
 * @param {object} config - LAIA config (unused for now, reserved for future)
 * @returns {Function} cleanup — call to disconnect all servers
 */
export async function connectMcpServers(configPath, config) {
  // Parse config
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read MCP config from ${configPath}: ${err.message}`);
  }

  const servers = raw.mcpServers;
  if (!servers || typeof servers !== 'object') {
    throw new Error(`Invalid MCP config: expected { mcpServers: { ... } }`);
  }

  const clients = [];
  const transports = [];

  for (const [serverName, serverDef] of Object.entries(servers)) {
    if (!serverDef.command) {
      process.stderr.write(`[mcp-client] Skipping server "${serverName}": no command defined\n`);
      continue;
    }

    try {
      const transport = new StdioClientTransport({
        command: serverDef.command,
        args: serverDef.args || [],
        env: { ...process.env, ...(serverDef.env || {}) },
        stderr: 'pipe',
      });

      // Pipe server stderr to our stderr for debugging
      transport.stderr?.on('data', (chunk) => {
        process.stderr.write(`[mcp:${serverName}] ${chunk}`);
      });

      const client = new Client({
        name: 'laia',
        version: '2.0.0',
      });

      await client.connect(transport);

      // List tools and register each one
      const { tools } = await client.listTools();
      let registered = 0;

      for (const tool of tools) {
        const namespacedName = `mcp__${serverName}__${tool.name}`;

        registerTool(namespacedName, {
          description: tool.description || `MCP tool: ${tool.name} (${serverName})`,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          async execute(args) {
            try {
              const result = await client.callTool({ name: tool.name, arguments: args });
              // MCP tool results come as { content: [{type, text}], isError }
              if (result.isError) {
                const errText = result.content
                  ?.filter(c => c.type === 'text')
                  .map(c => c.text)
                  .join('\n') || 'MCP tool error';
                return { error: true, message: errText };
              }
              const text = result.content
                ?.filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n') || '';
              return text;
            } catch (err) {
              return { error: true, message: `MCP call failed: ${err.message}` };
            }
          },
        });
        registered++;
      }

      clients.push(client);
      transports.push(transport);
      process.stderr.write(`[mcp-client] Connected to "${serverName}": ${registered} tools registered\n`);
    } catch (err) {
      process.stderr.write(`[mcp-client] Failed to connect to "${serverName}": ${err.message}\n`);
      // Continue with other servers (graceful degradation)
    }
  }

  // Return cleanup function
  return async () => {
    for (const client of clients) {
      try { await client.close(); } catch {}
    }
  };
}
