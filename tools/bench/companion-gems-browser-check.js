'use strict';
// Regression fixture: populated imported account, not the hand-shaped empty account used by
// the routing smoke test. Exercise the shipped mapper and host-store boundary together.
const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.resolve(__dirname,'../..');
const sandbox = vm.createContext({window:{},console});
for (const file of ['hunterDefs.js','saveImport.js']) vm.runInContext(fs.readFileSync(path.join(root,'webapp/public',file),'utf8'),sandbox);
const gems = sandbox.window.mapCifiSaveToStore({
  ExodusQualityLevel:4,TemporalQualityLevel:2,InnovationQualityLevel:1,
  AttractionQualityLevel:3,CreationQualityLevel:3,
  AttractionGU1Level:13,AttractionGU2Level:8,AttractionGU3Level:3,
  CreationGU9Level:0,CreationGU10Level:0,CreationGU11Level:0,
}).gems;
assert.equal(gems.exodus.upgrades,undefined,'fixture must retain the actual sparse importer shape');
(async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'cifi-gems-import-test-'));
  const extension=path.join(root,'extension');
  const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  try {
    await page.goto('https://cifi-tools.com/home');
    await page.waitForFunction(()=>document.documentElement.dataset.cifiRouterReady==='true');
    await page.evaluate(gems=>localStorage.setItem('gemPlanner_store',JSON.stringify({gemStates:gems})),gems);
    console.log('Testing persisted sparse import fixture: Exodus 4, Attraction 3, Creation 3');
    await page.goto('https://cifi-tools.com/upgrades/gems');
    await page.getByRole('heading',{name:'Gems',exact:true}).waitFor({timeout:10000});
    assert.equal(new URL(page.url()).pathname,'/upgrades/gems');
    assert.equal(await page.locator('main button').count()>7,true,'native gem controls rendered');
    console.log('PASS existing malformed import repaired on load; native Gems renders');
    await page.getByRole('link',{name:'Hunters',exact:true}).click();
    await page.locator('[data-cifi-companion-page="sim"]').waitFor();
    await page.evaluate(gems=>{
      const app=document.querySelector('#app').__vue_app__;
      const pinia=Reflect.ownKeys(app._context.provides).map(key=>app._context.provides[key]).find(value=>value?._s?.get);
      const planner=pinia._s.get('gemPlanner');
      for(const [tree,state] of Object.entries(gems)) planner.gemStates[tree]={...planner.gemStates[tree],...state,
        upgrades:{...planner.gemStates[tree]?.upgrades,...state.upgrades}};
      planner.saveToStorage();
    },gems);
    await page.getByRole('link',{name:'Gems',exact:true}).click();
    await page.getByRole('heading',{name:'Gems',exact:true}).waitFor({timeout:10000});
    const state=await page.evaluate(()=>JSON.parse(localStorage.getItem('gemPlanner_store')).gemStates);
    for(const [tree,original] of Object.entries(gems)) {
      assert.equal(state[tree].level,original.level);
      assert.deepEqual(state[tree].nodes,Array.from(original.nodes));
      assert.equal(typeof state[tree].upgrades,'object',`${tree}.upgrades must exist`);
    }
    assert.equal(state.attraction.upgrades['borge-loot-bonus'],13);
    console.log('PASS actual mapper -> host import -> header Gems; levels, nodes and upgrades preserved');
  } finally {await context.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
