'use strict';
// Exercise the real save mapper and import handler: rendering another hunter must not be
// required to persist account-wide eligibility for its advanced talent.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const H = require('./harness.js');
const sb = H.browserSandbox();
const app = fs.readFileSync(path.join(__dirname, '../../webapp/public/app.js'), 'utf8');

function functionSource(name, nextMarker) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = app.indexOf(nextMarker, start);
  assert.notEqual(end, -1, `${name} end marker must exist`);
  return app.slice(start, end);
}
const helper = functionSource('shouldShowAdvancedTalents', '\nfunction renderTalents(');
const importer = functionSource('processImportedSaveText', '\n// Small transient toast');
const account = functionSource('accountStateFor', '\nfunction evalStateFor(');

function fixture({ disabled = false, manual = false, broken = false } = {}) {
  const store = sb.StoreSchema.freshStore();
  store.settings.advancedTalents.borge = manual;
  store.settings.advancedTalents.ozzy = manual;
  const categories = Object.fromEntries(Object.keys(sb.StoreSchema.defaultImportPrefs().categories).map(k => [k, false]));
  categories.hunterBuilds = !disabled;
  const persisted = [];
  let id = 0;
  const ctx = vm.createContext({
    window: { HUNTER_DEFS: sb.HUNTER_DEFS, AccountState: sb.AccountState,
      decodeCifiSaveText: async raw => JSON.parse(raw), mapCifiSaveToStore: sb.mapCifiSaveToStore },
    store, EMBEDDED: false,
    getImportPrefs: () => ({ categories, quiet: true }),
    saveStore: () => persisted.push(JSON.parse(JSON.stringify(store))),
    render() {}, renderImportSaveResult() {}, showImportToast() {},
    newDraftBuild: () => ({ id: null, name: '', level: 1, talents: {}, attributes: {}, overrides: {} }),
    genBuildId: () => `scan-${++id}`,
  });
  // Remove only the new detection inside the import path. Keep the canonical helper intact,
  // so the negative control reproduces the old dependency on a later render/account-state read.
  const importSource = broken ? importer.replace(/shouldShowAdvancedTalents\(([^)]*)\)/g, 'false') : importer;
  vm.runInContext(`${helper}\n${account}\nasync ${importSource}`, ctx);
  return { ctx, store, persisted, import: save => ctx.processImportedSaveText(JSON.stringify(save), true) };
}

async function positive(broken = false) {
  const f = fixture({ broken });
  await f.import({ BorgeLevel: 80, OzzyLevel: 60, BorgeSkill8Level: 5, OzzySkill8Level: 3 });
  for (const [hunter, points] of [['borge', 5], ['ozzy', 3]]) {
    assert.equal(f.store[hunter].builds.find(b => /Scanned/.test(b.name)).talents.ultima, points, `${hunter} Skill8 mapping`);
    assert.equal(f.store.settings.advancedTalents[hunter], true, `${hunter} import must immediately enable advanced talents`);
    assert.equal(f.persisted.at(-1).settings.advancedTalents[hunter], true, `${hunter} eligibility must be persisted`);
    const zero = { level: 60, talents: { ultima: 0 }, attributes: {}, overrides: {} };
    const cfg = sb.AccountState.optimizerCfg(f.ctx.accountStateFor(hunter, zero));
    assert(cfg.TALENTS.some(t => t.id === 'ultima'), `${hunter} optimizer must offer Ultima to a zero-point build after import`);
  }
}

(async () => {
  await positive();
  for (const save of [{ BorgeSkill8Level: 0, OzzySkill8Level: 0 }, {}]) {
    const f = fixture();
    await f.import(save);
    assert.equal(f.store.settings.advancedTalents.borge, false);
    assert.equal(f.store.settings.advancedTalents.ozzy, false);
  }
  const manual = fixture({ manual: true });
  await manual.import({ BorgeSkill8Level: 0, OzzySkill8Level: 0 });
  assert.equal(manual.store.settings.advancedTalents.borge, true);
  assert.equal(manual.store.settings.advancedTalents.ozzy, true);

  const updated = fixture();
  await updated.import({ BorgeLevel: 80, OzzyLevel: 60, BorgeSkill8Level: 0, OzzySkill8Level: 0 });
  const ids = ['borge', 'ozzy'].map(h => updated.store[h].builds.find(b => /Scanned/.test(b.name)).id);
  await updated.import({ BorgeLevel: 80, OzzyLevel: 60, BorgeSkill8Level: 4, OzzySkill8Level: 2 });
  for (const [i, hunter] of ['borge', 'ozzy'].entries()) {
    assert.equal(updated.store[hunter].builds.find(b => /Scanned/.test(b.name)).id, ids[i], 'update must retain the scanned build');
    assert.equal(updated.store.settings.advancedTalents[hunter], true, `${hunter} updated scan must enable advanced talents`);
  }

  const unchanged = fixture();
  const save = { BorgeLevel: 80, OzzyLevel: 60, BorgeSkill8Level: 5, OzzySkill8Level: 3 };
  await unchanged.import(save);
  unchanged.store.settings.advancedTalents.borge = false;
  unchanged.store.settings.advancedTalents.ozzy = false;
  unchanged.persisted.length = 0;
  await unchanged.import(save);
  assert(unchanged.persisted.length > 0, 'unchanged scanned build must persist newly detected eligibility');
  assert.equal(unchanged.persisted.at(-1).settings.advancedTalents.borge, true);
  assert.equal(unchanged.persisted.at(-1).settings.advancedTalents.ozzy, true);

  const disabled = fixture({ disabled: true });
  await disabled.import(save);
  assert.equal(disabled.store.settings.advancedTalents.borge, false);
  assert.equal(disabled.store.settings.advancedTalents.ozzy, false);
  await assert.rejects(() => positive(true), /import must immediately enable advanced talents/);
  console.log('PASS save Skill8 eligibility, zero/missing inputs, manual preferences, unchanged scans, disabled imports, optimizer eligibility and known-bad control');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
