'use strict';
// WHERE does an under-spent build lose value? underspend-test.js says THAT a repair fell short;
// this says WHICH stage lost it.
//
//   node tools/bench/underspend-diagnose.js <hunter> <fixtureIndex> [stripT] [stripA]
//
// The repair path has four points where value can go missing, and they have different fixes:
//
//   import            the untouched build, at its own full allocation -- the target
//   damaged           after stripping points out (what a real under-spent build looks like)
//   topped-up flat    what the top-up USED to do: Space.spendRemaining, declaration-order
//                     round-robin. Kept as the baseline because it is the thing the current
//                     top-up had to beat -- on a level-38 Borge it lands 12.06% below the
//                     import where filling by marginal value reproduces the import exactly.
//   incumbent refined after optimizeJointly from that top-up
//   enumerated best   the best allocation the support enumeration found independently
//   winner            what optimize() actually returned
//
// Everything is scored at FINAL_ITERATIONS so the numbers are comparable to each other and to
// what the build card displays -- screening scores are a ranking surrogate and would make a
// stage look better or worse than it is.

const H = require('./harness.js');

const Space = H.Space;
const [nameArg, stripTArg, stripAArg] = process.argv.slice(2);
if (!nameArg) {
  console.error('usage: node tools/bench/underspend-diagnose.js <fixture> [stripT] [stripA]');
  console.error('  <fixture> is hunter#index or hunter:SET#index, e.g. knox#22 or');
  console.error('  borge:KNOWN_BORGE_LATE_BUILDS#2. An ambiguous name is refused, not guessed.');
  process.exit(2);
}
const STRIP_T = Number(stripTArg || 12);
const STRIP_A = Number(stripAArg || 9);

function strip(defs, deps, minVal, alloc, n) {
  const out = { ...alloc };
  let removed = 0;
  let guard = 0;
  while (removed < n && guard++ < 1000) {
    let target = null;
    for (const d of defs) {
      if ((out[d.id] || 0) <= 0) continue;
      if (!target || out[d.id] > out[target.id]) target = d;
    }
    if (!target) break;
    out[target.id] -= 1;
    removed += target.cost || 1;
  }
  Space.clearInvalidDescendants(defs, deps, minVal, out);
  return out;
}

const top = (defs, alloc, n = 6) => defs
  .map((d) => [d.id, alloc[d.id] || 0])
  .filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1])
  .slice(0, n)
  .map(([k, v]) => `${k}:${v}`)
  .join(' ');

(async () => {
  const known = H.loadKnownBuilds();
  // Resolved through the shared strict resolver. `index` alone is NOT unique -- Borge's loot
  // fixtures collide over 0-10 across two sets -- and diagnosing a different build than the one
  // that failed is worse than not diagnosing it at all.
  const fx = H.findFixture(known, nameArg);
  const hunter = fx.hunter;
  const build = await H.parseBuildCode(fx.code);
  if (!build) throw new Error('could not parse the fixture build code');

  const cfg = H.cfgForImport(hunter, build, { budgetMode: 'level' });
  const noDeps = {};
  const noMin = {};
  const deps = cfg.ATTRIBUTE_DEPENDENCIES;
  const minVal = cfg.ATTRIBUTE_MIN_VALUE;

  const score = async (t, a) => (await H.evaluateAllocation(cfg, t, a)).loot;

  const impT = Space.costOf(cfg.TALENTS, build.talents);
  const impA = Space.costOf(cfg.ATTRIBUTES, build.attributes);
  console.log(`${fx.uid} lvl${build.level}`);
  console.log(`budgets: ${cfg.TALENT_BUDGET}T ${cfg.ATTRIBUTE_BUDGET}A   import spends ${impT}T ${impA}A`
    + `${impT > cfg.TALENT_BUDGET || impA > cfg.ATTRIBUTE_BUDGET ? '   <-- IMPORT IS NOT REACHABLE' : ''}`);
  console.log('');

  const importScore = await score(build.talents, build.attributes);
  console.log(`import          ${importScore.toFixed(2)}`);
  console.log(`   talents ${top(cfg.TALENTS, build.talents)}`);
  console.log(`   attrs   ${top(cfg.ATTRIBUTES, build.attributes)}`);

  const dT = strip(cfg.TALENTS, {}, {}, build.talents, STRIP_T);
  const dA = strip(cfg.ATTRIBUTES, deps, minVal, build.attributes, STRIP_A);
  const damagedScore = await score(dT, dA);
  const rel = (s) => `${(100 * (s - importScore) / importScore).toFixed(2)}%`;
  console.log(`damaged         ${damagedScore.toFixed(2)}  ${rel(damagedScore)}   `
    + `(${Space.costOf(cfg.TALENTS, dT)}T ${Space.costOf(cfg.ATTRIBUTES, dA)}A spent)`);

  // The OLD top-up, kept as the baseline the current one had to beat.
  const tuT = { ...dT };
  const tuA = { ...dA };
  Space.clearInvalidDescendants(cfg.ATTRIBUTES, deps, minVal, tuA);
  Space.spendRemaining(cfg.TALENTS, noDeps, noMin, cfg.TALENT_BUDGET, tuT);
  Space.spendRemaining(cfg.ATTRIBUTES, deps, minVal, cfg.ATTRIBUTE_BUDGET, tuA);
  const toppedScore = await score(tuT, tuA);
  console.log(`topped up flat  ${toppedScore.toFixed(2)}  ${rel(toppedScore)}   `
    + `(${Space.costOf(cfg.TALENTS, tuT)}T ${Space.costOf(cfg.ATTRIBUTES, tuA)}A spent)`);
  console.log(`   talents ${top(cfg.TALENTS, tuT)}`);
  console.log(`   attrs   ${top(cfg.ATTRIBUTES, tuA)}`);

  // Now the real search, from the damaged incumbent.
  const damagedCfg = { ...cfg, currentTalents: dT, currentAttrs: dA };
  const scorer = await H.makeScorer(damagedCfg, 'loot');
  const res = await H.Optimizer.optimize(damagedCfg, { mode: 'loot', scorer, scorerFor: H.scorerFactory(damagedCfg) });
  const winner = res.best;
  const winScore = await score(winner.talentAlloc, winner.attrAlloc);
  console.log('');
  console.log(`optimizer       ${winScore.toFixed(2)}  ${rel(winScore)}   `
    + `(${Space.costOf(cfg.TALENTS, winner.talentAlloc)}T `
    + `${Space.costOf(cfg.ATTRIBUTES, winner.attrAlloc)}A spent)`);
  console.log(`   talents ${top(cfg.TALENTS, winner.talentAlloc)}`);
  console.log(`   attrs   ${top(cfg.ATTRIBUTES, winner.attrAlloc)}`);

  // Is the winner the incumbent's own line, or an enumerated support?
  const sameAs = (a, b, defs) => defs.every((d) => (a[d.id] || 0) === (b[d.id] || 0));
  console.log(`   winner == topped-up incumbent: `
    + `${sameAs(winner.talentAlloc, tuT, cfg.TALENTS) && sameAs(winner.attrAlloc, tuA, cfg.ATTRIBUTES)}`);

  if (res.notes?.length) console.log(`\nnotes: ${res.notes.join(' | ')}`);
  console.log(`evals ${res.evals}`);

  // THE DIAGNOSIS. Which stage is responsible decides which code to change.
  console.log('');
  if (winScore >= importScore) {
    console.log('VERDICT: repaired -- the optimizer met or beat the untouched import.');
  } else if (impT > cfg.TALENT_BUDGET || impA > cfg.ATTRIBUTE_BUDGET) {
    console.log('VERDICT: NOT REACHABLE -- the import spends more than the level-derived budget '
      + 'allows, so this is inferred-level, not search.');
  } else {
    console.log(`VERDICT: genuine search shortfall of ${rel(winScore)}.`);
    console.log(`   the old flat top-up sat at ${rel(toppedScore)}; the current pipeline reaches `
      + `${rel(winScore)}.`);
    console.log('   If the winner is far below the import while the flat baseline is close, the '
      + 'regression is in the search. If BOTH are far below, the build is a joint peak in '
      + '(talent support, attribute depth) -- check where the import support ranks when '
      + 'screened against the topped-up attributes; that is the pass meant to catch it.');
  }
})().catch((e) => { console.error(e); process.exit(1); });
