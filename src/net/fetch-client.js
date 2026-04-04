/**
 * Lean resilient-fetch — HTTP client with retry, timeout, and circuit breaker.
 * Ported from Claudia's src/lib/net/, adapted for Laia (lighter, no audit log).
 *
 * Usage:
 *   import { resilientFetch, configureService } from './fetch-client.js';
 *
 *   configureService('nextcloud', {
 *     baseUrl: 'https://cloud.example.com',
 *     headers: { Authorization: 'Basic ...' },
 *   });
 *
 *   const { data, status } = await resilientFetch('nextcloud', '/remote.php/dav/files/user/', {
 *     method: 'PROPFIND',
 *     headers: { Depth: '1' },
 *   });
 */

// ── Service registry ────────────────────────────────────────────────────────

const _services = new Map();

/**
 * Register or update a service configuration.
 * @param {string} name - Service identifier
 * @param {{ baseUrl: string, headers?: object, timeout?: number, maxRetries?: number }} config
 */
export function configureService(name, config) {
  _services.set(name, { timeout: 15000, maxRetries: 2, ...config });
}

/**
 * Get a registered service config.
 * @param {string} name
 * @returns {object|undefined}
 */
export function getService(name) { return _services.get(name); }

/**
 * List all registered service names.
 */
export function listServices() { return [..._services.keys()]; }

// ── Circuit Breaker (per-service) ───────────────────────────────────────────

const _breakers = new Map();
const CB_THRESHOLD = 5;     // failures before opening
const CB_RESET_MS = 60000;  // 60s before half-open

function getBreaker(service) {
  if (!_breakers.has(service)) {
    _breakers.set(service, { state: 'closed', failures: 0, lastFailure: 0 });
  }
  return _breakers.get(service);
}

function recordBreakerSuccess(service) {
  const cb = getBreaker(service);
  cb.state = 'closed';
  cb.failures = 0;
}

function recordBreakerFailure(service) {
  const cb = getBreaker(service);
  cb.failures++;
  cb.lastFailure = Date.now();
  if (cb.failures >= CB_THRESHOLD) cb.state = 'open';
}

function isBreakerOpen(service) {
  const cb = getBreaker(service);
  if (cb.state === 'closed') return false;
  if (cb.state === 'open' && Date.now() - cb.lastFailure > CB_RESET_MS) {
    cb.state = 'half-open';
    return false; // allow one probe
  }
  return cb.state === 'open';
}

/**
 * Get circuit breaker state for a service.
 * @param {string} service
 * @returns {{ state: string, failures: number }}
 */
export function getBreakerState(service) {
  const cb = getBreaker(service);
  return { state: cb.state, failures: cb.failures };
}

/**
 * Reset a circuit breaker manually.
 * @param {string} service
 */
export function resetBreaker(service) {
  _breakers.delete(service);
}

// ── Retry with jitter ───────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jitteredBackoff(attempt) {
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  return base + Math.random() * base * 0.3;
}

// ── TTL Cache (GET only) ────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL_MS = 30000; // 30s default

function cacheKey(service, path) { return `${service}:${path}`; }

function getCached(service, path) {
  const key = cacheKey(service, path);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(service, path, value) {
  _cache.set(cacheKey(service, path), { value, time: Date.now() });
}

/**
 * Clear the response cache.
 * @param {string} [service] - If provided, only clear entries for this service
 */
export function clearCache(service) {
  if (service) {
    for (const key of _cache.keys()) {
      if (key.startsWith(service + ':')) _cache.delete(key);
    }
  } else {
    _cache.clear();
  }
}

// ── Main fetch function ─────────────────────────────────────────────────────

/**
 * Make an HTTP request with retry, timeout, and circuit breaker.
 *
 * @param {string} service - Registered service name, or raw URL
 * @param {string} [path=''] - Path appended to service baseUrl
 * @param {object} [options={}] - fetch options + { cache: boolean }
 * @returns {Promise<{ data: any, status: number, headers: Headers, cached: boolean }>}
 */
export async function resilientFetch(service, path = '', options = {}) {
  const { cache: useCache = false, ...fetchOpts } = options;
  const method = (fetchOpts.method || 'GET').toUpperCase();

  // Resolve URL
  const svc = _services.get(service);
  const url = svc ? `${svc.baseUrl}${path}` : `${service}${path}`;
  const timeout = fetchOpts.timeout || svc?.timeout || 15000;
  const maxRetries = fetchOpts.maxRetries ?? svc?.maxRetries ?? 2;

  // Merge service headers
  const headers = { ...(svc?.headers || {}), ...(fetchOpts.headers || {}) };

  // Cache check (GET only)
  if (useCache && method === 'GET') {
    const cached = getCached(service, path);
    if (cached) return { ...cached, cached: true };
  }

  // Circuit breaker
  if (isBreakerOpen(service)) {
    throw new Error(`Circuit breaker OPEN for ${service} (${getBreaker(service).failures} failures)`);
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(jitteredBackoff(attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        ...fetchOpts,
        method,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Parse response
      const contentType = res.headers.get('content-type') || '';
      let data;
      if (contentType.includes('json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }

      const result = { data, status: res.status, headers: res.headers, cached: false };

      // Success
      if (res.ok) {
        recordBreakerSuccess(service);
        if (useCache && method === 'GET') setCache(service, path, result);
        return result;
      }

      // Non-retryable errors
      if (res.status >= 400 && res.status < 500) {
        recordBreakerSuccess(service); // client error, service is fine
        return result;
      }

      // 5xx — retryable
      lastError = new Error(`HTTP ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`);
      lastError.status = res.status;
      recordBreakerFailure(service);

    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (err.name === 'AbortError') {
        lastError = new Error(`Request to ${service}${path} timed out after ${timeout}ms`);
      }
      recordBreakerFailure(service);
    }
  }

  throw lastError;
}
