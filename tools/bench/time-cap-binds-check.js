'use strict';
// THE CAP MUST BOUND WALL CLOCK ON AN EXPENSIVE RUN, NOT JUST SET A FLAG.
//
//   node tools/bench/time-cap-binds-check.js [--cap=20]
//
// `time-cap-check` proves the cap FIRES and returns a legal build under an absurd 1ms cap. It does
// NOT prove the cap bounds a run that would otherwise be long, and that gap hid a real defect: the
// deadline was checked in refinement and polish but NOT in the archive stage -- which is exactly
// what the Exhaustive tier doubles. Measured before the fix: borge@12 at exhaustive ran 20,125
// evaluations under a 45s cap. Uncapped it is 564s / 23,880 evaluations, so the cap was bounding
// almost nothing.
//
// This is the property that matters for leaving a machine running unattended, and it is the reason
// to have both checks: one asks "does the mechanism work", this one asks "does it actually stop".
//
// THE CONTRACT IS A CONSTANT FLOOR, NOT A MULTIPLE. The cap is checked at STAGE BOUNDARIES, and
// one unit of work is indivisible: refinement always completes its FIRST elite (breaking at i=0
// would return an unrefined build), and at `exhaustive` that single elite is tens of seconds. So
// the overrun is a roughly FIXED cost, not a proportional one -- which is why this checks
// `cap + FLOOR` rather than `cap * k`. A multiplicative tolerance would pass trivially at a large
// cap and fail unavoidably at a small one, testing the cap size rather than the mechanism.
//
// Progression measured while fixing this, each number from this bench:
//     no deadline in archive or polish   564s   (uncapped baseline: 564s -- bounding nothing)
//     archive checked                    115s
//     archive + polish rounds checked     73s
// The residue is the refinement floor. FLOOR is set from that measurement, not chosen.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const CAP = Number(opt('cap', 20));
const FLOOR_SECONDS = 60;   // one indivisible refinement elite at the most expensive tier

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, 'borge@12');
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
  const scorer = await H.makeScorer(cfg, 'loot');

  // The MOST expensive shipped tier, deliberately: a cap that bounds only cheap runs is untested
  // where it is actually needed.
  const t0 = Date.now();
  const res = await H.Optimizer.optimize(cfg, {
    mode: 'loot', scorer, effort: 'exhaustive', maxSeconds: CAP,
  });
  const secs = (Date.now() - t0) / 1000;

  const tSpend = H.Space.costOf(cfg.TALENTS, res.best.talentAlloc);
  const aSpend = H.Space.costOf(cfg.ATTRIBUTES, res.best.attrAlloc);
  const fullySpent = tSpend === cfg.TALENT_BUDGET && aSpend === cfg.ATTRIBUTE_BUDGET;

  console.log(`exhaustive on ${fx.name} with maxSeconds=${CAP}`);
  console.log(`  ran ${secs.toFixed(0)}s   ${res.evals} evals   truncated=${!!res.truncated}`
    + `   spend ${tSpend}/${cfg.TALENT_BUDGET},${aSpend}/${cfg.ATTRIBUTE_BUDGET}`);
  console.log(`  (uncapped this tier measured 564s / 23,880 evals on this same build)`);

  let failures = 0;
  const allowed = CAP + FLOOR_SECONDS;
  if (secs > allowed) {
    console.log(`  *** NOT BOUNDED: ran ${secs.toFixed(0)}s against a ${CAP}s cap `
      + `+ ${FLOOR_SECONDS}s refinement floor = ${allowed}s allowed ***`);
    failures++;
  }
  // A bounded run that returns a broken build is worse than no cap at all.
  if (!fullySpent) { console.log('  *** truncated build is UNDER-SPENT ***'); failures++; }
  if (!res.best) { console.log('  *** returned no build ***'); failures++; }

  console.log('');
  if (failures) { console.log(`FAIL  ${failures} problem(s)`); process.exit(1); }
  console.log(`PASS  the cap bounded the most expensive tier and still returned a complete build`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
