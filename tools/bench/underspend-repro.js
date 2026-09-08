'use strict';
// DOES THE UNDERSPEND CRASH STILL HAPPEN? Reproduce it, do not infer it from an old artifact.
//
//   node tools/bench/underspend-repro.js [--only=borge@65,borge@79]
//
// `archive-seeds.json` (generated 2026-09-05) records two builds whose optimize() THREW:
//   "Optimizer left 1 talent point(s) unspent while \"omen\" could still take one"
// That is a user-visible crash -- a player choosing that effort gets an exception instead of a
// build -- so it matters whether it is live or already fixed.
//
// It may well be STALE: `greedyTopUp` was later wired into the returned winner precisely for this,
// and it takes the best candidate UNCONDITIONALLY (it does not require an improvement), so it
// should always spend a spendable point. But "should" is what this project's notes warn about, and
// a dated artifact is not evidence about today's code. This runs the real optimizer at the efforts
// the crash was recorded under and reports what actually happens.
//
// GATE: any throw is a failure. An underspent-but-returned build is also a failure -- returning a
// build with value left on the table is the defect the assertion exists to catch, and silently
// weakening the assertion would hide it rather than fix it.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@65,ozzy@11,knox@12');
const EFFORTS = (opt('efforts', 'fast,complete')).split(',');

(async () => {
  const known = H.loadKnownBuilds();
  let failures = 0;
  let checked = 0;

  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    let fx; try { fx = H.findFixture(known, name); } catch (e) { console.log(`${name}: not a fixture -- skip`); continue; }
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';

    for (const effort of EFFORTS) {
      const pooled = await H.makePooledScorer(cfg, mode);
      try {
        // CAPPED AT 45s, AND THE CAP CANNOT HIDE WHAT THIS LOOKS FOR. This gate replays two
        // builds to see whether a historical CRASH is still live, and it was costing 938s to
        // answer that -- the third most expensive gate in the suite, for two optimize calls.
        //
        // The failure it hunts is an assertion inside optimize() that fires at Stage 3, and Stage
        // 3 runs whether or not the deadline passed (a cap that skipped it would return an
        // unranked build, so it is never skipped). The under-spend check therefore still happens.
        // If anything a capped run is MORE likely to leave a point unspent, which is the condition
        // being tested -- the original crash appeared on the cheap effort level, not the thorough
        // one.
        const res = await H.Optimizer.optimize(cfg, { mode, scorer: pooled.score, effort, maxSeconds: 45 });
        const tS = H.Space.costOf(cfg.TALENTS, res.best.talentAlloc);
        const aS = H.Space.costOf(cfg.ATTRIBUTES, res.best.attrAlloc);
        const full = tS === cfg.TALENT_BUDGET && aS === cfg.ATTRIBUTE_BUDGET;
        checked++;
        if (!full) failures++;
        console.log(`${name.padEnd(10)} ${effort.padEnd(10)} spend ${tS}/${cfg.TALENT_BUDGET},${aS}/${cfg.ATTRIBUTE_BUDGET}`
          + `  ${full ? 'ok' : '*** UNDER-SPENT ***'}`);
      } catch (e) {
        checked++; failures++;
        console.log(`${name.padEnd(10)} ${effort.padEnd(10)} *** THREW: ${e.message.slice(0, 110)}`);
      } finally { await pooled.destroy(); }
    }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures}/${checked} run(s) threw or under-spent`); process.exit(1); }
  console.log(`PASS  ${checked} run(s): no crash, every build fully spent`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
