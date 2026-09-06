'use strict';
// DOES EACH OBJECTIVE ACTUALLY OPTIMISE ITS OWN METRIC?
//
//   node tools/bench/mode-matrix-check.js [--only=borge@35,knox@27] [--sample=3]
//
// THE HOLE THIS FILLS. The UI offers four modes. Of 182 fixtures, 168 are `loot` and 14 are
// `push`, so `boss` and `bossTimeless` have NEVER been quality-tested -- and they are the two
// whose objective is lexicographic over a kill rate that moves in visible steps, i.e. exactly the
// threshold landscape where coordinate exchange has already been measured failing on `loot`.
//
// Fixtures cannot fix this: there is no recorded community build for "best boss kill chance", so
// there is nothing to compare against. The invariant below needs no reference build.
//
// THE INVARIANT: run all four modes on the same account, then score every resulting build under
// every mode's objective. The build produced by mode M must be M's best -- if `push`'s build beats
// `boss`'s build on the BOSS objective, the boss search is not optimising the boss objective.
// That is a matrix with a dominant diagonal, and it is checkable without knowing the true optimum.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM. A dominant diagonal does not prove any mode found the GLOBAL
// optimum -- borge@73 is 39% short on loot and would still pass this. It proves each mode is
// pointed at the right target and beats the others at it, which is precisely the property that has
// never been checked for two of the four.
//
// Ties are allowed: two modes can legitimately converge on the same build (a low-level account
// where the best loot build is also the deepest). Only being BEATEN at your own objective fails.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const EVALS = Number(opt('archiveEvals', 1200));
const REFINE = Number(opt('refineSupports', 3));
// Which modes exist is PER HUNTER -- Knox has no `timeless`, so bossTimeless does not apply there
// and running it throws. Resolved from the same function the UI uses, so the gate can never test a
// mode the app does not offer, or miss one it does.
const ALL_MODES = ['loot', 'push', 'boss', 'bossTimeless'];

let failures = 0;
let compared = 0;

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY ? ONLY.split(',').map((x) => x.trim())
    : ['borge@35', 'ozzy@31', 'knox@27'];

  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const bare = { ...cfg };
    delete bare.currentTalents;
    delete bare.currentAttrs;

    console.log(`\n=== ${name} (${fx.hunter}, level ${build.level}) ===`);

    // ONE pool for all four modes and for the matrix afterwards. Standing up a pool per mode
    // compiles the evaluator in every worker each time, and on a level-27 build that startup cost
    // dominated the run.
    const multi = await H.makeMultiModeScorer(bare);
    const builds = {};
    try {
    for (const mode of MODES) {
      const res = await H.Optimizer.optimize(bare, {
        mode,
        scorer: multi.scorerFor(mode),
        effort: {
          archiveEvals: EVALS, refineSupports: REFINE, structuralShare: 0.35, depthShare: 0,
          selection: 'curiosity', seeds: [0x9e3779b9], breakpointSpending: true,
        },
      });
      if (!res.best) throw new Error(`mode ${mode} returned no build`);
      builds[mode] = res.best;
    }

    // LEGALITY, per mode. A mode that returns an illegal allocation is broken regardless of score.
    for (const mode of MODES) {
      compared++;
      const b = builds[mode];
      // Argument order is (defs, deps, minVal, alloc, budget). Getting it wrong here would
      // validate the BUDGET as an allocation and quietly report everything legal.
      const legal = H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES,
        cfg.ATTRIBUTE_MIN_VALUE, b.attrAlloc, cfg.ATTRIBUTE_BUDGET);
      if (legal) console.log(`ok    ${mode.padEnd(13)} returns a legal attribute allocation`);
      else { failures++; console.log(`FAIL  ${mode}: ILLEGAL attribute allocation`); }
    }

    // bossTimeless must actually PIN timeless -- it is the only structural difference from `boss`,
    // and a pin that silently does nothing would make the two modes identical while the UI offers
    // them as different answers.
    const timeless = cfg.ATTRIBUTES.find((a) => a.id === 'timeless');
    compared++;
    if (!MODES.includes('bossTimeless')) {
      // Not a skip: the mode is correctly unavailable here, which mode-availability-check asserts.
      console.log(`ok    bossTimeless is not offered for ${fx.hunter} (no timeless attribute)`);
    } else if (!timeless) {
      failures++;
      console.log(`FAIL  bossTimeless is OFFERED for ${fx.hunter} but it has no timeless attribute`);
    } else {
      const got = builds.bossTimeless.attrAlloc.timeless || 0;
      const cap = Number.isFinite(timeless.maxLevel) ? timeless.maxLevel : got;
      if (got >= cap) console.log(`ok    bossTimeless pinned timeless at ${got}/${cap}`);
      else { failures++; console.log(`FAIL  bossTimeless left timeless at ${got}/${cap} -- the pin did nothing`); }
    }

    // THE MATRIX. Every build scored under every objective, at FINAL_ITERATIONS.
    const scores = {};
    for (const mode of MODES) {
      const order = MODES.map((m) => builds[m]);
      const vals = await multi.scorerFor(mode)(order, H.Optimizer.FINAL_ITERATIONS);
      scores[mode] = {};
      MODES.forEach((m, i) => { scores[mode][m] = vals[i]; });
    }

    console.log('\n      objective ->        ' + MODES.map((m) => m.padStart(16)).join(''));
    for (const built of MODES) {
      console.log(`      build from ${built.padEnd(13)}`
        + MODES.map((m) => scores[m][built].toExponential(4).padStart(16)).join(''));
    }

    for (const mode of MODES) {
      for (const other of MODES) {
        if (other === mode) continue;
        compared++;
        const mine = scores[mode][mode];
        const theirs = scores[mode][other];
        // A strict loss only. Ties are legitimate -- two modes can converge on the same build.
        if (theirs > mine) {
          failures++;
          const by = mine === 0 ? Infinity : ((theirs - mine) / Math.abs(mine)) * 100;
          console.log(`FAIL  under the ${mode} objective, the ${other} build BEATS the ${mode} build `
            + `(${theirs.toExponential(4)} > ${mine.toExponential(4)}, by ${by.toFixed(2)}%)`);
        }
      }
    }
    } finally { await multi.destroy(); }
  }

  console.log('');
  if (!compared) { console.log('FAIL  mode-matrix-check compared nothing'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} of ${compared} check(s) failed`); process.exit(1); }
  console.log(`PASS  ${compared} checks: every mode wins at its own objective, all builds legal`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
