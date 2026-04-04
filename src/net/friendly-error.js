/**
 * Translate raw Python/subprocess stderr into user-friendly error messages.
 * Ported from Claudia's playwright-adapter.js, adapted for personal use (Linux/Termux).
 *
 * @param {string} label - Service or script display name
 * @param {string} stderr - Raw stderr output
 * @param {number|string} [exitCode] - Process exit code
 * @returns {string} Friendly, actionable error message
 */
export function friendlyError(label, stderr = '', exitCode) {
  const s = (stderr || '').toLowerCase();

  // Python module errors
  if (s.includes("no module named 'playwright'")) {
    return `${label}: Playwright not installed. Run: pip install playwright && playwright install chromium`;
  }
  if (s.includes('modulenotfounderror')) {
    const match = stderr.match(/No module named ['"]([^'"]+)['"]/i);
    const mod = match ? match[1] : 'unknown';
    return `${label}: Python module '${mod}' not installed. Run: pip install ${mod}`;
  }

  // Network / connectivity
  if (s.includes('timeout') || s.includes('timed out')) {
    return `${label}: request timed out. Check network connectivity and retry`;
  }
  if (s.includes('econnrefused') || s.includes('connection refused')) {
    return `${label}: connection refused. Is the service running?`;
  }
  if (s.includes('enotfound') || s.includes('getaddrinfo')) {
    return `${label}: DNS resolution failed. Check the URL and network`;
  }
  if (s.includes('ssl') || s.includes('certificate')) {
    return `${label}: SSL/certificate error. Check proxy settings or use NODE_TLS_REJECT_UNAUTHORIZED=0`;
  }

  // Auth errors
  if (s.includes('401') || s.includes('unauthorized')) {
    return `${label}: authentication failed (401). Check credentials or re-authenticate`;
  }
  if (s.includes('403') || s.includes('forbidden')) {
    return `${label}: access denied (403). Check permissions`;
  }

  // Browser / Playwright errors
  if (s.includes('browser') && (s.includes('not found') || s.includes('not installed'))) {
    return `${label}: browser not found. Run: playwright install chromium`;
  }

  // Filesystem
  if (s.includes('enoent') || s.includes('no such file')) {
    const match = stderr.match(/(?:ENOENT|No such file)[^']*'([^']+)'/i);
    const file = match ? match[1] : 'unknown path';
    return `${label}: file not found: ${file}`;
  }
  if (s.includes('eacces') || s.includes('permission denied')) {
    return `${label}: permission denied. Check file permissions`;
  }

  // Rate limiting
  if (s.includes('429') || s.includes('rate limit') || s.includes('too many requests')) {
    return `${label}: rate limited (429). Wait a moment and retry`;
  }

  // Fallback: extract last meaningful line from traceback
  const lines = (stderr || '').split('\n')
    .filter(l => l.trim() && !l.startsWith('Traceback') && !l.match(/^\s+/));
  const lastLine = lines[lines.length - 1] || `exit code ${exitCode ?? 'unknown'}`;
  return `${label}: ${lastLine.trim()}`;
}
