import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadDotEnv } from '../src/config.js';

const TMP = join(tmpdir(), 'laia-dotenv-test-' + process.pid);

function writeEnv(content) {
  const p = join(TMP, '.env');
  writeFileSync(p, content);
  return p;
}

// Save and restore env vars touched during tests
const saved = {};
function saveEnv(...keys) {
  for (const k of keys) saved[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('loadDotEnv', () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => { restoreEnv(); rmSync(TMP, { recursive: true, force: true }); });

  it('loads KEY=VALUE into process.env', () => {
    saveEnv('TEST_DOTENV_A');
    delete process.env.TEST_DOTENV_A;
    const p = writeEnv('TEST_DOTENV_A=hello123\n');
    loadDotEnv(p);
    assert.equal(process.env.TEST_DOTENV_A, 'hello123');
  });

  it('strips double quotes', () => {
    saveEnv('TEST_DOTENV_B');
    delete process.env.TEST_DOTENV_B;
    const p = writeEnv('TEST_DOTENV_B="quoted value"\n');
    loadDotEnv(p);
    assert.equal(process.env.TEST_DOTENV_B, 'quoted value');
  });

  it('strips single quotes', () => {
    saveEnv('TEST_DOTENV_C');
    delete process.env.TEST_DOTENV_C;
    const p = writeEnv("TEST_DOTENV_C='single quoted'\n");
    loadDotEnv(p);
    assert.equal(process.env.TEST_DOTENV_C, 'single quoted');
  });

  it('skips comments and empty lines', () => {
    saveEnv('TEST_DOTENV_D');
    delete process.env.TEST_DOTENV_D;
    const p = writeEnv('# This is a comment\n\n  \nTEST_DOTENV_D=works\n# another comment\n');
    loadDotEnv(p);
    assert.equal(process.env.TEST_DOTENV_D, 'works');
  });

  it('does NOT overwrite existing env vars', () => {
    saveEnv('TEST_DOTENV_E');
    process.env.TEST_DOTENV_E = 'original';
    const p = writeEnv('TEST_DOTENV_E=overwritten\n');
    loadDotEnv(p);
    assert.equal(process.env.TEST_DOTENV_E, 'original');
  });

  it('handles missing file gracefully', () => {
    assert.doesNotThrow(() => loadDotEnv('/nonexistent/path/.env'));
  });

  it('handles multiple keys', () => {
    saveEnv('TEST_DOTENV_F', 'TEST_DOTENV_G');
    delete process.env.TEST_DOTENV_F;
    delete process.env.TEST_DOTENV_G;
    const p = writeEnv('TEST_DOTENV_F=first\nTEST_DOTENV_G=second\n');
    loadDotEnv(p);
    assert.equal(process.env.TEST_DOTENV_F, 'first');
    assert.equal(process.env.TEST_DOTENV_G, 'second');
  });

  it('handles values with = signs', () => {
    saveEnv('TEST_DOTENV_H');
    delete process.env.TEST_DOTENV_H;
    const p = writeEnv('TEST_DOTENV_H=abc=def=ghi\n');
    loadDotEnv(p);
    assert.equal(process.env.TEST_DOTENV_H, 'abc=def=ghi');
  });
});
