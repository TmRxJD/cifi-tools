'use strict';
// Correctness under an emergency cap: protect the actual selected, underspent allocation.
// Recovering an undisclosed full allocation belongs to uncapped search-quality reports.
const assert = require('node:assert/strict');
const H = require('./harness.js');
const {assertCoverage, assertSelectedInput, assertUnderspendContract} = require('./underspend-contract.js');
const Space = H.Space;
function strip(defs, deps, minVal, alloc, points) {
  const out = {...alloc};
  let removed = 0;
  while (removed < points) {
    const target = defs.filter(node => (out[node.id] || 0) > 0)
      .reduce((best,node) => !best || out[node.id] > out[best.id] ? node : best, null);
    if (!target) break;
    out[target.id]--;
    removed += target.cost || 1;
  }
  Space.clearInvalidDescendants(defs,deps,minVal,out);
  return out;
}
function selectFixtures(known,args) {
  const only = args.find(arg => arg.startsWith('--only='));
  assert(args.every(arg => !arg.startsWith('--') || arg === only), 'unknown underspend-test option');
  if (only) {
    assert.equal(args.length,1,'--only cannot be combined with positional arguments');
    const names = only.slice(7).split(',');
    assert(names.every(name => name && name === name.trim()), '--only needs exact nonempty fixture names');
    assert.equal(new Set(names).size,names.length,'--only contains duplicate fixtures');
    return names.map(name => {
      const matches = Object.values(known).flat().filter(fixture => fixture.name === name);
      assert.equal(matches.length,1,`--only fixture must resolve exactly once: ${name}`);
      assert.equal(matches[0].mode,'loot',`underspend-test requires a loot fixture: ${name}`);
      return matches[0];
    });
  }
  assert(args.length <= 2,'expected [hunter] [count] or --only=exactName,...');
  const hunters = args[0] ? [args[0]] : ['borge','ozzy','knox'];
  const count = args[1] === undefined ? 3 : Number(args[1]);
  assert(Number.isInteger(count) && count > 0,'fixture count must be a positive integer');
  return hunters.flatMap(hunter => {
    assert(Array.isArray(known[hunter]),`unknown hunter ${hunter}`);
    const all = known[hunter].filter(fixture => fixture.mode === 'loot');
    assert(all.length >= count,`${hunter} has fewer than ${count} loot fixtures`);
    const step = Math.max(1,Math.floor(all.length/count));
    const picks = all.filter((_,index) => index % step === 0).slice(0,count);
    assertCoverage(picks.length,count);
    return picks;
  });
}
async function main(args=process.argv.slice(2)) {
  const picks = selectFixtures(H.loadKnownBuilds(),args);
  assertCoverage(picks.length,picks.length);
  const iterations = H.Optimizer.FINAL_ITERATIONS;
  const effort = 'complete';
  let checked = 0;
  let failures = 0;
  for (const fixture of picks) {
    const started = performance.now();
    console.log(`START ${fixture.name} effort=${effort} FINAL_ITERATIONS=${iterations} cap=30s`);
    let pool;
    try {
      const build = await H.parseBuildCode(fixture.code,fixture.hunter);
      assert(build,`${fixture.name}: build code did not decode`);
      // Definitions originate in the VM sandbox. Compare host snapshots to host inputs while
      // preserving Infinity; JSON cloning would silently change uncapped definitions to null.
      const cfg = structuredClone(H.cfgForImport(fixture.hunter,build,{budgetMode:'level'}));
      const untouchedReference = await H.scoreAllocation(cfg,fixture.mode,build.talents,build.attributes,iterations);
      assert(Number.isFinite(untouchedReference), `${fixture.name}: untouched reference is nonfinite`);
      cfg.currentTalents = strip(cfg.TALENTS,{}, {},build.talents,12);
      cfg.currentAttrs = strip(cfg.ATTRIBUTES,cfg.ATTRIBUTE_DEPENDENCIES,cfg.ATTRIBUTE_MIN_VALUE,build.attributes,9);
      assert(Space.costOf(cfg.TALENTS,cfg.currentTalents) < cfg.TALENT_BUDGET
        || Space.costOf(cfg.ATTRIBUTES,cfg.currentAttrs) < cfg.ATTRIBUTE_BUDGET,`${fixture.name}: no underspend exercised`);
      const snapshot = structuredClone(cfg);
      assertSelectedInput(snapshot,Space);
      const inputReadback = {iterations,score:await H.scoreAllocation(snapshot,fixture.mode,
        snapshot.currentTalents,snapshot.currentAttrs,iterations)};
      pool = await H.makePooledScorer(cfg,fixture.mode,undefined,6);
      assert.equal(pool.workers,6,`${fixture.name}: expected six ready scoring workers`);
      let lastPhase, lastProgress = 0;
      const result = await H.Optimizer.optimize(cfg,{mode:fixture.mode,effort,scorer:pool.score,maxSeconds:30,
        onProgress:progress => {
          const now = performance.now();
          if (progress.phase !== lastPhase || now-lastProgress > 15000) {
            console.log(`progress ${fixture.name} ${progress.phase} ${progress.done}/${progress.total} evals=${progress.evals}`);
            lastPhase=progress.phase; lastProgress=now;
          }
        }});
      assert(result.best,`${fixture.name}: no returned build`);
      const outputReadback = {iterations,score:await H.scoreAllocation(snapshot,fixture.mode,
        result.best.talentAlloc,result.best.attrAlloc,iterations)};
      const verified = assertUnderspendContract({cfg,snapshot,result,inputReadback,outputReadback,iterations,effort,space:Space});
      checked++;
      console.log(`PASS ${fixture.name} input=${inputReadback.score} output=${outputReadback.score}`
        + ` kept=${verified.kept} truncated=${verified.truncated} contenders=${verified.contenders}`
        + ` workers=${pool.workers} untouchedReference=${untouchedReference} (diagnostic, not supplied as a floor)`
        + ` seconds=${((performance.now()-started)/1000).toFixed(2)}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${fixture.name}: ${error.stack || error}`);
    } finally { if (pool) await pool.destroy(); }
  }
  assertCoverage(checked+failures,picks.length);
  assertCoverage(checked,picks.length);
  console.log(`PASS underspend correctness: ${checked}/${picks.length} actual selected inputs protected; effort=${effort}, iterations=${iterations}`);
}
module.exports = {selectFixtures};
if (require.main === module) main().catch(error => {console.error(`FAIL ${error.stack || error}`);process.exitCode=1;});
