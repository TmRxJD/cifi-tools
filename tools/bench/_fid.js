// Does cutting decision fidelity cost build quality? Cost is linear in iterations and ~87% of wall
// clock is spent at this fidelity, so 1000 -> 250 should be ~3x faster overall. The question is
// whether a noisier ranking picks worse moves.
const H = require('./harness.js');
(async () => {
  const known = H.loadKnownBuilds();
  for (const name of process.argv.slice(2)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const imported = await H.evaluateAllocation(cfg, build.talents, build.attributes);
    const pooled = await H.makePooledScorer(cfg, fx.mode || 'loot');
    try {
      for (const fi of [1000, 250]) {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, {
          mode: fx.mode || 'loot', scorer: pooled.score,
          effort: { archiveEvals: 9600, refineSupports: 8, seeds: [0x9e3779b9], finalIterations: fi },
        });
        // ALWAYS judged at 1000, whatever fidelity the search decided at -- otherwise the cheaper
        // arm would be scored on its own noisier ruler and look artificially good.
        const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, 1000);
        const pct = 100 * (got.loot - imported.loot) / imported.loot;
        console.log(`${name.padEnd(10)} finalIterations ${String(fi).padStart(4)}  ${pct.toFixed(2).padStart(7)}%  ${Math.round((Date.now()-t0)/1000)}s  evals=${res.evals}`);
      }
    } finally { await pooled.destroy(); }
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
