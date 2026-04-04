import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../../src/net/friendly-error.js';

describe('friendlyError', () => {
  it('detects missing playwright', () => {
    const msg = friendlyError('Nextcloud', "ModuleNotFoundError: No module named 'playwright'", 1);
    assert.match(msg, /Playwright not installed/);
    assert.match(msg, /pip install playwright/);
  });

  it('detects generic missing python module', () => {
    const msg = friendlyError('Script', "ModuleNotFoundError: No module named 'requests'", 1);
    assert.match(msg, /Python module 'requests'/);
    assert.match(msg, /pip install requests/);
  });

  it('detects timeout', () => {
    const msg = friendlyError('API', 'Error: request timed out after 30000ms');
    assert.match(msg, /timed out/);
  });

  it('detects connection refused', () => {
    const msg = friendlyError('Nextcloud', 'Error: connect ECONNREFUSED 192.168.1.100:443');
    assert.match(msg, /connection refused/);
  });

  it('detects DNS failure', () => {
    const msg = friendlyError('API', 'Error: getaddrinfo ENOTFOUND api.example.com');
    assert.match(msg, /DNS resolution failed/);
  });

  it('detects SSL error', () => {
    const msg = friendlyError('API', 'Error: unable to verify the first certificate');
    assert.match(msg, /SSL.*certificate|CA certs/);
  });

  it('detects 401 unauthorized', () => {
    const msg = friendlyError('Nextcloud', 'HTTP 401 Unauthorized');
    assert.match(msg, /authentication failed.*401/);
  });

  it('detects 403 forbidden', () => {
    const msg = friendlyError('API', 'HTTP 403 Forbidden');
    assert.match(msg, /access denied.*403/);
  });

  it('detects missing browser', () => {
    const msg = friendlyError('Login', 'browser chromium is not installed');
    assert.match(msg, /browser not found/);
  });

  it('detects file not found (ENOENT)', () => {
    const msg = friendlyError('Script', "Error: ENOENT: no such file or directory, open '/tmp/config.json'");
    assert.match(msg, /file not found/);
  });

  it('detects permission denied', () => {
    const msg = friendlyError('Script', 'Error: EACCES: permission denied');
    assert.match(msg, /permission denied/);
  });

  it('detects rate limiting', () => {
    const msg = friendlyError('API', 'HTTP 429 Too Many Requests');
    assert.match(msg, /rate limited.*429/);
  });

  it('falls back to last meaningful line for unknown errors', () => {
    const stderr = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: bad value';
    const msg = friendlyError('Script', stderr, 1);
    assert.match(msg, /ValueError: bad value/);
  });

  it('falls back to exit code when stderr is empty', () => {
    const msg = friendlyError('Script', '', 137);
    assert.match(msg, /exit code 137/);
  });

  it('handles null/undefined stderr', () => {
    const msg = friendlyError('Script', null, 1);
    assert.match(msg, /exit code 1/);
  });
});
