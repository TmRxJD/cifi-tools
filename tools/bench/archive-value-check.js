'use strict';
// HOW MUCH OF THE ARCHIVE IS DOING ANYTHING? Same build, shrinking archive budgets.
//
//   node tools/bench/archive-value-check.js [--only=a,b,c] [--budgets=1200,400,100]
//
// THE QUESTION. `fast` (archiveEvals 1200) was measured returning the SAME build as `complete`
// (9600) on nine builds, including the three boss-critical ones -- 0.00% on all three. That kills
// the old "the archive is load-bearing for ozzy@62" note, but it does not answer the next
// question: is 1200 also more than needed? If the corpus donor and the VND climb decide the
// answer, the archive may be near-pure overhead on any build the corpus covers, and the shipped
// default is paying for it on every run.
//
// WHY THIS IS NOT JUST effort-value-check WITH SMALLER NUMBERS. That compares two SHIPPED levels
// and is the gate for whether an option earns its place. This varies one dimension in isolation
// with everything else pinned, which is what you need before changing a default -- and it reports
// the archive's own diag (cells, kill bands, boss reach) so a collapse in COVERAGE is visible even
// when the returned score is unchanged. A budget cut that quietly stops reaching bosses would look
// identical to a free win if only the score were compared.
//
// NOISE FLOOR: two FINAL_ITERATIONS scores differ by ~0.2% from sampling alone, so anything under
// ~1% is not a difference. The interesting result here is EXACT equality, which is what the
// previous nine-build comparison produced.
//
// REPORT, not a gate: it informs a default, and that choice is the project owner's.

const H = require('./harness.js');
const { NOISE_PCT } = require('./verdict.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@73,ozzy@62,knox@30');
const BUDGETS = opt('budgets', '1200,400,100').split(',').map(Number);
const ITERS = 1000;

(async () => {
  const known = H.loadKnownBuilds();
  console.log(`archive budgets: ${BUDGETS.join(', ')} (everything else pinned to Fast)`);
  console.log(`differences under ~${NOISE_PCT.meaningful}% are sampling, not signal\n`);

  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    let fx; try { fx = H.findFixture(known, name); } catch { continue; }
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const scoreCtx = (mode === 'boss' || mode === 'bossTimeless') && Number.isFinite(fx.bossStage)
      ? { bossTarget: fx.bossStage } : undefined;
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);

    let base = null;
    for (const archiveEvals of BUDGETS) {
      const pooled = await H.makePooledScorer(cfg, mode, scoreCtx);
      try {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, {
          mode,
          scorer: pooled.score,
          // Everything except the archive budget is held at Fast's settings, so any difference is
          // attributable to the archive and nothing else.
          effort: { archiveEvals, refineSupports: 3 },
          maxSeconds: 0,   // no cap: a truncated arm would measure the cap, not the archive
        });
        const secs = (Date.now() - t0) / 1000;
        const score = primary(await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, ITERS));
        const a = (res.diag && res.diag.archive) || {};
        if (base === null) base = score;
        const pct = 100 * (score - base) / Math.abs(base);
        console.log(`${String(fx.name).padEnd(10)} archive ${String(archiveEvals).padStart(5)}`
          + `  ${secs.toFixed(0).padStart(4)}s  ${String(res.evals).padStart(6)} evals`
          + `  cells ${String(a.cells ?? '?').padStart(4)}`
          + `  killBands ${String(a.killBands ?? '?').padStart(2)}`
          + `  bestKill ${String(a.bestKillReached ?? '?').padStart(4)}`
          + `  vs first ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`);
      } finally { await pooled.destroy(); }
    }
    console.log('');
  }
  console.log('If the score is unchanged as the budget falls, the archive is not deciding these');
  console.log('builds -- but check cells/killBands too: coverage can collapse before the score does.');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
