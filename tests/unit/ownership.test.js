import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNERSHIP_MATRIX,
  classifyByType,
  getOwner,
  isTypedOwned,
  isBrainOwned,
  canonicalKey,
} from '../../src/memory/ownership.js';

// ── 1. OWNERSHIP_MATRIX structure ──────────────────────────────────────────

describe('OWNERSHIP_MATRIX', () => {
  const types = Object.keys(OWNERSHIP_MATRIX);

  it('has exactly 9 types', () => {
    assert.equal(types.length, 9);
  });

  it('has 5 brain-owned types', () => {
    const brainTypes = types.filter(t => OWNERSHIP_MATRIX[t].owner === 'brain');
    assert.deepStrictEqual(brainTypes.sort(), ['learning', 'pattern', 'principle', 'procedure', 'warning']);
  });

  it('has 4 typed-owned types', () => {
    const typedTypes = types.filter(t => OWNERSHIP_MATRIX[t].owner === 'typed');
    assert.deepStrictEqual(typedTypes.sort(), ['feedback', 'project', 'reference', 'user']);
  });

  it('every entry has owner and reason strings', () => {
    for (const [key, entry] of Object.entries(OWNERSHIP_MATRIX)) {
      assert.equal(typeof entry.owner, 'string', `${key}.owner should be a string`);
      assert.equal(typeof entry.reason, 'string', `${key}.reason should be a string`);
      assert.ok(entry.reason.length > 0, `${key}.reason should be non-empty`);
    }
  });
});

// ── 2. classifyByType ──────────────────────────────────────────────────────

describe('classifyByType', () => {
  const brainTypes = ['procedure', 'learning', 'warning', 'pattern', 'principle'];
  const typedTypes = ['user', 'feedback', 'project', 'reference'];

  for (const type of brainTypes) {
    it(`returns brain owner for "${type}"`, () => {
      const result = classifyByType(type);
      assert.equal(result.owner, 'brain');
      assert.equal(typeof result.reason, 'string');
    });
  }

  for (const type of typedTypes) {
    it(`returns typed owner for "${type}"`, () => {
      const result = classifyByType(type);
      assert.equal(result.owner, 'typed');
      assert.equal(typeof result.reason, 'string');
    });
  }

  it('is case-insensitive', () => {
    assert.deepStrictEqual(classifyByType('PROCEDURE'), OWNERSHIP_MATRIX.procedure);
    assert.deepStrictEqual(classifyByType('User'), OWNERSHIP_MATRIX.user);
    assert.deepStrictEqual(classifyByType('LeArNiNg'), OWNERSHIP_MATRIX.learning);
  });

  it('returns null for unknown type', () => {
    assert.equal(classifyByType('unknown'), null);
    assert.equal(classifyByType('snapshot'), null);
  });

  it('returns null for null/undefined/empty/non-string', () => {
    assert.equal(classifyByType(null), null);
    assert.equal(classifyByType(undefined), null);
    assert.equal(classifyByType(''), null);
    assert.equal(classifyByType(42), null);
    assert.equal(classifyByType({}), null);
  });
});

// ── 3. getOwner ────────────────────────────────────────────────────────────

describe('getOwner', () => {
  it('returns "brain" for brain-owned types', () => {
    for (const type of ['procedure', 'learning', 'warning', 'pattern', 'principle']) {
      assert.equal(getOwner(type), 'brain', `expected brain for ${type}`);
    }
  });

  it('returns "typed" for typed-owned types', () => {
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      assert.equal(getOwner(type), 'typed', `expected typed for ${type}`);
    }
  });

  it('returns null for unknown type', () => {
    assert.equal(getOwner('nonexistent'), null);
  });

  it('returns null for falsy input', () => {
    assert.equal(getOwner(null), null);
    assert.equal(getOwner(''), null);
  });
});

// ── 4. isTypedOwned ────────────────────────────────────────────────────────

describe('isTypedOwned', () => {
  it('returns true for typed-owned types', () => {
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      assert.equal(isTypedOwned(type), true, `expected true for ${type}`);
    }
  });

  it('returns false for brain-owned types', () => {
    for (const type of ['procedure', 'learning', 'warning', 'pattern', 'principle']) {
      assert.equal(isTypedOwned(type), false, `expected false for ${type}`);
    }
  });

  it('returns false for unknown types', () => {
    assert.equal(isTypedOwned('unknown'), false);
    assert.equal(isTypedOwned(null), false);
  });
});

// ── 5. isBrainOwned ───────────────────────────────────────────────────────

describe('isBrainOwned', () => {
  it('returns true for brain-owned types', () => {
    for (const type of ['procedure', 'learning', 'warning', 'pattern', 'principle']) {
      assert.equal(isBrainOwned(type), true, `expected true for ${type}`);
    }
  });

  it('returns false for typed-owned types', () => {
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      assert.equal(isBrainOwned(type), false, `expected false for ${type}`);
    }
  });

  it('returns false for unknown types', () => {
    assert.equal(isBrainOwned('unknown'), false);
    assert.equal(isBrainOwned(null), false);
  });
});

// ── 6. canonicalKey ────────────────────────────────────────────────────────

describe('canonicalKey', () => {
  it('generates slugified keys', () => {
    assert.equal(canonicalKey('Hello World', 'user'), 'user:hello-world');
    assert.equal(canonicalKey('Some Procedure Name', 'procedure'), 'procedure:some-procedure-name');
  });

  it('strips special characters', () => {
    assert.equal(canonicalKey('hello@world!', 'user'), 'user:helloworld');
    assert.equal(canonicalKey('foo#bar$baz', 'learning'), 'learning:foobarbaz');
  });

  it('collapses multiple spaces into single dash', () => {
    assert.equal(canonicalKey('hello   world', 'user'), 'user:hello-world');
  });

  it('strips leading and trailing dashes', () => {
    assert.equal(canonicalKey(' hello world ', 'user'), 'user:hello-world');
    assert.equal(canonicalKey('---hello---', 'user'), 'user:hello');
  });

  it('handles unicode / diacritics by stripping them', () => {
    assert.equal(canonicalKey('café résumé', 'user'), 'user:cafe-resume');
    assert.equal(canonicalKey('naïve über', 'learning'), 'learning:naive-uber');
  });

  it('returns empty string for falsy name', () => {
    assert.equal(canonicalKey('', 'user'), '');
    assert.equal(canonicalKey(null, 'user'), '');
    assert.equal(canonicalKey(undefined, 'user'), '');
  });

  it('omits type prefix when type is falsy', () => {
    assert.equal(canonicalKey('hello world', ''), 'hello-world');
    assert.equal(canonicalKey('hello world', null), 'hello-world');
    assert.equal(canonicalKey('hello world', undefined), 'hello-world');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    const result = canonicalKey(long, 'user');
    // prefix is "user:" (5 chars) + 80 chars of normalized name
    assert.equal(result, `user:${'a'.repeat(80)}`);
  });

  it('handles purely special-char input', () => {
    assert.equal(canonicalKey('!!!@@@###', 'user'), 'user:');
  });

  it('handles numeric-looking input', () => {
    assert.equal(canonicalKey('123 456', 'user'), 'user:123-456');
  });
});
