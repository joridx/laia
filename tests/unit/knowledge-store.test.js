// tests/unit/knowledge-store.test.js — Tests for Knowledge Store (Sprint 1.5)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── URI Resolver Tests ──────────────────────────────────────────────────────

describe('nc:// URI resolver', () => {
  // Import dynamically to allow env override tests
  let resolveNcUri, extractNcPath, buildNcUri, isNcUri, getNcConfig;

  it('should load module', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    resolveNcUri = mod.resolveNcUri;
    extractNcPath = mod.extractNcPath;
    buildNcUri = mod.buildNcUri;
    isNcUri = mod.isNcUri;
    getNcConfig = mod.getNcConfig;
  });

  it('should resolve nc:/// URI to WebDAV URL', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    const url = mod.resolveNcUri('nc:///knowledge/docs/spec.pdf');
    assert.ok(url.includes('/remote.php/dav/files/'));
    assert.ok(url.endsWith('/knowledge/docs/spec.pdf'));
  });

  it('should reject invalid URIs', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    assert.throws(() => mod.resolveNcUri('https://example.com'), /Invalid nc/);
    assert.throws(() => mod.resolveNcUri(''), /Invalid nc/);
    assert.throws(() => mod.resolveNcUri(null), /Invalid nc/);
  });

  it('should reject path traversal attempts', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    assert.throws(() => mod.resolveNcUri('nc:///../../etc/passwd'), /Unsafe path/);
    assert.throws(() => mod.resolveNcUri('nc:///knowledge/../../../etc/shadow'), /Unsafe path/);
  });

  it('should extract relative path from nc:/// URI', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    assert.equal(mod.extractNcPath('nc:///knowledge/docs/spec.pdf'), 'knowledge/docs/spec.pdf');
    assert.equal(mod.extractNcPath('not-nc-uri'), 'not-nc-uri');
  });

  it('should build nc:/// URI from path', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    assert.equal(mod.buildNcUri('knowledge/docs/spec.pdf'), 'nc:///knowledge/docs/spec.pdf');
    assert.equal(mod.buildNcUri('/knowledge/docs/spec.pdf'), 'nc:///knowledge/docs/spec.pdf');
  });

  it('should detect nc:/// URIs', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    assert.ok(mod.isNcUri('nc:///knowledge/docs/spec.pdf'));
    assert.ok(!mod.isNcUri('https://example.com'));
    assert.ok(!mod.isNcUri(''));
    assert.ok(!mod.isNcUri(null));
  });

  it('should reject encoded path traversal attempts', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    assert.throws(() => mod.resolveNcUri('nc:///%2e%2e/%2e%2e/etc/passwd'), /Unsafe path/);
    assert.throws(() => mod.resolveNcUri('nc:///knowledge/%2e%2e/%2e%2e/etc/shadow'), /Unsafe path/);
  });

  it('should URL-encode spaces and special chars', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    const url = mod.resolveNcUri('nc:///knowledge/docs/My File.pdf');
    assert.ok(url.includes('My%20File.pdf'), `Expected encoded space, got: ${url}`);
    assert.ok(!url.includes(' '), 'Should not contain raw spaces');
  });

  it('should reject paths outside /knowledge/ allowlist', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    assert.throws(() => mod.resolveNcUri('nc:///Documents/private.pdf'), /not in allowed prefixes/);
    assert.throws(() => mod.resolveNcUri('nc:///Photos/photo.jpg'), /not in allowed prefixes/);
    // /knowledge/ paths should work
    assert.ok(mod.resolveNcUri('nc:///knowledge/docs/spec.pdf'));
  });

  it('should return config with defaults', async () => {
    const mod = await import('../../src/nc/uri-resolver.js');
    const config = mod.getNcConfig();
    assert.ok(config.url);
    assert.ok(config.user);
    assert.equal(typeof config.hasAuth, 'boolean');
  });
});

// ─── Attachment Schema Tests ─────────────────────────────────────────────────

describe('attachment schema validation', () => {
  it('should validate correct attachment objects', () => {
    const valid = [
      { uri: 'nc:///knowledge/docs/spec.pdf', mime: 'application/pdf', label: 'API Spec' },
      { uri: 'nc:///knowledge/diagrams/arch.png', mime: 'image/png', label: 'Architecture diagram' },
      { uri: 'nc:///knowledge/spreadsheets/data.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Data export' },
    ];

    for (const att of valid) {
      assert.ok(att.uri.startsWith('nc:///'), `URI should start with nc:///`);
      assert.ok(att.mime, 'MIME should be present');
      assert.ok(att.label, 'Label should be present');
    }
  });

  it('should reject attachments without nc:/// prefix', () => {
    const invalid = [
      { uri: 'https://example.com/file.pdf', mime: 'application/pdf', label: 'External file' },
      { uri: '/local/path/file.pdf', mime: 'application/pdf', label: 'Local file' },
      { uri: '', mime: 'application/pdf', label: 'Empty URI' },
    ];

    for (const att of invalid) {
      const passes = att.uri && att.uri.startsWith('nc:///') && att.mime && att.label;
      assert.ok(!passes, `Should reject: ${att.uri}`);
    }
  });

  it('should serialize/deserialize attachments in frontmatter', () => {
    const attachments = [
      { uri: 'nc:///knowledge/docs/spec.pdf', mime: 'application/pdf', label: 'API Spec v3' },
    ];

    // Serialize (same as utils.js does)
    const serialized = JSON.stringify(attachments);
    assert.ok(serialized.includes('nc:///'));

    // Deserialize (same as parseLearningFrontmatter does)
    const deserialized = JSON.parse(serialized);
    assert.equal(deserialized.length, 1);
    assert.equal(deserialized[0].uri, 'nc:///knowledge/docs/spec.pdf');
    assert.equal(deserialized[0].mime, 'application/pdf');
    assert.equal(deserialized[0].label, 'API Spec v3');
  });

  it('should handle empty attachments gracefully', () => {
    const empty = JSON.stringify([]);
    const parsed = JSON.parse(empty);
    assert.equal(parsed.length, 0);
  });

  it('should filter invalid attachments', () => {
    const mixed = [
      { uri: 'nc:///knowledge/docs/spec.pdf', mime: 'application/pdf', label: 'Valid' },
      { uri: 'https://bad.com/file.pdf', mime: 'application/pdf', label: 'Invalid URI' },
      { uri: 'nc:///knowledge/docs/other.pdf', mime: '', label: 'Missing mime' },
      { uri: 'nc:///knowledge/docs/third.pdf', mime: 'text/plain', label: '' },
    ];

    // Same filter as brain-remember.js
    const clean = mixed.filter(a => a?.uri?.startsWith('nc:///') && a?.mime && a?.label);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].label, 'Valid');
  });
});

// ─── Roundtrip: serializer ↔ parser ────────────────────────────────────────

describe('attachments roundtrip (serializer ↔ parser)', () => {
  it('should roundtrip YAML-native attachments', async () => {
    const { buildLearningMarkdown, parseLearningFrontmatter } = await import('../../packages/brain/utils.js');

    const attachments = [
      { uri: 'nc:///knowledge/docs/spec.pdf', mime: 'application/pdf', label: 'API Spec v3' },
      { uri: 'nc:///knowledge/diagrams/arch.png', mime: 'image/png', label: 'Architecture diagram' },
    ];

    const md = buildLearningMarkdown(
      'Test Learning', 'learning', ['test'],
      'Test description', null,
      { attachments }
    );

    assert.ok(md.includes('attachments:'), 'Should contain attachments key');
    assert.ok(md.includes('nc:///knowledge/docs/spec.pdf'), 'Should contain first URI');
    assert.ok(md.includes('nc:///knowledge/diagrams/arch.png'), 'Should contain second URI');

    const parsed = parseLearningFrontmatter(md);
    assert.ok(parsed, 'Should parse successfully');
    assert.ok(parsed.frontmatter.attachments, 'Should have attachments in frontmatter');
    assert.equal(parsed.frontmatter.attachments.length, 2, 'Should have 2 attachments');
    assert.equal(parsed.frontmatter.attachments[0].uri, 'nc:///knowledge/docs/spec.pdf');
    assert.equal(parsed.frontmatter.attachments[0].mime, 'application/pdf');
    assert.equal(parsed.frontmatter.attachments[0].label, 'API Spec v3');
    assert.equal(parsed.frontmatter.attachments[1].uri, 'nc:///knowledge/diagrams/arch.png');
  });

  it('should roundtrip JSON-string attachments (backward compat)', async () => {
    const { parseLearningFrontmatter } = await import('../../packages/brain/utils.js');

    const oldMd = '---\ntitle: "Old Learning"\ntype: learning\ntags: [test]\nattachments: [{"uri":"nc:///knowledge/docs/old.pdf","mime":"application/pdf","label":"Old file"}]\n---\n\nOld content\n';

    const parsed = parseLearningFrontmatter(oldMd);
    assert.ok(parsed.frontmatter.attachments, 'Should parse JSON attachments');
    assert.equal(parsed.frontmatter.attachments.length, 1);
    assert.equal(parsed.frontmatter.attachments[0].uri, 'nc:///knowledge/docs/old.pdf');
  });

  it('should handle learning with no attachments', async () => {
    const { buildLearningMarkdown, parseLearningFrontmatter } = await import('../../packages/brain/utils.js');

    const md = buildLearningMarkdown('No Attachments', 'learning', ['test'], 'Content', null);
    const parsed = parseLearningFrontmatter(md);
    assert.ok(parsed, 'Should parse');
    assert.ok(!parsed.frontmatter.attachments, 'Should have no attachments');
  });
});

// ─── MIME Type Detection ─────────────────────────────────────────────────────

describe('attachment display icons', () => {
  it('should pick correct icon per MIME type', () => {
    const getIcon = (mime) => {
      if (mime?.startsWith('image/')) return '🖼️';
      if (mime?.includes('pdf')) return '📄';
      if (mime?.includes('spreadsheet') || mime?.includes('excel')) return '📊';
      return '📎';
    };

    assert.equal(getIcon('image/png'), '🖼️');
    assert.equal(getIcon('image/jpeg'), '🖼️');
    assert.equal(getIcon('application/pdf'), '📄');
    assert.equal(getIcon('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), '📊');
    assert.equal(getIcon('text/plain'), '📎');
    assert.equal(getIcon('application/octet-stream'), '📎');
  });
});
