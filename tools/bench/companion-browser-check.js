'use strict';
// Integration gate against the REAL site in an isolated Chromium profile. It loads the unpacked
// extension, not copied scripts in the page world, so world isolation and CSS are exercised too.
const {chromium} = require('playwright');
const path = require('path');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'cifi-routing-test-'));
  const extension = path.resolve(__dirname,'../../extension');
  const context = await chromium.launchPersistentContext(profile, {
    headless:true, channel:'chromium',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
    viewport:{width:1440,height:1000},
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => {errors.push(e.message); console.log('pageerror:',e.stack);});
  page.on('console', m => { if (m.type()==='error') console.log('browser:',m.text()); });
  try {
    await page.goto('https://cifi-tools.com/upgrades/gems');
    console.log('Loaded',page.url());
    await page.waitForFunction(() => document.documentElement.dataset.cifiRouterReady === 'true',{},{timeout:30000});
    await page.getByRole('heading',{name:'Gems',exact:true}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/upgrades/gems');
    assert.equal(await page.locator('[data-cifi-companion-page]').count(),0);
    assert.equal(await page.locator('aside:visible').count(),0,'extension must not add a sidebar to a native route');
    for (const label of ['Gadgets','Researches','Construction Milest.','Trinkets']) {
      assert.equal(await page.locator('aside').getByRole('link',{name:label,exact:true}).count(),0,`${label} must be filtered by native progression`);
    }
    console.log('PASS native Gems is untouched on direct load');
    if (process.argv.includes('--negative-control')) {
      // Reproduce the reported symptom; this must trip the same visible-page assertion below.
      await page.addStyleTag({content:'main { display:none !important; }'});
      await page.getByRole('heading',{name:'Gems',exact:true}).waitFor({state:'visible',timeout:1000});
      throw new Error('Negative control failed to detect blank Gems');
    }
    for (const [name,id,pathname] of [
      ['Hunters','sim','/companion/hunters'],
      ['Fleet','fleet','/companion/fleet'],
      ['Ship Setup','ships','/companion/ships'],['Gear Sets','gear','/companion/gear'],
      ['Research','research','/companion/research'],['Academy Badges','badges','/companion/badges'],
    ]) {
      const directLink = page.getByRole('link',{name,exact:true}).first();
      if (await directLink.count()) await directLink.click();
      else await page.goto('https://cifi-tools.com'+pathname);
      await page.locator(`[data-cifi-companion-page="${id}"]`).waitFor();
      await page.waitForFunction(() => document.querySelector('[data-cifi-companion-page]')?.textContent.length > 20);
      const body = await page.locator('[data-cifi-companion-page]').innerText();
      assert(!body.includes('Unable to render'),body.slice(0,300));
      assert.equal(await page.locator('aside:visible').count(),1);
      if (id !== 'fleet' && id !== 'sim') {
        const active = page.locator('aside').getByRole('link',{name,exact:true});
        assert.equal(await active.getAttribute('aria-current'),'page','native RouterLink marks the added destination active');
        assert.equal(await active.locator('svg').count(),1,'native icon is retained');
        assert.notEqual(await page.locator('aside a[href="/upgrades/relics"]').getAttribute('aria-current'),'page');
      }
      const toolUrl = page.url();
      await page.reload();
      await page.locator(`[data-cifi-companion-page="${id}"]`).waitFor();
      assert.equal(page.url(),toolUrl,'refresh preserves added route');
      await page.getByRole('link',{name:'Gems',exact:true}).first().click();
      await page.getByRole('heading',{name:'Gems',exact:true}).waitFor();
      assert.equal(new URL(page.url()).pathname,'/upgrades/gems');
      assert.equal(new URL(page.url()).hash,'');
      assert.equal(await page.locator('[data-cifi-companion-page]').count(),0);
      await page.goBack();
      await page.locator(`[data-cifi-companion-page="${id}"]`).waitFor();
      await page.goForward();
      await page.getByRole('heading',{name:'Gems',exact:true}).waitFor();
      console.log(`PASS ${name} -> native Gems`);
    }
    // Change the real Pinia store in this disposable account and verify the native sidebar's
    // own reactive gating. Full companion serialization is covered separately below.
    for (const level of [4,0]) {
      await page.evaluate(level => {
        const app=document.querySelector('#app').__vue_app__;
        const pinia=Reflect.ownKeys(app._context.provides).map(key=>app._context.provides[key]).find(value=>value?._s?.get);
        const gems=pinia._s.get('gemPlanner');
        gems.gemStates.exodus={...gems.gemStates.exodus,level,nodes:[false,false,false]};
        gems.saveToStorage();
      },level);
      await page.waitForFunction(level => {
        const links=[...document.querySelectorAll('aside a')];
        return links.some(a=>a.textContent.trim()==='Gadgets') === (level===4);
      },level);
      for (const [destination,pathname] of [['Fleet','/companion/fleet']]) {
        await page.goto('https://cifi-tools.com'+pathname);
        await page.waitForFunction(()=>document.documentElement.dataset.cifiRouterReady==='true');
        await page.locator('aside.cifi-native-sidebar').waitFor({state:'visible'});
        assert.equal(await page.locator('aside:visible').getByRole('link',{name:'Gadgets',exact:true}).count(),level===4?1:0,destination);
      }
      console.log(`PASS imported Exodus ${level}: reactive gates survive navigation`);
    }
    await page.getByRole('link',{name:'Settings',exact:true}).first().click();
    // Use the actual native toggle, not a private companion setting.
    const toggle = page.getByRole('heading',{name:'Upgrades Sidebar in Hunter View',exact:true}).locator('..').locator('..').getByRole('button');
    await toggle.click();
    await page.getByRole('link',{name:'Fleet',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector('.cifi-native-sidebar')?.hidden === true);
    assert.equal(await page.locator('aside:visible').count(),0,'native preference hides companion sidebar');
    await page.getByRole('link',{name:'Settings',exact:true}).first().click();
    await toggle.click();
    await page.getByRole('link',{name:'Fleet',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector('.cifi-native-sidebar')?.hidden === false);
    assert.equal(await page.locator('aside:visible').count(),1);
    console.log('PASS native Settings toggle controls persistent sidebar');
    assert.equal(await page.locator('aside.cifi-native-sidebar > #bridgeStatusSidebar').count(),1,
      'bridge status must be a child of the one native sidebar, not a second layout sibling');
    for (const destination of ['/upgrades/relics','/upgrades/inscryptions','/borge','/home']) {
      await page.goto('https://cifi-tools.com'+destination);
      await page.waitForFunction(()=>document.documentElement.dataset.cifiRouterReady==='true');
      assert.equal(new URL(page.url()).pathname,destination);
      assert.equal(await page.locator('.cifi-native-sidebar:visible').count(),0,'companion sidebar stays off native routes');
      assert((await page.locator('aside:visible').count()) <= 1,'native route must never have overlapping sidebars');
      assert.equal(await page.locator('[data-cifi-companion-page]').count(),0);
      await page.getByRole('link',{name:'Fleet',exact:true}).first().click();
      await page.locator('[data-cifi-companion-page="fleet"]').waitFor();
      await page.getByRole('link',{name:'Gems',exact:true}).first().click();
      await page.getByRole('heading',{name:'Gems',exact:true}).waitFor();
      console.log(`PASS native ${destination} -> Fleet -> Gems`);
    }
    // Full Hunter product contract. The standalone implementation is authoritative: one header
    // destination, three in-page hunter tabs, its complete toolbar/card workflow, an editable
    // level, Effective Path, and the optimizer in the Build Creator footer.
    await page.goto('https://cifi-tools.com/companion/hunters');
    await page.waitForFunction(()=>document.documentElement.dataset.cifiRouterReady==='true');
    await page.locator('[data-cifi-companion-page="sim"]').waitFor();
    assert.equal(await page.locator('header nav a[href="/borge"]:visible,header nav a[href="/ozzy"]:visible,header nav a[href="/knox"]:visible').count(),0,
      'three native Hunter header destinations must be replaced by one Hunters destination');
    for (const [label,id] of [['Borge','hunterBorgeBtn'],['Ozzy','hunterOzzyBtn'],['Knox','hunterKnoxBtn']]) assert.equal(
      await page.locator(`#${id}`).count(),1,`${label} hunter tab must exist`);
    for (const label of ['Borge Stats','New Build','Import','Filter','Manage Categories','Vertical','Horizontal','Temporary Upgrades']) {
      await page.getByRole('button',{name:label,exact:true}).waitFor();
    }
    await page.getByRole('button',{name:'New Build',exact:true}).click();
    const level=page.locator('#levelInput');
    await level.waitFor();
    await level.fill('27');
    assert.equal(await level.inputValue(),'27','Build Creator level must accept direct typing');
    await page.getByRole('button',{name:/Optimize within this budget/}).waitFor();
    await page.locator('#buildNameInput').fill('Parity Contract');
    await page.getByRole('button',{name:'Save Build',exact:true}).click();
    await page.getByRole('heading',{name:'Parity Contract',exact:true}).waitFor();
    const persistence=await page.evaluate(async()=>({
      native:JSON.parse(localStorage.getItem('hunter-data')).hunterBuilds.borge.some(build=>build.name==='Parity Contract'),
      companion:localStorage.getItem('cifi-companion:store'),
      oldScan:localStorage.getItem('huntersim_last_scan'),
      dbs:(await indexedDB.databases()).map(db=>db.name),
      resources:JSON.parse(document.getElementById('cifi-companion-navigation').dataset.resourceAssets),
    }));
    assert.equal(persistence.native,true,'build must be persisted by native hunter-data');
    assert.equal(persistence.companion,null,'parallel companion localStorage must not exist');
    assert.equal(persistence.oldScan,null,'scan state must not use a second localStorage key');
    assert(!persistence.dbs.includes('cifi-companion-backup'),'parallel companion IndexedDB must not exist');
    assert.equal(new Set(Object.values(persistence.resources).flatMap(icons=>[icons.mat1,icons.mat2,icons.mat3])).size,9,
      'each hunter must use its own three live-site resource images');
    await page.reload();
    await page.getByRole('heading',{name:'Parity Contract',exact:true}).waitFor();
    console.log('PASS Hunter state persists only in native Pinia and resource sets are hunter-specific');
    for (const action of ['edit','dup','overrides','compareEfficiency','buildStats','effectivePath','export','archive','delete','screenshot','overrideCosts','reEvaluate']) {
      assert((await page.locator(`[data-act="${action}"]`).count())>0,`Hunter card action ${action} must be retained`);
    }
    await page.getByRole('heading',{name:'Parity Contract',exact:true}).click();
    await page.getByRole('button',{name:/Optimize within this budget/}).click();
    await page.locator('#optimizeEffort').selectOption('fast');
    await page.locator('#startOptimizeBtn').click();
    await page.locator('#optimizeProgressModal:not(.hidden)').waitFor();
    await page.waitForTimeout(1000);
    const cancelStarted=Date.now();
    await page.locator('#cancelOptimizeRunBtn').click();
    await page.waitForFunction(()=>document.getElementById('optimizeProgressModal').classList.contains('hidden'),{},{timeout:3000});
    assert(Date.now()-cancelStarted<3000,'Cancel must terminate active scoring without a refresh');
    console.log('PASS complete Hunter surface retained and native-worker cancellation is bounded');
    await page.locator('#closeModalBtn').click();
    await page.getByRole('link',{name:'Gems',exact:true}).first().click();
    await page.getByRole('heading',{name:'Gems',exact:true}).waitFor();
    await page.evaluate(async()=>{await Promise.all(document.getAnimations()
      .filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime))
      .map(a=>a.finished.catch(()=>{})));});
    await page.screenshot({path:path.join(profile,'native-gems.png'),fullPage:true,animations:'disabled'});
    console.log('Screenshot:',path.join(profile,'native-gems.png'));
    assert.deepEqual(errors,[],'uncaught browser errors');
  } catch(error) {
    console.log('Sidebar:',await page.evaluate(()=>({preference:localStorage.getItem('huntersim_hunter_sidebar'),layout:document.querySelector('.cifi-native-sidebar')?.outerHTML})));
    console.log('DOM:',(await page.locator('body').innerText()).slice(0,700));
    console.log('App:',await page.evaluate(()=>({app:!!document.getElementById('app')?.__vue_app__,instance:!!document.getElementById('app')?.__vue_app__?._instance, scripts:[...document.scripts].map(s=>({type:s.type,src:s.src}))})));
    throw error;
  } finally { await context.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
