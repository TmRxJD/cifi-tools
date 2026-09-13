'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert/strict');
try {
  const root=path.resolve(__dirname,'../..');
  const source=fs.readFileSync(path.join(root,'extension/hostStoreBridge.js'),'utf8');
  const original={gemStates:{exodus:{level:4,nodes:[true,false,true]},attraction:{level:3,nodes:[true,true,true],upgrades:{'borge-loot-bonus':13,'ship-evo-bonus':7}}},gameStats:{ticks:123},gemPlans:[{name:'keep'}]};
  const raw=JSON.stringify(original);
  const storage=new Map([['gemPlanner_store',raw]]);
  const planner={gemStates:JSON.parse(raw).gemStates};
  const app={_context:{provides:{pinia:{_s:new Map([['gemPlanner',planner]])}}}};
  const context=vm.createContext({
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    document:{querySelector:()=>({__vue_app__:app}),addEventListener(){}},console,
  });
  // Known-bad control reproduces the native renderer's actual read, not synthetic hidden CSS.
  assert.throws(()=>original.gemStates.exodus.upgrades['cells-bonus'],TypeError);
  vm.runInContext(source,context);
  const repaired=JSON.parse(storage.get('gemPlanner_store'));
  assert.deepEqual(repaired,{...original,gemStates:{...original.gemStates,exodus:{...original.gemStates.exodus,upgrades:{}}}});
  assert.equal(storage.get('cifi-companion:gem-store-before-upgrades-repair'),raw);
  assert.equal(planner.gemStates.exodus.upgrades['cells-bonus'],undefined);
  assert.equal(context.repairImportedGemStates(),0,'migration is idempotent');
  assert.equal(storage.get('cifi-companion:gem-store-before-upgrades-repair'),raw,'backup is immutable');
  context.writeGemStates({attraction:{level:3,nodes:[false,true,true],upgrades:{'borge-loot-bonus':14}},exodus:{level:4,nodes:[true,true,false]}});
  const updated=JSON.parse(storage.get('gemPlanner_store'));
  assert.equal(updated.gemStates.attraction.upgrades['ship-evo-bonus'],7,'unmapped native GU fields must survive import');
  assert.equal(updated.gemStates.attraction.upgrades['borge-loot-bonus'],14);
  assert.deepEqual(updated.gemStates.exodus.upgrades,{});
  assert.deepEqual(updated.gameStats,original.gameStats);
  assert.deepEqual(updated.gemPlans,original.gemPlans);
  for(const bad of [{nodes:[]},{level:4,nodes:{}},{level:4,nodes:[],upgrades:null}]) {
    assert.throws(()=>context.mergeHostGemState('exodus',undefined,bad),/Invalid/);
  }
  console.log('PASS gem-state migration, reactive repair, partial imports, retained native fields and negative controls');
} catch(error){console.error(error);process.exitCode=1;}
