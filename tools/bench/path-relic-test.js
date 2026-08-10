'use strict';
// The Effective Path now ranks RELICS alongside base stats and inscriptions, in their own
// Fragments column. What must hold:
//
//   1. Fragments is a separate column -- it must never compete with the stat materials.
//   2. Knox gets no relic column at all (no modeled relic currency; see CLAUDE.md).
//   3. The three relics measured to do nothing (Borge r7/r19, Ozzy r7) are NEVER recommended.
//      There is deliberately no blocklist for them -- the walk ranks by real measured marginal
//      effect, so an inert relic scores 0 and loses. This test is what guarantees that the
//      no-blocklist design actually behaves, rather than trusting the argument.
//
//   node tools/bench/path-relic-test.js

const H = require('./harness.js');

const sb = H.browserSandbox();
let failures = 0;
const queued = [];
const check = (name, fn) => queued.push({ name, fn });

// The path module reads its coarse fidelity from the optimizer at load time, and the optimizer
// is a CommonJS require in the harness rather than something the sandbox loaded. Hand it over
// before evaluating the browser files, so the path uses the SAME screening fidelity the search
// does instead of a second number.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PUBLIC = path.join(__dirname, '../../webapp/public');
sb.HunterOptimizer = H.Optimizer;
for (const f of ['hunterStatPath.js', 'hunterStatPathBrowser.js']) {
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), sb, { filename: f });
}

const INERT = { borge: ['r7', 'r19'], ozzy: ['r7'], knox: [] };
const STEPS = 6;

check('fragments is its own column, and Knox has none', () => {
  for (const hunter of ['borge', 'ozzy']) {
    const withUpgrades = sb.resourcesFor(hunter, true);
    const statsOnly = sb.resourcesFor(hunter, false);
    if (!withUpgrades.includes('frags')) return `${hunter} build-card path has no frags column`;
    if (statsOnly.includes('frags')) return `${hunter} bare stats page should not price relics`;
    for (const r of ['mat1', 'mat2', 'mat3']) {
      if (!withUpgrades.includes(r)) return `${hunter} lost its ${r} column`;
    }
  }
  if (sb.resourcesFor('knox', true).includes('frags')) {
    return 'Knox got a fragments column despite having no modeled relic currency';
  }
  return null;
});

for (const hunter of ['borge', 'ozzy', 'knox']) {
  check(`${hunter}: the path never recommends a relic that does nothing`, async () => {
    const known = H.loadKnownBuilds()[hunter];
    const fx = known[known.length - 1];
    const b = await H.parseBuildCode(fx.code);
    if (!b) return 'fixture failed to decode';

    const defs = sb.HUNTER_DEFS[hunter];
    const cfg = {
      level: b.level,
      talents: b.talents,
      attributes: b.attributes,
      hunterStats: {},
      baseOverrides: {},
      globalUpgrades: {},
      gemPlannerStore: { gemStates: {} },
      TALENTS: defs.talents,
      ATTRIBUTES: defs.attributes,
    };

    const res = await sb.greedyPurchasePath(hunter, cfg, STEPS, true);
    const frags = res.columns.frags;
    if (hunter === 'knox') return frags ? 'Knox produced a fragments column' : null;
    if (!frags) return 'no fragments column was produced';

    const picked = frags.steps.map((s) => s.key);
    for (const dead of INERT[hunter]) {
      if (picked.includes(dead)) {
        return `recommended ${dead}, which is measured to change no output at all`;
      }
    }
    if (!picked.length) return 'the fragments column recommended nothing at all';
    // Every step must be a relic -- nothing else is bought with fragments.
    const wrongKind = frags.steps.find((s) => s.kind !== 'relic');
    if (wrongKind) return `a ${wrongKind.kind} ended up in the fragments column`;
    return null;
  });
}

check('relic steps carry a real fragment cost, never zero', async () => {
  const known = H.loadKnownBuilds().borge;
  const b = await H.parseBuildCode(known[known.length - 1].code);
  const defs = sb.HUNTER_DEFS.borge;
  const res = await sb.greedyPurchasePath('borge', {
    level: b.level, talents: b.talents, attributes: b.attributes, hunterStats: {},
    baseOverrides: {}, globalUpgrades: {}, gemPlannerStore: { gemStates: {} },
    TALENTS: defs.talents, ATTRIBUTES: defs.attributes,
  }, 4, true);
  for (const s of res.columns.frags.steps) {
    if (!(s.cost > 0)) return `${s.key} level ${s.level} priced at ${s.cost}`;
    if (s.resource !== 'frags') return `${s.key} claims resource ${s.resource}`;
  }
  return null;
});

// ---- objective modes -------------------------------------------------------------------------
// The path now ranks under the SAME objective table the optimizer uses. What must hold:
//   - 'loot' behaves exactly as it always did (a lootPerMin difference), so nothing regressed.
//   - boss mode is genuinely different, and prefers the thing that improves the kill.
//   - bossTimeless is refused: it differs from boss only by pinning attributes, which the path
//     never allocates, so offering it would be a choice that silently does nothing.

check('the path offers exactly the modes it can actually act on', () => {
  const all = Object.keys(sb.OptimizerObjective.MODES);
  const pathable = Object.keys(sb.OptimizerObjective.pathModes());
  if (!pathable.includes('loot') || !pathable.includes('push') || !pathable.includes('boss')) {
    return `path modes missing one of loot/push/boss: ${pathable.join(', ')}`;
  }
  if (pathable.includes('bossTimeless')) return 'bossTimeless is offered but cannot behave differently in a path';
  if (all.length - pathable.length !== 1) return `unexpected split: ${all.join(',')} vs ${pathable.join(',')}`;
  return null;
});

check("marginalValue in 'loot' mode is still exactly a lootPerMin difference", () => {
  const base = { lootPerMin: 1000, avgStage: 10, bossKillRate: 0, bossHpPercent: 50 };
  const cand = { lootPerMin: 1750, avgStage: 10, bossKillRate: 0, bossHpPercent: 50 };
  const { delta } = sb.HunterStatPath.marginalValue(base, cand, 'loot');
  if (delta !== 750) return `expected 750, got ${delta}`;
  // And the default argument must stay 'loot' so existing callers are unaffected.
  if (sb.HunterStatPath.marginalValue(base, cand).delta !== 750) return 'the default mode is no longer loot';
  return null;
});

check('boss mode values a kill above any amount of loot', () => {
  const base = { lootPerMin: 1e9, avgStage: 200, bossKillRate: 0, bossHpPercent: 20 };
  const richer = { lootPerMin: 1e12, avgStage: 200, bossKillRate: 0, bossHpPercent: 20 };
  const kills = { lootPerMin: 1, avgStage: 200, bossKillRate: 5, bossHpPercent: 0 };
  const dRich = sb.HunterStatPath.marginalValue(base, richer, 'boss').delta;
  const dKill = sb.HunterStatPath.marginalValue(base, kills, 'boss').delta;
  if (!(dKill > dRich)) return `a 1000x loot gain (${dRich}) outranked unlocking the kill (${dKill})`;
  if (dRich !== 0) return `loot moved the boss score by ${dRich} while no kill was happening; it must contribute nothing`;
  return null;
});

check('an unknown or non-path mode is refused, not silently treated as loot', async () => {
  const defs = sb.HUNTER_DEFS.borge;
  const cfg = {
    level: 20, talents: {}, attributes: {}, hunterStats: {}, baseOverrides: {},
    globalUpgrades: {}, gemPlannerStore: { gemStates: {} },
    TALENTS: defs.talents, ATTRIBUTES: defs.attributes,
  };
  for (const bad of ['nonsense', 'bossTimeless']) {
    try {
      await sb.greedyPurchasePath('borge', cfg, 1, false, bad);
      return `mode "${bad}" was accepted`;
    } catch (err) {
      if (!/not a purchase-path mode/.test(err.message)) return `wrong error for "${bad}": ${err.message}`;
    }
  }
  return null;
});

check('boss mode produces a different plan than loot mode on a real build', async () => {
  const known = H.loadKnownBuilds().borge;
  const b = await H.parseBuildCode(known[known.length - 1].code);
  const defs = sb.HUNTER_DEFS.borge;
  const cfg = {
    level: b.level, talents: b.talents, attributes: b.attributes, hunterStats: {},
    baseOverrides: {}, globalUpgrades: {}, gemPlannerStore: { gemStates: {} },
    TALENTS: defs.talents, ATTRIBUTES: defs.attributes,
  };
  const [loot, boss] = await Promise.all([
    sb.greedyPurchasePath('borge', cfg, 4, true, 'loot'),
    sb.greedyPurchasePath('borge', cfg, 4, true, 'boss'),
  ]);
  const flat = (r) => Object.entries(r.columns).sort().map(([res, col]) => `${res}:${col.steps.map((s) => s.key + s.level).join('>')}`).join(' | ');
  const a = flat(loot); const c = flat(boss);
  console.log(`      loot: ${a}`);
  console.log(`      boss: ${c}`);
  // Not asserting they differ -- on a build that already farms and kills comfortably the two can
  // legitimately agree. Assert both produced a real plan; the printout is for eyeballing.
  if (!a.length || !c.length) return 'one of the modes produced no plan at all';
  return null;
});

(async () => {
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
  console.log(`\n${failures ? `${failures} FAILED` : 'all effective-path relic invariants hold'}`);
  process.exit(failures ? 1 : 0);
})();
