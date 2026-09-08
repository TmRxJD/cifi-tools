'use strict';
// HOW MUCH OF THE ARCHIVE IS DOING ANYTHING? Same build, shrinking archive budgets.
//
//   node tools/bench/archive-value-check.js [--only=a,b,c] [--values=1200,400,100]
//   node tools/bench/archive-value-check.js --dim=refineSupports --values=8,5,3 --base=complete
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
// FIRST RESULT: 1200 IS ALREADY AT THE KNEE. DO NOT SHRINK IT FURTHER.
//
//   borge@73  1200->100  147s -> 126s (-14%)  score +0.00%  cells 115->62  killBands 9->7  bestKill 99->96
//   ozzy@62   1200->100  164s -> 137s (-16%)  score +0.00%  cells  75->26  killBands 1->1  bestKill  0-> 0
//   knox@30   1200->100   63s ->  59s ( -6%)  score +0.00%  cells   5-> 5  (already degenerate)
//
// The score never moves, which invites the conclusion that the archive is free to delete. The
// TIME says otherwise: total evaluations barely change (13,983 -> 13,800), because at 1200 the
// archive is already a small fraction of the run and the climb dominates. So the trade on offer
// is ~14% wall clock in exchange for measurably less coverage -- and coverage is the insurance for
// builds the CORPUS does not cover, which is not these three. Corpus coverage is partial (knox
// donors stop at level 40), so paying 14% to keep it is the right side of that trade.
//
// This is why the check reports cells/killBands/bestKill and not just the score: judged on score
// alone, "archive 100" looks like a free 14% win on every build here.
//
// REPORT, not a gate: it informs a default, and that choice is the project owner's.

const H = require('./harness.js');
const { NOISE_PCT } = require('./verdict.js');
const { makeBudget } = require('./budget.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@73,ozzy@62,knox@30');
// WHICH DIMENSION TO SWEEP, and what to hold everything else at. `complete` differs from `fast`
// on TWO dimensions -- archiveEvals (9600 vs 1200) and refineSupports (8 vs 3) -- so a probe that
// could only vary the archive was unable to say which of the two was buying anything. Everything
// not being swept is pinned to `--base`, so a difference is attributable to the swept dimension
// and nothing else.
const DIM = opt('dim', 'archiveEvals');
const BASE = opt('base', 'fast');
const BUDGETS = (opt('values', null) || opt('budgets', '1200,400,100')).split(',').map(Number);
const ITERS = 1000;

(async () => {
  const known = H.loadKnownBuilds();
  const baseSpec = H.Optimizer.EFFORT_LEVELS[BASE];
  if (!baseSpec) throw new Error(`unknown --base="${BASE}"; expected one of `
    + Object.keys(H.Optimizer.EFFORT_LEVELS).join(', '));
  if (!(DIM in baseSpec)) throw new Error(`--dim="${DIM}" is not a field of the ${BASE} effort `
    + `level (${Object.keys(baseSpec).join(', ')}) -- sweeping a key the spec does not read would `
    + 'produce three identical arms and look like a null result');
  console.log(`sweeping ${DIM}: ${BUDGETS.join(', ')} (everything else pinned to ${BASE})`);
  console.log(`differences under ~${NOISE_PCT.meaningful}% are sampling, not signal\n`);

  // One optimizer run per (build, budget) pair -- three each by default.
  const names = ONLY.split(',').map((x) => x.trim()).filter(Boolean);
  const budget = makeBudget(args, { minutes: 20 });
  let done = 0;
  for (const name of names) {
    if (budget.stop(done, names.length)) break;
    let fx; try { fx = H.findFixture(known, name); } catch { continue; }
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const scoreCtx = (mode === 'boss' || mode === 'bossTimeless') && Number.isFinite(fx.bossStage)
      ? { bossTarget: fx.bossStage } : undefined;
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);

    let base = null;
    for (const value of BUDGETS) {
      const pooled = await H.makePooledScorer(cfg, mode, scoreCtx);
      try {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, {
          mode,
          scorer: pooled.score,
          // Everything except the swept dimension is held at the base level's settings, so a
          // difference is attributable to that dimension and nothing else. `label`/`help` are
          // dropped: they are metadata and EFFORT_SPEC_KEYS would accept them, but carrying them
          // into a synthetic spec makes the arm look like a shipped level in any diag that reads
          // the label.
          effort: (() => {
            const spec = { ...baseSpec, [DIM]: value };
            delete spec.label; delete spec.help;
            return spec;
          })(),
          maxSeconds: 0,   // no cap: a truncated arm would measure the cap, not the archive
        });
        const secs = (Date.now() - t0) / 1000;
        const score = primary(await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, ITERS));
        const a = (res.diag && res.diag.archive) || {};
        if (base === null) base = score;
        const pct = 100 * (score - base) / Math.abs(base);
        console.log(`${String(fx.name).padEnd(10)} ${DIM} ${String(value).padStart(5)}`
          + `  ${secs.toFixed(0).padStart(4)}s  ${String(res.evals).padStart(6)} evals`
          + `  cells ${String(a.cells ?? '?').padStart(4)}`
          + `  killBands ${String(a.killBands ?? '?').padStart(2)}`
          + `  bestKill ${String(a.bestKillReached ?? '?').padStart(4)}`
          + `  vs first ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`);
      } finally { await pooled.destroy(); }
    }
    done++;
    console.log('');
  }
  budget.report(done, names.length);
  console.log('If the score is unchanged as the budget falls, the archive is not deciding these');
  console.log('builds -- but check cells/killBands too: coverage can collapse before the score does.');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
