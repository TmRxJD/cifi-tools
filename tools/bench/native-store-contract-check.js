'use strict';
const {chromium}=require('playwright');
const path=require('path');
const fs=require('fs');
const os=require('os');
(async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'cifi-native-store-'));
  const extension=path.resolve(__dirname,'../../extension');
  const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try {
    const page=await context.newPage();
    await page.goto('https://cifi-tools.com/home');
    await page.waitForFunction(()=>document.documentElement.dataset.cifiRouterReady==='true');
    const contract=await page.evaluate(async()=>{
      const script=[...document.scripts].find(s=>s.type==='module' && /\/assets\/index-[^/]+\.js$/.test(s.src));
      const native=await import(script.src); if(native.__tla) await native.__tla;
      const resourceCandidates=[];
      const seen=new WeakSet();
      const visit=(value,path,depth)=>{
        if(!value || typeof value!=='object' || seen.has(value) || depth>4) return;
        seen.add(value);
        const entries=Object.entries(value);
        const images=entries.filter(([,v])=>typeof v==='string' && /loot_mat[123]-/.test(v));
        if(images.length) resourceCandidates.push({path,entries:images});
        for(const [key,child] of entries) visit(child,`${path}.${key}`,depth+1);
      };
      for(const [key,value] of Object.entries(native)) visit(value,key,0);
      const app=document.querySelector('#app').__vue_app__;
      const pinia=Reflect.ownKeys(app._context.provides).map(k=>app._context.provides[k])
        .find(v=>v?._s?.get);
      const summarize=id=>{const s=pinia._s.get(id);return {id,state:Object.keys(s.$state),
        actions:Object.keys(s).filter(k=>typeof s[k]==='function').sort()};};
      const hunter=pinia._s.get('hunter');
      for(const id of ['borge','ozzy','knox']) await hunter.initHunterConfig(id);
      return {resourceCandidates,hunter:summarize('hunter'),gems:summarize('gemPlanner'),hunterState:{
        hunterStats:hunter.hunterStats,upgrades:hunter.upgrades,hunterBuilds:hunter.hunterBuilds,
        hunterIterations:hunter.hunterIterations,displaySettings:hunter.displaySettings,
        hunterLevelSettings:hunter.hunterLevelSettings,buildCategories:hunter.buildCategories,
      }};
    });
    console.log(JSON.stringify(contract,null,2));
    await page.evaluate(()=>{
      const app=document.querySelector('#app').__vue_app__;
      const pinia=Reflect.ownKeys(app._context.provides).map(k=>app._context.provides[k]).find(v=>v?._s?.get);
      const hunter=pinia._s.get('hunter');
      hunter.$patch({cifiCompanion:{contractProbe:137}});
      hunter.$persist();
    });
    await page.reload();
    const persisted=await page.evaluate(()=>JSON.parse(localStorage.getItem('hunter-data')).cifiCompanion?.contractProbe);
    if(persisted!==137) throw new Error('native Pinia persistence discarded expanded state');
    console.log('PASS native Pinia persists expanded companion state');
  } finally {await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
