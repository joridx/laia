import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, defaultRegistry, getToolSchemas, executeTool, getToolNames } from '../../src/tools/index.js';

describe('createToolRegistry', () => {
  test('creates an empty registry', () => {
    const reg = createToolRegistry();
    assert.deepStrictEqual(reg.getNames(), []);
    assert.deepStrictEqual(reg.getSchemas(), []);
  });

  test('set/get/has/delete work', () => {
    const reg = createToolRegistry();
    reg.set('foo', { description: 'd', parameters: {}, execute: () => 42 });
    assert.ok(reg.has('foo'));
    assert.equal(reg.get('foo').name, 'foo');
    reg.delete('foo');
    assert.ok(!reg.has('foo'));
  });

  test('two instances are fully isolated', () => {
    const a = createToolRegistry();
    const b = createToolRegistry();
    a.set('only_a', { description: 'a', parameters: {}, execute: () => 'a' });
    b.set('only_b', { description: 'b', parameters: {}, execute: () => 'b' });
    assert.ok(a.has('only_a'));
    assert.ok(!a.has('only_b'));
    assert.ok(b.has('only_b'));
    assert.ok(!b.has('only_a'));
  });

  test('getSchemas returns correct format', () => {
    const reg = createToolRegistry();
    reg.set('mytool', {
      description: 'My tool',
      parameters: { type: 'object', properties: {} },
      execute: () => ({}),
    });
    const schemas = reg.getSchemas();
    assert.equal(schemas.length, 1);
    assert.deepStrictEqual(schemas[0], {
      type: 'function',
      name: 'mytool',
      description: 'My tool',
      parameters: { type: 'object', properties: {} },
    });
  });

  test('execute returns error for unknown tool', async () => {
    const reg = createToolRegistry();
    const result = await reg.execute('nonexistent', {});
    assert.equal(result.error, true);
    assert.match(result.message, /Unknown tool/);
  });

  test('execute calls the tool function', async () => {
    const reg = createToolRegistry();
    reg.set('adder', {
      description: 'add',
      parameters: {},
      execute: ({ a, b }) => ({ sum: a + b }),
    });
    const result = await reg.execute('adder', { a: 2, b: 3 });
    assert.equal(result.sum, 5);
  });
});

describe('defaultRegistry backwards-compat', () => {
  test('getToolSchemas delegates to defaultRegistry', () => {
    // defaultRegistry is populated by registerBuiltinTools in real usage;
    // here we just verify the function exists and returns an array
    const schemas = getToolSchemas();
    assert.ok(Array.isArray(schemas));
  });

  test('getToolNames delegates to defaultRegistry', () => {
    const names = getToolNames();
    assert.ok(Array.isArray(names));
  });

  test('executeTool delegates to defaultRegistry', async () => {
    const result = await executeTool('nonexistent_tool_xyz', {});
    assert.equal(result.error, true);
  });
});

describe('registerBuiltinTools with custom registry', () => {
  test('registers tools into custom registry, not default', async () => {
    const custom = createToolRegistry();
    const namesBefore = defaultRegistry.getNames().length;

    const { registerBuiltinTools } = await import('../../src/tools/index.js');
    await registerBuiltinTools({ workspaceRoot: process.cwd(), commandDirs: [] }, custom);

    // Custom registry has tools
    const customNames = custom.getNames();
    assert.ok(customNames.includes('read'));
    assert.ok(customNames.includes('write'));
    assert.ok(customNames.includes('bash'));
    assert.ok(customNames.includes('glob'));
    assert.ok(customNames.includes('grep'));
    assert.ok(customNames.includes('edit'));
    assert.ok(customNames.includes('git_diff'));
    assert.ok(customNames.includes('git_status'));
    assert.ok(customNames.includes('git_log'));

    // Default registry was not modified by this call
    assert.equal(defaultRegistry.getNames().length, namesBefore);
  });

  test('config.swarm=false does not register agent tool', async () => {
    const custom = createToolRegistry();
    const { registerBuiltinTools } = await import('../../src/tools/index.js');
    await registerBuiltinTools({ workspaceRoot: process.cwd(), commandDirs: [], swarm: false }, custom);
    assert.ok(!custom.has('agent'));
  });

  test('config.swarm=true registers agent tool', async () => {
    const custom = createToolRegistry();
    const { registerBuiltinTools } = await import('../../src/tools/index.js');
    await registerBuiltinTools({ workspaceRoot: process.cwd(), commandDirs: [], swarm: true }, custom);
    assert.ok(custom.has('agent'));
    const schema = custom.getSchemas().find(s => s.name === 'agent');
    assert.equal(schema.type, 'function');
    assert.ok(schema.parameters.properties.prompt);
  });

  test('tools in custom registry actually execute', async () => {
    const custom = createToolRegistry();
    const { registerBuiltinTools } = await import('../../src/tools/index.js');
    await registerBuiltinTools({ workspaceRoot: process.cwd(), commandDirs: [] }, custom);

    // read tool should be able to read this test file
    const result = await custom.execute('read', { path: 'tests/unit/registry.test.js' });
    assert.ok(result.content.includes('createToolRegistry'));
    assert.ok(!result.error);
  });
});
