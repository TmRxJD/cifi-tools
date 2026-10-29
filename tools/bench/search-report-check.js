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
  const corpus = {donorsFor:() => ['0','1','neighbor'].map(code=>({code}))};
  const originalDonors = corpus.donorsFor;
  const H = {
    loadKnownBuilds: () => ({ borge: [0, 1].map(index => ({ index, uid: `fixture-${index}`, name: `fixture-${index}`, mode: 'loot', code: `${index}` })), ozzy: [], knox: [] }),
    parseBuildCode: async code => ({ level: 12, code, talents: {t:1}, attributes: {a:1} }),
    cfgForImport: (hunter,build) => ({ testCode:build.code, currentTalents: build.talents, currentAttrs: build.attributes,
      TALENTS:[{id:'t',cost:1,maxLevel:1}],ATTRIBUTES:[{id:'a',cost:1,maxLevel:1}],
      ATTRIBUTE_DEPENDENCIES:{},ATTRIBUTE_MIN_VALUE:{},TALENT_BUDGET:1,ATTRIBUTE_BUDGET:1 }),
    Space: require('./harness.js').Space,
    evaluateAllocation: async () => ({ loot: bad === 'nan' && calls === 1 ? NaN : 100 }),
    makePooledScorer: async () => ({workers:bad === 'workers' ? 5 : 6, score:async () => [], destroy:async () => {}}),
    Optimizer: { optimize: async (cfg, options) => {
      assert(!('currentTalents' in cfg) && !('currentAttrs' in cfg));
      assert.equal(options.maxSeconds, 0);
      assert.equal(options.effort, 'complete');
      calls++;
      if (bad !== 'corpus') {
        const donors = corpus.donorsFor('borge','loot',12);
        assert(!donors.some(donor=>donor.code===cfg.testCode), 'target leaked into its own donors');
        assert(donors.some(donor=>donor.code==='neighbor'), 'neighbor donors must remain available');
      }
      if (bad === 'crash' && calls === 1) throw new Error('known-bad fixture crash');
      return { best: { talentAlloc: {t:bad==='illegal'?2:1}, attrAlloc: {a:1}, score:bad==='stale'?101:100 }, evals: 1, truncated:bad === 'truncated',
        diag: { incumbent: { protected: bad === 'incumbent' }, profile:{settings:{effort:bad === 'effort' ? 'fast' : 'complete'}} } };
    } },
  };
  await vm.runInNewContext(source, {
    global: {OptimizerCorpus:corpus},
    require: name => { if(name==='./measurement.js') return require('./measurement.js'); assert.equal(name, './harness.js'); return H; },
    process: { argv: ['node', 'report', '--sample=2', '--seed=7'], exit: code => exits.push(code) },
    console: { log: (...args) => output.push(args.join(' ')), error: error => output.push(String(error)) },
  });
  assert.equal(corpus.donorsFor,originalDonors,'corpus must be restored after success and failure');
  assert.equal(calls, bad === 'workers' ? 0 : 2, 'both fixtures must be exercised, or refused before search for a worker mismatch');
  return { exits, output: output.join('\n') };
}
(async () => {
  assert.deepEqual((await run(null)).exits, []);
  for (const fault of ['crash', 'nan', 'incumbent', 'workers', 'truncated', 'effort', 'corpus', 'illegal', 'stale']) {
    const result = await run(fault);
    assert(result.exits.includes(1), `${fault} must fail the report`);
    assert.match(result.output, /incomplete measurement/);
  }
  console.log('PASS search report: target-code holdout and restoration; crash, NaN, incumbent contamination, worker mismatch, truncation, wrong effort and inert holdout rejected');
})().catch(error => { console.error(error); process.exitCode = 1; });
