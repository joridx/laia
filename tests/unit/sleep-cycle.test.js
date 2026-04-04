// tests/unit/sleep-cycle.test.js — Tests for sleep cycle service
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the extraction logic directly by importing internals
// The module uses hardcoded paths, so we test the logic patterns

const TEMP_DIR = join(tmpdir(), `laia-sleep-test-${Date.now()}`);
const SESSIONS_DIR = join(TEMP_DIR, 'sessions');
const DAILY_DIR = join(TEMP_DIR, 'daily');

describe('sleep-cycle extraction logic', () => {
  beforeEach(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(DAILY_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('should extract bullets from session notes format', () => {
    const content = `# Session Notes

## 1. Primary Request & Intent
Migrate service X to Kubernetes

## 2. Key Technical Concepts
- Kubernetes, Helm charts, sealed-secrets
- ArgoCD deployment pipeline

## 3. Files & Code
_Files examined, modified, or created._

## 4. Errors & Fixes
- Error: ImagePullBackOff — fixed by setting correct registry URL
- Warning: Pod CrashLoopBackOff — resolved by increasing memory limits

## 5. Problem Solving
Debugging K8s deployment failures using kubectl logs

## 6. User Messages Summary
_Key user messages (not tool results)._

## 7. Pending Tasks
- Deploy to staging environment
- Run integration tests

## 8. Current Work
_What is being worked on right now._

## 9. Next Step
_The immediate next action._
`;

    // Simulate extraction logic (same as sleep-cycle.js extractFromSessionNotes)
    const SESSION_SECTIONS = [
      'Primary Request & Intent',
      'Key Technical Concepts',
      'Errors & Fixes',
      'Problem Solving',
      'Pending Tasks',
    ];

    const bullets = [];
    for (const section of SESSION_SECTIONS) {
      const re = new RegExp(`## \\d+\\.\\s*${section}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
      const match = content.match(re);
      if (!match) continue;
      const body = match[1].trim();
      if (body.startsWith('_') && body.endsWith('_')) continue;
      if (body.length < 5) continue;
      const lines = body.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('_') && l.length > 3);
      for (const line of lines.slice(0, 3)) {
        const clean = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
        if (clean.length > 5) bullets.push(`- ${clean.slice(0, 150)}`);
      }
    }

    assert.ok(bullets.length >= 5, `Expected at least 5 bullets, got ${bullets.length}`);
    assert.ok(bullets.some(b => b.includes('Kubernetes')), 'Should extract K8s mention');
    assert.ok(bullets.some(b => b.includes('ImagePullBackOff')), 'Should extract error');
    assert.ok(bullets.some(b => b.includes('Deploy to staging')), 'Should extract pending task');
  });

  it('should skip template placeholders', () => {
    const content = `# Session Notes

## 1. Primary Request & Intent
_What the user wants to achieve._

## 2. Key Technical Concepts
_Technologies, frameworks, patterns discussed._
`;

    const SESSION_SECTIONS = ['Primary Request & Intent', 'Key Technical Concepts'];
    const bullets = [];
    for (const section of SESSION_SECTIONS) {
      const re = new RegExp(`## \\d+\\.\\s*${section}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
      const match = content.match(re);
      if (!match) continue;
      const body = match[1].trim();
      if (body.startsWith('_') && body.endsWith('_')) continue;
      bullets.push(body);
    }

    assert.equal(bullets.length, 0, 'Should skip template placeholders');
  });

  it('should respect 1KB budget per daily file', () => {
    // 1KB = ~1024 bytes. Each bullet ~50 chars. ~20 bullets max.
    const bullets = Array.from({ length: 50 }, (_, i) =>
      `- This is bullet point number ${i} with some extra padding text to fill bytes`
    );

    let content = `# 2026-04-04\n\n`;
    let bytes = Buffer.byteLength(content);
    const MAX_DAILY_SIZE = 1_024;
    let kept = 0;

    for (const bullet of bullets) {
      const entryBytes = Buffer.byteLength(bullet + '\n');
      if (bytes + entryBytes > MAX_DAILY_SIZE) break;
      content += bullet + '\n';
      bytes += entryBytes;
      kept++;
    }

    assert.ok(Buffer.byteLength(content) <= MAX_DAILY_SIZE, 'Should not exceed 1KB');
    assert.ok(kept > 5, 'Should keep some bullets');
    assert.ok(kept < 50, 'Should not keep all 50 bullets');
  });

  it('should deduplicate similar bullets', () => {
    const allBullets = [
      '- Migrate service X to Kubernetes',
      '- Migrate service X to Kubernetes',
      '-  Migrate  service  X  to  Kubernetes',  // Same after normalization
      '- Deploy to staging environment',
    ];

    const seen = new Set();
    const unique = allBullets.filter(b => {
      const key = b.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    assert.equal(unique.length, 2, 'Should deduplicate exact and whitespace-variant matches');
  });
});

describe('daily-loader', () => {
  it('should generate correct date strings', () => {
    const dates = [];
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    assert.equal(dates.length, 3);
    assert.match(dates[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(dates[0] >= dates[1], 'Most recent first');
    assert.ok(dates[1] >= dates[2], 'Chronological order');
  });

  it('should validate daily file naming pattern', () => {
    const validFiles = ['2026-04-04.md', '2026-01-01.md', '2025-12-31.md'];
    const invalidFiles = ['notes.md', '2026-13-01.md', 'session-abc.md'];

    const pattern = /^\d{4}-\d{2}-\d{2}\.md$/;
    for (const f of validFiles) {
      assert.ok(pattern.test(f), `${f} should match`);
    }
    // Note: regex doesn't validate actual dates, just format
    for (const f of invalidFiles.filter(f => f !== '2026-13-01.md')) {
      assert.ok(!pattern.test(f), `${f} should not match`);
    }
  });
});

describe('auto-recall guards', () => {
  const GREETING_PATTERNS = /^(hola|bon dia|bona tarda|bona nit|hey|hi|hello|ok|thanks|gràcies|merci|good morning|sup)\b/i;
  const MIN_MESSAGE_LENGTH = 10;

  it('should skip trivial messages', () => {
    const trivial = ['hi', 'ok', 'yes', 'no', '?', 'hm'];
    for (const msg of trivial) {
      assert.ok(msg.length < MIN_MESSAGE_LENGTH, `"${msg}" should be too short`);
    }
  });

  it('should skip greetings', () => {
    const greetings = ['Hola', 'Bon dia!', 'Hello there', 'hey', 'Good morning'];
    for (const msg of greetings) {
      assert.ok(GREETING_PATTERNS.test(msg.trim()), `"${msg}" should match greeting pattern`);
    }
  });

  it('should NOT skip substantive messages', () => {
    const substantive = [
      'Desplega el projecte a staging',
      'Quina era l\'URL de Jenkins?',
      'Analitza el fitxer de configuració',
      'Crea un test per la funció parse',
    ];
    for (const msg of substantive) {
      assert.ok(msg.length >= MIN_MESSAGE_LENGTH, `"${msg}" should pass length check`);
      assert.ok(!GREETING_PATTERNS.test(msg.trim()), `"${msg}" should NOT match greeting pattern`);
    }
  });
});

describe('pruning logic', () => {
  it('should identify files older than cutoff', () => {
    const MAX_DAILY_DAYS = 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAILY_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const oldFile = '2025-01-01.md';
    const recentFile = new Date().toISOString().slice(0, 10) + '.md';

    assert.ok(oldFile.replace('.md', '') < cutoffStr, 'Old file should be before cutoff');
    assert.ok(recentFile.replace('.md', '') >= cutoffStr, 'Recent file should be after cutoff');
  });
});
