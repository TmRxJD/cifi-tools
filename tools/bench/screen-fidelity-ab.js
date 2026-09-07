'use strict';
// IS THE ARCHIVE DECIDING ON NOISE? Vary ONLY screening fidelity, hold everything else fixed.
//
//   node tools/bench/screen-fidelity-ab.js --only=knox@30,knox@37 --seeds=3 [--hi=400]
//
// THE HYPOTHESIS. Every archive decision is made at SCREEN_ITERATIONS, which is a SAMPLE: ~0.9%
// mean deviation and ~1.2% rank inversions against 1000 iterations, with one measured case of a
// 0.32% ridge ordering BACKWARDS by 1.7%. MAP-Elites replaces a cell's occupant only with a
// higher-SCORING one, so under noise a cell retains whichever build got a LUCKY estimate rather
// than the best build -- the winner's curse. The QD literature names it: "lucky solutions might be
// kept in place of truly good-performing ones" (Uncertain Quality-Diversity, arXiv 2302.00463).
//
// THE TEST. If outcomes are driven by lucky estimates, raising screening fidelity must CHANGE them.
// If the answers barely move, the winner's curse is a good story that is not this search's problem,
// and that is a real finding rather than a failed experiment.
//
// WHAT MAKES THIS DIFFERENT FROM A PLAIN SPEED/QUALITY DIAL: nothing here is proposed for shipping.
// Higher screening is 4x the archive cost; the point is DIAGNOSIS, not a configuration to adopt.
//
// Rules this bench follows (MEASUREMENT.md):
//   - names the exact fixture, never hunter@level
//   - judges each build on ITS OWN objective (fixture.mode)
//   - judges BOTH arms at the same final fidelity, so the cheap arm is never scored on its own ruler
//   - asserts the fidelity FROM diag, refusing to produce a number if the run did not record it
//   - prints the comparison count; zero comparisons is a failure

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const NSEEDS = Number(opt('seeds', 3));
const HI = Number(opt('hi', 400));
const ARCHIVE_EVALS = Number(opt('archiveEvals', 9600));
const JUDGE_ITERS = 1000;
const SEEDS = [0x9e3779b9, 0x1234, 0xa5a5a5a5, 0xc0ffee, 0xbadf00d].slice(0, NSEEDS);

if (!ONLY) throw new Error('screen-fidelity-ab: --only= is required; name exact fixtures');

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`archiveEvals ${ARCHIVE_EVALS}  screening 100 vs ${HI}  seeds ${SEEDS.length}`);
  console.log(`builds: ${names.join(' ')}`);
  console.log('');

  let comparisons = 0;
  const spread = {};

  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const imported = await H.evaluateAllocation(cfg, build.talents, build.attributes, JUDGE_ITERS);
    spread[name] = { lo: [], hi: [] };

    for (const seed of SEEDS) {
      for (const iters of [100, HI]) {
        const pooled = await H.makePooledScorer(cfg, mode);
        let row;
        try {
          const t0 = Date.now();
          const res = await H.Optimizer.optimize(cfg, {
            mode,
            scorer: pooled.score,
            effort: {
              archiveEvals: ARCHIVE_EVALS, refineSupports: 8, seeds: [seed],
              breakpointSpending: true, screenIterations: iters,
            },
          });
          const a = (res.diag && res.diag.archive) || {};
          // ASSERT FROM THE RESULT. A flag that reaches three of four wiring sites has already
          // produced a silent false negative in this repo; an unwired one would make both arms the
          // control and the null result would be written down as "screening noise does not matter".
          if (a.screenIterations !== iters) {
            throw new Error(`${name}: asked screenIterations ${iters} but the run recorded `
              + `${a.screenIterations} -- this comparison would be a lie`);
          }
          const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, JUDGE_ITERS);
          row = {
            pct: 100 * (primary(got) - primary(imported)) / primary(imported),
            secs: (Date.now() - t0) / 1000,
            cells: a.cells,
            regime: (res.diag && res.diag.regime) || '',
          };
        } finally { await pooled.destroy(); }
        spread[name][iters === 100 ? 'lo' : 'hi'].push(row.pct);
        comparisons++;
        console.log(`${name.padEnd(10)} seed ${seed.toString(16).padStart(8)}  screen ${String(iters).padStart(4)}  `
          + `${row.pct.toFixed(2).padStart(8)}%  cells ${String(row.cells).padStart(4)}  ${row.secs.toFixed(0).padStart(4)}s  ${row.regime}`);
      }
    }
    console.log('');
  }

  if (!comparisons) { console.log('NOTHING MEASURED -- zero comparisons is a failure, not a pass'); process.exit(1); }

  const rng = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
  console.log('SEED SPREAD PER BUILD (max - min across seeds). The hypothesis predicts the HIGH-');
  console.log('fidelity arm is TIGHTER: if lucky estimates decide cells, better estimates decide better.');
  for (const name of names) {
    const s = spread[name];
    console.log(`  ${name.padEnd(10)} screen 100: spread ${rng(s.lo).toFixed(2).padStart(7)} pts  `
      + `[${s.lo.map((v) => v.toFixed(2)).join(', ')}]`);
    console.log(`  ${' '.repeat(10)} screen ${String(HI).padEnd(3)}: spread ${rng(s.hi).toFixed(2).padStart(7)} pts  `
      + `[${s.hi.map((v) => v.toFixed(2)).join(', ')}]`);
  }
  console.log('');
  console.log(`${comparisons} comparison(s). REPORT -- this diagnoses a cause; it proposes no shipped change.`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
