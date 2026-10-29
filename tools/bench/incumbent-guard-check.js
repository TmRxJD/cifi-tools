'use strict';
// Exercise the shipped optimizer entry point: a protected input is an allocation, not a top-up.
const assert = require('assert/strict');
const H = require('./harness.js');
const clone = value => JSON.parse(JSON.stringify(value));
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
function controlled(value) {
  return async (pairs, iterations) => {
    const scores = pairs.map(pair => value(pair, iterations));
    scores.boss = pairs.map(() => ({kill:0,hp:100,maxStage:50}));
    return scores;
  };
}
const isZero = pair => [...Object.values(pair.talentAlloc), ...Object.values(pair.attrAlloc)].every(v => v === 0);
const run = (cfg, effort, scorer, mode = 'loot') => H.Optimizer.optimize(cfg, {effort,mode,scorer,maxSeconds:0});
function assertRanked(result, finalValue) {
  for (let i=0;i<result.ranked.length;i++) {
    const candidate = result.ranked[i];
    assert.equal(candidate.score, finalValue(candidate), `ranked[${i}] has a stale final score`);
    if (i) assert(result.ranked[i-1].score >= candidate.score, 'ranked must descend by verified score');
  }
}
async function main() {
  const known = H.loadKnownBuilds();
  const borgeFixture = H.findFixture(known, 'borge@12');
  const borge = await H.parseBuildCode(borgeFixture.code);
  const base = H.cfgForImport('borge', borge, {budgetMode:'level'});
  const empty = {...base,currentTalents:Object.fromEntries(base.TALENTS.map(d=>[d.id,0])),
    currentAttrs:Object.fromEntries(base.ATTRIBUTES.map(d=>[d.id,0]))};
  await check('AccountState detaches selected allocation snapshots and excludes them from workers', async () => {
    const accountState = H.browserSandbox().AccountState;
    const input = clone(borge);
    const account = accountState.build({hunter:'borge',build:input,hunterStats:{},globalUpgrades:{},gems:{},showAdvancedTalents:false});
    const cfg = accountState.optimizerCfg(account);
    assert.notEqual(cfg.currentTalents,account.talents);
    assert.notEqual(cfg.currentAttrs,account.attributes);
    assert.deepEqual(clone(cfg.currentTalents),clone(account.talents));
    assert.deepEqual(clone(cfg.currentAttrs),clone(account.attributes));
    const expected = clone({talents:account.talents,attrs:account.attributes});
    cfg.currentTalents.revival += 1;
    cfg.currentAttrs.ares += 1;
    assert.deepEqual(clone({talents:account.talents,attrs:account.attributes}),expected);
    assert.deepEqual(input,clone(borge));
    const worker = accountState.workerCfg(cfg);
    assert.equal(Object.hasOwn(worker,'currentTalents'),false);
    assert.equal(Object.hasOwn(worker,'currentAttrs'),false);
  });
  await check('real Knox coarse-score inversion keeps the exact verified incumbent', async () => {
    const fixture = H.findFixture(known, 'knox@30');
    const build = await H.parseBuildCode(fixture.code);
    const cfg = H.cfgForImport('knox',build);
    const before = clone({talents:cfg.currentTalents,attrs:cfg.currentAttrs});
    const pool = await H.makePooledScorer(cfg,'loot',undefined,6);
    const started = performance.now();
    let timedOut = false;
    try {
      const result = await H.Optimizer.optimize(cfg,{effort:'refinement',mode:'loot',scorer:pool.score,maxSeconds:0,
        shouldCancel:()=>{timedOut=performance.now()-started>180000;return timedOut;}});
      if (timedOut) throw new Error('TIMEOUT: real Knox regression exceeded the 180s safety budget');
      assert.equal(result.diag.strategy,'refinement');
      assert.equal(result.diag.incumbent.protected,true);
      assert.equal(result.diag.incumbent.kept,true);
      assert(result.diag.localRefinement.candidateFinalScore < result.diag.incumbent.score, 'fixture must exercise the known coarse-score inversion');
      const evaluated = await H.evaluateAllocation(cfg,result.best.talentAlloc,result.best.attrAlloc,1000);
      const baseline = await H.evaluateAllocation(cfg,build.talents,build.attributes,1000);
      assert.equal(result.best.score,evaluated.loot);
      assert(evaluated.loot >= baseline.loot);
      assert.deepEqual(result.best.talentAlloc,before.talents);
      assert.deepEqual(result.best.attrAlloc,before.attrs);
      assert.deepEqual({talents:cfg.currentTalents,attrs:cfg.currentAttrs},before);
    } finally { await pool.destroy(); }
  });
  for (const effort of ['refinement','fast']) {
    await check(`${effort} preserves an underspent input and prefers it on ties`, async () => {
      const before = clone({talents:empty.currentTalents,attrs:empty.currentAttrs});
      const result = await run(empty,effort,controlled((pair,it)=>it===1000&&isZero(pair)?100:1));
      assert.equal(result.best.score,100);
      assert.deepEqual(result.best.talentAlloc,empty.currentTalents);
      assert.deepEqual(result.best.attrAlloc,empty.currentAttrs);
      assert.equal(result.diag.incumbent.kept,true);
      const tied = await run(empty,effort,controlled(()=>1));
      assert.equal(tied.diag.incumbent.kept,true);
      assert.deepEqual(tied.best.talentAlloc,empty.currentTalents);
      assert.deepEqual(tied.best.attrAlloc,empty.currentAttrs);
      assert.deepEqual({talents:empty.currentTalents,attrs:empty.currentAttrs},before);
    });
  }
  await check('malformed incumbent values fail with the allocation field named', async () => {
    const scorer = controlled(()=>1);
    const half = {...empty}; delete half.currentAttrs;
    await assert.rejects(()=>run(half,'refinement',scorer),/currentTalents and currentAttrs/);
    for (const [id,value] of [['revival',-1],['revival',0.5],['unknown_positive',1],['revival',3]]) {
      await assert.rejects(()=>run({...empty,currentTalents:{...empty.currentTalents,[id]:value}},'refinement',scorer),
        error=>error.message.includes(`incumbent.talentAlloc.${id}`));
    }
    const absent = {...base}; delete absent.currentTalents; delete absent.currentAttrs;
    await assert.rejects(()=>run(absent,'refinement',scorer),/currentTalents and currentAttrs/);
  });
  await check('bossTimeless excludes an incompatible input and enforces its pin', async () => {
    const cfg = {...base,currentTalents:{...borge.talents},currentAttrs:{...borge.attributes,timeless:0}};
    const before = clone({talents:cfg.currentTalents,attrs:cfg.currentAttrs});
    const result = await run(cfg,'refinement',controlled(()=>1),'bossTimeless');
    assert.equal(result.diag.incumbent.modeCompatible,false);
    assert.equal(result.diag.incumbent.protected,false);
    assert.equal(result.best.attrAlloc.timeless,5);
    assert.deepEqual({talents:cfg.currentTalents,attrs:cfg.currentAttrs},before);
  });
  await check('Knox bossTimeless spends points refunded by final mode pins', async () => {
    const fixture = H.findFixture(known, 'knox@12');
    const build = await H.parseBuildCode(fixture.code, fixture.hunter);
    const cfg = H.cfgForImport(fixture.hunter, build, {budgetMode:'spend'});
    const result = await run(cfg, 'fast', controlled(() => 1), 'bossTimeless');
    assert(result.ranked.length > 0);
    for (const candidate of result.ranked) {
      assert.equal(candidate.attrAlloc.time, 5);
      assert.equal(H.Space.costOf(cfg.ATTRIBUTES, candidate.attrAlloc), cfg.ATTRIBUTE_BUDGET);
    }
    assertRanked(result, () => 1);
  });
  await check('a pin-compatible mode start survives a misleading local improvement', async () => {
    const cfg = {...base,currentAttrs:{...base.currentAttrs,timeless:0}};
    const isOriginalTalents = pair=>H.Space.sameAlloc(base.TALENTS,pair.talentAlloc,base.currentTalents);
    const result = await run(cfg,'refinement',controlled((pair,it)=>it===1000
      ? (isOriginalTalents(pair)?100:1) : (pair.talentAlloc.revival||0)*100),'bossTimeless');
    assert.equal(result.diag.incumbent.protected,false);
    assert(result.diag.localRefinement.candidateFinalScore < result.best.score);
    assert.equal(result.best.score,100);
    assert.equal(result.best.attrAlloc.timeless,5);
    assert(isOriginalTalents(result.best));
  });
  await check('the emergency deadline stops at a completed local sweep and still verifies', async () => {
    const realNow = Date.now, started = realNow();
    let elapsed = 0;
    try {
      Date.now = ()=>started+elapsed;
      const result = await H.Optimizer.optimize(base,{effort:'refinement',mode:'loot',maxSeconds:1,
        scorer:async pairs=>{elapsed+=2000;return pairs.map(pair=>(pair.talentAlloc.revival||0)*100);}});
      assert.equal(result.truncated,true,'the known-expired cap must be observed');
      assert.equal(result.diag.localRefinement.stoppedAfterSweeps,1);
      assert.equal(result.diag.incumbent.protected,true);
      assert(result.best.score>=result.diag.incumbent.score);
    } finally { Date.now = realNow; }
  });
  await check('global finalization verifies every cleaned contender and detects stale scores', async () => {
    const finalValue = pair => 1 + base.TALENTS.reduce((s,d,i)=>s+(i+1)*(pair.talentAlloc[d.id]||0),0)
      + base.ATTRIBUTES.reduce((s,d,i)=>s+(i+1)*17*(pair.attrAlloc[d.id]||0),0);
    const result = await run(empty,'fast',controlled((pair,it)=>it===1000?finalValue(pair):1));
    assertRanked(result,finalValue);
    assert(result.diag.finalization.changedCount>0, 'fixture did not exercise normalization changes');
    if (result.diag.incumbent.kept) assert.equal(result.best.score,finalValue(result.best));
    const corrupt = clone(result); corrupt.ranked[0].score += 1;
    assert.throws(()=>assertRanked(corrupt,finalValue),/stale final score/,'known-bad score must be rejected');
  });
  await check('cancelled refinement returns no applicable build and leaves the original intact', async () => {
    const before = clone({talents:base.currentTalents,attrs:base.currentAttrs});
    let batches = 0;
    const result = await H.Optimizer.optimize(base,{effort:'refinement',mode:'loot',maxSeconds:0,
      scorer:async pairs=>{ batches++; return pairs.map(()=>1); },shouldCancel:()=>batches>=2});
    assert.equal(result.cancelled,true);
    assert.equal(result.best,null);
    assert.deepEqual(result.ranked,[]);
    assert.deepEqual({talents:base.currentTalents,attrs:base.currentAttrs},before);
  });
  await check('cancellation arriving during the final memo await cannot apply a result', async () => {
    let cancel = false;
    const result = await H.Optimizer.optimize(base,{effort:'refinement',mode:'loot',maxSeconds:0,
      scorer:controlled(()=>1),onProgress:p=>{if(p.phase==='done')queueMicrotask(()=>{cancel=true;});},
      shouldCancel:()=>cancel});
    assert.equal(cancel,true,'the final-await cancellation control was not exercised');
    assert.equal(result.cancelled,true);
    assert.equal(result.best,null);
  });
  console.log(`${failures ? 'FAIL' : 'PASS'} incumbent guard: ${failures} failure(s)`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
