'use strict';
// DOES SOLVING ONE SUBPROBLEM PER REGIME FIND THE BUILD ONE SEARCH CANNOT?
//
//   node tools/bench/regime-decomposition-check.js --only=borge@73
//
// The claim being tested, stated before running so the result cannot be reinterpreted:
//
//   WIN      the decomposed answer beats the unconstrained one on the TRUE objective, on a build
//            where the unconstrained search is known to fail, AND loses nowhere else.
//   NEUTRAL  no difference beyond the ~7-point seed variance already measured for this search.
//   LOSS     the decomposed answer is worse anywhere. (It should be structurally impossible for
//            the WINNER to be worse, since subproblem 0 IS the unconstrained search and the final
//            choice is a max over candidates on the true objective -- so a loss here means a bug,
//            not a tuning problem. That is exactly why it is worth asserting.)
//
// It also reports, per regime, whether the subproblem SATISFIED its own constraint. "No feasible
// build was found" and "no feasible build exists" are different claims and this project has
// conflated them before; the report keeps them apart.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@73');
const EVALS = Number(opt('archiveEvals', 9600));
const REFINE = Number(opt('refineSupports', 8));

let failures = 0;

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY.split(',').map((x) => x.trim()).filter(Boolean);

  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const reference = await H.evaluateAllocation(cfg, build.talents, build.attributes);

    const bare = { ...cfg };
    delete bare.currentTalents;
    delete bare.currentAttrs;
    const pooled = await H.makePooledScorer(bare, fx.mode || 'loot');

    try {
      const effort = {
        archiveEvals: EVALS, refineSupports: REFINE, structuralShare: 0.35, depthShare: 0,
        selection: 'curiosity', seeds: [0x9e3779b9], breakpointSpending: true,
      };
      const t0 = Date.now();
      const res = await H.Optimizer.optimizeByRegime(bare, {
        mode: fx.mode || 'loot', scorer: pooled.score, effortPerRegime: effort,
      });
      const secs = Math.round((Date.now() - t0) / 1000);

      const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc);
      const d = H.Objective.describeRun(got);
      const pct = 100 * (got.loot - reference.loot) / reference.loot;

      console.log(`\n${name}  reference ${reference.loot.toFixed(0)}  (${H.Objective.describeRun(reference).regime})`);
      console.log('per-subproblem, every score on the TRUE objective:');
      for (const r of res.byRegime) {
        console.log(`  ${String(r.label).padEnd(14)} true ${r.trueScore.toFixed(0).padStart(14)}  `
          + `maxStage ${r.maxStage.toFixed(1).padStart(6)}  kill ${String(r.killRate).padStart(5)}  `
          + `satisfied ${r.satisfied === null ? 'n/a' : (r.satisfied ? 'YES' : 'no ')}  ${r.secs}s`);
      }
      console.log(`chosen: ${res.chosenRegime === null ? 'unconstrained' : 'clears ' + res.chosenRegime}`);
      console.log(`result: ${d.summary}`);
      console.log(`vs reference: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%   total ${secs}s, ${res.evals} evals`);

      // The winner is a max over candidates that INCLUDES the unconstrained one, so it can never
      // be below it. If it is, the selection is broken -- assert rather than trust.
      const free = res.byRegime.find((r) => r.regime === null);
      const chosen = res.byRegime.find((r) => r.regime === res.chosenRegime);
      if (chosen.trueScore < free.trueScore) {
        failures++;
        console.log(`FAIL  ${name}: chose a candidate scoring BELOW the unconstrained one `
          + `(${chosen.trueScore} < ${free.trueScore}); the max over subproblems is broken`);
      }
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (failures) { console.log(`FAIL  ${failures} check(s) failed`); process.exit(1); }
  console.log('PASS  the decomposition never returns worse than the unconstrained search');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
