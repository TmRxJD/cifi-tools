'use strict';
// DOES RUNNING k ARCHIVES AND REFINING THE MOST PROMISING BEAT ONE ARCHIVE?
//
//   node tools/bench/bet-and-run-check.js --only=knox@30,ozzy@60 [--k=3]
//
// The failure this targets is BIMODAL, not gradual: ozzy@62 returns +15.34% on one seed and -66.27%
// on another with nothing between. That is a heavy-tailed outcome distribution, and restart
// portfolios are the standard answer. Bet-and-run runs k streams and continues only the best.
//
// Cheap here because of where the time goes: illumination is ~10% of wall clock and refinement
// ~87%, so k archives plus ONE refinement is about 1.2x at k=3, against 3x for best-of-k full runs.
//
// NOT the multi-seed merge already measured and lost -- that split one budget three ways and left
// each stream too shallow. Each stream here gets the FULL archiveEvals.
//
// The per-stream table is printed whatever the outcome, because the interesting question is not
// only "did it win" but "did the streams actually DIFFER in boss reach". If every stream reaches
// the same depth there is nothing for a portfolio to choose between, and that is a finding about
// the search rather than about bet-and-run.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'knox@30');
const K = Number(opt('k', 3));
const POOL = opt('pool', null) ? Number(opt('pool', null)) : undefined;
// --ocba runs BOTH arms with OCBA polish. The two are orthogonal -- OCBA makes the polish cheaper,
// bet-and-run picks a better archive to polish -- and the arithmetic is why they belong together:
// OCBA measured 1.24x faster and k=3 costs about 1.2x, so the portfolio is close to free.
const OCBA = args.includes('--ocba');

(async () => {
  const known = H.loadKnownBuilds();
  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const imported = await H.evaluateAllocation(cfg, build.talents, build.attributes);
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const pooled = await H.makePooledScorer(cfg, mode, undefined, POOL);
    try {
      const per = {};
      for (const k of [1, K]) {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, {
          mode,
          scorer: pooled.score,
          effort: { archiveEvals: 9600, refineSupports: 8, breakpointSpending: true, betAndRun: k, ocbaPolish: OCBA },
        });
        // ASSERT FROM THE RESULT. A betAndRun that silently did one stream would report the
        // control's number as the portfolio's, which is the false negative this project keeps
        // producing.
        const recorded = res.diag && res.diag.betAndRun;
        if (k > 1 && (!recorded || recorded.streams !== k)) {
          throw new Error(`${name}: asked for betAndRun=${k} but the run recorded `
            + `${recorded ? recorded.streams : 'nothing'} -- the flag is not reaching the archive`);
        }
        if (k === 1 && recorded) throw new Error(`${name}: betAndRun was 1 but the run recorded a portfolio`);
        const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc);
        const d = H.Objective.describeRun(got);
        per[k] = {
          pct: 100 * (primary(got) - primary(imported)) / primary(imported),
          secs: (Date.now() - t0) / 1000,
          regime: d.regime,
          bar: res.diag && res.diag.betAndRun,
        };
        console.log(`${name.padEnd(10)} betAndRun ${String(k).padStart(2)}  `
          + `${per[k].pct.toFixed(2).padStart(8)}%  ${per[k].secs.toFixed(0).padStart(4)}s  ${per[k].regime}`);
        if (per[k].bar) {
          console.log(`           streams: ${per[k].bar.perStream.map((s) => `${s.seed.toString(16)}(cells ${s.cells}, kill ${s.bestKillReached}, viol ${Math.round(s.bestViolation ?? 100)})`).join('  ')}`);
          console.log(`           chose ${per[k].bar.chosenSeed.toString(16)}`);
        }
      }
      const delta = per[K].pct - per[1].pct;
      const cost = per[K].secs / Math.max(0.001, per[1].secs);
      console.log(`           => ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} points for ${cost.toFixed(2)}x the time`);
      console.log('');
    } finally { await pooled.destroy(); }
  }
  console.log(OCBA ? 'BOTH arms used OCBA polish, so the comparison isolates the portfolio.'
    : 'OCBA polish was OFF in both arms.');
  console.log('one seed per stream is still ONE SAMPLE of each stream; this measures whether the');
  console.log('portfolio picks a better archive, not how often it does so across accounts.');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
