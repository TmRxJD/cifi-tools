'use strict';
// Real-WASM checks and adversarial controls share this oracle. The floor is the supplied
// allocation, never a hidden allocation the search was expected to rediscover.
const assert = require('node:assert/strict');
function assertCoverage(completed, expected) {
  assert(Number.isInteger(expected) && expected > 0, 'expected coverage must be nonzero');
  assert.equal(completed, expected, `incomplete coverage: ${completed}/${expected}`);
}
function assertSelectedInput(cfg, space) {
  for (const [alloc, defs, deps, minimums, budget] of [
    [cfg.currentTalents,cfg.TALENTS,{}, {},cfg.TALENT_BUDGET],
    [cfg.currentAttrs,cfg.ATTRIBUTES,cfg.ATTRIBUTE_DEPENDENCIES,cfg.ATTRIBUTE_MIN_VALUE,cfg.ATTRIBUTE_BUDGET],
  ]) {
    assert(space.isLegal(defs,deps,minimums,alloc,budget), 'selected input is illegal before measurement');
    for (const [id,value] of Object.entries(alloc)) {
      const def=defs.find(node=>node.id===id);
      assert(Number.isInteger(value) && value>=0 && (def || value===0)
        && (!def || value<=def.maxLevel), `selected input node ${id} invalid before measurement`);
    }
  }
}
function assertUnderspendContract({cfg, snapshot, result, inputReadback, outputReadback, iterations, effort, space}) {
  assertSelectedInput(snapshot,space);
  assert.deepEqual(cfg, snapshot, 'selected account/allocation input was mutated');
  assert(Number.isInteger(iterations) && iterations > 0, 'FINAL fidelity must be explicit');
  for (const [label, readback] of [['input', inputReadback], ['output', outputReadback]]) {
    assert.equal(readback.iterations, iterations, `${label} readback used a different fidelity`);
    assert(Number.isFinite(readback.score), `${label} readback score is nonfinite`);
  }
  assert.equal(result.cancelled, false, 'optimizer cancelled');
  assert(result.best && Array.isArray(result.ranked) && result.ranked.length, 'optimizer returned no ranked build');
  const diag = result.diag;
  assert.equal(typeof result.truncated,'boolean','truncation readback missing');
  assert.equal(diag.truncated,result.truncated,'truncation readbacks disagree');
  assert.equal(diag.strategy, 'global', 'requested complete search did not run');
  assert.equal(diag.profile.settings.effort, effort, 'effort readback differs');
  assert.equal(diag.profile.settings.finalIterations, iterations, 'search fidelity differs');
  assert.equal(diag.finalization.finalIterations, iterations, 'finalization fidelity differs');
  assert.equal(diag.incumbent.provided, true, 'selected input was not recorded');
  assert.equal(diag.incumbent.modeCompatible, true, 'loot input excluded');
  assert.equal(diag.incumbent.protected, true, 'selected input was not protected');
  assert.equal(diag.incumbent.score, inputReadback.score, 'incumbent score is stale');
  assert.equal(result.best.score, outputReadback.score, 'returned score is stale');
  assert(outputReadback.score >= inputReadback.score, 'returned allocation degraded the actual selected input');
  const original = pair => space.sameAlloc(snapshot.TALENTS, pair.talentAlloc, snapshot.currentTalents)
    && space.sameAlloc(snapshot.ATTRIBUTES, pair.attrAlloc, snapshot.currentAttrs);
  assert.equal(diag.incumbent.kept, original(result.best), 'forged or missing incumbent-kept marker');
  assert(Number.isFinite(diag.incumbent.candidateScore), 'generated-candidate score is nonfinite');
  assert(result.best.score >= diag.incumbent.candidateScore, 'a verified contender beats the returned build');
  // The protected original can also occur below the winner; it is not a generated contender.
  for (const [index, pair] of result.ranked.entries()) {
    assert(Number.isFinite(pair.score), `ranked[${index}] score is nonfinite`);
    if (index) assert(result.ranked[index-1].score >= pair.score, 'ranked scores are not descending');
    for (const [field, defs, deps, minimums, declared] of [
      ['talentAlloc', snapshot.TALENTS, {}, {}, snapshot.TALENT_BUDGET],
      ['attrAlloc', snapshot.ATTRIBUTES, snapshot.ATTRIBUTE_DEPENDENCIES, snapshot.ATTRIBUTE_MIN_VALUE, snapshot.ATTRIBUTE_BUDGET],
    ]) {
      const alloc = pair[field];
      assert(alloc && typeof alloc === 'object' && !Array.isArray(alloc), `ranked[${index}].${field} missing`);
      for (const [id,value] of Object.entries(alloc)) {
        const def = defs.find(node => node.id === id);
        assert(Number.isInteger(value) && value >= 0 && (def || value === 0)
          && (!def || value <= def.maxLevel), `ranked[${index}].${field}.${id} invalid`);
      }
      const capacity = defs.reduce((sum,node) => sum + (node.cost || 1)*node.maxLevel, 0);
      const budget = Math.min(declared, capacity);
      assert(space.isLegal(defs, deps, minimums, alloc, budget), `ranked[${index}].${field} illegal`);
      if (!original(pair)) {
        const idle = budget - space.costOf(defs, alloc);
        const eligible = defs.find(node => (node.cost || 1) <= idle && space.isEligible(node, defs, deps, minimums, alloc));
        assert(!eligible, `ranked[${index}].${field} has unmarked spendable points`);
      }
    }
  }
  assert.equal(result.best.score, result.ranked[0].score, 'best does not match ranked[0] score');
  assert(space.sameAlloc(snapshot.TALENTS,result.best.talentAlloc,result.ranked[0].talentAlloc)
    && space.sameAlloc(snapshot.ATTRIBUTES,result.best.attrAlloc,result.ranked[0].attrAlloc), 'best does not match ranked[0] allocation');
  return {kept:diag.incumbent.kept, truncated:result.truncated, contenders:result.ranked.length};
}
module.exports = {assertCoverage, assertSelectedInput, assertUnderspendContract};
