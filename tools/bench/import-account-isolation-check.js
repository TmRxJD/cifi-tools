'use strict';
// Run the actual import/save handlers through both script worlds with a native account that
// changes after the companion loads. Static "import has no assignments" checks missed this.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const H = require('./harness.js');
const sb = H.browserSandbox();
const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'webapp/public/app.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'extension/hostStoreBridge.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function section(start, end) {
  const a = app.indexOf(start), b = app.indexOf(end, a);
  assert(a >= 0 && b > a, `missing source section ${start}`);
  return app.slice(a, b);
}
function fixture(broken = false) {
  const initial = clone(sb.StoreSchema.freshStore());
  initial.borge.hunterStats.hp = 15;
  initial.globalUpgrades['relics.r4'] = 2;
  initial.gems.exodus = { level: 4, nodes: [], upgrades: {} };
  initial.borge.builds.push({ id: 'existing', name: 'Keep me', level: 1, talents: {}, attributes: {}, overrides: {}, results: { lootPerMin: 123 } });
  const hunter = { $state: {}, hunterBuilds: {}, hunterStats: {}, hunterIterations: {}, upgrades: {}, $patch(extra) { Object.assign(this.$state, extra); }, $persist() {} };
  const gems = { gemStates: {}, saveToStorage() {} };
  const elements = new Map();
  const listeners = new Map();
  const append = el => { elements.set(el.id, el); return el; };
  const nativeApp = { _context: { provides: { pinia: { _s: new Map([['hunter', hunter], ['gemPlanner', gems]]) } } } };
  const document = {
    querySelector: () => ({ __vue_app__: nativeApp }),
    getElementById: id => elements.get(id) || null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    documentElement: { appendChild: append }, body: { appendChild: append },
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
  };
  const Event = class { constructor(type) { this.type = type; } };
  const host = vm.createContext({ document, console, Event, localStorage: { getItem: () => null }, indexedDB: {} });
  let hostSource = bridge;
  if (broken) {
    const start = hostSource.indexOf("    if (typeof incoming.expectedHostState");
    const end = hostSource.indexOf('    applyCanonicalStore(hunter,gems,incoming.state);', start);
    assert(start >= 0 && end > start);
    hostSource = hostSource.slice(0, start) + hostSource.slice(end);
  }
  vm.runInContext(hostSource, host);
  host.applyCanonicalStore(hunter, gems, initial);
  host.publishHostState();
  append({ id: 'buildNameInput', value: 'Imported safely' });
  append({ id: 'updateBuildBtn' });
  let ctx;
  let nextId = 0;
  const window = { StoreSchema: sb.StoreSchema };
  ctx = vm.createContext({
    window, document, console, Event, EMBEDDED: true, __embeddedStorePending: false,
    embeddedHostSnapshot: null, freshStore: sb.StoreSchema.freshStore, dedupeStoreIds() {},
    currentHunter: 'borge', showCategoryId: 'active', editingHunter: 'borge', editingBuild: null,
    defs: () => sb.HUNTER_DEFS[ctx.currentHunter],
    accountLevel: (hunterId, key) => key.startsWith('upgrades.') ? (ctx.store.globalUpgrades[key.slice(9)] ?? 0) : (ctx.store[hunterId].hunterStats[key] ?? 0),
    openBuildModal(build) { ctx.editingBuild = clone(build); ctx.editingHunter = ctx.currentHunter; },
    genBuildId: () => `new-${++nextId}`,
    resetImportModal() {}, showImportToast() {}, paintImportModal() {}, switchHunter() {},
    closeBuildModal() {}, renderCategoryTabs() {}, renderBuildList() {}, updateNavGating() {},
  });
  vm.runInContext(section('function storeFromHostState()', '\n// True while the embedded store'), ctx);
  ctx.store = ctx.storeFromHostState();
  vm.runInContext(section('window.refreshStoreFromNative =', '\n// One-time startup recovery'), ctx);
  vm.runInContext(section('function saveStore()', '\n// Fleet pages'), ctx);
  vm.runInContext(section('function newDraftBuild()', '\n// THE canonical purchase-path'), ctx);
  vm.runInContext(section('function applyImportedBuild(', "\ndocument.getElementById('importBuildOnlyBtn')"), ctx);
  vm.runInContext(section("document.getElementById('updateBuildBtn').onclick", "\ndocument.getElementById('closeModalBtn')"), ctx);
  return { ctx, host, hunter, gems, elements };
}
async function run() {
  const code = 'EEMxgAMCXRjy2j6Nd5h5pcvcC6H229wvGwZ5fhn2fft93rGCWPtdxXn1dBf3kKEZmP28LRf5QGbecSgSdm6HVuJkmZTfV';
  const payload = await sb.parseBuildCode(code);
  const buildOnly = fixture();
  const buildOnlyBefore = clone({ stats: buildOnly.hunter.hunterStats, upgrades: buildOnly.hunter.upgrades, gems: buildOnly.gems.gemStates, builds: buildOnly.hunter.hunterBuilds });
  buildOnly.ctx.applyImportedBuild(payload, false);
  assert.deepEqual(clone(buildOnly.ctx.editingBuild.overrides), {}, 'Import Build Only must open without any overrides');
  assert.deepEqual(clone(buildOnly.ctx.editingBuild.talents), clone(payload.talents));
  assert.deepEqual(clone(buildOnly.ctx.editingBuild.attributes), clone(payload.attributes));
  buildOnly.elements.get('updateBuildBtn').onclick();
  assert.deepEqual(clone({ stats: buildOnly.hunter.hunterStats, upgrades: buildOnly.hunter.upgrades, gems: buildOnly.gems.gemStates }),
    { stats: buildOnlyBefore.stats, upgrades: buildOnlyBefore.upgrades, gems: buildOnlyBefore.gems }, 'Import Build Only must preserve the account on save');
  assert.deepEqual(clone(buildOnly.hunter.hunterBuilds.borge[0]), buildOnlyBefore.builds.borge[0]);
  assert.equal(buildOnly.hunter.hunterBuilds.borge.length, 2);
  assert.deepEqual(clone(buildOnly.hunter.hunterBuilds.borge[1].overrides), {}, 'saved Import Build Only must have no overrides');
  const f = fixture();
  f.hunter.hunterStats.borge.hp = 88;
  f.hunter.upgrades.relics.r4 = 7;
  f.hunter.upgrades.inscryptions = { i88: 3 };
  assert(payload.carriedUpgradeKeys.includes('upgrades.inscryptions.i88'), 'real code must carry the zero-upgrade test key');
  assert.equal(payload.upgradeOverrides['upgrades.inscryptions.i88'] ?? 0, 0, 'real code must encode zero for the test key');
  const originalBuild = clone(f.hunter.hunterBuilds.borge[0]);
  const account = () => clone({stats:f.hunter.hunterStats,upgrades:f.hunter.upgrades,gems:f.gems.gemStates});
  const beforeImport = account();
  f.ctx.applyImportedBuild(payload, true);
  assert.deepEqual(account(), beforeImport, 'all account levels must remain unchanged on import');
  assert.equal(f.hunter.hunterStats.borge.hp, 88, 'opening import must not overwrite native stats');
  assert.equal(f.ctx.editingBuild.overrides.hp, payload.overrides.hp);
  assert.equal(f.ctx.editingBuild.overrides['upgrades.relics.r4'], payload.upgradeOverrides['upgrades.relics.r4']);
  assert.equal(f.ctx.editingBuild.overrides['upgrades.inscryptions.i88'], 0, 'encoded zero must override the nonzero account level');
  // Another native edit while the creator is open must also survive saving the import.
  f.hunter.hunterStats.borge.hp = 99;
  f.hunter.upgrades.relics.r4 = 8;
  f.hunter.hunterBuilds.borge.push({ ...originalBuild, id: 'native-added', name: 'Added while draft open' });
  const beforeSave = account();
  f.elements.get('updateBuildBtn').onclick();
  assert.deepEqual(account(), beforeSave, 'all account levels must remain unchanged on save');
  assert.equal(f.hunter.hunterStats.borge.hp, 99);
  assert.equal(f.hunter.upgrades.relics.r4, 8);
  assert.deepEqual(clone(f.hunter.hunterBuilds.borge[0]), originalBuild);
  assert.equal(f.hunter.hunterBuilds.borge.length, 3);
  assert.equal(f.hunter.hunterBuilds.borge[1].id, 'native-added');
  assert.equal(f.hunter.hunterBuilds.borge[2].overrides.hp, payload.overrides.hp);
  assert.equal(f.hunter.hunterBuilds.borge[2].overrides['upgrades.inscryptions.i88'], 0, 'encoded zero must survive saving');
  // A different real code must add a second card without changing the first card or account.
  const secondPayload = await sb.parseBuildCode('2gtWM2cw3G1rc6ejDzAJTm1Yk7Kt212cW8w5E1R3efugcPnbYzpocBUeK1');
  const beforeSecondImport = account();
  const beforeSecondBuilds = clone(f.hunter.hunterBuilds);
  f.ctx.applyImportedBuild(secondPayload, true);
  assert.deepEqual(account(), beforeSecondImport, 'second import must preserve the account while opening');
  assert.equal(f.ctx.editingBuild.overrides.hp, secondPayload.overrides.hp);
  assert.equal(f.ctx.editingBuild.overrides['upgrades.relics.r4'], 0, 'second code zero must override the nonzero account relic');
  f.elements.get('updateBuildBtn').onclick();
  assert.deepEqual(account(), beforeSecondImport, 'second import must preserve the account on save');
  assert.deepEqual(clone(f.hunter.hunterBuilds.borge.slice(0, 3)), beforeSecondBuilds.borge, 'second import must preserve every existing card');
  assert.equal(f.hunter.hunterBuilds.borge.length, 4);
  assert.equal(f.hunter.hunterBuilds.borge[3].overrides.hp, secondPayload.overrides.hp);
  assert.equal(f.hunter.hunterBuilds.borge[3].overrides['upgrades.relics.r4'], 0);
  assert.notEqual(f.hunter.hunterBuilds.borge[3].id, f.hunter.hunterBuilds.borge[2].id, 'successive imports must receive distinct ids');
  // After the successful write, refresh the cached projection and change native account state.
  f.ctx.window.refreshStoreFromNative();
  f.hunter.hunterStats.borge.hp = 100;
  assert.throws(() => f.ctx.saveStore(), /Native account changed/);
  assert.equal(f.hunter.hunterStats.borge.hp, 100, 'rejected stale write leaves account intact');
  // Known-bad control: remove the bridge guard and prove an unchanged stale cache overwrites HP.
  const bad = fixture(true);
  bad.hunter.hunterStats.borge.hp = 100;
  bad.ctx.saveStore();
  assert.notEqual(bad.hunter.hunterStats.borge.hp, 100, 'negative control must reproduce account overwrite');
  console.log('PASS import/account isolation: real codes, build-only without overrides, successive imports, encoded zero upgrades, native stats/upgrades, existing builds, in-flight native edits, stale-write refusal and known-bad overwrite control');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
