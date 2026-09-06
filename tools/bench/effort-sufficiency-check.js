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

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const SAMPLE = Number(opt('sample', 6));
const SEED = Number(opt('seed', 20260905));
const MAXLEVEL = Number(opt('max-level', 70));

const ARMS = [
  { label: 'complete', archiveEvals: 9600, refineSupports: 8 },
  { label: 'refine4', archiveEvals: 9600, refineSupports: 4 },
  { label: 'fast', archiveEvals: 1200, refineSupports: 3 },
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
    const multi = await H.makeMultiModeScorer(cfg);
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
