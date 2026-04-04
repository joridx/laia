/**
 * api_call tool — allows the LLM to make HTTP requests through the resilient-fetch layer.
 * Ported from Claudia, adapted for Laia (domain allowlist, no corporate services).
 *
 * Safety: domain allowlist, method restrictions, size limits, header redaction.
 */

import { resilientFetch, configureService, getService, friendlyError } from '../net/index.js';

// Domain allowlist — only these domains are permitted.
// Extend as new personal services are added.
const ALLOWED_DOMAINS = new Set([
  // Nextcloud (configured dynamically from service registry)
  // Google APIs
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'accounts.google.com',
  // GitHub (public)
  'api.github.com',
  // Copilot
  'api.business.githubcopilot.com',
  'api.githubcopilot.com',
  // Common useful APIs
  'httpbin.org',
  'api.openai.com',
  'api.anthropic.com',
]);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'MKCOL']);
const MAX_BODY_SIZE = 1_000_000; // 1MB
const MAX_RESPONSE_SIZE = 5_000_000; // 5MB display limit

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    // Check registered services first
    if (getService(parsed.hostname)) return true;
    // Then static allowlist
    return ALLOWED_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Add a domain to the allowlist at runtime.
 * Useful when configureService() registers a new service.
 */
export function allowDomain(domain) {
  ALLOWED_DOMAINS.add(domain);
}

/**
 * Register the api_call tool with Laia's tool registry.
 */
export function registerApiCallTool(registry) {
  registry.set('api_call', {
    description: 'Make an HTTP request to an allowed API. Use for Nextcloud, Google, GitHub, etc. Prefer this over bash(curl) for structured API access.',
    parameters: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Registered service name (e.g. "nextcloud") OR full URL',
        },
        path: {
          type: 'string',
          description: 'Path appended to service baseUrl (e.g. "/remote.php/dav/files/user/")',
          default: '',
        },
        method: {
          type: 'string',
          enum: [...ALLOWED_METHODS],
          default: 'GET',
        },
        headers: {
          type: 'object',
          description: 'Additional headers (merged with service defaults)',
        },
        body: {
          type: 'string',
          description: 'Request body (JSON string for POST/PUT/PATCH)',
        },
        cache: {
          type: 'boolean',
          description: 'Use TTL cache for GET requests (30s)',
          default: false,
        },
      },
      required: ['service'],
    },
    execute: async (args) => {
      const { service, path = '', method = 'GET', headers = {}, body, cache = false } = args;

      // Resolve full URL for allowlist check
      const svc = getService(service);
      const fullUrl = svc ? `${svc.baseUrl}${path}` : `${service}${path}`;

      // Safety: check allowlist
      if (!svc && !isAllowedUrl(fullUrl)) {
        return {
          error: true,
          message: `Domain not allowed. Permitted: ${[...ALLOWED_DOMAINS].join(', ')}. Use configureService() to add new services.`,
        };
      }

      // Safety: method check
      if (!ALLOWED_METHODS.has(method.toUpperCase())) {
        return { error: true, message: `Method ${method} not allowed. Use: ${[...ALLOWED_METHODS].join(', ')}` };
      }

      // Safety: body size
      if (body && body.length > MAX_BODY_SIZE) {
        return { error: true, message: `Body too large (${body.length} bytes, max ${MAX_BODY_SIZE})` };
      }

      try {
        const opts = { method, headers, cache };
        if (body) opts.body = body;

        const result = await resilientFetch(service, path, opts);

        // Truncate large responses for LLM context
        let data = result.data;
        if (typeof data === 'string' && data.length > MAX_RESPONSE_SIZE) {
          data = data.slice(0, MAX_RESPONSE_SIZE) + '\n... [truncated]';
        } else if (typeof data === 'object') {
          const json = JSON.stringify(data);
          if (json.length > MAX_RESPONSE_SIZE) {
            data = json.slice(0, MAX_RESPONSE_SIZE) + '\n... [truncated]';
          }
        }

        return {
          status: result.status,
          data,
          cached: result.cached,
        };
      } catch (err) {
        return {
          error: true,
          message: friendlyError(service, err.message, err.code),
        };
      }
    },
  });
}
