'use strict';
// Invariant tests for the store schema (webapp/public/storeSchema.js).
//
// Runs the SHIPPED module under Node, same as the optimizer benchmark does, so what is asserted
// here is what the app enforces. Exits non-zero on any failure.
//
//   node tools/bench/schema-test.js

const H = require('./harness.js');

const sb = H.browserSandbox();
const S = sb.StoreSchema;

let failures = 0;
function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.message}`);
    failures++;
  }
}

const eq = (a, b, label) => (a === b ? null : `${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

check('a fresh store satisfies its own invariants', () => {
  const problems = S.validateStore(S.freshStore());
  return problems.length ? problems.join('; ') : null;
});

check('a fresh store has every schema key', () => {
  const fresh = S.freshStore();
  const missing = Object.keys(S.SCHEMA).filter((k) => !(k in fresh));
  return missing.length ? `missing ${missing.join(', ')}` : null;
});

check('every hunter gets seeded stats for exactly its own baseStatKeys', () => {
  for (const h of S.HUNTERS) {
    const seeded = Object.keys(S.seedHunterStats(h)).sort();
    const expected = [...new Set([...sb.HUNTER_DEFS[h].baseStatKeys, 'stage'])].sort();
    if (seeded.join(',') !== expected.join(',')) return `${h}: ${seeded.join(',')} vs ${expected.join(',')}`;
  }
  return null;
});

check('an empty object migrates to a complete, valid store', () => {
  const { store } = S.migrateStore({});
  const missing = Object.keys(S.SCHEMA).filter((k) => !(k in store));
  if (missing.length) return `still missing ${missing.join(', ')}`;
  const problems = S.validateStore(store);
  return problems.length ? problems.join('; ') : null;
});

check('migration never overwrites existing user data', () => {
  const before = { viewMode: 'horizontal', borge: { hunterStats: { hp: 999 }, builds: [{ id: 'a', name: 'keep', level: 3, talents: {}, attributes: {} }] } };
  const { store } = S.migrateStore(JSON.parse(JSON.stringify(before)));
  return eq(store.viewMode, 'horizontal', 'viewMode')
    || eq(store.borge.hunterStats.hp, 999, 'hunterStats.hp')
    || eq(store.borge.builds.length, 1, 'builds.length')
    || eq(store.borge.builds[0].name, 'keep', 'build name');
});

check('deep fields gain newly-added sub-keys without losing existing ones', () => {
  const { store } = S.migrateStore({ importPrefs: { categories: { relics: false }, autoPoll: true } });
  return eq(store.importPrefs.categories.relics, false, 'existing sub-key preserved')
    || eq(store.importPrefs.autoPoll, true, 'existing key preserved')
    || eq(store.importPrefs.categories.gems, true, 'new sub-key filled')
    || eq(store.importPrefs.quiet, false, 'new key filled');
});

check('retired keys are dropped', () => {
  const { store, removed } = S.migrateStore({ currentLoadout: { name: 'old' } });
  return eq('currentLoadout' in store, false, 'currentLoadout removed')
    || eq(removed.includes('currentLoadout'), true, 'reported as removed');
});

check('migration is idempotent', () => {
  const once = S.migrateStore({});
  const twice = S.migrateStore(JSON.parse(JSON.stringify(once.store)));
  return eq(twice.changed, false, 'second migration reports no change');
});

check('over-budget talent spend is rejected', () => {
  const store = S.freshStore();
  store.borge.builds.push({ id: 'b', name: '', level: 2, talents: { impeccable: 9 }, attributes: {} });
  const problems = S.validateStore(store);
  return problems.some((p) => /talent points, budget is 2/.test(p)) ? null : `not caught: ${problems.join('; ')}`;
});

check('an attribute above its max level is rejected', () => {
  const store = S.freshStore();
  store.borge.builds.push({ id: 'b', name: '', level: 90, talents: {}, attributes: { ares: 1, ylith: 1, spartan: 99 } });
  const problems = S.validateStore(store);
  return problems.some((p) => /spartan/.test(p)) ? null : `not caught: ${problems.join('; ')}`;
});

check('a dependency-gated attribute with its parent at zero is rejected', () => {
  const store = S.freshStore();
  // timeless requires spartan, which requires ylith, which requires ares.
  store.borge.builds.push({ id: 'b', name: '', level: 40, talents: {}, attributes: { timeless: 5 } });
  const problems = S.validateStore(store);
  return problems.some((p) => /timeless/.test(p)) ? null : `not caught: ${problems.join('; ')}`;
});

check('a tier-threshold violation is rejected', () => {
  const store = S.freshStore();
  // atlas carries minValue 75: it needs 75 points spent in lower tiers, which this build lacks.
  store.borge.builds.push({ id: 'b', name: '', level: 40, talents: {}, attributes: { ares: 1, htb: 1, exp: 1, sensors: 0, baal: 1, atlas: 1 } });
  const problems = S.validateStore(store);
  return problems.some((p) => /atlas/.test(p)) ? null : `not caught: ${problems.join('; ')}`;
});

check('a legal allocation passes', () => {
  const store = S.freshStore();
  store.borge.builds.push({
    id: 'b', name: '', level: 12,
    talents: { revival: 2, impeccable: 10 },
    attributes: { ares: 1, ylith: 1, spartan: 1, timeless: 4, htb: 1, lfin: 9 },
  });
  const problems = S.validateStore(store);
  return problems.length ? problems.join('; ') : null;
});

// Borge's Call Me Lucky Loot is the one node in the game with a non-constant cap: Attraction
// gem node 2 raises it 10 -> 12. Ported verbatim from the live bundle's getMaxValue, and
// confirmed against two real fixtures whose recorded Loot Score only reproduces at ll=12.
check('the dynamic Lucky Loot cap follows the live rule', () => {
  const capWith = (ctx) => sb.resolveMaxLevels(sb.HUNTER_DEFS.borge.talents, ctx).find((t) => t.id === 'll').maxLevel;
  const none = { gemPlannerStore: { gemStates: {} }, buildOverrides: {} };
  const node = { gemPlannerStore: { gemStates: { attraction: { nodes: [false, true] } } }, buildOverrides: {} };
  const override = { gemPlannerStore: { gemStates: {} }, buildOverrides: { 'upgrades.gems_nodes.attraction_gem2': 1 } };
  return eq(capWith(none), 10, 'no attraction node')
    || eq(capWith(node), 12, 'via gem node')
    || eq(capWith(override), 12, 'via build override')
    || eq(sb.resolveMaxLevels(sb.HUNTER_DEFS.ozzy.talents, node).find((t) => t.id === 'll').maxLevel, 10, "ozzy's ll is unaffected");
});

// cfgFor() sends resolved node lists to the optimizer's Web Workers via postMessage, which uses
// structured clone. A resolved node carrying a function is not cloneable, and shipping one broke
// the optimizer in the browser for the only hunter with a dynamic cap -- while every Node test
// passed, because the benchmark scores in-process and never crosses a worker boundary. Assert
// the property the workers actually require.
check('resolved node lists are plain data (structured-cloneable for postMessage)', () => {
  const ctx = { gemPlannerStore: { gemStates: { attraction: { nodes: [false, true] } } }, buildOverrides: {} };
  for (const hunter of S.HUNTERS) {
    for (const kind of ['talents', 'attributes']) {
      const resolved = sb.resolveMaxLevels(sb.HUNTER_DEFS[hunter][kind], ctx);
      const fnField = resolved.flatMap((n) => Object.entries(n)).find(([, v]) => typeof v === 'function');
      if (fnField) return `${hunter}.${kind} node carries function field "${fnField[0]}"`;
      try {
        structuredClone(resolved);
      } catch (err) {
        return `${hunter}.${kind} is not structured-cloneable: ${err.message}`;
      }
    }
  }
  return null;
});

check('a build at the raised Lucky Loot cap validates when the gem node is on', () => {
  const store = S.freshStore();
  store.gems.attraction.nodes[1] = true;
  // 2 + 5 + 12 + 15 + 15 = 49, exactly a level-49 talent budget.
  store.borge.builds.push({
    id: 'b', name: '', level: 49, categoryId: 'active', overrides: {},
    talents: { revival: 2, impeccable: 5, ll: 12, pog: 15, tfow: 15 }, attributes: {},
  });
  const problems = S.validateStore(store);
  return problems.length ? problems.join('; ') : null;
});

check('the same build is rejected when the gem node is off', () => {
  const store = S.freshStore();
  store.borge.builds.push({
    id: 'b', name: '', level: 49, categoryId: 'active', overrides: {},
    talents: { revival: 2, impeccable: 5, ll: 12, pog: 15, tfow: 15 }, attributes: {},
  });
  return S.validateStore(store).some((p) => /ll = 12 exceeds max 10/.test(p)) ? null : 'not caught';
});

// The Fleet domain owns its own store shapes; the schema names them rather than re-declaring
// them. These two checks are what stop the pair silently drifting apart again -- which is how
// `optimizerSettings.runLength` came to exist only after a UI accessor happened to run, and
// gearSets/shipGear/fleetBadges came to be declared as bare `{}` in the schema while their real
// shapes lived behind lazy getters.
check('every fleet store field the schema names has a factory in shipsPage', () => {
  const missing = Object.keys(sb.FleetStoreDefaults || {}).filter((k) => typeof sb.FleetStoreDefaults[k] !== 'function');
  return missing.length ? `not functions: ${missing.join(', ')}` : null;
});

check('a fresh store already contains the real fleet shapes, not empty objects', () => {
  const fresh = S.freshStore();
  const checks = [
    ['optimizerSettings', 'runLength'],
    ['optimizerSettings', 'shipEnabled'],
    ['gearSets', 'pieces'],
    ['fleetBadges', 'owned'],
    ['fleetBoosts', 'levels'],
    ['fleetResearch', 'levels'],
  ];
  for (const [field, key] of checks) {
    if (!fresh[field] || !(key in fresh[field])) return `fresh store's ${field} is missing "${key}"`;
  }
  if (!Object.keys(fresh.shipGear).length) return 'fresh store shipGear is empty';
  if (!Object.keys(fresh.unlockedGens).length) return 'fresh store unlockedGens is empty';
  return null;
});

// An under-spent build is a normal thing for a user to have, and it must never survive an
// optimize: unspent points are free value. Reported symptom was a level-58 Borge build coming
// back with 46 of 58 talent points still unspent.
check('spendRemaining fills idle budget, opening new nodes when it must', () => {
  const d = sb.HUNTER_DEFS.borge;
  const talents = d.talents.filter((t) => !t.advanced);
  // 46 of 58 spent, and the only remaining capacity is in nodes currently at ZERO (omen, ll) --
  // the case fillLeftover cannot handle, because it refuses to widen the support.
  const under = { revival: 2, loth: 5, ua: 5, impeccable: 10, omen: 0, ll: 0, pog: 15, tfow: 9 };
  const before = sb.AllocSpace.costOf(talents, under);
  const after = sb.AllocSpace.spendRemaining(talents, {}, {}, 58, { ...under });
  const spent = sb.AllocSpace.costOf(talents, after);
  if (before !== 46) return `fixture drifted: expected 46 spent, got ${before}`;
  if (58 - spent > sb.AllocSpace.MAX_IDLE_POINTS) {
    return `still ${58 - spent} points idle after spendRemaining: ${JSON.stringify(after)}`;
  }
  for (const t of talents) {
    if ((after[t.id] || 0) > t.maxLevel) return `${t.id} overfilled to ${after[t.id]} (max ${t.maxLevel})`;
  }
  return null;
});

check('spendRemaining respects dependency and threshold gates', () => {
  const d = sb.HUNTER_DEFS.borge;
  // Nothing invested at all: only ungated attributes may be opened, and gated ones must stay 0
  // until their prerequisites are funded.
  const alloc = {};
  d.attributes.forEach((a) => { alloc[a.id] = 0; });
  sb.AllocSpace.spendRemaining(d.attributes, d.attributeDependencies, d.attributeMinValue, 40, alloc);
  const problems = d.attributes
    .filter((a) => !sb.AllocSpace.isHeld(a, d.attributes, d.attributeDependencies, d.attributeMinValue, alloc))
    .map((a) => `${a.id}=${alloc[a.id]}`);
  if (problems.length) return `illegal after fill: ${problems.join(', ')}`;
  const spent = sb.AllocSpace.costOf(d.attributes, alloc);
  if (40 - spent > sb.AllocSpace.MAX_IDLE_POINTS) return `only spent ${spent} of 40`;
  return null;
});

check('duplicate build ids are rejected', () => {
  const store = S.freshStore();
  store.borge.builds.push({ id: 'dup', name: 'a', level: 1, talents: {}, attributes: {} },
    { id: 'dup', name: 'b', level: 1, talents: {}, attributes: {} });
  return S.validateStore(store).some((p) => /duplicates id/.test(p)) ? null : 'not caught';
});

check('a missing system category is rejected', () => {
  const store = S.freshStore();
  store.categories = store.categories.filter((c) => c.id !== 'archived');
  return S.validateStore(store).some((p) => /archived/.test(p)) ? null : 'not caught';
});

check('an invalid level is rejected', () => {
  const store = S.freshStore();
  store.borge.builds.push({ id: 'b', name: '', level: 0, talents: {}, attributes: {} });
  return S.validateStore(store).some((p) => /level is 0/.test(p)) ? null : 'not caught';
});

console.log(`\n${failures ? `${failures} FAILED` : 'all schema invariants hold'}`);
process.exit(failures ? 1 : 0);
