'use strict';
// DONOR RECOMBINATION IN THE SHIPPED PATH: does it fire, and does it ever hurt?
//
//   node tools/bench/corpus-recombine-check.js
//
// Recombination crosses one donor's TALENTS with another's ATTRIBUTES, which is a cross-block move
// obtained without searching for one. It produced the largest single gain measured in this effort
// -- ozzy@70 from -44.02% to -1.98% -- on a build with 59 donors below it and 5 above, whose own
// climb gained only 1.78 points.
//
// TWO PROPERTIES, and only the second is a real gate:
//   1. IT FIRES. `diag.corpusRecombined` must show pairs admitted, or the feature is inert and
//      looks wired -- this project's most repeated failure.
//   2. IT NEVER REGRESSES. Recombined builds enter as EXTRA finalists and Stage 3 takes the
//      maximum, so the returned build can only improve. That is an argument, not a measurement,
//      and this is the measurement.

const H = require('./harness.js');

const ITERS = 1000;
// NOISE FLOOR. Evaluation is deterministic for a given (allocation, iterations), so there is no
// seed variance here -- what remains is EVALUATION error: FINAL_ITERATIONS carries ~0.12% mean
// (worst 0.35%), so a comparison of two scores carries roughly 0.2-0.3%. A delta under 0.3% is not
// a difference, which is why the regression bar below is -0.3% rather than 0.
const NOISE_FLOOR_PCT = 0.3;
const NAMES = (process.argv[2] || 'knox@12,ozzy@11,borge@42').split(',');

(async () => {
  const known = H.loadKnownBuilds();
  let failures = 0;
  let fired = 0;
  let checked = 0;

  for (const name of NAMES.map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const res = await H.Optimizer.optimize(cfg, {
        mode, scorer: pooled.score,
        effort: { archiveEvals: 1200, refineSupports: 3, seeds: [0x9e3779b9] },
      });
      const got = primary(await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, ITERS));
      const target = primary(await H.evaluateAllocation(cfg, build.talents, build.attributes, ITERS));
      const rc = (res.diag && res.diag.corpusRecombined) || null;
      checked++;
      if (rc && rc.admitted > 0) fired++;

      // The returned build must still be at least as good as the import. Recombination adds
      // candidates and Stage 3 maximises, so anything else means the finalist path is broken.
      const pct = (100 * (got - target)) / target;
      const bad = pct < -NOISE_FLOOR_PCT;
      if (bad) failures++;
      console.log(`${name.padEnd(10)} recombined ${rc ? `${rc.admitted}/${rc.offered}` : 'none'}`
        + `   vs import ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
        + (bad ? '   *** WORSE THAN THE IMPORT ***' : ''));
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (!fired) {
    console.log('FAIL  recombination never fired on any build -- it is wired but inert, which is');
    console.log('      indistinguishable from not shipping it at all.');
    process.exit(1);
  }
  if (failures) { console.log(`FAIL  ${failures} build(s) regressed`); process.exit(1); }
  console.log(`PASS  ${checked} build(s): recombination fired on ${fired}, none regressed`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
