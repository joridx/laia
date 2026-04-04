import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerApiCallTool, allowDomain } from '../../src/tools/api-call.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { configureService } from '../../src/net/index.js';

describe('api_call tool', () => {
  const registry = createToolRegistry();
  registerApiCallTool(registry);
  const tool = registry.get('api_call');

  it('registers with correct schema', () => {
    assert.ok(tool);
    assert.equal(tool.name, 'api_call');
    assert.ok(tool.parameters.properties.service);
    assert.ok(tool.parameters.properties.method);
  });

  it('rejects disallowed domains', async () => {
    const result = await tool.execute({ service: 'https://evil.com/steal' });
    assert.ok(result.error);
    assert.match(result.message, /Domain not allowed/);
  });

  it('allows registered service by name', async () => {
    configureService('test-api', { baseUrl: 'https://localhost:9999', timeout: 500, maxRetries: 0 });
    const result = await tool.execute({ service: 'test-api', path: '/health' });
    // Will fail with network error, but should NOT be blocked by allowlist
    assert.ok(result.error);
    assert.ok(!result.message.includes('Domain not allowed'));
  });

  it('rejects disallowed methods', async () => {
    const result = await tool.execute({ service: 'https://api.github.com', method: 'TRACE' });
    assert.ok(result.error);
    assert.match(result.message, /Method.*not allowed/);
  });

  it('rejects oversized body', async () => {
    const bigBody = 'x'.repeat(1_100_000);
    const result = await tool.execute({ service: 'https://api.github.com', method: 'POST', body: bigBody });
    assert.ok(result.error);
    assert.match(result.message, /Body too large/);
  });

  it('allowDomain adds to allowlist', async () => {
    allowDomain('custom.example.com');
    configureService('custom-test', { baseUrl: 'https://custom.example.com', timeout: 500, maxRetries: 0 });
    const result = await tool.execute({ service: 'https://custom.example.com/test' });
    // Network error expected, but not "Domain not allowed"
    assert.ok(result.error);
    assert.ok(!result.message.includes('Domain not allowed'));
  });
});
