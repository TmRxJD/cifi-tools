'use strict';
// Controls corrupt externally expected outcomes, then call the SAME oracle as the real bench.
const assert = require('node:assert/strict');
const H = require('./harness.js');
const {assertCoverage,assertUnderspendContract} = require('./underspend-contract.js');
const {selectFixtures} = require('./underspend-test.js');
function packet(kept=false) {
  const cfg = {TALENTS:[{id:'t',cost:1,maxLevel:2}],ATTRIBUTES:[{id:'a',cost:1,maxLevel:4}],
    ATTRIBUTE_DEPENDENCIES:{},ATTRIBUTE_MIN_VALUE:{},TALENT_BUDGET:2,ATTRIBUTE_BUDGET:2,
    currentTalents:{t:0},currentAttrs:{a:0}};
  const original = {talentAlloc:{t:0},attrAlloc:{a:0},score:kept?10:5};
  const candidate = {talentAlloc:{t:2},attrAlloc:{a:2},score:7};
  const result = {cancelled:false,truncated:false,best:kept?original:candidate,
    ranked:kept?[original,candidate]:[candidate,original],diag:{strategy:'global',truncated:false,
      profile:{settings:{effort:'complete',finalIterations:1000}},
      finalization:{finalIterations:1000},
      incumbent:{provided:true,modeCompatible:true,protected:true,kept,score:original.score,candidateScore:7}}};
  return {cfg,snapshot:structuredClone(cfg),result,inputReadback:{iterations:1000,score:original.score},
    outputReadback:{iterations:1000,score:result.best.score},iterations:1000,effort:'complete',space:H.Space};
}
function main() {
let positive=0, negative=0;
for (const kept of [false,true]) {assertUnderspendContract(packet(kept));positive++;}
const tied=packet(true);
tied.result.best.score=7; tied.result.diag.incumbent.score=7;
tied.inputReadback.score=7; tied.outputReadback.score=7;
assertUnderspendContract(tied); positive++;
const bad = [
  ['degraded selected input',p=>{p.outputReadback.score=4;p.result.best.score=4;}],
  ['stale returned score',p=>{p.result.best.score++;}],
  ['stale incumbent score',p=>{p.result.diag.incumbent.score++;}],
  ['nonfinite score',p=>{p.outputReadback.score=NaN;}],
  ['forged kept marker',p=>{p.result.diag.incumbent.kept=true;}],
  ['missing kept marker',p=>{p.result.diag.incumbent.kept=false;},true],
  ['missing protection',p=>{p.result.diag.incumbent.protected=false;},true],
  ['unmarked generated underspend',p=>{p.result.best.talentAlloc.t=1;}],
  ['generated underspend hidden below winner',p=>{p.result.ranked.splice(1,0,{talentAlloc:{t:1},attrAlloc:{a:2},score:6});}],
  ['illegal allocation',p=>{p.result.best.attrAlloc.a=5;}],
  ['unknown positive node',p=>{p.result.best.attrAlloc.unknown=1;}],
  ['input mutation',p=>{p.cfg.currentTalents.t=1;}],
  ['wrong independent fidelity',p=>{p.inputReadback.iterations=100;}],
  ['wrong finalized fidelity',p=>{p.result.diag.finalization.finalIterations=100;}],
  ['wrong effort readback',p=>{p.result.diag.profile.settings.effort='fast';}],
  ['cancelled result',p=>{p.result.cancelled=true;}],
  ['missing truncation readback',p=>{delete p.result.truncated;}],
  ['inconsistent truncation readback',p=>{p.result.diag.truncated=true;}],
  ['illegal selected input before measurement',p=>{p.cfg.currentAttrs.a=5;p.snapshot.currentAttrs.a=5;}],
  ['no ranked build',p=>{p.result.ranked=[];}],
  ['better generated candidate discarded',p=>{p.result.diag.incumbent.candidateScore=8;}],
];
for (const [name,corrupt,kept] of bad) {
  const p=packet(kept);
  corrupt(p);
  assert.throws(()=>assertUnderspendContract(p),assert.AssertionError,`known bad accepted: ${name}`);
  negative++;
}
assertCoverage(3,3);positive++;
for (const counts of [[0,0],[0,3],[2,3]]) {
  assert.throws(()=>assertCoverage(...counts),assert.AssertionError);negative++;
}
const known=H.loadKnownBuilds();
assert.equal(selectFixtures(known,[]).length,9);positive++;
const names=['borge@12','ozzy@11','knox@12'];
assert.deepEqual(selectFixtures(known,[`--only=${names.join(',')}`]).map(f=>f.name),names);positive++;
for (const args of [['--only='],['--only=missing'],['--only=borge@12,borge@12'],['borge','0'],['missing'],['--wrong']]) {
  assert.throws(()=>selectFixtures(known,args),assert.AssertionError);negative++;
}
console.log(`PASS underspend contract controls: ${positive} positive cases; ${negative} known-bad cases rejected; default coverage=9`);
}
try { main(); }
catch (error) { console.error(`FAIL ${error.stack || error}`); process.exitCode=1; }
