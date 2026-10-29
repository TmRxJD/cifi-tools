'use strict';
// Exercise the real timing entry point with a controlled clock. Startup counts too;
// a wrong pool, invalid ceiling or missing build must never produce a passing run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./runtime-ceiling-check.js'), 'utf8');
async function run(fault) {
  let clock = 0, destroyed = 0, started = 0;
  const exits = [];
  const output = [];
  const H = {
    loadKnownBuilds: () => ({borge:[{name:'highest-fixture',hunter:'borge',mode:'loot',level:84,code:'fixture'}]}),
    parseBuildCode: async () => ({}), cfgForImport: () => ({}),
    makePooledScorer: async (cfg,mode,context,size) => {
      assert.equal(size,6); started++; clock+=1000;
      return {workers:fault==='workers'?5:6,score:async()=>[],destroy:async()=>{destroyed++;clock+=6000;}};
    },
    Optimizer:{DEFAULT_EFFORT:'complete', optimize:async(cfg,options)=>{
      assert.equal(options.effort,'complete'); clock+=2000;
      return {best:fault==='empty'?null:{},evals:1,diag:{profile:{settings:{effort:fault==='effort'?'fast':'complete'}}}};
    }},
  };
  await vm.runInNewContext(source,{
    require:name=>{assert.equal(name,'./harness.js');return H;},
    process:{argv:['node','gate',`--ceiling=${fault==='startup'?2.5:fault==='invalid'?'NaN':4}`],exit:code=>exits.push(code)},
    performance:{now:()=>clock},console:{log:(...args)=>output.push(args.join(' ')),error:error=>output.push(String(error))},
  });
  assert.equal(destroyed,started,'every started pool must be destroyed, even on failure');
  return {exits,output:output.join('\n')};
}
(async()=>{
  assert.deepEqual((await run(null)).exits,[]);
  for(const fault of ['startup','workers','empty','effort','invalid']) {
    assert((await run(fault)).exits.includes(1),`known-bad timing setup accepted: ${fault}`);
  }
  console.log('PASS runtime ceiling controls: ready-pool success; startup overrun, wrong workers/effort, empty result and NaN ceiling rejected');
})().catch(error=>{console.error(error);process.exitCode=1;});
