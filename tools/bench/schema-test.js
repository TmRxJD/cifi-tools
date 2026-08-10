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

// Checks register here and run in declaration order at the end, so a check may be async
// (parseBuildCode returns a promise) without reordering the output or racing.
let failures = 0;
const queued = [];
function check(name, fn) { queued.push({ name, fn }); }
async function runChecks() {
  for (const { name, fn } of queued) {
    try {
      const problem = await fn();
      if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
      else console.log(`pass  ${name}`);
    } catch (err) {
      console.log(`FAIL  ${name}\n        threw: ${err.message}`);
      failures++;
    }
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

// Optimize modes live in ONE table (optimizer/objective.js) that the search, the browser
// workers and this harness all score through. These lock the contract of the boss objectives,
// which are lexicographic rather than a weighted blend.
check('every optimize mode scores and is self-consistent', () => {
  const Obj = sb.OptimizerObjective;
  const modes = Object.keys(Obj.MODES);
  if (!modes.includes('loot') || !modes.includes('push')) return 'the original modes went missing';
  if (!modes.includes('boss') || !modes.includes('bossTimeless')) return 'boss modes not registered';
  const sample = { lootPerMin: 1e6, avgStage: 200, bossKillRate: 50, bossHpPercent: 1 };
  for (const m of modes) {
    const v = Obj.scoreFor(m, sample);
    if (!Number.isFinite(v)) return `mode "${m}" scored ${v}`;
    if (!Obj.MODES[m].label) return `mode "${m}" has no label for the UI`;
    if (!Obj.MODES[m].help) return `mode "${m}" has no help text for the UI`;
  }
  try { Obj.scoreFor('nonsense', sample); return 'an unknown mode scored instead of throwing'; }
  catch { /* expected */ }
  return null;
});

check('any boss kill outranks any amount of progress toward one', () => {
  const Obj = sb.OptimizerObjective;
  // A build that cannot kill the boss but farms enormously must never beat one that kills it.
  const cannotKill = { bossKillRate: 0, avgStage: 999, bossHpPercent: 0.0001, lootPerMin: 1e12 };
  const barelyKills = { bossKillRate: 0.1, avgStage: 200, bossHpPercent: 99, lootPerMin: 1 };
  if (Obj.scoreFor('boss', barelyKills) <= Obj.scoreFor('boss', cannotKill)) {
    return 'a non-killing build outranked a killing one';
  }
  return null;
});

check('loot only breaks ties between equal kill rates, never buys kill rate', () => {
  const Obj = sb.OptimizerObjective;
  const lower = { bossKillRate: 90, bossHpPercent: 0.5, lootPerMin: 1e12 };
  const higher = { bossKillRate: 90.1, bossHpPercent: 0.5, lootPerMin: 1 };
  if (Obj.scoreFor('boss', higher) <= Obj.scoreFor('boss', lower)) {
    return 'a huge loot gain outweighed a 0.1 kill-rate gain -- the tiers are bleeding together';
  }
  const richer = { bossKillRate: 90, bossHpPercent: 0.5, lootPerMin: 2e7 };
  const poorer = { bossKillRate: 90, bossHpPercent: 0.5, lootPerMin: 1e7 };
  if (Obj.scoreFor('boss', richer) <= Obj.scoreFor('boss', poorer)) {
    return 'equal kill rates did not prefer more loot -- overflow points have nowhere useful to go';
  }
  return null;
});

check('loot is ignored while the boss cannot be killed at all', () => {
  const Obj = sb.OptimizerObjective;
  // Both fail to kill; the one CLOSER to a kill must win regardless of loot.
  const closer = { bossKillRate: 0, avgStage: 200, bossHpPercent: 5, lootPerMin: 1 };
  const richer = { bossKillRate: 0, avgStage: 200, bossHpPercent: 40, lootPerMin: 1e12 };
  if (Obj.scoreFor('boss', closer) <= Obj.scoreFor('boss', richer)) {
    return 'loot outweighed being closer to a first kill';
  }
  return null;
});

// bossHpPercent reads 0 BOTH for a build that never reaches the wall and one already past it
// (measured -- see objective.js). Ranking non-kills on HP alone therefore scored an empty build
// identically to the strongest non-killing build. avgStage is the monotone signal.
check('below a kill, a stronger build outranks a weaker one even at bossHp% 0', () => {
  const Obj = sb.OptimizerObjective;
  // Real measured pairs from scaling one build down: both report bossHpPercent 0.
  const strong = { bossKillRate: 0, avgStage: 237.1, bossHpPercent: 0, lootPerMin: 2.9e7 };
  const empty = { bossKillRate: 0, avgStage: 135.8, bossHpPercent: 0, lootPerMin: 0 };
  if (Obj.scoreFor('boss', strong) <= Obj.scoreFor('boss', empty)) {
    return 'an empty build tied or beat the strongest non-killing build';
  }
  // And the wall case still discriminates on HP when stage ties exactly.
  const atWallCloser = { bossKillRate: 0, avgStage: 200, bossHpPercent: 47, lootPerMin: 0 };
  const atWallFarther = { bossKillRate: 0, avgStage: 200, bossHpPercent: 74, lootPerMin: 0 };
  if (Obj.scoreFor('boss', atWallCloser) <= Obj.scoreFor('boss', atWallFarther)) {
    return 'stalled at the same wall, less remaining boss HP did not win';
  }
  // Stage must dominate the HP tiebreak, never the other way round.
  const further = { bossKillRate: 0, avgStage: 201, bossHpPercent: 99, lootPerMin: 0 };
  if (Obj.scoreFor('boss', further) <= Obj.scoreFor('boss', atWallCloser)) {
    return 'the HP tiebreak outweighed a whole stage of progress';
  }
  return null;
});

check('only bossTimeless pins Timeless Mastery', () => {
  const Obj = sb.OptimizerObjective;
  if (Obj.pinnedAttrsFor('bossTimeless').join() !== 'timeless') return 'bossTimeless does not pin timeless';
  for (const m of ['loot', 'push', 'boss']) {
    if (Obj.pinnedAttrsFor(m).length) return `mode "${m}" unexpectedly pins ${Obj.pinnedAttrsFor(m).join()}`;
  }
  return null;
});

// Share codes never encode level, so parseBuildCode infers it. Inferring from the TALENT sum
// alone assumes the player spent every available talent point. A real level-58 Borge code with
// 46 talents and 174 attributes decoded as level 46, and the resulting 138-point attribute
// budget then TRIMMED 36 points off the build on import -- silently wrecking it, and handing
// the optimizer a budget 12 talent points short of the account's real one. Attribute spend is
// an independent second lower bound on level.
check('level inference uses attribute spend, not just the talent sum', async () => {
  const code = 'TZyeYAa1AQoozqzASMADS7GNHGuQHXFgPtqgLABM4wexvGSR8ECpPLwyDaLvasTQRkwrfMRdXunbtCsHJpoLGo';
  const b = await sb.parseBuildCode(code);
  const d = sb.HUNTER_DEFS.borge;
  const talentSum = d.talents.reduce((acc, t) => acc + (b.talents[t.id] || 0), 0);
  const attrCost = sb.AllocSpace.costOf(d.attributes, b.attributes);
  if (talentSum !== 46 || attrCost !== 174) return `fixture drifted: ${talentSum} talents / ${attrCost} attributes`;
  if (b.level !== 58) return `inferred level ${b.level}, expected 58 (174 attributes at 3 per level)`;
  return null;
});

// The property that actually matters, across every fixture: whatever level is inferred, it must
// be able to PAY for the build it was inferred from. Anything less gets trimmed on import.
check('every fixture infers a level that can fund its own allocation', async () => {
  const known = require('./harness.js').loadKnownBuilds();
  for (const hunter of Object.keys(known)) {
    const d = sb.HUNTER_DEFS[hunter];
    for (const fx of known[hunter]) {
      const b = await sb.parseBuildCode(fx.code);
      if (!b) continue;
      const talentSum = d.talents.reduce((acc, t) => acc + (b.talents[t.id] || 0), 0);
      const attrCost = sb.AllocSpace.costOf(d.attributes, b.attributes);
      if (sb.talentBudgetForLevel(b.level) < talentSum) {
        return `${hunter}/${fx.set}#${fx.index}: level ${b.level} funds ${sb.talentBudgetForLevel(b.level)} talents, build spends ${talentSum}`;
      }
      if (sb.attributeBudgetForLevel(b.level) < attrCost) {
        return `${hunter}/${fx.set}#${fx.index}: level ${b.level} funds ${sb.attributeBudgetForLevel(b.level)} attributes, build spends ${attrCost}`;
      }
    }
  }
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

// ---- Per-hunter iterations + loot filter ------------------------------------------------
// Both are per hunter because the original tool keys them per hunter, and because the tradeoffs
// genuinely differ per hunter (a level-79 Borge evaluation costs far more than a level-12 Knox).

check('a fresh store gives every hunter a usable iteration count and a full loot filter', () => {
  const store = S.freshStore();
  for (const h of S.HUNTERS) {
    if (store[h].iterations !== S.ITERATIONS.default) return `${h}.iterations is ${store[h].iterations}`;
    for (const k of S.LOOT_KEYS) {
      if (store[h].lootFilter[k] !== true) return `${h}.lootFilter.${k} should default to visible`;
    }
  }
  return S.validateStore(store).length ? `fresh store does not validate: ${S.validateStore(store)[0]}` : null;
});

check('an existing account without the new per-hunter fields is migrated, not broken', () => {
  // The per-hunter schema entry is `deep`, which is what makes this work; without it the fields
  // would only appear for brand-new profiles.
  const store = S.freshStore();
  delete store.borge.iterations;
  delete store.borge.lootFilter;
  store.borge.builds.push({ id: 'keep', name: 'mine', level: 5, talents: {}, attributes: {} });
  S.migrateStore(store);
  if (store.borge.iterations !== S.ITERATIONS.default) return 'iterations not backfilled';
  if (!store.borge.lootFilter || store.borge.lootFilter.mat1 !== true) return 'lootFilter not backfilled';
  if (store.borge.builds.length !== 1) return 'migration destroyed existing builds';
  return null;
});

check('iterations outside the allowed range is reported', () => {
  const store = S.freshStore();
  store.borge.iterations = 0;
  if (!S.validateStore(store).some((p) => /borge\.iterations is 0/.test(p))) return 'zero not caught';
  store.borge.iterations = S.ITERATIONS.max + S.ITERATIONS.step;
  if (!S.validateStore(store).some((p) => /above the current ceiling/.test(p))) return 'over-ceiling not caught';
  return null;
});

check('High Iterations Mode raises the ceiling rather than changing the value', () => {
  const store = S.freshStore();
  const high = S.ITERATIONS.max + S.ITERATIONS.step;
  if (S.clampIterations(high, store) !== S.ITERATIONS.max) return 'not clamped to the normal ceiling';
  store.settings.ui.highIterations = true;
  if (S.iterationCeiling(store) !== S.ITERATIONS.maxHigh) return 'ceiling did not rise';
  if (S.clampIterations(high, store) !== high) return 'value was altered even though it is now in range';
  store.borge.iterations = high;
  if (S.validateStore(store).some((p) => /iterations/.test(p))) return 'a now-legal value is still reported';
  return null;
});

check('clamping never yields something the evaluator cannot use', () => {
  const store = S.freshStore();
  for (const bad of [undefined, null, NaN, 'abc', -5, 0, Infinity, -Infinity]) {
    const v = S.clampIterations(bad, store);
    if (!Number.isInteger(v) || v < S.ITERATIONS.min || v > S.iterationCeiling(store)) {
      return `clampIterations(${String(bad)}) returned ${v}`;
    }
  }
  return null;
});

check('a loot filter with an unknown key or a non-boolean is reported', () => {
  const store = S.freshStore();
  store.borge.lootFilter.mat9 = true;
  if (!S.validateStore(store).some((p) => /unknown key "mat9"/.test(p))) return 'unknown key not caught';
  delete store.borge.lootFilter.mat9;
  store.borge.lootFilter.mat1 = 'yes';
  if (!S.validateStore(store).some((p) => /lootFilter\.mat1 is string/.test(p))) return 'non-boolean not caught';
  return null;
});

check('the interface preferences are declared, not conjured at a call site', () => {
  const store = S.freshStore();
  if (store.settings.ui.upgradesSidebar !== true) return 'upgradesSidebar should default on';
  if (store.settings.ui.highIterations !== false) return 'highIterations should default off';
  // An account that predates the `ui` block must gain it on migration.
  delete store.settings.ui;
  S.migrateStore(store);
  if (!store.settings.ui || store.settings.ui.upgradesSidebar !== true) return 'ui block not backfilled';
  return null;
});

runChecks().then(() => {
  console.log(`\n${failures ? `${failures} FAILED` : 'all schema invariants hold'}`);
  process.exit(failures ? 1 : 0);
});
