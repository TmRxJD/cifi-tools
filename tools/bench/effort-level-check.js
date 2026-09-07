'use strict';
// EVERY SHIPPED EFFORT LEVEL MUST RETURN A BUILD, ON EVERY HUNTER.
//
//   node tools/bench/effort-level-check.js [--sample=N]
//
// THE BUG THIS EXISTS FOR WAS USER-VISIBLE AND SHIPPED. `fast` -- an option in the UI's dropdown --
// THREW on ozzy@11:
//     ozzy@11  fast      THROWS  Optimizer left 1 talent point(s) unspent while "revival" could...
//     ozzy@11  complete  ok
// A level-11 Ozzy player choosing Fast got an exception instead of a build.
//
// ROOT CAUSE: two definitions of "acceptably spent", disagreeing by exactly one point.
// Space.MAX_IDLE_POINTS is 1 -- the legality model deliberately permits one idle point, because a
// budget cannot always be spent exactly (a cost-2 node with one point left), and isLegal, transfer
// and canonicalFill all honour it. The Stage 3 assertion demanded ZERO. So a build legal by the
// space's own rules was a crash by the assertion's. A thorough search happens to place the last
// point; a cheaper one leaves it idle, which is why only the cheap effort level failed.
//
// Nothing covered this because every quality gate runs at the default effort. Coverage of the
// OTHER shipped level was zero, exactly as `boss` and `bossTimeless` had zero coverage while being
// offered in the same UI.
//
// This asserts the weakest useful property -- it RETURNS something legal -- rather than a quality
// bar, because quality at reduced effort is a separate question and a gate that conflates them
// would fail for the wrong reason.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const SAMPLE = Number(opt('sample', 2));

let failures = 0;
let checked = 0;

(async () => {
  const known = H.loadKnownBuilds();
  const levels = Object.keys(H.Optimizer.EFFORT_LEVELS);
  if (!levels.length) { console.log('FAIL  no shipped effort levels found'); process.exit(1); }
  console.log(`shipped effort levels: ${levels.join(', ')}`);

  // The CHEAPEST builds per hunter, deliberately: an underspent budget is likeliest where the
  // budget is small and a single point is a large fraction of it, which is where this failed.
  const picks = [];
  for (const h of ['borge', 'ozzy', 'knox']) {
    const sorted = known[h].slice().sort((a, b) => (a.level || 0) - (b.level || 0));
    picks.push(...sorted.slice(0, SAMPLE));
  }
  console.log(`${picks.length} build(s): ${picks.map((f) => f.name).join(' ')}`);
  console.log('');

  for (const fx of picks) {
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const scorer = await H.makeScorer(cfg, fx.mode || 'loot');
    for (const effort of levels) {
      checked++;
      try {
        // TIME-CAPPED, BECAUSE THIS GATE'S COST GREW WITH A NEW EFFORT TIER AND IT LOOKED LIKE A
        // HANG. Adding `exhaustive` (19200 archive evals, refine 16, cross-block forced) made this
        // 3 hunters x 3 levels instead of x2, with the new level several times the cost of
        // Complete: measured 21.7 CPU-MINUTES and still running, inside a suite that runs gates
        // sequentially, so the whole suite stalled behind it.
        //
        // Capping is sound HERE specifically because of what this gate asserts: that every shipped
        // effort level RETURNS A LEGAL, FULLY-SPENT BUILD. A truncated run still returns one -- the
        // cap is checked at stage boundaries precisely so it cannot yield a partial allocation --
        // so the property under test survives. It would NOT be sound in a gate comparing SCORES,
        // where truncation makes the number irreproducible.
        //
        // Skipping the expensive tier instead would be worse: it is a dropdown option users can
        // pick, and the whole reason this gate exists is that a shipped option threw.
        const res = await H.Optimizer.optimize(cfg, {
          // 45s, NOT 90s. The cap bounds each RUN; the gate runs 18 of them (6 builds x 3 levels),
          // so 90s bounded a single optimize at 27 MINUTES for the suite -- it still overran a
          // 900s budget. What matters here is that each level returns a legal fully-spent build,
          // and a truncated run demonstrates that as well as a converged one, so the cheaper cap
          // loses nothing this gate is actually asserting.
          // 15s, DOWN FROM 45s. At 45 this was 910s solo and 1,407s when run alongside other
          // gates -- 35% of a 2,700s suite, and the long pole that bounded every attempt to
          // parallelise it. The same reasoning that justified 45 justifies 15, and more strongly:
          // a SHORTER run is MORE likely to leave a point unspent, which is precisely the failure
          // this gate exists for (`fast` threw on ozzy@11 for exactly that). Cheaper and stricter
          // point the same way here, which is rare enough to be worth saying out loud.
          mode: fx.mode || 'loot', scorer, effort, maxSeconds: 15,
        });
        if (!res.best) throw new Error('returned no build');
        const legal = H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES,
          cfg.ATTRIBUTE_MIN_VALUE, res.best.attrAlloc, cfg.ATTRIBUTE_BUDGET);
        if (!legal) throw new Error('returned an ILLEGAL attribute allocation');
        console.log(`ok    ${fx.name.padEnd(10)} ${effort.padEnd(9)} ${res.evals} evals`);
      } catch (e) {
        failures++;
        console.log(`FAIL  ${fx.name.padEnd(10)} ${effort.padEnd(9)} ${String(e.message).slice(0, 100)}`);
      }
    }
  }

  console.log('');
  if (!checked) { console.log('FAIL  effort-level-check ran nothing'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} of ${checked} (build, effort) combination(s) failed`); process.exit(1); }
  console.log(`PASS  ${checked} (build, effort) combinations across ${levels.length} shipped levels`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
