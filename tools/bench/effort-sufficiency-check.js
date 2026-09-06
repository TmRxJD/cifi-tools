'use strict';
// IS THE SHIPPED EFFORT DOING WORK THAT CHANGES THE ANSWER?
//
//   node tools/bench/effort-sufficiency-check.js --sample=8
//   node tools/bench/effort-sufficiency-check.js --only=borge@35,ozzy@54
//
// NOT A FISHING TRIP FOR SOMETHING ALREADY REJECTED. Two cheaper-search ideas are measured and
// dead, and neither is retried here:
//   - polish shortlisting (rank the neighbourhood at SCREEN_ITERATIONS, verify only the top few):
//     on ozzy@62 a top-12 shortlist returned 38,238,568 against a full scan's 39,881,450 -- 1.64M
//     given away, because a 100-iteration score has been measured ordering a 0.32% ridge BACKWARDS
//     by 1.7%.
//   - archiveEvals 4800 instead of 9600: fails Ozzy boss reachability outright (-66.27%).
//
// WHAT IS UNTESTED IS refineSupports. Measured cost breakdown on borge@12: ~4,200 real evaluations
// in 276s. Screening costs 11.9ms each, so it accounts for ~50s -- meaning roughly 2,200
// FULL-FIDELITY evaluations consume ~87% of the run, and those come from refinement and polish,
// whose width is refineSupports (8 at Complete, 3 at Fast). Halving it roughly halves the sweep.
//
// The archive is visibly saturated on these builds -- 9,600 variations filling 37-68 cells with
// ~60% cache hits -- but it is only ~10% of wall clock, so cutting it cannot save much even where
// it is safe. Recorded so nobody spends a day there.
//
// THE VERDICT IS ON THE GATE'S CONCLUSION, NOT ON THE SCORE. A cheaper arm that returns a
// different-but-still-passing build is not a regression in the gate's terms; one that drops below
// its import where the full arm cleared it is.

const H = require('./harness.js');

// POOL SIZE, so an experiment can share the machine with a running sweep instead of waiting hours
// for it. Oversubscribing cores does not corrupt anything -- the evaluator is deterministic and
// the pool is asserted bit-identical to serial -- but it slows BOTH jobs, so a background
// experiment should take the spare capacity rather than a full pool.
const POOL = (() => {
  const f = process.argv.find((a) => a.startsWith('--pool='));
  return f ? Number(f.slice('--pool='.length)) : undefined;
})();

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const SAMPLE = Number(opt('sample', 6));
const SEED = Number(opt('seed', 20260905));
const MAXLEVEL = Number(opt('max-level', 70));

//
// IS THE ARCHIVE EARNING ITS COST? Three independent measurements say it may not be:
//   - knox@30's archive holds SIX cells. 9,600 variations feeding a 6-slot hill climber.
//   - MOME retained 118 extra stepping stones on borge@73 and the returned build was BIT-IDENTICAL.
//   - This repo's own note: "Borge's archive varies 17.8% between seeds and its FINAL answer is
//     0.00% every time -- refinement recovers from any archive it is handed."
// The QD literature agrees this is a real failure mode rather than a local quirk: MAP-Elites has
// "lack of directed search" causing "slow convergence even in low-dimensional search spaces", and
// its overhead "may not always justify the computational cost, particularly in scenarios with
// limited diversity requirements" -- which is exactly a six-cell archive.
//
// So the arms test the STRUCTURE, not just the budget: `noarchive` nearly removes illumination,
// and `shifted` moves that budget into refinement instead. If either holds the verdict, the
// pipeline is carrying a stage that does not decide its answers.
//
// KNOWN COUNTER-EXAMPLE, which is why the sample must include boss-critical builds: archiveEvals
// 4800 -> 9600 was required for Ozzy boss reachability (-66.27% at 4800). A cheap-archive arm that
// looks fine on farm builds and breaks boss builds is the outcome to watch for.
const ARMS = [
  { label: 'complete', archiveEvals: 9600, refineSupports: 8 },
  { label: 'refine4', archiveEvals: 9600, refineSupports: 4 },
  { label: 'noarchive', archiveEvals: 400, refineSupports: 8 },
  { label: 'shifted', archiveEvals: 400, refineSupports: 16 },
];

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  const known = H.loadKnownBuilds();
  let picks;
  if (ONLY) {
    picks = ONLY.split(',').map((s) => H.findFixture(known, s.trim()));
  } else {
    const all = [];
    for (const h of Object.keys(known)) for (const f of known[h]) if ((f.level || 0) <= MAXLEVEL) all.push(f);
    const bands = new Map();
    for (const f of all) {
      const b = Math.floor((f.level || 0) / 10);
      if (!bands.has(b)) bands.set(b, []);
      bands.get(b).push(f);
    }
    const rand = mulberry(SEED);
    const keys = [...bands.keys()].sort((a, b) => a - b);
    picks = [];
    let i = 0;
    while (picks.length < SAMPLE && keys.length) {
      const k = keys[i % keys.length];
      const pool = bands.get(k);
      if (pool.length) picks.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
      else keys.splice(i % keys.length, 1);
      i++;
    }
  }

  console.log('seed ' + SEED + '   ' + picks.length + ' build(s): ' + picks.map((f) => f.name).join(' '));
  console.log('');

  const rows = [];
  for (const fx of picks) {
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const imported = await H.evaluateAllocation(cfg, build.talents, build.attributes);
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const multi = await H.makeMultiModeScorer(cfg, POOL);
    try {
      const per = {};
      for (const arm of ARMS) {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, {
          mode,
          scorer: multi.scorerFor(mode),
          effort: {
            archiveEvals: arm.archiveEvals,
            refineSupports: arm.refineSupports,
            structuralShare: 0.35,
            depthShare: 0,
            selection: 'curiosity',
            seeds: [0x9e3779b9],
            breakpointSpending: true,
          },
        });
        const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc);
        per[arm.label] = {
          value: primary(got),
          pct: 100 * (primary(got) - primary(imported)) / primary(imported),
          secs: (Date.now() - t0) / 1000,
        };
      }
      rows.push({ name: fx.name, mode, per });
      const c = per.complete;
      const line = ARMS.map((a) => {
        const p = per[a.label];
        const rel = 100 * (p.value - c.value) / c.value;
        return a.label + ' ' + (p.pct >= 0 ? '+' : '') + p.pct.toFixed(2) + '% ('
          + (rel >= 0 ? '+' : '') + rel.toFixed(2) + ' vs complete, ' + p.secs.toFixed(0) + 's)';
      }).join('   ');
      console.log(fx.name.padEnd(11) + ' ' + mode.padEnd(5) + ' ' + line);
    } finally { await multi.destroy(); }
  }

  console.log('');
  console.log('VERDICT -- would the GATE have reached the same conclusion?');
  for (const arm of ARMS.slice(1)) {
    const worse = [];
    let secsArm = 0;
    let secsFull = 0;
    for (const r of rows) {
      secsArm += r.per[arm.label].secs;
      secsFull += r.per.complete.secs;
      const passFull = r.per.complete.pct >= -0.5;
      const passArm = r.per[arm.label].pct >= -0.5;
      if (passFull && !passArm) {
        worse.push(r.name + ' (' + r.per[arm.label].pct.toFixed(2) + '% vs ' + r.per.complete.pct.toFixed(2) + '%)');
      }
    }
    const speed = secsFull / Math.max(1, secsArm);
    console.log('  ' + arm.label.padEnd(9) + ' ' + speed.toFixed(2) + 'x faster   '
      + (worse.length
        ? 'CHANGES THE VERDICT on ' + worse.length + ': ' + worse.join(', ')
        : 'same verdict on every build tested'));
  }
  console.log('');
  console.log('A verdict match on a sample licenses running the SWEEP cheaper. It does NOT license');
  console.log('changing the shipped default -- that is what a USER gets, and for them the question');
  console.log('is build quality, not gate throughput.');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
