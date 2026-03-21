import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, detectProvider, getProvider, isProviderAvailable,
  buildAuthHeaders, resolveToken, resolveUrl, getBaseUrl,
  findCopilotAppsJson, getTempDir,
} from '../packages/providers/src/providers.js';

// ─── Helper: save/restore env vars ───────────────────────────────────────────

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

// ─── PROVIDERS registry ──────────────────────────────────────────────────────

describe('@claude/providers — registry', () => {
  it('has all 5 providers', () => {
    assert.deepStrictEqual(Object.keys(PROVIDERS).sort(), ['anthropic', 'azure_openai', 'copilot', 'ollama', 'openai']);
  });

  it('each provider has required fields', () => {
    for (const [id, p] of Object.entries(PROVIDERS)) {
      assert.equal(p.id, id, `${id}.id mismatch`);
      assert.ok(p.auth, `${id} missing auth`);
      assert.ok(p.supports, `${id} missing supports`);
      assert.ok(p.quirks !== undefined, `${id} missing quirks`);
      assert.ok(p.extraHeaders !== undefined, `${id} missing extraHeaders`);
    }
  });

  it('copilot has Copilot-specific headers and empty quirks', () => {
    const c = PROVIDERS.copilot;
    assert.ok(c.extraHeaders['Editor-Version']);
    assert.ok(c.extraHeaders['Copilot-Integration-Id']);
    assert.deepEqual(c.quirks, {});
  });
});

// ─── detectProvider ──────────────────────────────────────────────────────────

describe('@claude/providers — detectProvider', () => {
  it('routes claude models to anthropic (when available)', () => {
    withEnv({ ANTHROPIC_API_KEY: 'test-key' }, () => {
      const r = detectProvider('claude-opus-4.6');
      assert.equal(r.providerId, 'anthropic');
      assert.equal(r.model, 'claude-opus-4.6');
    });
  });

  it('falls back to copilot when anthropic key not set', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      const r = detectProvider('claude-opus-4.6');
      assert.equal(r.providerId, 'copilot');
      assert.equal(r.model, 'claude-opus-4.6');
    });
  });

  it('routes gpt models to openai (when available)', () => {
    withEnv({ OPENAI_API_KEY: 'test-key' }, () => {
      const r = detectProvider('gpt-5-mini');
      assert.equal(r.providerId, 'openai');
    });
  });

  it('routes codex models to openai (when available)', () => {
    withEnv({ OPENAI_API_KEY: 'test-key' }, () => {
      const r = detectProvider('gpt-5.3-codex');
      assert.equal(r.providerId, 'openai');
    });
  });

  it('routes o1/o3/o4 models to openai', () => {
    withEnv({ OPENAI_API_KEY: 'test-key' }, () => {
      assert.equal(detectProvider('o1-mini').providerId, 'openai');
      assert.equal(detectProvider('o3-medium').providerId, 'openai');
      assert.equal(detectProvider('o4-mini').providerId, 'openai');
    });
  });

  it('does not match o2- or oracle as openai', () => {
    const r = detectProvider('o2-something');
    assert.notEqual(r.providerId, 'openai');
  });

  it('routes llama/mistral/qwen/deepseek to ollama', () => {
    assert.equal(detectProvider('llama-3.3-70b').providerId, 'ollama');
    assert.equal(detectProvider('mistral-7b').providerId, 'ollama');
    assert.equal(detectProvider('qwen-2.5').providerId, 'ollama');
    assert.equal(detectProvider('deepseek-coder').providerId, 'ollama');
    assert.equal(detectProvider('gemma-2b').providerId, 'ollama');
  });

  it('explicit prefix overrides auto-detection', () => {
    const r = detectProvider('copilot:claude-opus-4.6');
    assert.equal(r.providerId, 'copilot');
    assert.equal(r.model, 'claude-opus-4.6');
  });

  it('explicit prefix forces provider even without key', () => {
    withEnv({ OPENAI_API_KEY: undefined }, () => {
      const r = detectProvider('openai:gpt-5-mini');
      assert.equal(r.providerId, 'openai');
      assert.equal(r.model, 'gpt-5-mini');
    });
  });

  it('unknown model falls back to default provider', () => {
    const r = detectProvider('some-random-model');
    assert.equal(r.providerId, 'copilot');
  });

  it('respects defaultProvider option', () => {
    const r = detectProvider('some-random-model', { defaultProvider: 'ollama' });
    assert.equal(r.providerId, 'ollama');
  });

  it('respects CLAUDIA_DEFAULT_PROVIDER env', () => {
    withEnv({ CLAUDIA_DEFAULT_PROVIDER: 'ollama' }, () => {
      const r = detectProvider('some-random-model');
      assert.equal(r.providerId, 'ollama');
    });
  });

  it('handles whitespace and case in model name', () => {
    withEnv({ ANTHROPIC_API_KEY: 'test' }, () => {
      const r = detectProvider('  Claude-Opus-4.6  ');
      assert.equal(r.providerId, 'anthropic');
      // Model is lowercased+trimmed (internal normalization for pattern matching)
      assert.equal(r.model, 'claude-opus-4.6');
    });
  });

  it('preserves original model name on fallback', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      const r = detectProvider('Claude-Opus-4.6');
      assert.equal(r.providerId, 'copilot');
      // On fallback, original model name is preserved for the API
      assert.equal(r.model, 'Claude-Opus-4.6');
    });
  });

  it('handles null/undefined/empty model', () => {
    assert.equal(detectProvider(null).providerId, 'copilot');
    assert.equal(detectProvider(undefined).providerId, 'copilot');
    assert.equal(detectProvider('').providerId, 'copilot');
    assert.equal(detectProvider('  ').providerId, 'copilot');
  });

  it('cascades fallback when default provider unavailable', () => {
    withEnv({ OPENAI_API_KEY: undefined, CLAUDIA_DEFAULT_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'test' }, () => {
      // claude model → anthropic detected → available → returns anthropic
      assert.equal(detectProvider('claude-opus-4.6').providerId, 'anthropic');
    });
    withEnv({ OPENAI_API_KEY: undefined, CLAUDIA_DEFAULT_PROVIDER: 'openai', ANTHROPIC_API_KEY: undefined }, () => {
      // claude model → anthropic detected → unavailable → fallback openai → unavailable → cascade to copilot
      const r = detectProvider('claude-opus-4.6');
      assert.equal(r.providerId, 'copilot');
    });
  });
});

// ─── getProvider ─────────────────────────────────────────────────────────────

describe('@claude/providers — getProvider', () => {
  it('returns provider by id', () => {
    assert.equal(getProvider('copilot').id, 'copilot');
    assert.equal(getProvider('openai').id, 'openai');
  });

  it('throws on unknown provider', () => {
    assert.throws(() => getProvider('nonexistent'), /Unknown provider/);
  });
});

// ─── isProviderAvailable ─────────────────────────────────────────────────────

describe('@claude/providers — isProviderAvailable', () => {
  it('ollama is always available (auth=none)', () => {
    assert.ok(isProviderAvailable('ollama'));
  });

  it('copilot is available when apps.json exists', () => {
    // This test depends on the environment — skip assertion if no apps.json
    const appsJson = findCopilotAppsJson();
    assert.equal(isProviderAvailable('copilot'), appsJson !== null);
  });

  it('openai is available only when OPENAI_API_KEY set', () => {
    withEnv({ OPENAI_API_KEY: undefined }, () => {
      assert.ok(!isProviderAvailable('openai'));
    });
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      assert.ok(isProviderAvailable('openai'));
    });
  });

  it('returns false for unknown provider', () => {
    assert.ok(!isProviderAvailable('nonexistent'));
  });
});

// ─── buildAuthHeaders ────────────────────────────────────────────────────────

describe('@claude/providers — buildAuthHeaders', () => {
  it('copilot → Bearer', () => {
    assert.deepStrictEqual(buildAuthHeaders(getProvider('copilot'), 'tok'), { Authorization: 'Bearer tok' });
  });

  it('openai → Bearer', () => {
    assert.deepStrictEqual(buildAuthHeaders(getProvider('openai'), 'sk'), { Authorization: 'Bearer sk' });
  });

  it('anthropic → x-api-key', () => {
    assert.deepStrictEqual(buildAuthHeaders(getProvider('anthropic'), 'ant'), { 'x-api-key': 'ant' });
  });

  it('azure → api-key', () => {
    assert.deepStrictEqual(buildAuthHeaders(getProvider('azure_openai'), 'az'), { 'api-key': 'az' });
  });

  it('ollama → empty', () => {
    assert.deepStrictEqual(buildAuthHeaders(getProvider('ollama'), null), {});
  });
});

// ─── resolveToken ────────────────────────────────────────────────────────────

describe('@claude/providers — resolveToken', () => {
  it('none provider returns null', async () => {
    assert.equal(await resolveToken(getProvider('ollama')), null);
  });

  it('copilot calls getCopilotToken callback', async () => {
    const token = await resolveToken(getProvider('copilot'), { getCopilotToken: async () => 'cop-tok' });
    assert.equal(token, 'cop-tok');
  });

  it('copilot throws without callback', async () => {
    await assert.rejects(() => resolveToken(getProvider('copilot')), /getCopilotToken callback required/);
  });

  it('bearer reads from env', async () => {
    const token = await withEnv({ OPENAI_API_KEY: 'sk-test' }, () => resolveToken(getProvider('openai')));
    assert.equal(token, 'sk-test');
  });

  it('bearer throws when env not set', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      await assert.rejects(() => resolveToken(getProvider('openai')), /Missing env var OPENAI_API_KEY/);
    });
  });
});

// ─── resolveUrl ──────────────────────────────────────────────────────────────

// ─── resolveUrl + getBaseUrl (call-time env resolution) ──────────────────────────

describe('@claude/providers — resolveUrl', () => {
  it('copilot: baseUrl + endpoint', () => {
    assert.equal(resolveUrl(getProvider('copilot'), 'chat/completions'), 'https://api.business.githubcopilot.com/chat/completions');
  });

  it('copilot: responses endpoint', () => {
    assert.equal(resolveUrl(getProvider('copilot'), 'responses'), 'https://api.business.githubcopilot.com/responses');
  });

  it('openai: default baseUrl + endpoint', () => {
    withEnv({ OPENAI_BASE_URL: undefined }, () => {
      assert.equal(resolveUrl(getProvider('openai'), 'chat/completions'), 'https://api.openai.com/v1/chat/completions');
    });
  });

  it('openai: respects OPENAI_BASE_URL at call time', () => {
    withEnv({ OPENAI_BASE_URL: 'https://custom.openai.proxy/v1' }, () => {
      assert.equal(resolveUrl(getProvider('openai'), 'chat/completions'), 'https://custom.openai.proxy/v1/chat/completions');
    });
  });

  it('env changes between calls are reflected (not stale)', () => {
    withEnv({ OPENAI_BASE_URL: 'https://first.com/v1' }, () => {
      assert.equal(resolveUrl(getProvider('openai'), 'models'), 'https://first.com/v1/models');
    });
    withEnv({ OPENAI_BASE_URL: 'https://second.com/v1' }, () => {
      assert.equal(resolveUrl(getProvider('openai'), 'models'), 'https://second.com/v1/models');
    });
  });

  it('handles leading slash in endpoint', () => {
    assert.equal(resolveUrl(getProvider('copilot'), '/chat/completions'), 'https://api.business.githubcopilot.com/chat/completions');
  });

  it('azure: deployment-based URL', () => {
    withEnv({
      AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com',
      AZURE_OPENAI_DEPLOYMENT: 'gpt-4o-deploy',
    }, () => {
      const url = resolveUrl(getProvider('azure_openai'), 'chat/completions');
      assert.ok(url.includes('/openai/deployments/gpt-4o-deploy/chat/completions'));
      assert.ok(url.includes('api-version='));
    });
  });

  it('azure: strips trailing slash from endpoint', () => {
    withEnv({
      AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com/',
      AZURE_OPENAI_DEPLOYMENT: 'deploy1',
    }, () => {
      const url = resolveUrl(getProvider('azure_openai'), 'chat/completions');
      assert.ok(!url.includes('//openai'));
    });
  });

  it('azure: throws without endpoint/deployment', () => {
    withEnv({ AZURE_OPENAI_ENDPOINT: undefined, AZURE_OPENAI_DEPLOYMENT: undefined }, () => {
      assert.throws(() => resolveUrl(getProvider('azure_openai'), 'chat/completions'), /AZURE_OPENAI_ENDPOINT/);
    });
  });
});

describe('@claude/providers — getBaseUrl', () => {
  it('returns static baseUrl for copilot', () => {
    assert.equal(getBaseUrl(getProvider('copilot')), 'https://api.business.githubcopilot.com');
  });

  it('resolves env var at call time for openai', () => {
    withEnv({ OPENAI_BASE_URL: 'https://proxy.corp.com/v1' }, () => {
      assert.equal(getBaseUrl(getProvider('openai')), 'https://proxy.corp.com/v1');
    });
  });

  it('returns default when env not set', () => {
    withEnv({ OPENAI_BASE_URL: undefined }, () => {
      assert.equal(getBaseUrl(getProvider('openai')), 'https://api.openai.com/v1');
    });
  });
});

// ─── Cross-platform utilities ────────────────────────────────────────────────

describe('@claude/providers — cross-platform', () => {
  it('findCopilotAppsJson returns string or null', () => {
    const result = findCopilotAppsJson();
    assert.ok(result === null || typeof result === 'string');
  });

  it('getTempDir returns a non-empty string', () => {
    assert.ok(getTempDir().length > 0);
  });
});
