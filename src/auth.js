import { readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const APPS_JSON = join(process.env.APPDATA, '..', 'Local', 'github-copilot', 'apps.json');
const CACHE_FILE = join(process.env.TEMP, 'copilot_token_cache.json');
const CACHE_TTL_SEC = 25 * 60; // refresh at 25 min (token lasts 30)

const COMMON_HEADERS = {
  'Editor-Version': 'JetBrains-IC/2025.3',
  'Editor-Plugin-Version': 'copilot-intellij/1.5.66',
};

export async function getCopilotToken() {
  if (!needsRefresh()) {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')).token;
  }

  const apps = JSON.parse(readFileSync(APPS_JSON, 'utf8'));
  const oauthToken = apps[Object.keys(apps)[0]].oauth_token;

  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { 'Authorization': `token ${oauthToken}`, ...COMMON_HEADERS },
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);

  const data = await res.text();
  writeFileSync(CACHE_FILE, data);
  return JSON.parse(data).token;
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
