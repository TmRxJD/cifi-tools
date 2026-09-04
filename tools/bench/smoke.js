'use strict';
// Single-build smoke run: decode one known build code, score it, run the optimizer against
// the same budgets, and print the comparison plus cost. Used to sanity-check the pipeline and
// measure eval cost before committing to a full sweep.
//
//   node tools/bench/smoke.js [hunter] [index]

const H = require('./harness.js');

(async () => {
  const hunter = process.argv[2] || 'borge';
  const index = Number(process.argv[3] || 0);
  const known = H.loadKnownBuilds()[hunter];
  if (!known) throw new Error(`Unknown hunter ${hunter}`);
  const fixture = known[index];
  if (!fixture) throw new Error(`No fixture at index ${index} for ${hunter} (have ${known.length})`);

  const build = await H.parseBuildCode(fixture.code);
  if (!build) throw new Error('Build code did not decode');
  const cfg = H.cfgForImport(hunter, build);

  console.log(`${hunter} #${index}  level ${build.level}  (fixture level ${fixture.level}, live loot ${fixture.expectedLootScore})`);
  console.log(`budgets: ${cfg.TALENT_BUDGET} talent / ${cfg.ATTRIBUTE_BUDGET} attribute`);
  console.log('import talents   :', JSON.stringify(build.talents));
  console.log('import attributes:', JSON.stringify(build.attributes));

  const importScore = await H.scoreAllocation(cfg, 'loot', build.talents, build.attributes);
  console.log(`import loot score (local, 1000 iter): ${importScore.toFixed(2)}`);

  const scorer = await H.makeScorer(cfg, 'loot');
  const t0 = Date.now();
  let lastPhase = '';
  const result = await H.Optimizer.optimize(cfg, {
    mode: 'loot',
    scorer,
    onProgress: ({ phase, done, total }) => {
      if (phase !== lastPhase) { lastPhase = phase; process.stdout.write(`  [${phase} ${done}/${total}]\n`); }
    },
  });
  const secs = (Date.now() - t0) / 1000;

  console.log(`optimizer loot score: ${result.best.score.toFixed(2)}`);
  console.log(`delta vs import     : ${(100 * (result.best.score - importScore) / importScore).toFixed(2)}%`);
  console.log(`evals ${result.evals} (+${result.cacheHits} cached), ${secs.toFixed(1)}s (${(1000 * secs / result.evals).toFixed(2)} ms/eval)`);
  console.log(`supports: ${result.supportsEnumerated} enumerated, ${result.supportsRealizable} realizable`);
  result.notes.forEach((n) => console.log(`note: ${n}`));
  console.log('best talents   :', JSON.stringify(result.best.talentAlloc));
  console.log('best attributes:', JSON.stringify(result.best.attrAlloc));
})().catch((err) => { console.error(err); process.exit(1); });
