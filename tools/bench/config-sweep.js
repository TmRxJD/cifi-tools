// Run a GRID of optimizer configurations x seeds and print one comparable table.
//
// WHY THIS EXISTS. Every configuration question asked of this search so far -- structural share,
// depth share, selection strategy, archive budget, seed merging -- was first answered from a
// SINGLE RUN per arm, and most of those answers were wrong. The search is deterministic given a
// seed but that is one sample of a stochastic process, and the spread between samples is large
// enough to invert a comparison: the identical configuration returned +15.34% and +8.24% on a
// level-62 Ozzy, and an arm that looked 2x better on cell count was a coin flip on the outcome
// that mattered. A bench that runs one seed per arm is not a comparison, it is an anecdote.
//
// So: every arm runs every seed, results are aggregated, and the SPREAD is printed next to the
// mean. An arm only wins if it wins wider than the spread.
//
//   node tools/bench/config-sweep.js --hunter=ozzy --archive-only
//   node tools/bench/config-sweep.js --hunter=ozzy --seeds=4
//   node tools/bench/config-sweep.js --fixture=borge@54 --grid=budget
//   node tools/bench/config-sweep.js --fixture=knox@26 --evals=1200 --seeds=2 --archive-only
//
// NODE SCORES SERIALLY, so this is ~6x slower here than in the browser, where the worker pool
// evaluates in parallel. Use small --evals here for a smoke test; run real sweeps in the app.
//
// --archive-only stops after illumination. That is ~5x cheaper (24s against 131s on a level-62
// Ozzy) and it isolates the MOVE SET, since refinement and polish are identical across arms and
// are ~90% of a full run. Use it for anything about variation; use the full pipeline only to
// settle the final answer, because archive champion score is a KNOWN-BAD proxy for it (Borge's
// archive varies 17.8% between seeds while its final build is identical every time).

const path = require('path');
const H = require(path.join(__dirname, 'harness.js'));

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => args.includes(`--${name}`);

const SEEDS = [0x9e3779b9, 0x12345678, 0xa5a5a5a5, 0x2545f491, 0x6c8e9cf5, 0xb7e15163];

// The grids. Each is a list of {name, effort-overrides}. Keep them small: an arm costs
// seeds x (24s archive-only | ~250s full).
const GRIDS = {
  selection: [
    { name: 'random', selection: 'random' },
    { name: 'curiosity', selection: 'curiosity' },
  ],
  budget: [
    { name: 'evals 2400', archiveEvals: 2400 },
    { name: 'evals 4800', archiveEvals: 4800 },
    { name: 'evals 9600', archiveEvals: 9600 },
    { name: 'evals 19200', archiveEvals: 19200 },
  ],
  structural: [
    { name: 'struct 0.00', structuralShare: 0 },
    { name: 'struct 0.35', structuralShare: 0.35 },
    { name: 'struct 0.70', structuralShare: 0.70 },
  ],
  depth: [
    { name: 'depth 0.0', depthShare: 0 },
    { name: 'depth 0.6', depthShare: 0.6 },
    { name: 'depth 1.0', depthShare: 1.0 },
  ],
};

function stats(xs) {
  if (!xs.length) return { mean: 0, min: 0, max: 0, spreadPct: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return { mean, min, max, spreadPct: mean ? ((max - min) / mean) * 100 : 0 };
}

(async () => {
  const gridName = flag('grid', 'selection');
  const grid = GRIDS[gridName];
  if (!grid) throw new Error(`unknown --grid=${gridName}; have ${Object.keys(GRIDS).join(', ')}`);

  const seedCount = Number(flag('seeds', 3));
  const seeds = SEEDS.slice(0, seedCount);
  const archiveOnly = has('archive-only');

  // Either a fixture build code, or the real account from the pulled save.
  const fixtureName = flag('fixture', null);
  const hunter = flag('hunter', 'ozzy');
  let cfg;
  let label;
  let importScore;
  if (fixtureName) {
    const fx = H.findFixture(H.loadKnownBuilds(), fixtureName);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    cfg = H.cfgForImport(fx.hunter, build);
    label = fixtureName;
    importScore = (await H.evaluateAllocation(cfg, build.talents, build.attributes)).loot;
  } else {
    const save = H.latestDecodedSave();
    if (!save) throw new Error('no decoded save; pass --fixture=<name> instead');
    const sb = H.browserSandbox();
    const real = (sb.mapSaveToStore(save).perHunter || {})[hunter];
    if (!real) throw new Error(`no ${hunter} in the decoded save`);
    cfg = H.cfgForImport(hunter, {
      level: real.level, talents: real.talents, attributes: real.attributes, overrides: {},
    });
    cfg.hunterStats = real.hunterStats;
    label = `${hunter}@${real.level} (account)`;
    importScore = (await H.evaluateAllocation(cfg, real.talents, real.attributes)).loot;
  }

  const scorer = await H.makeScorer(cfg, 'loot');
  console.log(`config-sweep: ${label}  grid=${gridName}  seeds=${seeds.length}`
    + `  ${archiveOnly ? 'ARCHIVE-ONLY' : 'FULL PIPELINE'}`);
  console.log(`reference (the build being compared against): ${Math.round(importScore)}\n`);

  const rows = [];
  for (const arm of grid) {
    const { name, ...over } = arm;
    const per = [];
    for (const seed of seeds) {
      const t0 = Date.now();
      const res = await H.Optimizer.optimize(cfg, {
        mode: 'loot',
        scorer,
        effort: {
          label: name,
          archiveEvals: Number(flag('evals', 9600)),
          refineSupports: 8,
          structuralShare: 0.35,
          depthShare: 0,
          selection: 'curiosity',
          archiveOnly,
          seeds: [seed],
          ...over,
        },
      });
      const d = res.diag || {};
      const a = d.archive || {};
      let score = a.bestScore || 0;
      if (!archiveOnly) {
        score = (await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc)).loot;
      }
      per.push({
        seed: seed.toString(16).slice(0, 4),
        score,
        pct: ((score - importScore) / importScore) * 100,
        cells: a.cells || 0,
        bands: a.killBands || 0,
        bestKill: a.bestKillReached || 0,
        strandPct: a.moves && a.moves.attempted
          ? (a.moves.strandedRepairs / a.moves.attempted) * 100 : 0,
        secs: (Date.now() - t0) / 1000,
      });
      process.stderr.write(`  ${name} seed ${per[per.length - 1].seed}: `
        + `${per[per.length - 1].pct.toFixed(2)}%  kill ${per[per.length - 1].bestKill}\n`);
    }
    const sc = stats(per.map((r) => r.score));
    rows.push({
      name,
      meanPct: ((sc.mean - importScore) / importScore) * 100,
      spreadPct: sc.spreadPct,
      // The metric that actually decided every Ozzy run: did the archive get a foothold at all.
      reachedBoss: per.filter((r) => r.bestKill > 0).length,
      of: per.length,
      cells: stats(per.map((r) => r.cells)).mean,
      strand: stats(per.map((r) => r.strandPct)).mean,
      secs: stats(per.map((r) => r.secs)).mean,
      per,
    });
  }

  const pad = (v, n) => String(v).padStart(n);
  console.log(`${'arm'.padEnd(14)} ${pad('mean %', 9)} ${pad('spread %', 9)} ${pad('boss', 6)}`
    + ` ${pad('cells', 6)} ${pad('strand%', 8)} ${pad('secs', 6)}`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(14)} ${pad(r.meanPct.toFixed(2), 9)} ${pad(r.spreadPct.toFixed(1), 9)}`
      + ` ${pad(`${r.reachedBoss}/${r.of}`, 6)} ${pad(r.cells.toFixed(0), 6)}`
      + ` ${pad(r.strand.toFixed(1), 8)} ${pad(r.secs.toFixed(0), 6)}`);
  }

  // A winner must beat the runner-up by more than the seed spread, or it is not a winner.
  const sorted = [...rows].sort((a, b) => b.meanPct - a.meanPct);
  const top = sorted[0];
  const next = sorted[1];
  console.log('');
  if (!next) {
    console.log(`only one arm: ${top.name}`);
  } else {
    const margin = top.meanPct - next.meanPct;
    const noise = Math.max(top.spreadPct, next.spreadPct);
    console.log(margin > noise
      ? `WINNER ${top.name}: +${margin.toFixed(2)} points over ${next.name}, wider than the `
        + `${noise.toFixed(1)} point seed spread.`
      : `NO WINNER: ${top.name} leads ${next.name} by ${margin.toFixed(2)} points, INSIDE the `
        + `${noise.toFixed(1)} point seed spread. Run more seeds or accept they are equivalent.`);
  }
})();
