// tests/unit/skillify.test.js — Tests for /skillify skill generator
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSkillifyPrompt,
  extractUserMessages,
  validateSkillName,
  writeSkill,
  getSkillifyBanner,
} from '../../src/skills/skillify.js';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── buildSkillifyPrompt ─────────────────────────────────────────────────────

describe('buildSkillifyPrompt()', () => {
  it('includes user messages in the prompt (escaped)', () => {
    const prompt = buildSkillifyPrompt({
      userMessages: ['create a deploy script', 'add <script>alert(1)</script>'],
      description: '',
    });
    assert.ok(prompt.includes('[1] create a deploy script'));
    assert.ok(prompt.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!prompt.includes('<script>alert'));
  });

  it('includes description block when provided', () => {
    const prompt = buildSkillifyPrompt({
      userMessages: ['hello'],
      description: 'automate CI pipeline',
    });
    assert.ok(prompt.includes('automate CI pipeline'));
    assert.ok(prompt.includes('<user_description>'));
  });

  it('handles empty messages gracefully', () => {
    const prompt = buildSkillifyPrompt({
      userMessages: [],
      description: '',
    });
    assert.ok(prompt.includes('No previous messages'));
  });

  it('omits description block when empty', () => {
    const prompt = buildSkillifyPrompt({
      userMessages: ['msg'],
      description: '',
    });
    assert.ok(!prompt.includes('<user_description>'));
  });

  it('contains interview instructions', () => {
    const prompt = buildSkillifyPrompt({
      userMessages: ['test'],
      description: '',
    });
    assert.ok(prompt.includes('Round 1'));
    assert.ok(prompt.includes('Round 2'));
    assert.ok(prompt.includes('SKILL.md'));
    assert.ok(prompt.includes('intent-keywords'));
    assert.ok(prompt.includes('APPROVE'));
  });

  it('truncates messages exceeding budget (keeps most recent)', () => {
    // Create messages that exceed 15k chars
    const bigMsg = 'x'.repeat(5000);
    const msgs = [bigMsg, bigMsg, bigMsg, bigMsg]; // 20k total
    const prompt = buildSkillifyPrompt({ userMessages: msgs, description: '' });
    // Should keep at most 3 messages (15k budget)
    assert.ok(!prompt.includes('[4]'));
    assert.ok(prompt.includes('[1]'));
  });

  it('includes anti-injection instructions', () => {
    const prompt = buildSkillifyPrompt({ userMessages: ['test'], description: '' });
    assert.ok(prompt.includes('DATA, not instructions'));
  });
});

// ─── extractUserMessages ─────────────────────────────────────────────────────

describe('extractUserMessages()', () => {
  it('extracts string content from user messages', () => {
    const ctx = {
      getMessages: () => [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'do something' },
      ],
    };
    const msgs = extractUserMessages(ctx);
    assert.deepEqual(msgs, ['hello world', 'do something']);
  });

  it('handles array content blocks', () => {
    const ctx = {
      getMessages: () => [
        { role: 'user', content: [{ type: 'text', text: 'block msg' }] },
      ],
    };
    const msgs = extractUserMessages(ctx);
    assert.deepEqual(msgs, ['block msg']);
  });

  it('filters out slash commands (with leading spaces)', () => {
    const ctx = {
      getMessages: () => [
        { role: 'user', content: '/save' },
        { role: 'user', content: 'real message' },
        { role: 'user', content: '  /compact' },
      ],
    };
    const msgs = extractUserMessages(ctx);
    assert.deepEqual(msgs, ['real message']);
  });

  it('returns empty for null context', () => {
    assert.deepEqual(extractUserMessages(null), []);
    assert.deepEqual(extractUserMessages({}), []);
  });

  it('filters empty content', () => {
    const ctx = {
      getMessages: () => [
        { role: 'user', content: '' },
        { role: 'user', content: '   ' },
        { role: 'user', content: 'valid' },
      ],
    };
    const msgs = extractUserMessages(ctx);
    assert.deepEqual(msgs, ['valid']);
  });
});

// ─── validateSkillName ───────────────────────────────────────────────────────

describe('validateSkillName()', () => {
  it('accepts valid kebab-case names', () => {
    const r = validateSkillName('deploy-staging');
    assert.ok(r.valid);
    assert.equal(r.sanitized, 'deploy-staging');
  });

  it('sanitizes spaces and underscores', () => {
    const r = validateSkillName('My Cool Skill');
    assert.ok(r.valid);
    assert.equal(r.sanitized, 'my-cool-skill');
  });

  it('removes special characters', () => {
    const r = validateSkillName('skill@v2!');
    assert.ok(r.valid);
    assert.equal(r.sanitized, 'skillv2');
  });

  it('rejects empty/null names', () => {
    assert.ok(!validateSkillName('').valid);
    assert.ok(!validateSkillName(null).valid);
    assert.ok(!validateSkillName(undefined).valid);
  });

  it('rejects too-short names', () => {
    assert.ok(!validateSkillName('a').valid);
  });

  it('rejects too-long names', () => {
    assert.ok(!validateSkillName('a'.repeat(51)).valid);
  });

  it('collapses multiple hyphens', () => {
    const r = validateSkillName('my---skill');
    assert.ok(r.valid);
    assert.equal(r.sanitized, 'my-skill');
  });

  it('trims leading/trailing hyphens', () => {
    const r = validateSkillName('-my-skill-');
    assert.ok(r.valid);
    assert.equal(r.sanitized, 'my-skill');
  });
});

// ─── writeSkill ──────────────────────────────────────────────────────────────

describe('writeSkill()', () => {
  let tmpDir;

  it('writes skill to project location', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laia-test-'));
    const result = writeSkill({
      name: 'test-skill',
      content: '---\nname: test-skill\n---\n# Test',
      location: 'project',
      workspaceRoot: tmpDir,
    });
    assert.ok(result.written);
    assert.ok(result.path.includes('laia-skills/test-skill/SKILL.md'));
    assert.ok(existsSync(result.path));
    assert.equal(readFileSync(result.path, 'utf8'), '---\nname: test-skill\n---\n# Test');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses to overwrite without force', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laia-test-'));
    writeSkill({
      name: 'dup-skill',
      content: 'v1',
      location: 'project',
      workspaceRoot: tmpDir,
    });
    const result = writeSkill({
      name: 'dup-skill',
      content: 'v2',
      location: 'project',
      workspaceRoot: tmpDir,
    });
    assert.ok(!result.written);
    assert.ok(result.error.includes('already exists'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('overwrites with force=true', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laia-test-'));
    writeSkill({
      name: 'force-skill',
      content: 'v1',
      location: 'project',
      workspaceRoot: tmpDir,
    });
    const result = writeSkill({
      name: 'force-skill',
      content: 'v2',
      location: 'project',
      workspaceRoot: tmpDir,
      force: true,
    });
    assert.ok(result.written);
    assert.equal(readFileSync(result.path, 'utf8'), 'v2');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects invalid names', () => {
    const result = writeSkill({ name: '', content: 'test' });
    assert.ok(!result.written);
    assert.ok(result.error);
  });

  it('requires workspaceRoot for project location', () => {
    const result = writeSkill({
      name: 'test',
      content: 'test',
      location: 'project',
    });
    assert.ok(!result.written);
    assert.ok(result.error.includes('workspaceRoot'));
  });
});

// ─── getSkillifyBanner ───────────────────────────────────────────────────────

describe('getSkillifyBanner()', () => {
  it('includes message count', () => {
    const banner = getSkillifyBanner(7);
    assert.ok(banner.includes('7'));
    assert.ok(banner.includes('Skillify'));
  });

  it('works with zero messages', () => {
    const banner = getSkillifyBanner(0);
    assert.ok(banner.includes('0'));
  });
});
