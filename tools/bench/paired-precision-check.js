'use strict';
// HOW PRECISE IS A *COMPARISON* AT LOW FIDELITY? (Common Random Numbers)
//
//   node tools/bench/paired-precision-check.js [--only=borge@44] [--pairs=40]
//
// THE QUESTION THIS ANSWERS, AND WHY IT IS WORTH MORE THAN ANY MOVE-SET CHANGE. Every stage of the
// search spends its budget COMPARING allocations, and we size fidelity from the precision of an
// ABSOLUTE score (measured: 0.12% mean error at 1000 iterations). But absolute precision is the
// wrong statistic for a comparison.
//
// This evaluator is deterministic for a given (allocation, iterations) because determinism requires
// a FRESH WASM INSTANCE per call -- so every evaluation starts from the SAME RNG state and two
// allocations are simulated over the SAME random stream. That is Common Random Numbers, the
// standard variance-reduction technique for exactly this situation, and we appear to get it for
// free without ever having exploited it. Under CRN the DIFFERENCE between two designs is far more
// precisely estimated than either design alone, because the shared randomness cancels.
//
// If that holds here, comparisons could run at 250 iterations instead of 1000 -- a 4x speedup
// across the entire search, which dwarfs every move-set result measured so far.
//
// WHAT IS MEASURED: for many allocation PAIRS, does the low-fidelity comparison agree with the
// 1000-iteration one? Two statistics, because they fail differently:
//   - SIGN AGREEMENT: does cheap fidelity pick the same winner? This is what a search actually
//     needs, and it is the number that matters.
//   - DISAGREEMENT MAGNITUDE: when it picks wrong, how large was the true gap? Getting a 0.01%
//     tie backwards is harmless; getting a 2% gap backwards is not.
// A 0.32% ridge was once ranked BACKWARDS by 1.7% at 100 iterations and cost 1.64M on ozzy@62, so
// this is not a foregone conclusion -- it is the reason to measure rather than assume.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@44');
const PAIRS = Number(opt('pairs', 40));
const LADDER = (opt('ladder', '100,250,500')).split(',').map(Number);
const REF = 1000;

const capOf = (d) => (d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel);

(async () => {
  const known = H.loadKnownBuilds();
  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const legal = (a) => cfg.ATTRIBUTES.every((d) => (a[d.id] || 0) <= capOf(d))
      && H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPS || {}, minVal, a, cfg.ATTRIBUTE_BUDGET);

    // NEIGHBOURING allocations, not random ones. The search compares a build against its own
    // neighbours, so pairs drawn from anywhere in the space would measure an easier problem than
    // the one the optimizer actually faces -- distant pairs have huge gaps that any fidelity gets
    // right, which would flatter the cheap ruler.
    const pairs = [];
    const baseA = build.attributes;
    for (const from of cfg.ATTRIBUTES) {
      for (const to of cfg.ATTRIBUTES) {
        if (pairs.length >= PAIRS) break;
        if (from.id === to.id || (baseA[from.id] || 0) < 1) continue;
        const alt = { ...baseA };
        alt[from.id] -= 1;
        const room = Math.floor((cfg.ATTRIBUTE_BUDGET - H.Space.costOf(cfg.ATTRIBUTES, alt)) / (to.cost || 1));
        const add = Math.min(room, capOf(to) - (alt[to.id] || 0));
        if (add < 1) continue;
        alt[to.id] = (alt[to.id] || 0) + add;
        if (!legal(alt)) continue;
        pairs.push([baseA, alt]);
      }
      if (pairs.length >= PAIRS) break;
    }
    if (pairs.length < 5) { console.log(`${name}: only ${pairs.length} legal neighbour pairs -- skipping`); continue; }

    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const score = async (allocs, iters) => pooled.score(
        allocs.map((a) => ({ talentAlloc: build.talents, attrAlloc: a })), iters);
      const left = pairs.map((p) => p[0]);
      const right = pairs.map((p) => p[1]);
      const refL = await score(left, REF);
      const refR = await score(right, REF);
      const refDiff = refL.map((v, i) => refR[i] - v);

      // THE PREDICTOR UNDER TEST: is this build sitting ON a boss threshold?
      //
      // Hypothesis, from the first five builds measured: a PARTIAL kill rate (strictly between 0
      // and 100) means the run outcome is a coin flip the Monte Carlo has to resolve, so cutting
      // iterations makes the estimate jump discontinuously. A kill rate pinned at 0 or 100 is a
      // determined outcome and cheap to estimate. CRN cancels shared randomness in a SMOOTH
      // response and does nothing for a threshold that flips.
      //
      // borge@73 was the only one of five to fail at 500 iterations (4.874% reversed) and is the
      // only one with a partial kill rate (31.7). If that holds across more builds, fidelity can be
      // chosen from a MEASURABLE property of the build rather than a hunter or a level.
      const probe = await H.evaluateAllocation(cfg, build.talents, baseA, REF);
      const kill = probe.bossKillRate === undefined ? -1 : probe.bossKillRate;

      // PREDICTOR v2 -- DO NOT TRUST `bossHpPercent == 0`.
      //
      // v1 used a partial kill rate alone and leaked borge@84 (0.449% reversed while predicted
      // cheap). Its reading was `kill 0.00, hp 0.00`, which v1 took as "nowhere near a threshold" --
      // but hp reads 0 for TWO OPPOSITE situations, and at level 84 the build had CLEARED its wall
      // and died in the open stages beyond it. That is the fourth time this field has produced a
      // wrong answer in this project, and CLAUDE.md's standing instruction is to treat any new use
      // of it as a defect until it states which of the two zeros it handles. This one now does: it
      // does not read hp at all.
      //
      // The real question is whether a THRESHOLD OUTCOME FLIPS between runs, and there are two ways
      // that happens:
      //   1. a partial kill rate -- some runs kill the boss, some do not;
      //   2. the run's stage RANGE straddles a boss boundary -- some runs reach the wall at all and
      //      some die short, which is a threshold even when the kill rate is a flat 0.
      // Case 2 is what v1 was blind to, and it is exactly borge@84's situation.
      const BI = H.Objective.BOSS_INTERVAL;
      const lo = probe.minStage === undefined ? probe.avgStage : probe.minStage;
      const hi = probe.maxStage === undefined ? probe.avgStage : probe.maxStage;
      // THE STRADDLE RULE IS MEASURED-DEAD AND IS KEPT ONLY AS A REPORTED FIELD.
      // Added to catch borge@84 (0.449% reversed while predicted cheap). It did NOT catch it --
      // borge@84 runs 322.3-350.6, entirely between walls -- and it fired on 7 OTHER builds, ALL of
      // which were safe (<=0.059%): 100% false positives. It cut the builds eligible for the cheap
      // ruler from 15/22 to 9/22 and caught nothing. Do not re-enable it without new evidence.
      const straddles = Math.floor(lo / BI) !== Math.floor(hi / BI);
      const partialKill = kill > 0.05 && kill < 99.95;
      const onThreshold = partialKill;
      const why = partialKill ? 'partial-kill' : '';
      console.log(`${name}: ${pairs.length} neighbour pairs, reference ${REF} iterations`
        + `   killRate ${kill.toFixed(2)}  stage ${lo.toFixed(1)}-${hi.toFixed(1)}`
        + `   PREDICT ${onThreshold ? `NEEDS-HIGH-FIDELITY (${why})` : 'cheap-ok'}`);
      for (const it of LADDER) {
        const l = await score(left, it);
        const r = await score(right, it);
        let agree = 0; let worstMiss = 0;
        for (let i = 0; i < pairs.length; i++) {
          const d = r[i] - l[i];
          const same = (d >= 0) === (refDiff[i] >= 0);
          if (same) agree++;
          else {
            // How big was the TRUE gap we got backwards, relative to the build's own score?
            const rel = Math.abs(refDiff[i]) / Math.abs(refL[i] || 1) * 100;
            if (rel > worstMiss) worstMiss = rel;
          }
        }
        console.log(`  ${String(it).padStart(5)} iters: sign agreement ${agree}/${pairs.length}`
          + ` (${(100 * agree / pairs.length).toFixed(1)}%)`
          + `   worst TRUE gap called backwards: ${worstMiss.toFixed(3)}%`
          + `   speedup ${(REF / it).toFixed(1)}x`);
      }
      console.log('  A cheap ruler is safe only if the gaps it gets backwards are smaller than the');
      console.log('  differences the search must resolve. Read the worst-miss column, not the %.');
    } finally { await pooled.destroy(); }
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
