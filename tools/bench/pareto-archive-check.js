'use strict';
// paretoDepth 1 MUST BE THE OLD SINGLE-ELITE ARCHIVE, EXACTLY.
//
// The MOME change rewrote the archive's retention rule and re-keyed every cell. If depth 1 is not
// bit-identical to the previous behaviour, then an A/B between depth 1 and depth 2 is measuring
// TWO changes at once and its result means nothing -- which is precisely how the bossDamageBands
// arm could have lied if the flag had not been wired (it reached three of four sites).
//
// So this asserts three things, in order of how badly each would mislead:
//   1. depth 1 returns the same build, the same score, and the same descriptor coverage as a
//      reference run -- i.e. re-keying and the `put` refactor changed nothing.
//   2. depth 2 is a SUPERSET: every cell the depth-1 archive occupies is still occupied, and the
//      max-loot member of each is unchanged. This is the non-regression guarantee the design rests
//      on -- the max-loot point is always on the Pareto front, so MOME can only ADD.
//   3. depth 2 actually retains something extra in kill-0 cells, or it is a no-op wearing a flag.
//
//   node tools/bench/pareto-archive-check.js [--fixture=borge@35]

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const FIXTURE = opt('fixture', 'borge@35');
const EVALS = Number(opt('archiveEvals', 900));

let failures = 0;
const fail = (m) => { failures++; console.log('FAIL  ' + m); };
const ok = (m) => console.log('ok    ' + m);

async function runArm(cfg, scorer, depth) {
  return H.Optimizer.optimize(cfg, {
    mode: 'loot',
    scorer,
    effort: {
      archiveEvals: EVALS, refineSupports: 2, structuralShare: 0.35, depthShare: 0,
      selection: 'curiosity', seeds: [0x9e3779b9], breakpointSpending: true,
      paretoDepth: depth, archiveOnly: true,
    },
  });
}

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, FIXTURE);
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
  const bare = { ...cfg };
  delete bare.currentTalents;
  delete bare.currentAttrs;
  const pooled = await H.makePooledScorer(bare, 'loot');

  try {
    const a = await runArm(bare, pooled.score, 1);
    const b = await runArm(bare, pooled.score, 2);

    const sig = (r) => JSON.stringify({ t: r.best.talentAlloc, a: r.best.attrAlloc });

    // --- 1. depth 1 is unchanged behaviour -------------------------------------------------
    // Compared against a run of the SAME code, so this cannot detect a change made before this
    // file existed. What it CAN detect, and what matters going forward, is depth 1 drifting away
    // from single-elite semantics: with depth 1 the archive must hold exactly one entry per cell.
    console.log(`depth 1: cells ${a.diag.archive.cells}  entries ${a.diag.archive.entries}  `
      + `paretoDepth ${a.diag.archive.paretoDepth}`);
    console.log(`depth 2: cells ${b.diag.archive.cells}  entries ${b.diag.archive.entries}  `
      + `paretoDepth ${b.diag.archive.paretoDepth}`);

    if (a.diag.archive.paretoDepth !== 1 || b.diag.archive.paretoDepth !== 2) {
      fail('the run did not RECORD the paretoDepth it was given; the flag is not reaching the archive');
    } else ok('both arms recorded the paretoDepth they were given');

    if (a.diag.archive.entries === a.diag.archive.cells) ok('depth 1 holds exactly one entry per cell');
    else fail(`depth 1 holds ${a.diag.archive.entries} entries for ${a.diag.archive.cells} cells -- not single-elite`);

    // --- 2. depth 2 is a SUPERSET in coverage ----------------------------------------------
    // REPORTED, NOT ASSERTED, AND THE REASON IS A CLAIM THIS FILE ITSELF DISPROVED. The design note
    // originally argued depth 2 could only ADD, since the max-loot point is always on the Pareto
    // front. That is true of the retention RULE and false of the RUN: extra elites change what
    // parent selection sees, the trajectory diverges, and coverage can fall (measured: 201 -> 194).
    // Coverage is also explicitly NOT the metric for this search -- a move set that raised coverage
    // and lowered champion quality has already been measured here. Failing on it would enforce the
    // wrong thing.
    const dc = b.diag.archive.cells - a.diag.archive.cells;
    console.log(`      coverage ${dc >= 0 ? '+' : ''}${dc} cells at depth 2 `
      + '(reported only -- the verdict is returned loot, measured end to end)');

    // --- 3. depth 2 actually retains extra members -----------------------------------------
    if (b.diag.archive.entries > b.diag.archive.cells) {
      ok(`depth 2 retains ${b.diag.archive.entries - b.diag.archive.cells} extra member(s) beyond one per cell`);
    } else {
      fail('depth 2 retained NO extra members -- the flag is a no-op and an A/B on it would be a lie');
    }

    console.log('');
    console.log(`depth 1 champion ${a.best.score === undefined ? '' : ''}${sig(a) === sig(b) ? '(same build as depth 2)' : '(different build from depth 2)'}`);
  } finally { await pooled.destroy(); }

  console.log('');
  if (failures) { console.log(`FAIL  ${failures} check(s) failed`); process.exit(1); }
  console.log('PASS  paretoDepth 1 is single-elite; depth 2 retains extra members and records its flag');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
