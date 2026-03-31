/**
 * Minimal test harness — no dependencies.
 * Usage: const t = createSuite("name"); t.assert(...); t.summary();
 */

export function createSuite(name) {
  let passed = 0;
  let failed = 0;

  return {
    assert(condition, label) {
      if (condition) { passed++; }
      else { failed++; console.error(`  FAIL: ${label}`); }
    },

    assertClose(actual, expected, tolerance, label) {
      this.assert(
        Math.abs(actual - expected) < tolerance,
        `${label} (got ${actual}, expected ~${expected})`
      );
    },

    section(label) {
      console.log(`\n--- ${label} ---`);
    },

    summary() {
      console.log(`\n[${name}] ${passed} passed, ${failed} failed, ${passed + failed} total`);
      return { passed, failed };
    },

    getResults() {
      return { passed, failed };
    }
  };
}
