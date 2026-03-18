// MCP server mode — exposes 'agent' tool via stdio JSON-RPC transport
// Usage: node bin/claudia.js --mcp
// Claude Code: claude mcp add claudia -- node /path/to/bin/claudia.js --mcp
//
// CRITICAL: nothing may write to process.stdout except MCP protocol frames.
// All internal logs, worker output, and debug info → process.stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import util from 'node:util';
import { createAgentTool } from './tools/agent.js';
import { registerBuiltinTools } from './tools/index.js';
import { startBrain, stopBrain } from './brain/client.js';
import { createSemaphore } from './swarm.js';

let consoleRedirected = false;
function redirectConsoleToStderr() {
  if (consoleRedirected) return;
  consoleRedirected = true;

  const methods = ['log', 'info', 'debug', 'warn', 'error'];
  for (const m of methods) {
    // Redirect output to stderr to avoid breaking MCP stdout framing.
    // Use util.format to mimic Node console formatting and avoid JSON.stringify pitfalls.
    console[m] = (...args) => {
      try {
        const line = util.format(...args);
        process.stderr.write(`[console.${m}] ${line}\n`);
      } catch {
        process.stderr.write(`[console.${m}] (format error)\n`);
      }
    };
  }
}

export async function startMcpServer({ config, logger, stdoutPolicy = 'strict' }) {
  redirectConsoleToStderr();

  // Workers in MCP mode never recurse back through MCP (disable swarm in worker config)
  const workerConfig = { ...config, swarm: false };

  // Strict MCP safeguard: only the MCP transport is allowed to emit to stdout.
  // Any other stdout output corrupts JSON-RPC framing.
  //
  // On Windows with Git Bash, process.stdout.write uses the Windows HANDLE which may
  // differ from POSIX fd 1 in pipeline contexts. We use fs.writeSync(1, chunk) to write
  // directly to POSIX fd 1, which is always the correct MCP output channel.
  const { writeSync } = await import('node:fs');

  // Guard: intercept any OTHER stdout writes (not from the transport)
  process.stdout.write = (chunk, encoding, cb) => {
    const preview = typeof chunk === 'string'
      ? chunk.slice(0, 200)
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8', 0, Math.min(chunk.length, 200))
        : String(chunk).slice(0, 200);

    if (stdoutPolicy === 'redirect') {
      process.stderr.write(`[mcp] redirected non-protocol stdout: ${preview}\n`);
      if (typeof cb === 'function') cb();
      return true;
    }

    process.stderr.write(`[mcp] ERROR: non-protocol stdout detected (policy=strict): ${preview}\n`);
    process.exitCode = 1;
    process.exit(1);
  };

  // Create a Writable wrapper using fs.writeSync(1, ...) to bypass stream/handle ambiguity.
  // This works correctly on both Linux and Windows (POSIX fd 1 is always the MCP stdout pipe).
  const { Writable } = await import('node:stream');
  const mcpStdout = new Writable({
    write(chunk, encoding, callback) {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
        writeSync(1, buf);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });

  // Brain: start once, owned by server — workers never call startBrain/stopBrain
  try { await startBrain({ brainPath: config.brainPath }); } catch (e) {
    process.stderr.write(`[mcp] brain start failed: ${e.message}\n`);
  }

  // Register builtin tools so workers can use them
  await registerBuiltinTools(workerConfig);

  const agentTool = createAgentTool({ config: workerConfig });
  const semaphore = createSemaphore(8); // max 8 concurrent workers in MCP mode

  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });

  const server = new Server(
    { name: 'claudia', version: pkg.version ?? '0.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'agent',
      description: agentTool.schema.description,
      inputSchema: agentTool.schema.parameters,
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    if (name !== 'agent') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    const release = await semaphore.acquire();
    try {
      const result = await agentTool.execute({
        ...(args ?? {}),
        _signal: extra?.signal,  // forward MCP cancellation into worker AbortController
      });
      return {
        content: [{ type: 'text', text: result.success ? result.text : `Error: ${result.error}` }],
        isError: !result.success,
      };
    } catch (err) {
      process.stderr.write(`[mcp] uncaught error: ${err.message}\n`);
      return { content: [{ type: 'text', text: `Fatal: ${err.message}` }], isError: true };
    } finally {
      release();
    }
  });

  const transport = new StdioServerTransport(process.stdin, mcpStdout);
  await server.connect(transport);
  process.stderr.write('[claudia MCP server] running on stdio\n');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const watchdog = setTimeout(() => {
      process.stderr.write('[mcp] shutdown watchdog fired; forcing exit\n');
      process.exitCode = 1;
      // Forced exit as last resort to avoid hanging stdio MCP clients
      process.exit(1);
    }, 10_000);
    watchdog.unref?.();

    try { await server.close?.(); } catch {}
    try { await transport.close?.(); } catch {}
    try { await stopBrain(); } catch {}

    clearTimeout(watchdog);
    process.exitCode = 0;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
