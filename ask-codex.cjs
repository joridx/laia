#!/usr/bin/env node
// Helper to query Codex (gpt-5.3-codex) via Copilot Business API
// Usage: node ask-codex.js "your prompt here"

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(process.env.TEMP, 'copilot_token_cache.json');
const APPS_JSON = path.join(process.env.APPDATA, '..', 'Local', 'github-copilot', 'apps.json');

async function getCopilotToken() {
  let needRefresh = true;
  try {
    const stat = fs.statSync(CACHE_FILE);
    if ((Date.now() - stat.mtimeMs) / 1000 < 1500) needRefresh = false;
  } catch {}

  if (needRefresh) {
    const apps = JSON.parse(fs.readFileSync(APPS_JSON, 'utf8'));
    const oauthToken = apps[Object.keys(apps)[0]].oauth_token;
    const tokenData = await httpRequest({
      hostname: 'api.github.com',
      path: '/copilot_internal/v2/token',
      headers: {
        'Authorization': `token ${oauthToken}`,
        'Editor-Version': 'JetBrains-IC/2025.3',
        'Editor-Plugin-Version': 'copilot-intellij/1.5.66',
      }
    });
    fs.writeFileSync(CACHE_FILE, tokenData);
  }

  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).token;
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method: body ? 'POST' : 'GET', rejectAuthorized: false, ...options }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function askCodex(prompt) {
  const token = await getCopilotToken();
  const raw = await httpRequest({
    hostname: 'api.business.githubcopilot.com',
    path: '/responses',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Editor-Version': 'JetBrains-IC/2025.3',
      'Editor-Plugin-Version': 'copilot-intellij/1.5.66',
      'Copilot-Integration-Id': 'vscode-chat',
    }
  }, JSON.stringify({ model: 'gpt-5.3-codex', input: prompt, stream: false }));

  const parsed = JSON.parse(raw);
  if (parsed.output?.[0]?.content) {
    const text = parsed.output[0].content.map(c => c.text || '').join('');
    const u = parsed.usage || {};
    return { text, tokens_in: u.input_tokens, tokens_out: u.output_tokens };
  }
  throw new Error('Unexpected response: ' + raw.substring(0, 500));
}

// CLI mode
if (require.main === module) {
  const prompt = process.argv.slice(2).join(' ') || fs.readFileSync(0, 'utf8');
  askCodex(prompt).then(r => {
    process.stderr.write(`[${r.tokens_in} in / ${r.tokens_out} out]\n`);
    console.log(r.text);
  }).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { askCodex, getCopilotToken };
