'use strict';
// NO OPTIMIZED BUILD MAY BE WORSE THAN AN ESTABLISHED COMMUNITY BUILD, JUDGED ON THIS ACCOUNT.
//
//   node tools/bench/community-vs-profile-check.js [--sample=N] [--seed=N] [--hunter=borge]
//
// The other benches each answer half of this and neither answers it whole:
//   * `run.js` / `search-quality-check.js` judge community codes against the state a SHARE CODE
//     carries, which is a fraction of an account (see the CODE_PARAMS note in CLAUDE.md).
//   * `real-account-optimizer-check.js` uses the real account but compares only against the
//     player's OWN build, so it cannot say whether a well-known community build would beat what
//     the tool hands you.
//
// This one puts a community allocation and the optimizer's answer on the same account: the real
// save's overrides, gems, base stats and level budgets, changing only the allocation. That is the
// question a player actually asks -- "if I copy a build people recommend, do I do better than
// pressing Optimize?" -- and the answer must be no.
//
// The community build is entered as the INCUMBENT, exactly as importing it would be, so the
// never-worse property is a design guarantee rather than a hope: the incumbent competes as a
// finalist at full fidelity. A failure here means that guarantee is broken.
//
// Levels are the account's own per hunter, so the comparison sits where the player actually is
// rather than being dominated by fixture levels they are nowhere near.


// NOISE FLOOR, stated because a delta without one invites reading noise as signal:
//   a comparison of two FINAL_ITERATIONS scores carries ~0.3% (measured: 0.12% mean error each),
//   and the SEARCH varies ~7 percentage points across seeds -- one seed is ONE SAMPLE.
// A single-seed difference narrower than ~7 points is not evidence about a mechanism.
const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const Space = H.Space;
const args = process.argv.slice(2);
const opt = (n, d) => {
  const h = args.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};
const SAMPLE = Number(opt('sample', 3));
const SEED = Number(opt('seed', Math.floor(Math.random() * 1e6)));
const ONLY_HUNTER = opt('hunter', null);
const SAVE_DIR = path.join(__dirname, '../gamefiles/save');
// The measured precision floor (eval-precision-check.js: 0.12% mean, 0.35% worst), doubled because
// a comparison reads two scores. Below it, "worse" is not distinguishable from measurement.
const TOL = 1.0;

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  const decoded = fs.existsSync(SAVE_DIR)
    ? fs.readdirSync(SAVE_DIR).filter((f) => f.startsWith('decoded-') && f.endsWith('.json')).sort().reverse()
    : [];
  if (!decoded.length) {
    console.log('SKIP: no decoded save in tools/gamefiles/save -- this bench verifies NOTHING '
      + 'without one. Pull a save (see tools/gamefiles/README.md) to enable it.');
    process.exit(0);
  }

  const sb = H.browserSandbox();
  const save = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, decoded[0]), 'utf8'));
  const mapped = sb.mapSaveToStore(save);
  const perHunter = mapped.perHunter || {};
  const allOverrides = mapped.globalUpgrades || {};
  const gemStates = mapped.gems || {};
  const known = H.loadKnownBuilds();
  const rand = mulberry(SEED);

  console.log(`seed ${SEED} -- replay with --seed=${SEED}`);
  console.log(`account: ${Object.entries(perHunter).map(([h, r]) => `${h} lvl${r.level}`).join(', ')}`);
  console.log('');

  let failures = 0;
  let checked = 0;

  for (const hunter of (ONLY_HUNTER ? [ONLY_HUNTER] : Object.keys(perHunter))) {
    const real = perHunter[hunter];
    if (!real || !real.level) continue;
    const defs = sb.HUNTER_DEFS[hunter];

    // This account's real override set for this hunter. The map is flat "cat.id" across hunters.
    const overrides = {};
    for (const [cat, group] of Object.entries(defs.globalUpgrades || {})) {
      for (const item of group.items || []) {
        const v = allOverrides[`${cat}.${item.id}`];
        if (v) overrides[`upgrades.${cat}.${item.id}`] = v;
      }
    }

    // Community builds NEAR this hunter's real level. A build 40 levels away is not one the player
    // could adopt, so comparing against it measures nothing about this account.
    const pool = known[hunter].filter((f) => f.mode === 'loot');
    const withLevels = [];
    for (const fx of pool) {
      const b = await H.parseBuildCode(fx.code);
      if (b) withLevels.push({ fx, b, dist: Math.abs(b.level - real.level) });
    }
    withLevels.sort((a, b) => a.dist - b.dist);
    const near = withLevels.slice(0, Math.max(SAMPLE * 3, 9));
    const picks = [];
    while (picks.length < SAMPLE && near.length) {
      picks.push(near.splice(Math.floor(rand() * near.length), 1)[0]);
    }

    for (const pick of picks) {
      const { fx, b } = pick;
      // The ACCOUNT's level and budgets; only the ALLOCATION comes from the community build, and
      // it is trimmed to what this account can actually spend.
      const talentBudget = sb.talentBudgetForLevel(real.level);
      const attributeBudget = sb.attributeBudgetForLevel(real.level);
      const capCtx = { buildOverrides: overrides, gemPlannerStore: { gemStates } };
      const talents = { ...b.talents };
      const attributes = { ...b.attributes };
      const TAL = sb.resolveMaxLevels(
        defs.talents.filter((t) => !t.advanced || (talents[t.id] || 0) > 0), capCtx,
      );
      const ATT = sb.resolveMaxLevels(defs.attributes, capCtx);
      Space.trimToBudget(TAL, {}, {}, talentBudget, talents);
      Space.trimToBudget(ATT, defs.attributeDependencies, defs.attributeMinValue, attributeBudget, attributes);

      const cfg = {
        hunter,
        level: real.level,
        hunterStats: real.hunterStats || {},
        globalUpgrades: {},
        gemPlannerStore: { gemStates },
        baseOverrides: overrides,
        TALENTS: TAL,
        ATTRIBUTES: ATT,
        ATTRIBUTE_DEPENDENCIES: defs.attributeDependencies,
        ATTRIBUTE_MIN_VALUE: defs.attributeMinValue,
        TALENT_BUDGET: talentBudget,
        ATTRIBUTE_BUDGET: attributeBudget,
        currentTalents: talents,
        currentAttrs: attributes,
      };

      const communityScore = (await H.evaluateAllocation(cfg, talents, attributes)).loot;
      const scorer = await H.makeScorer(cfg, 'loot');
      let res;
      try {
        res = await H.Optimizer.optimize(cfg, { mode: 'loot', scorer });
      } catch (err) {
        failures++;
        console.log(`FAIL ${fx.uid}: optimize threw -- ${err.message}`);
        continue;
      }
      const optimized = (await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc)).loot;
      const delta = 100 * (optimized - communityScore) / communityScore;
      const spentT = Space.costOf(TAL, res.best.talentAlloc);
      const spentA = Space.costOf(ATT, res.best.attrAlloc);
      checked++;

      const worse = delta < -TOL;
      if (worse) failures++;
      console.log(`${worse ? 'FAIL' : 'pass'} ${fx.uid.padEnd(34)} `
        + `(lvl${b.level} build on your lvl${real.level} ${hunter})`);
      console.log(`      community ${communityScore.toFixed(2)}  ->  optimized ${optimized.toFixed(2)}  `
        + `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%   spent ${spentT}/${talentBudget}T ${spentA}/${attributeBudget}A`);
      if (spentT < talentBudget - 1 || spentA < attributeBudget - 1) {
        console.log('      NOTE: budget left unspent -- confirm it is unspendable, not merely unspent');
      }
    }
  }

  console.log('');
  console.log(`${checked} community build(s) compared on this account`);
  console.log(failures
    ? `${failures} case(s) where the optimizer came back WORSE than a community build on this profile`
    : `no community build beat the optimizer on this account (tolerance ${TOL}%)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
