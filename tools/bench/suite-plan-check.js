'use strict';
// Prove that release-only checks are really scheduled, and that a broken registry fails.
const assert = require('node:assert/strict');
const { planSuite, validateRegistry, summarizeResults } = require('./all.js');
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
  assert.throws(() => validateRegistry([], [], new Set()), /empty/);
  assert.deepEqual(summarizeResults([
    {name:'schema-test',status:'PASS'}, {name:'suite-plan-check',status:'FAIL'},
    {name:'sirred-ship-check',status:'PASS'},
  ]), {passed:1,failed:1,skipped:0,reports:1}, 'unexecuted reports must not inflate the totals');
  assert.equal(summarizeResults([{name:'sirred-ship-check',status:'FAIL'}]).failed,1, 'a crashed report must fail the suite');
  console.log(`PASS suite scheduling: ${quick.length} structural entries, ${full.length} release entries; orphan and duplicate negative controls rejected`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
