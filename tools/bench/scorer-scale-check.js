'use strict';
// ARE THE TWO SCORERS THE SAME QUANTITY? If not, every percentage the corpus benches print is a
// comparison between two different rulers, and the numbers mean nothing.
//
//   node tools/bench/scorer-scale-check.js
//
// corpus-donor-refine climbs using pooled.score(pairs, ITERS) -- which is Objective.scoreFor(mode,
// result, ctx) -- but computes its reported delta against primary(evaluateAllocation(...)), which
// is r.loot for loot mode and r.stage for push. Those are only comparable if the objective score
// for a mode IS that field. This asserts it on real allocations rather than assuming it.
//
// Verified with a negative control: comparing loot mode against the PUSH field must fail.

const H = require('./harness.js');

(async () => {
  const known = H.loadKnownBuilds();
  const names = ['borge@32', 'knox@30', 'knox@31'];
  let bad = 0;
  let checked = 0;

  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);

    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const pair = { talentAlloc: build.talents, attrAlloc: build.attributes };
      const viaPool = (await pooled.score([pair], 1000))[0];
      const viaEval = primary(await H.evaluateAllocation(cfg, build.talents, build.attributes, 1000));
      checked++;
      const rel = Math.abs(viaPool - viaEval) / Math.max(1e-9, Math.abs(viaEval));
      const ok = rel < 1e-9;
      if (!ok) bad++;
      console.log(`${name.padEnd(10)} ${mode.padEnd(5)} pooled ${viaPool.toFixed(6).padStart(18)}  `
        + `evaluateAllocation ${viaEval.toFixed(6).padStart(18)}  rel ${rel.toExponential(2)}  ${ok ? 'SAME' : 'DIFFERENT -- deltas are meaningless'}`);

      // NEGATIVE CONTROL: the same result read through the WRONG field must not match, or this
      // check would pass no matter what and prove nothing.
      const r = await H.evaluateAllocation(cfg, build.talents, build.attributes, 1000);
      const wrong = mode === 'push' ? r.loot : r.stage;
      const wrongRel = Math.abs(viaPool - wrong) / Math.max(1e-9, Math.abs(wrong));
      if (wrongRel < 1e-9) {
        console.log(`  CONTROL FAILED on ${name}: the wrong field also matches, so this check cannot detect a mismatch`);
        bad++;
      }
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (bad) { console.log(`FAIL  ${bad} problem(s): the climb and the reported delta use different rulers`); process.exit(1); }
  console.log(`PASS  ${checked} build(s): pooled scorer == the field the delta is measured in`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
