'use strict';
// THE ADAPTIVE GATE: EXPENSIVE WORK ONLY WHERE THE BUILD NEEDS IT.
//
//   node tools/bench/cross-block-gate-check.js
//
// The cross-block pass costs +31% on a high-level Borge (226s -> 296s, against a 300s ceiling) and
// was measured finding NOTHING inside corpus coverage -- `crossBlockGains` confirmed it fired and
// accepted nothing. That is not a defect: inside coverage the donor pool already holds a build at
// this level, so the polish starts past the coupling barrier the pass exists to cross. Its measured
// +2.18 points on ozzy@11 came from the research bench's leave-one-out, which the shipped path
// never does.
//
// So it is gated on the MEASURED distance to the nearest usable donor, not on hunter or level.
//
// GATE, both directions -- a one-directional check would pass on a permanently-off feature:
//   1. A build WITH a near donor must NOT run the pass (no wasted cost).
//   2. `crossBlock: true` must still force it (the override works, so the gate cannot silently
//      become "never").
// Direction 2 is the one that matters. This project's recurring failure is the feature that looks
// wired and is inert, and a gate is the easiest possible place for that to happen unnoticed.

const H = require('./harness.js');

const ITERS = 1000;
const NAMES = (process.argv[2] || 'ozzy@11,knox@12').split(',');

(async () => {
  const known = H.loadKnownBuilds();
  let failures = 0;
  let checked = 0;

  for (const name of NAMES.map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const run = async (crossBlock) => {
        const effort = { archiveEvals: 1200, refineSupports: 3, seeds: [0x9e3779b9] };
        if (crossBlock !== undefined) effort.crossBlock = crossBlock;
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, { mode, scorer: pooled.score, effort });
        return {
          secs: (Date.now() - t0) / 1000,
          near: (res.diag && res.diag.corpus && res.diag.corpus.nearestLevelDistance),
          ran: !!(res.diag && res.diag.polish && res.diag.polish.crossBlockRan),
        };
      };

      const dflt = await run(undefined);
      const forced = await run(true);
      checked++;

      const nearDonor = Number.isFinite(dflt.near) && dflt.near <= 2;
      const gateOk = !nearDonor || !dflt.ran;      // near donor => default must not run it
      const forceOk = forced.ran;                  // the override must still work

      console.log(`${name.padEnd(10)} nearest donor ${String(dflt.near)}`
        + `   default ran=${dflt.ran} (${dflt.secs.toFixed(0)}s)`
        + `   forced ran=${forced.ran} (${forced.secs.toFixed(0)}s)`
        + (gateOk ? '' : '   *** GATE LEAKED: paid for the pass with a near donor ***')
        + (forceOk ? '' : '   *** OVERRIDE DEAD: crossBlock:true did not run it ***'));
      if (!gateOk) failures++;
      if (!forceOk) failures++;
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} gate problem(s)`); process.exit(1); }
  console.log(`PASS  ${checked} build(s): the pass is skipped where a near donor exists and still forceable`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
