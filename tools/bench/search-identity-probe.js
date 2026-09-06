'use strict';
// A BIT-IDENTITY FINGERPRINT OF THE SEARCH, for verifying that a refactor changed nothing.
//
//   node tools/bench/search-identity-probe.js > before.txt
//   ...refactor...
//   node tools/bench/search-identity-probe.js > after.txt   # must be identical
//
// Deleting a flag that "is off anyway" is exactly the kind of change that looks free and is not:
// this search's own history includes a case where adding a single rng() call for a check that
// could never pass shifted every later draw and moved a result by 7 points. Removing one can do
// the same in reverse. So the claim "inert when off" gets VERIFIED rather than asserted, on the
// allocation itself rather than on a score that might coincide.
//
// Cheap on purpose (small archive, one cheap fixture) so it can be run either side of any edit.

const H = require('./harness.js');

const FIXTURES = ['ozzy@11', 'knox@12'];

(async () => {
  const known = H.loadKnownBuilds();
  for (const name of FIXTURES) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const scorer = await H.makeScorer(cfg, fx.mode || 'loot');
    const res = await H.Optimizer.optimize(cfg, {
      mode: fx.mode || 'loot',
      scorer,
      // NOT SMALLER THAN THIS. At archiveEvals 600 the optimizer THROWS
      // "left 1 talent point(s) unspent while revival could still take one" -- an invariant
      // refusing to return an underspent build. The guard is right, but it means a low effort
      // setting can HARD-FAIL rather than degrade, which is a real consideration for any plan to
      // cut the archive budget for speed.
      effort: { archiveEvals: 2400, refineSupports: 3, seeds: [0x9e3779b9] },
    });
    const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc);
    // The ALLOCATION is the fingerprint, not the score: two different builds can score alike, and
    // a refactor that quietly changes which build is returned is exactly what this must catch.
    const sig = JSON.stringify({ t: res.best.talentAlloc, a: res.best.attrAlloc });
    console.log(`${name}  evals=${res.evals}  cells=${res.diag.archive.cells}  `
      + `loot=${got.loot.toFixed(6)}  alloc=${sig}`);
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
