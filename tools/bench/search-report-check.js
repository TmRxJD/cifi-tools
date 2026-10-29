'use strict';
// Exercise the actual report entry point with tiny controlled fixtures. A successful row
// must not conceal another fixture's crash, nonfinite result, or retained incumbent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./search-quality-check.js'), 'utf8');
async function run(bad) {
  let calls = 0;
  const exits = [];
  const output = [];
  const H = {
    loadKnownBuilds: () => ({ borge: [0, 1].map(index => ({ index, uid: `fixture-${index}`, name: `fixture-${index}`, mode: 'loot', code: `${index}` })), ozzy: [], knox: [] }),
    parseBuildCode: async () => ({ level: 12, talents: {}, attributes: {} }),
    cfgForImport: () => ({ currentTalents: {}, currentAttrs: {} }),
    evaluateAllocation: async () => ({ loot: bad === 'nan' && calls === 1 ? NaN : 100 }),
    makeScorer: async () => async () => [],
    Optimizer: { optimize: async cfg => {
      assert(!('currentTalents' in cfg) && !('currentAttrs' in cfg));
      calls++;
      if (bad === 'crash' && calls === 1) throw new Error('known-bad fixture crash');
      return { best: { talentAlloc: {}, attrAlloc: {} }, evals: 1, diag: { incumbent: { protected: bad === 'incumbent' } } };
    } },
  };
  await vm.runInNewContext(source, {
    require: name => { assert.equal(name, './harness.js'); return H; },
    process: { argv: ['node', 'report', '--sample=2', '--seed=7'], exit: code => exits.push(code) },
    console: { log: (...args) => output.push(args.join(' ')), error: error => output.push(String(error)) },
  });
  assert.equal(calls, 2, 'both fixtures must be exercised');
  return { exits, output: output.join('\n') };
}
(async () => {
  assert.deepEqual((await run(null)).exits, []);
  for (const fault of ['crash', 'nan', 'incumbent']) {
    const result = await run(fault);
    assert(result.exits.includes(1), `${fault} must fail the report`);
    assert.match(result.output, /incomplete measurement/);
  }
  console.log('PASS search report: two successful fixtures; partial crash, NaN and incumbent contamination rejected');
})().catch(error => { console.error(error); process.exitCode = 1; });
