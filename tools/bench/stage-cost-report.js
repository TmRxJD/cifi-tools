'use strict';
// WHERE DOES A RUN ACTUALLY SPEND ITS TIME? Per-stage seconds, per effort level.
//
//   node tools/bench/stage-cost-report.js [--only=borge@44] [--efforts=fast,complete]
//
// WHY. Every optimization attempt in this project has started from a guess about which stage is
// expensive, and the guesses have been wrong in both directions: a 45s cap was added to a bench
// expecting a speedup and bought nothing because the cost was in a stage the cap never touched,
// and separately the archive was assumed to be ~10% of wall clock when at `complete`'s budget it
// is a large fraction of the difference between the two levels.
//
// `diag.timings` was declared empty and never written, so there was no way to check. It is now
// populated per stage; this prints it, sorted, with each stage's share.
//
// REPORT, not a gate: it tells you where to look, it does not assert anything.

const H = require('./harness.js');
const { makeBudget } = require('./budget.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@44');
const EFFORTS = opt('efforts', 'fast,complete').split(',').map((s) => s.trim());

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  const budget = makeBudget(args, { minutes: 20 });
  let done = 0;

  for (const name of names) {
    if (budget.stop(done, names.length)) break;
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';

    for (const effort of EFFORTS) {
      const pooled = await H.makePooledScorer(cfg, mode);
      try {
        const t0 = Date.now();
        // No cap: a truncated run would report the cap's stage split, not the level's.
        const res = await H.Optimizer.optimize(cfg, { mode, scorer: pooled.score, effort, maxSeconds: 0 });
        const total = (Date.now() - t0) / 1000;
        const t = (res.diag && res.diag.timings) || {};
        const ev = (res.diag && res.diag.evaluations) || {};
        console.log(`\n${fx.name} lvl${fx.level}  effort=${effort}  ${total.toFixed(0)}s total`
          + `  ${res.evals} evals (${ev.memoHitPct ?? '?'}% memo hits)`);
        Object.entries(t).sort((a, b) => b[1] - a[1]).forEach(([stage, secs]) => {
          const pct = total ? (100 * secs / total) : 0;
          const bar = '#'.repeat(Math.round(pct / 2));
          console.log(`   ${stage.padEnd(24)} ${String(secs).padStart(7)}s  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
        });
        const accounted = Object.values(t).reduce((a, b) => a + b, 0);
        console.log(`   ${'(unaccounted)'.padEnd(24)} ${(total - accounted).toFixed(1).padStart(7)}s`);
      } finally { await pooled.destroy(); }
    }
    done++;
  }
  budget.report(done, names.length);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
