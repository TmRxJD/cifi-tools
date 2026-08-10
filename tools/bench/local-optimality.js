'use strict';
// The invariant that actually matters: it must not be possible to score higher from the
// optimizer's answer with a trivial change.
//
// "Spends the whole budget" is a symptom-level rule. Asserting it forces the right shape without
// proving the answer is good -- and forcing a result is not the same as earning it. This checks
// the real property instead: from the returned build, no single cheap move improves the score at
// FULL fidelity. If one does, the search stopped early, and that is a search-quality defect no
// amount of topping-up would fix.
//
// Moves probed, all at FINAL_ITERATIONS so the verdict uses the same measurement the build card
// shows:
//   +1  spend one idle point in any eligible node   (catches under-spending)
//   1:1 move one point between any pair of nodes    (catches a missed local improvement)
//
// This is expensive -- hundreds of full-fidelity evaluations per build -- so it runs over a
// SAMPLE by default rather than all 182.
//
//   node tools/bench/local-optimality.js                  # sample across hunters, both budget modes
//   node tools/bench/local-optimality.js borge 8          # 8 borge fixtures
//   node tools/bench/local-optimality.js borge 8 level    # force one budget mode

const H = require('./harness.js');

const Space = H.Space;
const [hunterArg, countArg, modeArg] = process.argv.slice(2);
const SAMPLE = Number(countArg || 4);
const MODES = modeArg ? [modeArg] : ['spend', 'level'];

/** Every allocation one cheap move away, paired with a label. */
function neighbours(defs, deps, minVal, budget, alloc) {
  const out = [];
  const spent = Space.costOf(defs, alloc);
  const idle = budget - spent;

  // Spend an idle point.
  if (idle > 0) {
    for (const d of defs) {
      if ((d.cost || 1) > idle) continue;
      if (!Space.isEligible(d, defs, deps, minVal, alloc)) continue;
      out.push({ label: `+1 ${d.id}`, alloc: { ...alloc, [d.id]: (alloc[d.id] || 0) + 1 } });
    }
  }
  // Move a single point.
  for (const from of defs) {
    if ((alloc[from.id] || 0) <= 0) continue;
    for (const to of defs) {
      if (to.id === from.id) continue;
      const next = { ...alloc, [from.id]: alloc[from.id] - 1 };
      Space.clearInvalidDescendants(defs, deps, minVal, next);
      if (!Space.isEligible(to, defs, deps, minVal, next)) continue;
      next[to.id] = (next[to.id] || 0) + 1;
      if (Space.costOf(defs, next) > budget) continue;
      if (!Space.isLegal(defs, deps, minVal, next, budget)) continue;
      out.push({ label: `${from.id} -> ${to.id}`, alloc: next });
    }
  }
  return out;
}

(async () => {
  const known = H.loadKnownBuilds();
  const hunters = hunterArg ? [hunterArg] : ['borge', 'ozzy', 'knox'];
  let failures = 0;
  let checked = 0;

  for (const hunter of hunters) {
    // Spread the sample across the level range rather than taking the cheapest few.
    const all = known[hunter].filter((f) => f.mode === 'loot');
    const step = Math.max(1, Math.floor(all.length / SAMPLE));
    const picks = all.filter((_, i) => i % step === 0).slice(0, SAMPLE);

    for (const fx of picks) {
      const build = await H.parseBuildCode(fx.code);
      if (!build) continue;

      for (const budgetMode of MODES) {
        const cfg = H.cfgForImport(hunter, build, { budgetMode });
        const scorer = await H.makeScorer(cfg, 'loot');
        const res = await H.Optimizer.optimize(cfg, { mode: 'loot', scorer });
        const { talentAlloc, attrAlloc } = res.best;

        const score = (t, a) => H.evaluateAllocation(cfg, t, a).then((r) => r.loot);
        const baseline = await score(talentAlloc, attrAlloc);

        const probes = [
          ...neighbours(cfg.TALENTS, {}, {}, cfg.TALENT_BUDGET, talentAlloc)
            .map((n) => ({ ...n, talentAlloc: n.alloc, attrAlloc })),
          ...neighbours(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, cfg.ATTRIBUTE_BUDGET, attrAlloc)
            .map((n) => ({ ...n, talentAlloc, attrAlloc: n.alloc })),
        ];

        let best = null;
        for (const p of probes) {
          const s = await score(p.talentAlloc, p.attrAlloc);
          if (s > baseline && (!best || s > best.score)) best = { label: p.label, score: s };
        }

        checked++;
        const idleT = cfg.TALENT_BUDGET - Space.costOf(cfg.TALENTS, talentAlloc);
        const idleA = cfg.ATTRIBUTE_BUDGET - Space.costOf(cfg.ATTRIBUTES, attrAlloc);
        const tag = `${hunter}/${fx.set}#${fx.index} lvl${build.level} [${budgetMode}]`;
        if (best) {
          failures++;
          console.log(`FAIL ${tag}`);
          console.log(`      returned ${baseline.toFixed(2)}, but "${best.label}" scores ${best.score.toFixed(2)} `
            + `(+${(100 * (best.score - baseline) / baseline).toFixed(2)}%)`);
          console.log(`      idle: ${idleT} talent, ${idleA} attribute; ${probes.length} moves probed`);
        } else {
          console.log(`pass ${tag}  ${baseline.toFixed(2)}  (${probes.length} moves probed, idle ${idleT}T/${idleA}A)`);
        }
      }
    }
  }

  console.log(`\n${checked} build(s) checked; ${failures} where a single move beat the optimizer's answer`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
