'use strict';
// Same production top-up/search, with only the scheduling swapped for the sequential oracle.
// Controlled scores exercise scheduling without WASM, worker processes, or wall-clock quality caps.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const H = require('./harness.js');
const filename = path.resolve(__dirname, '../../webapp/public/optimizer/search.js');
const source = fs.readFileSync(filename, 'utf8');
const plain = value => structuredClone(value);
function load(sequential = false, finishCandidates = null, exhaustiveCleanup = false) {
  const anchor = '  const Optimizer = {';
  assert.equal(source.split(anchor).length, 2, 'private instrumentation anchor must be unique');
  const injected = `${sequential ? 'normalizeFinalists = async (candidates, ctx, one) => { const out = []; for (const c of candidates) out.push(await one(c, ctx)); return out; };' : ''}
    globalThis.internals = {normalizeFinalists, greedyTopUp, applyPins};\n${anchor}`;
  const sb = {module:{exports:{}},require:createRequire(filename),console,performance,setTimeout,clearTimeout,
    OptimizerCorpus:globalThis.OptimizerCorpus,OptimizerRefit:globalThis.OptimizerRefit,
    parseBuildCode:H.parseBuildCode};
  let instrumented = source.replace(anchor,injected);
  if (finishCandidates) {
    sb.finishCandidates = finishCandidates;
    instrumented = instrumented.replace('async function finish(ranked, stageChampions) {',
      'async function finish(ranked, stageChampions) { ranked = globalThis.finishCandidates;');
  }
  if (exhaustiveCleanup) {
    assert(instrumented.includes('return index === 0 || ('));
    instrumented = instrumented.replace('return index === 0 || (', 'return true || (');
  }
  vm.runInNewContext(instrumented, sb, {filename});
  return {optimizer:sb.module.exports,...sb.internals};
}
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const pairValue = pair => Object.values(pair.talentAlloc).reduce((s,v,i)=>s+(i+1)*v,0)
  + Object.values(pair.attrAlloc).reduce((s,v,i)=>s+(i+3)*v,0);
function scorer(value) {
  return async (pairs,it) => {
    const scores = pairs.map(p=>value(p,it));
    scores.boss = pairs.map(p=>({kill:pairValue(p),hp:it,maxStage:50}));
    return scores;
  };
}
async function main() {
  const batched = load(), sequential = load(true);
  await check('dependent point choices, pins, metadata, stable order and ranking match sequential', async () => {
    const defs = [{id:'x',cost:1,maxLevel:20},{id:'y',cost:1,maxLevel:20}];
    const attrs = [{id:'free',cost:1,maxLevel:20},{id:'pin',cost:2,maxLevel:2}];
    const candidates = Array.from({length:13},(_,i)=>({talentAlloc:{x:i%3,y:0},attrAlloc:{free:i%4,pin:0}}));
    const snapshot = plain(candidates);
    async function run(api) {
      let calls=0, active=0, peak=0, widest=0;
      const ctx = {shouldCancel:()=>false,score:async(pairs,it)=>{
        calls++; active++; peak=Math.max(peak,active); widest=Math.max(widest,pairs.length);
        await Promise.resolve();
        const scores=await scorer((p,it)=>it+pairValue(p)%7)(pairs,it);
        active--; return scores;
      }};
      const result = await api.normalizeFinalists(candidates,ctx,async(c,lane)=>{
        let a=api.applyPins(attrs,{}, {},8,{...c.attrAlloc},['pin']);
        const t=await api.greedyTopUp(lane,defs,{}, {},7,c.talentAlloc,talentAlloc=>({talentAlloc,attrAlloc:a}));
        a=await api.greedyTopUp(lane,attrs,{}, {},8,a,attrAlloc=>({talentAlloc:t,attrAlloc}));
        const pair={talentAlloc:t,attrAlloc:a};
        const meta=await lane.score([pair],1000);
        assert.equal(meta.boss[0].kill,pairValue(pair),'metadata must follow its pair');
        return {...pair,score:meta[0]};
      });
      return {result:plain(result),calls,peak,widest};
    }
    const expected=await run(sequential), actual=await run(batched);
    assert.deepEqual(actual.result,expected.result);
    assert.deepEqual([...actual.result].sort((a,b)=>b.score-a.score),[...expected.result].sort((a,b)=>b.score-a.score));
    assert.equal(actual.peak,1,'canonical scoring must remain serial');
    assert(actual.calls<expected.calls,'test must prove real score-call coalescing');
    assert(actual.widest>expected.widest,'test must exercise combined batches');
    assert.deepEqual(candidates,snapshot,'input allocations must remain unchanged');
    const wrongScore=plain(actual.result); wrongScore[0].score++;
    assert.throws(()=>assert.deepEqual(wrongScore,expected.result),assert.AssertionError);
  });
  await check('four-lane bound and equal-score first choices match sequential', async()=>{
    let active=0,peak=0;
    const ctx={shouldCancel:()=>false,score:scorer(()=>1)};
    const values=Array.from({length:17},(_,i)=>i);
    const out=await batched.normalizeFinalists(values,ctx,async(value,lane)=>{
      active++; peak=Math.max(peak,active);
      const scores=await lane.score([{talentAlloc:{x:value},attrAlloc:{}}],100);
      active--; return [value,scores[0]];
    });
    assert.equal(peak,4); assert.deepEqual(plain(out),values.map(v=>[v,1]));
    assert.throws(()=>assert.deepEqual(plain(out).reverse(),values.map(v=>[v,1])),assert.AssertionError);
    const defs=[{id:'first',cost:1,maxLevel:9},{id:'second',cost:1,maxLevel:9}];
    const tied=await batched.normalizeFinalists(values,ctx,(_,lane)=>batched.greedyTopUp(
      lane,defs,{}, {},5,{first:0,second:0},talentAlloc=>({talentAlloc,attrAlloc:{}})));
    assert.deepEqual(plain(tied),values.map(()=>({first:5,second:0})), 'point ties must select first candidate');
  });
  for (const kind of ['cancel','lane failure','score rejection']) {
    await check(`${kind} drains the active scorer and prevents late applies`,async()=>{
      const started=deferred(), release=deferred(); let cancelled=false,calls=0,applied=0,settled=false;
      const cause=new Error('controlled normalization failure');
      const ctx={shouldCancel:()=>cancelled,score:async pairs=>{
        calls++; started.resolve(); await release.promise;
        if(kind==='score rejection') throw cause;
        return pairs.map(()=>1);
      }};
      const work=batched.normalizeFinalists([0,1,2,3,4],ctx,async(value,lane)=>{
        if(kind==='lane failure'&&value===0) { await started.promise; throw cause; }
        await lane.score([value],100); applied++; return value;
      });
      const observed=work.then(()=>{settled=true;return null;},error=>{settled=true;return error;});
      await started.promise;
      if(kind==='cancel') cancelled=true;
      await Promise.resolve(); await Promise.resolve();
      assert.equal(settled,false,'must not return before owned scorer drains');
      release.resolve();
      const error=await observed;
      assert(error,'operation must reject');
      if(kind!=='cancel') assert.equal(error,cause,'keep original failure');
      assert.equal(applied,0); assert.equal(calls,1);
      await Promise.resolve(); assert.equal(applied,0); assert.equal(calls,1);
    });
  }
  await check('malformed score arrays fail closed',async()=>{
    await assert.rejects(()=>batched.normalizeFinalists([1,2],{shouldCancel:()=>false,score:async()=>[]},
      (c,ctx)=>ctx.score([c],100)),/batch length mismatch/);
  });
  const known=H.loadKnownBuilds();
  await check('confirmation repairs only the champion and preserves a complete fallback when repair hurts',async()=>{
    const build=await H.parseBuildCode(H.findFixture(known,'borge@12').code);
    const cfg=H.cfgForImport('borge',build,{budgetMode:'level'});
    const baseline=await batched.optimizer.optimize(cfg,{effort:'fast',mode:'loot',maxSeconds:0,
      scorer:scorer(p=>pairValue(p))});
    const complete=plain(baseline.best);
    const signature=p=>JSON.stringify([p.talentAlloc,p.attrAlloc]);
    const originalSignature=signature(complete);
    const winner={talentAlloc:{},attrAlloc:{},score:100};
    const loser={talentAlloc:{[cfg.TALENTS[1].id]:1},attrAlloc:{},score:1};
    const candidates=[winner,{...complete,score:50},loser];
    // Every fill from the empty champion ties at screening fidelity, taking declaration order.
    // At final fidelity that repair loses to the previously complete contender.
    const value=(p,it)=>it===1000 && signature(p)===originalSignature ? 50 : 1;
    const options={effort:'fast',mode:'loot',maxSeconds:0,scorer:scorer(value)};
    const config={...cfg,currentTalents:undefined,currentAttrs:undefined};
    const result=await load(false,candidates).optimizer.optimize(config,options);
    const assertBounded=r=>{
      assert.equal(r.diag.finalization.inputContenders,3);
      assert.equal(r.diag.finalization.omittedIncomplete,1,'losing incomplete build must not get another search');
      assert.equal(r.diag.finalization.changedCount,1);
      assert.equal(signature(plain(r.best)),originalSignature,'repair must not displace a better complete contender');
      for(const p of r.ranked) assert.equal(p.score,value(plain(p),1000),'actual allocations need final scores');
    };
    assertBounded(result);
    const old=await load(false,candidates,true).optimizer.optimize(config,options);
    assert.throws(()=>assertBounded(old),assert.AssertionError,'known-slow exhaustive cleanup must fail this gate');
    const after=result.diag.profile.stages.winner_cleanup.performed;
    const before=old.diag.profile.stages.winner_cleanup.performed;
    assert(after<before,'bounded cleanup must remove real scorer work');
    console.log(`  controlled confirmation evaluations: ${before} -> ${after}`);
  });
  for(const [name,mode,ties] of [['borge@12','loot',false],['knox@12','bossTimeless',true]]) {
    await check(`full fast search exact ranked/best equivalence ${name} ${mode}${ties?' ties':''}`,async()=>{
      const build=await H.parseBuildCode(H.findFixture(known,name).code);
      const cfg=H.cfgForImport(name.split('@')[0],build,{budgetMode:'level'});
      const snapshot=plain(cfg);
      const value=ties?()=>1:(p,it)=>pairValue(p)+(it===1000?pairValue(p)%11:0);
      const opts={effort:'fast',mode,maxSeconds:0,scorer:scorer(value)};
      const expected=await sequential.optimizer.optimize(cfg,opts);
      const actual=await batched.optimizer.optimize(cfg,opts);
      assert(expected.ranked.length>0); assert(actual.ranked.length>0);
      assert.deepEqual(plain(actual.ranked),plain(expected.ranked));
      assert.deepEqual(plain(actual.best),plain(expected.best));
      assert.deepEqual(plain(actual.diag.incumbent),plain(expected.diag.incumbent));
      assert(actual.diag.archive, 'full-search comparison must exercise the archive');
      assert.deepEqual(plain(actual.diag.archive),plain(expected.diag.archive));
      assert.deepEqual(plain(actual.diag.ledger),plain(expected.diag.ledger));
      assert.deepEqual(plain(cfg),snapshot);
    });
  }
  console.log(`${checks} normalization checks passed (including 3 known-bad controls).`);
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
