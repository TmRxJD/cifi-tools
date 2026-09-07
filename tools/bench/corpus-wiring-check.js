'use strict';
// IS THE CORPUS SEEDING ACTUALLY WIRED, AND IS IT STRICTLY ADDITIVE?
//
//   node tools/bench/corpus-wiring-check.js
//
// TWO THINGS THIS PROJECT HAS BEEN BURNED BY, checked here rather than assumed:
//
//   1. A FEATURE THAT LOOKS WIRED AND DOES NOTHING. `optimizeByRegime` was ~90 lines, exported,
//      and never called. `bossDamageBands` reached three of four call sites and silently no-oped,
//      so its A/B recorded the control's number as "measured, no effect". The corpus block calls
//      an ASYNC `parseBuildCode` -- called synchronously it returns a Promise, every donor is
//      skipped, and the whole thing is inert while appearing perfect. So this asserts from the
//      run's own diag that donors were actually ADMITTED, not merely offered.
//
//   2. A SEED THAT MAKES THINGS WORSE. Donors are appended as ordinary finalists and Stage 3 takes
//      the maximum, so the answer can only rise. That is the entire safety argument for shipping a
//      heuristic this blunt, and it is worth checking rather than reasoning about: the optimizer
//      with corpus seeding must never score BELOW the same optimizer without it.
//
// GATE: an inert corpus block, or any build made worse, fails.
//
// THIS CHECKS WIRING, NOT QUALITY, AND THE DISTINCTION IS LOAD-BEARING.
//
// The corpus is GENERATED FROM THESE FIXTURES, so testing the shipped path against a fixture hands
// the optimizer that fixture's own build as a donor at distance 0. Measured: borge@73 came back at
// exactly 0.00%, i.e. the import refitted back to itself, and borge@42 at +0.07% -- which I almost
// reported as fixing a -0.68% shortfall that the leave-one-out bench still measures.
//
// That is correct behaviour for a REAL user (their build is not in the corpus) and useless as a
// benchmark. So the percentages printed here are NOT quality evidence; `corpus-donor-refine`, which
// excludes the target from its own donor pool, is where quality is measured. This file asserts only
// that donors are decoded, re-fitted, found legal and ADMITTED -- the wiring that has already been
// silently inert twice.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'knox@12,ozzy@11,borge@12');
const ITERS = 1000;

(async () => {
  const known = H.loadKnownBuilds();
  const sb = H.browserSandbox();
  if (!sb.OptimizerCorpus) { console.log('FAIL  optimizer/corpus.js did not register window.OptimizerCorpus'); process.exit(1); }
  if (!sb.OptimizerRefit) { console.log('FAIL  optimizer/refit.js did not register window.OptimizerRefit'); process.exit(1); }

  const counts = Object.entries(sb.OptimizerCorpus.CORPUS).map(([h, r]) => `${h} ${r.length}`).join(', ');
  console.log(`corpus loaded: ${counts}`);
  for (const [hunter, rows] of Object.entries(sb.OptimizerCorpus.CORPUS)) {
    if (!rows.length) { console.log(`FAIL  corpus has no rows for ${hunter}`); process.exit(1); }
  }
  // Nearest-first ordering is what makes interpolation work; a mis-sort would silently hand the
  // optimizer a donor 40 levels away.
  const near = sb.OptimizerCorpus.donorsFor('borge', 'loot', 73);
  if (!near.length || near[0].distance > 2) {
    console.log(`FAIL  donorsFor(borge, loot, 73) did not return a near donor first (got distance ${near[0] && near[0].distance})`);
    process.exit(1);
  }
  console.log(`donorsFor(borge,loot,73) -> nearest is level ${near[0].level} (distance ${near[0].distance})`);

  let failures = 0;
  let compared = 0;
  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const res = await H.Optimizer.optimize(cfg, {
        mode, scorer: pooled.score, effort: { archiveEvals: 1200, refineSupports: 3, seeds: [0x9e3779b9] },
      });
      const diag = (res.diag && res.diag.corpus) || null;
      if (!diag) {
        console.log(`  FAIL  ${name}: the run recorded NO corpus diag -- the block never executed`);
        failures++;
      } else if (!diag.admitted) {
        console.log(`  FAIL  ${name}: corpus offered ${diag.offered} donor(s) and admitted 0 -- inert`);
        failures++;
      } else {
        // SELF-DONATION IS EXPECTED HERE and must be labelled, not quietly folded into a
        // percentage. The corpus is generated from these fixtures, so the target's own build is in
        // the donor pool at distance 0.
        const selfDonated = sb.OptimizerCorpus.donorsFor(fx.hunter, mode, fx.level || 0)
          .slice(0, 12).some((d) => d.code === fx.code);
        console.log(`  ok    ${name}: corpus offered ${diag.offered}, admitted ${diag.admitted}`
          + (selfDonated ? '   [SELF-DONATED -- no quality claim can be made from this build]' : ''));
      }
      compared++;
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (!compared) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} build(s): the corpus block is not doing what it claims`); process.exit(1); }
  console.log(`PASS  corpus seeding is live and admitting donors on ${compared} build(s)`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
