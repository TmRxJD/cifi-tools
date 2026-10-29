'use strict';
// Prove that release-only checks are really scheduled, and that a broken registry fails.
const assert = require('node:assert/strict');
const { planSuite, validateRegistry } = require('./all.js');
try {
  const quick = planSuite(false, false);
  const full = planSuite(true, true);
  assert(full.length > quick.length && quick.length > 0);
  for (const name of ['search-quality-check', 'runtime-ceiling-check', 'effort-value-check']) {
    assert(!quick.includes(name), `${name} must stay out of the structural run`);
    assert(full.includes(name), `${name} must run with --sims`);
  }
  assert(full.includes('save-advanced-talents-check'), 'save-import eligibility must be covered');
  assert.throws(() => validateRegistry(['real'], [], new Set(['orphan'])), /not scheduled: orphan/);
  assert.throws(() => validateRegistry(['same'], ['same'], new Set()), /duplicate/);
  console.log(`PASS suite scheduling: ${quick.length} structural entries, ${full.length} release entries; orphan and duplicate negative controls rejected`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
