'use strict';
// MORE POINTS MUST NEVER PRODUCE A WORSE BUILD -- in every mode, with no fixtures required.
//
//   node tools/bench/budget-monotonicity-check.js [--hunter=knox] [--modes=loot,boss] [--steps=5]
//
// WHY THIS EXISTS. Every existing quality gate compares the optimizer against a recorded import,
// so it can only cover modes people have published builds for: of 182 fixtures, 168 are `loot` and
// 14 are `push`. `boss` and `bossTimeless` -- two of the four modes the UI offers -- have NEVER
// been tested for search quality, because there is nothing to compare them against.
//
// That gap matters more than it looks. The boss objective is lexicographic over a kill RATE that
// moves in visible steps (95.7 -> 85.7 -> 64.5 -> 43.8 -> 36.4 -> 0 as Soul Of Ares is stripped),
// which is precisely the threshold-shaped landscape where coordinate exchange was just measured
// failing on `loot`: on a level-31 Knox the talent block reaches 6,473 where the answer is 64,031,
// because Power Of Gaia is worthless at level 3 and no pairwise transfer can rebuild it.
//
// Budget monotonicity needs no reference build. Raising the budget cannot make the true optimum
// worse -- more talent and attribute levels are more stats, and the game has no mechanic that
// penalises them -- so if optimize(budget + k) scores BELOW optimize(budget), the search failed on
// the larger problem. It is a property of the OPTIMIZER, checkable on any build, in any mode.
//
// Two things it deliberately does NOT assume:
//   * That the feasible sets are nested. They are not: every allocation must leave at most
//     MAX_IDLE_POINTS idle, so a solution legal at budget N is usually illegal at N+k. The claim
//     is about the OPTIMUM, not about reusing a specific allocation.
//   * That a violation must be a search bug. It could also be real game non-monotonicity. The
//     report prints the allocations on both sides so the two can be told apart, rather than
//     asserting a cause it has not established.
//
// Scored at FINAL_ITERATIONS throughout, because a screening-fidelity comparison would report
// ~0.9% of noise as violations.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const HUNTERS = opt('hunter', 'borge,ozzy,knox').split(',');
const MODES = opt('modes', 'loot,push,boss,bossTimeless').split(',');
const STEPS = Number(opt('steps', 4));
// Below the tolerance a "violation" is measurement noise rather than a search failure. The
// evaluator is exactly deterministic, so repeated scoring of ONE allocation cannot vary -- but two
// different allocations at 1000 iterations still carry sampling error against each other.
const TOL = Number(opt('tol', 0.5));

const top = (defs, a, n = 6) => defs.map((d) => [d.id, a[d.id] || 0]).filter(([, v]) => v > 0)
  .sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(' ');

(async () => {
  const known = H.loadKnownBuilds();
  let violations = 0;
  let checked = 0;

  for (const hunter of HUNTERS) {
    // One mid-level build per hunter: high enough that the trees have real structure, low enough
    // that four optimize runs per mode finish. The fixture supplies account state (overrides,
    // base stats); only the BUDGET is varied.
    const loot = known[hunter].filter((f) => f.mode === 'loot');
    const fx = loot[Math.floor(loot.length / 2)];
    const build = await H.parseBuildCode(fx.code);
    if (!build) continue;
    const base = H.cfgForImport(hunter, build, { budgetMode: 'spend' });

    for (const mode of MODES) {
      const scores = [];
      for (let i = 0; i < STEPS; i++) {
        // Walk the budget up in even slices of the import's own spend.
        const frac = (i + 1) / STEPS;
        const cfg = {
          ...base,
          TALENT_BUDGET: Math.max(1, Math.round(base.TALENT_BUDGET * frac)),
          ATTRIBUTE_BUDGET: Math.max(1, Math.round(base.ATTRIBUTE_BUDGET * frac)),
        };
        delete cfg.currentTalents;
        delete cfg.currentAttrs;
        const scorer = await H.makeScorer(cfg, mode);
        let res;
        try {
          res = await H.Optimizer.optimize(cfg, { mode, scorer, scorerFor: H.scorerFactory(cfg) });
        } catch (err) {
          console.log(`ERR  ${hunter}/${mode} budget ${cfg.TALENT_BUDGET}T: ${err.message}`);
          break;
        }
        // Score every rung on the SAME objective at full fidelity.
        const [s] = await scorer([{ talentAlloc: res.best.talentAlloc, attrAlloc: res.best.attrAlloc }],
          H.Optimizer.FINAL_ITERATIONS);
        scores.push({ budget: `${cfg.TALENT_BUDGET}T/${cfg.ATTRIBUTE_BUDGET}A`, score: s, best: res.best, cfg });
      }

      for (let i = 1; i < scores.length; i++) {
        checked++;
        const prev = scores[i - 1];
        const cur = scores[i];
        const drop = 100 * (cur.score - prev.score) / Math.abs(prev.score || 1);
        if (drop < -TOL) {
          violations++;
          console.log(`FAIL ${hunter}/${mode}: ${prev.budget} scored ${prev.score.toFixed(2)} but the `
            + `LARGER ${cur.budget} scored ${cur.score.toFixed(2)} (${drop.toFixed(2)}%)`);
          console.log(`       smaller T ${top(base.TALENTS, prev.best.talentAlloc)}`);
          console.log(`       smaller A ${top(base.ATTRIBUTES, prev.best.attrAlloc)}`);
          console.log(`       larger  T ${top(base.TALENTS, cur.best.talentAlloc)}`);
          console.log(`       larger  A ${top(base.ATTRIBUTES, cur.best.attrAlloc)}`);
        }
      }
      const line = scores.map((s) => `${s.budget}=${s.score.toFixed(1)}`).join('  ');
      console.log(`${violations ? '    ' : 'ok  '} ${hunter}/${mode.padEnd(13)} ${line}`);
    }
  }

  console.log('');
  console.log(`${checked} budget step(s) compared across ${HUNTERS.length} hunter(s) x ${MODES.length} mode(s)`);
  console.log(violations
    ? `${violations} MONOTONICITY VIOLATION(S): a larger budget produced a worse build, which the `
      + 'game cannot explain -- the search failed on the larger problem'
    : 'raising the budget never produced a worse build in any mode');
  process.exit(violations ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
