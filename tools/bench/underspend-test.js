'use strict';
// The test that WOULD have caught the reported bug, and that the 182-build gate could not.
//
// The gate builds every fixture with budget == the import's own spend, so its incumbent is
// always fully spent and an under-spend can never arise (verified: 0 of 182 fixtures could
// produce one). The real app takes its budget from the LEVEL, which routinely exceeds what a
// saved build has spent -- a respec, a level-up not yet allocated, or simply a partial build.
// That gap is where the failure lived.
//
// Here the incumbent is deliberately damaged -- points stripped out, exactly as a real
// under-spent build looks -- and the optimizer must still:
//   1. leave no spendable points on the table, and
//   2. score at least as well as the untouched import it was derived from.
//
// (2) matters as much as (1): topping up to a full budget is worthless if the result is worse
// than the build the user already had.
//
//   node tools/bench/underspend-test.js [hunter] [count]

const H = require('./harness.js');

const Space = H.Space;
const [hunterArg, countArg] = process.argv.slice(2);
const COUNT = Number(countArg || 3);

/** Remove `n` points from an allocation, largest nodes first, keeping it legal. */
function strip(defs, deps, minVal, alloc, n) {
  const out = { ...alloc };
  let removed = 0;
  let guard = 0;
  while (removed < n && guard++ < 1000) {
    let target = null;
    for (const d of defs) {
      if ((out[d.id] || 0) <= 0) continue;
      if (!target || out[d.id] > out[target.id]) target = d;
    }
    if (!target) break;
    out[target.id] -= 1;
    removed += target.cost || 1;
  }
  Space.clearInvalidDescendants(defs, deps, minVal, out);
  return out;
}

let failures = 0;

(async () => {
  const known = H.loadKnownBuilds();
  const hunters = hunterArg ? [hunterArg] : ['borge', 'ozzy', 'knox'];

  for (const hunter of hunters) {
    const all = known[hunter].filter((f) => f.mode === 'loot');
    const step = Math.max(1, Math.floor(all.length / COUNT));
    const picks = all.filter((_, i) => i % step === 0).slice(0, COUNT);

    for (const fx of picks) {
      const build = await H.parseBuildCode(fx.code);
      if (!build) continue;

      // 'level' budgets: what the app actually gives the optimizer.
      const cfg = H.cfgForImport(hunter, build, { budgetMode: 'level' });
      const importScore = (await H.evaluateAllocation(cfg, build.talents, build.attributes)).loot;

      // Damage the incumbent the way a real under-spent build is damaged.
      const damagedTalents = strip(cfg.TALENTS, {}, {}, build.talents, 12);
      const damagedAttrs = strip(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, build.attributes, 9);
      const damaged = { ...cfg, currentTalents: damagedTalents, currentAttrs: damagedAttrs };

      const tSpent = Space.costOf(cfg.TALENTS, damagedTalents);
      const aSpent = Space.costOf(cfg.ATTRIBUTES, damagedAttrs);

      const scorer = await H.makeScorer(damaged, 'loot');
      let res;
      try {
        res = await H.Optimizer.optimize(damaged, { mode: 'loot', scorer });
      } catch (err) {
        failures++;
        console.log(`FAIL ${hunter}/${fx.set}#${fx.index} lvl${build.level}: optimize threw -- ${err.message}`);
        continue;
      }

      const out = res.best;
      const outScore = (await H.evaluateAllocation(cfg, out.talentAlloc, out.attrAlloc)).loot;

      // 1. Nothing spendable left.
      const leftover = (defs, deps, minVal, budget, alloc) => {
        const idle = budget - Space.costOf(defs, alloc);
        if (idle <= 0) return null;
        const node = defs.find((d) => (d.cost || 1) <= idle && Space.isEligible(d, defs, deps, minVal, alloc));
        return node ? `${idle} idle, "${node.id}" could take one` : null;
      };
      const tLeft = leftover(cfg.TALENTS, {}, {}, cfg.TALENT_BUDGET, out.talentAlloc);
      const aLeft = leftover(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, cfg.ATTRIBUTE_BUDGET, out.attrAlloc);

      // 2. No worse than the untouched import.
      const regressed = outScore < importScore;

      const tag = `${hunter}/${fx.set}#${fx.index} lvl${build.level}`;
      if (tLeft || aLeft || regressed) {
        failures++;
        console.log(`FAIL ${tag}`);
        if (tLeft) console.log(`      talents: ${tLeft}`);
        if (aLeft) console.log(`      attributes: ${aLeft}`);
        if (regressed) {
          console.log(`      scored ${outScore.toFixed(2)} vs the untouched import's ${importScore.toFixed(2)} `
            + `(${(100 * (outScore - importScore) / importScore).toFixed(2)}%)`);
        }
      } else {
        console.log(`pass ${tag}  incumbent damaged to ${tSpent}/${cfg.TALENT_BUDGET}T ${aSpent}/${cfg.ATTRIBUTE_BUDGET}A `
          + `-> ${Space.costOf(cfg.TALENTS, out.talentAlloc)}/${cfg.TALENT_BUDGET}T `
          + `${Space.costOf(cfg.ATTRIBUTES, out.attrAlloc)}/${cfg.ATTRIBUTE_BUDGET}A, `
          + `${outScore.toFixed(2)} vs import ${importScore.toFixed(2)}`);
      }
    }
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'under-spent incumbents are always repaired and never regress'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
