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
