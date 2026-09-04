'use strict';
// Does the optimizer beat the player's ACTUAL build, at the player's ACTUAL level, with the
// player's ACTUAL overrides?
//
//   node tools/bench/real-account-optimizer-check.js [hunter]
//
// Every other optimizer bench runs on community share codes. Those are useful but they are not
// this account: a share code cannot carry most of an account's overrides (see the CODE_PARAMS note
// in CLAUDE.md), and the fixture levels are spread from 11 to 79, so results are dominated by
// levels the player is nowhere near. This one reads the pulled save, rebuilds the real state
// through the shipped importer, and asks the only question that matters to the person using the
// tool: **if I press Optimize, do I get something at least as good as what I already have?**
//
// It is run TWICE per hunter -- once with the account's real overrides and once with none. Both
// matter, and for different reasons:
//   * WITH overrides is the real answer the app gives.
//   * WITHOUT is the control: if the two disagree about which allocation wins, the overrides are
//     changing the RANKING, which is exactly where a mis-modelled relic or trinket would show up.
//
// The incumbent is the real build, so "never worse" is a design guarantee here rather than a hope
// (the current build competes as a finalist). A failure means that guarantee is broken, which is a
// different and more serious thing than the search shortfalls underspend-test measures.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const SAVE_DIR = path.join(__dirname, '../gamefiles/save');
const only = process.argv[2];

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

(async () => {
  const decoded = fs.existsSync(SAVE_DIR)
    ? fs.readdirSync(SAVE_DIR).filter((f) => f.startsWith('decoded-') && f.endsWith('.json'))
    : [];
  if (!decoded.length) {
    // A skip here is honest but useless, so say so loudly rather than exiting 0 quietly.
    console.log('SKIP: no decoded save in tools/gamefiles/save -- this bench verifies NOTHING '
      + 'without one. Pull a save (see tools/gamefiles/README.md) to enable it.');
    process.exit(0);
  }

  const sb = H.browserSandbox();
  const save = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, decoded[0]), 'utf8'));
  const mapped = sb.mapSaveToStore(save);
  const perHunter = mapped.perHunter || {};
  const allOverrides = mapped.globalUpgrades || {};

  const hunters = only ? [only] : Object.keys(perHunter);
  for (const hunter of hunters) {
    const real = perHunter[hunter];
    if (!real || !real.level) { fail(`${hunter}: the save produced no level`); continue; }

    for (const withOverrides of [true, false]) {
      const label = `${hunter} lvl${real.level} ${withOverrides ? 'WITH' : 'without'} overrides`;

      // Only this hunter's own override keys; the map is flat "cat.id" across all hunters.
      const overrides = {};
      if (withOverrides) {
        const defs = sb.HUNTER_DEFS[hunter];
        for (const [cat, group] of Object.entries(defs.globalUpgrades || {})) {
          for (const item of group.items || []) {
            const v = allOverrides[`${cat}.${item.id}`];
            if (v) overrides[`upgrades.${cat}.${item.id}`] = v;
          }
        }
      }

      const build = {
        level: real.level,
        talents: { ...real.talents },
        attributes: { ...real.attributes },
        overrides,
        upgradeOverrides: {},
      };
      // The real account's base stats belong in the evaluation too -- they are most of the build.
      const cfg = H.cfgForImport(hunter, build, { budgetMode: 'level' });
      cfg.hunterStats = { ...real.hunterStats };

      const importScore = (await H.evaluateAllocation(cfg, build.talents, build.attributes)).loot;
      const scorer = await H.makeScorer(cfg, 'loot');
      let res;
      try {
        res = await H.Optimizer.optimize(cfg, { mode: 'loot', scorer, scorerFor: H.scorerFactory(cfg) });
      } catch (err) {
        fail(`${label}: optimize threw -- ${err.message}`);
        continue;
      }
      const out = res.best;
      const outScore = (await H.evaluateAllocation(cfg, out.talentAlloc, out.attrAlloc)).loot;
      const delta = ((outScore - importScore) / Math.max(importScore, 1e-9)) * 100;

      // Nothing spendable may be left behind either -- a "not worse" result that idles points is
      // still a wrong answer, and it is the failure mode that started this whole line of work.
      const tSpent = H.Space.costOf(cfg.TALENTS, out.talentAlloc);
      const aSpent = H.Space.costOf(cfg.ATTRIBUTES, out.attrAlloc);
      const idle = [];
      if (tSpent < cfg.TALENT_BUDGET) idle.push(`${cfg.TALENT_BUDGET - tSpent} talent`);
      if (aSpent < cfg.ATTRIBUTE_BUDGET) idle.push(`${cfg.ATTRIBUTE_BUDGET - aSpent} attribute`);

      if (outScore < importScore) {
        fail(`${label}: optimizer returned ${outScore.toFixed(2)} vs the account's own `
          + `${importScore.toFixed(2)} (${delta.toFixed(2)}%) -- the incumbent competes as a `
          + 'finalist, so this should be impossible');
      } else if (idle.length) {
        fail(`${label}: left ${idle.join(' and ')} point(s) unspent `
          + `(${tSpent}/${cfg.TALENT_BUDGET}T ${aSpent}/${cfg.ATTRIBUTE_BUDGET}A)`);
      } else {
        pass(`${label}: ${importScore.toFixed(2)} -> ${outScore.toFixed(2)} (+${delta.toFixed(2)}%), `
          + `${tSpent}/${cfg.TALENT_BUDGET}T ${aSpent}/${cfg.ATTRIBUTE_BUDGET}A spent`);
      }
    }
  }

  console.log(failures
    ? `\n${failures} failure(s)`
    : '\nthe optimizer never returns worse than the real account build, with or without overrides');
  process.exit(failures ? 1 : 0);
})();
