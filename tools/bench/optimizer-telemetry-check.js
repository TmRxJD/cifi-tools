'use strict';
const assert = require('assert/strict');
const H = require('./harness.js');
process.on('uncaughtException', error => { console.error(error); process.exit(1); });
function reconcile(result) {
  const p = result.diag.profile;
  for (const collection of [p.stages, p.fidelities]) {
    const sum = key => Object.values(collection).reduce((n, row) => n + row[key], 0);
    assert.equal(sum('performed'), result.evals, 'performed evaluations reconcile');
    assert.equal(sum('memoHits'), result.cacheHits, 'memo hits reconcile');
    assert.equal(sum('requests'), result.evals + result.cacheHits, 'all requests reconcile');
    for (const row of Object.values(collection)) {
      assert(row.withinBatchDuplicates <= row.performed);
      assert(row.scorerWallMs >= 0 && row.wallMs >= row.scorerWallMs);
    }
  }
  for (const row of Object.values(p.bestEvaluated)) {
    assert(row.history.length <= 128);
    assert(row.lastImprovementAtBatchEndEvaluation <= result.evals);
    let previousMs = -1;
    for (const point of row.history) {
      assert(Number.isFinite(point.batchEndedAfterMs) && point.batchEndedAfterMs >= 0 && point.batchEndedAfterMs >= previousMs,
        'improvement timestamps must be finite and monotonic');
      assert(point.talentAlloc && point.attrAlloc, 'improvements must retain both allocation blocks');
      previousMs = point.batchEndedAfterMs;
    }
  }
  assert('polish' in p.stageWallMs && 'value_ledger' in p.stageWallMs);
}
async function run() {
  const fx = H.findFixture(H.loadKnownBuilds(), 'borge@12');
  const build = await H.parseBuildCode(fx.code);
  const cfg = H.cfgForImport('borge', build);
  const sb = H.browserSandbox();
  const timing = { argumentMs: 0, instantiateMs: 0, simulateMs: 0, extractMs: 0 };
  const ordinary = await sb.HunterSim.compileEvaluator('borge', cfg);
  const observed = await sb.HunterSim.compileEvaluator('borge', cfg, timing);
  assert.deepEqual(await observed(build.talents, build.attributes, 100), await ordinary(build.talents, build.attributes, 100), 'kernel instrumentation cannot change any output');
  for (const value of Object.values(timing)) assert(Number.isFinite(value) && value >= 0);
  assert(timing.simulateMs > 0 && timing.instantiateMs > 0);
  let performed = 0;
  function uniqueBatch(pairs) {
    const keys = pairs.map(p => JSON.stringify([p.talentAlloc, p.attrAlloc]));
    assert.equal(new Set(keys).size, keys.length, 'duplicate candidates must not reach the evaluator in one batch');
  }
  const repeated = { talentAlloc: { revival: 1 }, attrAlloc: {} };
  assert.throws(() => uniqueBatch([repeated, repeated]), /duplicate candidates/, 'known-bad duplicate workload must fail');
  // Constant controlled scores exercise the full accounting pipeline cheaply, not game quality.
  const scorer = async pairs => {
    uniqueBatch(pairs);
    performed += pairs.length;
    const out = pairs.map(() => 1);
    out.boss = pairs.map(() => ({ kill: 0, hp: 50, maxStage: 100 }));
    return out;
  };
  const result = await H.Optimizer.optimize(cfg, { mode: fx.mode, effort: 'fast', maxSeconds: 0, scorer });
  assert.equal(result.evals, performed);
  reconcile(result);
  assert(Object.values(result.diag.profile.stages).some(row => row.withinBatchDuplicates > 0), 'the real search must exercise duplicate coalescing');
  const broken = JSON.parse(JSON.stringify(result));
  Object.values(broken.diag.profile.stages)[0].performed++;
  assert.throws(() => reconcile(broken), /performed evaluations reconcile/, 'known-bad accounting must fail');
  const brokenClock = JSON.parse(JSON.stringify(result));
  Object.values(brokenClock.diag.profile.bestEvaluated)[0].history[0].batchEndedAfterMs = -1;
  assert.throws(() => reconcile(brokenClock), /timestamps must be finite and monotonic/, 'known-bad clock must fail');
  console.log(`PASS optimizer telemetry: ${performed} controlled evaluations reconcile by stage/fidelity, bounded improvement history, split ledger, known-bad control; real ${fx.name} evaluator output bit-identical with timing`);
}
run().catch(error => { console.error(error); process.exit(1); });
