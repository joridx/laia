// tests/unit/evolved-split.test.js — V4 Track 3 evolved-prompt tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadEvolvedSplit, loadEvolvedIndex, getEvolvedDir, getEvolvedVersion,
} from '../../src/evolved-prompt.js';

describe('loadEvolvedSplit()', () => {
  it('returns object with stable and adaptive keys', () => {
    const result = loadEvolvedSplit();
    assert.ok('stable' in result);
    assert.ok('adaptive' in result);
  });

  it('stable and adaptive are string or null', () => {
    const { stable, adaptive } = loadEvolvedSplit();
    assert.ok(stable === null || typeof stable === 'string');
    assert.ok(adaptive === null || typeof adaptive === 'string');
  });
});

describe('loadEvolvedIndex()', () => {
  it('returns object with expected shape', () => {
    const result = loadEvolvedIndex();
    assert.ok('stableEntries' in result);
    assert.ok('adaptiveEntries' in result);
    assert.ok('version' in result);
    // Maps
    assert.ok(result.stableEntries instanceof Map || typeof result.stableEntries === 'object');
    assert.ok(result.adaptiveEntries instanceof Map || typeof result.adaptiveEntries === 'object');
  });
});

describe('getEvolvedDir()', () => {
  it('returns a string path', () => {
    const dir = getEvolvedDir();
    assert.equal(typeof dir, 'string');
    assert.ok(dir.includes('.laia'));
    assert.ok(dir.includes('evolved'));
  });
});

describe('getEvolvedVersion()', () => {
  it('returns object or null', () => {
    const version = getEvolvedVersion();
    assert.ok(version === null || typeof version === 'object');
  });
});
