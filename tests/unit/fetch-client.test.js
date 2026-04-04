import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureService, getService, listServices,
  resilientFetch, getBreakerState, resetBreaker, clearCache,
} from '../../src/net/fetch-client.js';

describe('fetch-client', () => {
  beforeEach(() => {
    clearCache();
  });

  describe('service registry', () => {
    it('registers and retrieves a service', () => {
      configureService('test-svc', { baseUrl: 'https://example.com' });
      const svc = getService('test-svc');
      assert.equal(svc.baseUrl, 'https://example.com');
      assert.equal(svc.timeout, 15000); // default
      assert.equal(svc.maxRetries, 2);  // default
    });

    it('lists registered services', () => {
      configureService('svc-a', { baseUrl: 'https://a.com' });
      configureService('svc-b', { baseUrl: 'https://b.com' });
      const names = listServices();
      assert.ok(names.includes('svc-a'));
      assert.ok(names.includes('svc-b'));
    });

    it('overrides defaults with provided values', () => {
      configureService('custom', { baseUrl: 'https://c.com', timeout: 5000, maxRetries: 0 });
      const svc = getService('custom');
      assert.equal(svc.timeout, 5000);
      assert.equal(svc.maxRetries, 0);
    });
  });

  describe('circuit breaker', () => {
    it('starts in closed state', () => {
      const state = getBreakerState('new-service');
      assert.equal(state.state, 'closed');
      assert.equal(state.failures, 0);
    });

    it('resets breaker', () => {
      resetBreaker('some-service');
      const state = getBreakerState('some-service');
      assert.equal(state.state, 'closed');
    });
  });

  describe('resilientFetch', () => {
    it('throws on unreachable URL', async () => {
      try {
        await resilientFetch('https://localhost:1', '', { timeout: 500, maxRetries: 0 });
        assert.fail('Should have thrown');
      } catch (err) {
        // Any network error is expected (timeout, ECONNREFUSED, fetch failed, etc.)
        assert.ok(err instanceof Error, `Expected Error, got: ${err}`);
      }
    });

    it('throws on circuit breaker open', async () => {
      // Force breaker open by recording many failures
      const service = 'force-open-test';
      configureService(service, { baseUrl: 'https://localhost:1', timeout: 100, maxRetries: 0 });

      // Trigger 5 failures to open breaker
      for (let i = 0; i < 5; i++) {
        try { await resilientFetch(service, '/fail'); } catch {}
      }

      const state = getBreakerState(service);
      assert.equal(state.state, 'open');

      await assert.rejects(
        () => resilientFetch(service, '/blocked'),
        /Circuit breaker OPEN/
      );
    });
  });

  describe('cache', () => {
    it('clearCache works without error', () => {
      clearCache();
      clearCache('nonexistent');
    });
  });
});
