// tests/unit/intent-matcher.test.js — V3P3 Skills auto-invoke tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchIntent, couldAutoInvoke } from '../../src/skills/intent-matcher.js';

// Helper: create a skill-like object
function skill(name, opts = {}) {
  return {
    name,
    invocation: opts.invocation || 'both',
    intentKeywords: opts.keywords || [],
    tags: opts.tags || [],
    body: opts.body || 'test body',
    context: opts.context || 'main',
  };
}

function skillMap(...skills) {
  const map = new Map();
  for (const s of skills) map.set(s.name, s);
  return map;
}

describe('couldAutoInvoke()', () => {
  it('returns true for normal text', () => {
    assert.equal(couldAutoInvoke('review my code'), true);
  });

  it('returns false for slash commands', () => {
    assert.equal(couldAutoInvoke('/commit'), false);
    assert.equal(couldAutoInvoke('  /save'), false);
  });

  it('returns false for short input', () => {
    assert.equal(couldAutoInvoke('hi'), false);
  });

  it('returns falsy for empty/null', () => {
    assert.ok(!couldAutoInvoke(''));
    assert.ok(!couldAutoInvoke(null));
    assert.ok(!couldAutoInvoke(undefined));
  });
});

describe('matchIntent()', () => {
  it('returns null for empty skills', () => {
    assert.equal(matchIntent('test', new Map()), null);
  });

  it('returns null for slash commands', () => {
    const skills = skillMap(skill('deploy', { keywords: ['deploy'] }));
    assert.equal(matchIntent('/deploy', skills), null);
  });

  it('skips skills with invocation=user', () => {
    const skills = skillMap(skill('deploy', { invocation: 'user', keywords: ['deploy'] }));
    assert.equal(matchIntent('deploy my app', skills), null);
  });

  it('matches by intent keywords', () => {
    const skills = skillMap(
      skill('deploy', { keywords: ['deploy', 'release', 'ship'] }),
    );
    const result = matchIntent('please deploy to production', skills);
    assert.ok(result);
    assert.equal(result.skill.name, 'deploy');
    assert.ok(result.score >= 0.3);
  });

  it('matches by skill name', () => {
    const skills = skillMap(skill('deploy', { keywords: [] }));
    const result = matchIntent('can you deploy this?', skills);
    assert.ok(result);
    assert.equal(result.skill.name, 'deploy');
  });

  it('matches by tags combined with keyword', () => {
    const skills = skillMap(
      skill('ci-pipeline', { keywords: ['pipeline', 'build', 'jenkins'], tags: ['jenkins', 'ci', 'build'] }),
    );
    const result = matchIntent('run the jenkins build pipeline', skills);
    assert.ok(result);
    assert.equal(result.skill.name, 'ci-pipeline');
  });

  it('returns best match among multiple skills', () => {
    const skills = skillMap(
      skill('deploy', { keywords: ['deploy', 'release'] }),
      skill('review', { keywords: ['review', 'pr'] }),
    );
    const result = matchIntent('review my pull request', skills);
    assert.ok(result);
    assert.equal(result.skill.name, 'review');
  });

  it('returns null below threshold', () => {
    const skills = skillMap(
      skill('deploy', { keywords: ['kubernetes', 'helm', 'argocd'] }),
    );
    const result = matchIntent('hello world', skills);
    assert.equal(result, null);
  });

  it('returns null for null input', () => {
    const skills = skillMap(skill('deploy', { keywords: ['deploy'] }));
    assert.equal(matchIntent(null, skills), null);
    assert.equal(matchIntent('', skills), null);
  });
});
