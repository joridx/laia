// Authentication module — multi-provider token resolution
// Supports: Copilot (token exchange), bearer (env var), api-key, anthropic, none
// Cross-platform: uses @claude/providers for path resolution

import { readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  PROVIDERS, getProvider, detectProvider,
  resolveToken as providerResolveToken,
  buildAuthHeaders, findCopilotAppsJson, getTempDir,
} from '@claude/providers';

const CACHE_FILE = join(getTempDir(), 'copilot_token_cache.json');
const CACHE_TTL_SEC = 25 * 60; // refresh at 25 min (token lasts 30)

const COMMON_HEADERS = {
  'Editor-Version': 'JetBrains-IC/2025.3',
  'Editor-Plugin-Version': 'copilot-intellij/1.5.66',
};

/**
 * Get a Copilot token via the token exchange flow (apps.json → GitHub API → JWT).
 * Caches to disk for 25 minutes.
 */
export async function getCopilotToken() {
  if (!needsRefresh()) {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')).token;
  }

  const appsJsonPath = findCopilotAppsJson();
  if (!appsJsonPath) throw new Error('Copilot apps.json not found. Is GitHub Copilot installed?');

  const apps = JSON.parse(readFileSync(appsJsonPath, 'utf8'));
  const oauthToken = apps[Object.keys(apps)[0]].oauth_token;

  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { 'Authorization': `token ${oauthToken}`, ...COMMON_HEADERS },
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);

  const data = await res.text();
  writeFileSync(CACHE_FILE, data);
  return JSON.parse(data).token;
}

/**
 * Get a token for any provider. Delegates to getCopilotToken for copilot,
 * reads env vars for all others.
 * @param {string} providerId - Provider from PROVIDERS registry
 * @returns {Promise<string|null>}
 */
export async function getProviderToken(providerId) {
  const provider = getProvider(providerId);
  return providerResolveToken(provider, { getCopilotToken });
}

function needsRefresh() {
  try {
    const stat = statSync(CACHE_FILE);
    return (Date.now() - stat.mtimeMs) / 1000 > CACHE_TTL_SEC;
  } catch {
    return true;
  }
}

export { COMMON_HEADERS };
