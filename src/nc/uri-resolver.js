// src/nc/uri-resolver.js — Resolve nc:// URIs to Nextcloud WebDAV URLs
// Sprint 1.5: Knowledge Store
//
// Protocol: nc:///path/to/file → ${NC_URL}/remote.php/dav/files/${NC_USER}/path/to/file
// On Raspberry Pi: NC_URL=http://localhost → zero-latency local access

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_NC_URL = 'http://localhost';
const DEFAULT_NC_USER = 'laia';
const NC_PREFIX = 'nc:///';
const DEFAULT_ALLOWED_PREFIXES = ['knowledge/'];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve a nc:/// URI to a full WebDAV URL.
 *
 * @param {string} uri - nc:///knowledge/docs/spec.pdf
 * @returns {string} Full WebDAV URL
 * @throws {Error} if URI doesn't start with nc:///
 */
export function resolveNcUri(uri) {
  if (!uri || !uri.startsWith(NC_PREFIX)) {
    throw new Error(`Invalid nc:// URI: ${uri}. Must start with ${NC_PREFIX}`);
  }

  const rawPath = uri.slice(NC_PREFIX.length);

  // Decode first to catch encoded traversal (%2e%2e, %00, etc.)
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }

  // Path traversal guard (on decoded path)
  if (decodedPath.includes('..') || decodedPath.includes('\0') || rawPath.includes('\0')) {
    throw new Error(`Unsafe path in nc:// URI: ${uri}`);
  }

  // Allowlist prefix guard (default: /knowledge/ only)
  const allowedPrefixes = (process.env.NC_ALLOWED_PREFIXES || '')
    .split(',')
    .map(p => p.trim().replace(/^\/+/, '').replace(/\/+$/, '') + '/')  // normalize: strip leading/trailing slashes, ensure trailing
    .filter(p => p !== '/');
  const prefixes = allowedPrefixes.length > 0 ? allowedPrefixes : DEFAULT_ALLOWED_PREFIXES;
  const allowed = prefixes.some(prefix => decodedPath.startsWith(prefix));
  if (!allowed) {
    throw new Error(`nc:// URI path not in allowed prefixes (${prefixes.join(', ')}): ${uri}`);
  }

  const ncUrl = (process.env.NC_URL || DEFAULT_NC_URL).replace(/\/$/, '');
  const ncUser = process.env.NC_USER || DEFAULT_NC_USER;

  // URL-encode each path segment for safe WebDAV URLs
  const encodedPath = decodedPath.split('/').map(segment => encodeURIComponent(segment)).join('/');

  return `${ncUrl}/remote.php/dav/files/${ncUser}/${encodedPath}`;
}

/**
 * Extract the relative path from a nc:/// URI.
 *
 * @param {string} uri - nc:///knowledge/docs/spec.pdf
 * @returns {string} knowledge/docs/spec.pdf
 */
export function extractNcPath(uri) {
  if (!uri || !uri.startsWith(NC_PREFIX)) return uri;
  return uri.slice(NC_PREFIX.length);
}

/**
 * Build a nc:/// URI from a relative path.
 *
 * @param {string} path - knowledge/docs/spec.pdf
 * @returns {string} nc:///knowledge/docs/spec.pdf
 */
export function buildNcUri(path) {
  const clean = path.replace(/^\/+/, '');
  return `${NC_PREFIX}${clean}`;
}

/**
 * Check if a string is a nc:/// URI.
 * @param {string} s
 * @returns {boolean}
 */
export function isNcUri(s) {
  return typeof s === 'string' && s.startsWith(NC_PREFIX);
}

/**
 * Get Nextcloud config from environment.
 * @returns {{ url: string, user: string, hasAuth: boolean }}
 */
export function getNcConfig() {
  return {
    url: process.env.NC_URL || DEFAULT_NC_URL,
    user: process.env.NC_USER || DEFAULT_NC_USER,
    hasAuth: !!(process.env.NC_USER && process.env.NC_PASS),
  };
}
