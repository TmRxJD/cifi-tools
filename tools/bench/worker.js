'use strict';
// One benchmark case per message. Runs in a worker_thread so the sweep can use every core --
// cases are fully independent, so this is exact, not approximate, parallelism: a case's result
// is identical to running it alone.
//
// TWO CHECKS PER BUILD.
//
//   Parity   the clone's loot score for the imported code vs the score recorded in the fixture.
//   Quality  the optimizer's result vs the import's, at the import's own budget.
//
// PARITY IS ASYMMETRIC, AND THAT ASYMMETRY IS THE WHOLE POINT.
//
// A share code does not fully determine a loot score. Run `node tools/bench/params-report.js
// <hunter>` for the exact list: Knox reads 91 simulation params and its code format carries
// only 46, so 47 -- researches, construction milestones, loop mods, inscryption #105, relic
// t2r5, several gem-tree fields -- simply are not in the code. The fixtures' recorded scores
// were observed on a real logged-in account that had those investments. So:
//
//   clone BELOW recorded  -> expected. Account state the code cannot carry can only ever
//                            subtract from a code-only evaluation.
//   clone ABOVE recorded  -> a real failure. Nothing missing can inflate a score, so an
//                            overcount means the clone's math is genuinely wrong.
//
// Verified end-to-end on knox #19 (recorded 5370): the clone says 4771.81, and importing that
// same code into cifi-tools.com as a guest ALSO yields 4.77k. Clone and original agree exactly;
// the recorded figure is what that account produced with state the code never carried.
//
// Two things checked and ruled out as the cause, recorded so nobody re-checks them:
//   - The gadget "Anchor of Ages" IS carried by the code (at 40) -- it is not the missing piece.
//   - upgrades.gems_nodes.attraction_lootKnox reaches the wasm correctly but changes the
//     returned loot score by exactly nothing (verified: arg 0 vs 150, bit-identical output),
//     so the Knox gem loot bonus cannot explain a gap either.
// Which of the remaining 47 accounts for it is not determinable without the account itself,
// and is deliberately NOT guessed at here.
//
// Either way the QUALITY check still runs. It compares the import and the optimizer's result
// under the *same* clone-side context, so it is internally consistent regardless of whether
// the absolute number matches a figure captured on a different account.
//
// For a definitive clone-vs-original comparison of the same code, use
// compare-mcp/batch-test.mjs -- it drives the live site directly. That is the canonical
// clone-vs-live tool; this file deliberately does not reimplement it.

const { parentPort } = require('node:worker_threads');
const H = require('./harness.js');

// Monte Carlo tolerance for parity. The recorded scores are also rounded in the fixture files
// (several to 3 significant figures, e.g. "1.58k" as 1580), so this covers recording precision
// as well as simulation variance.
const PARITY_TOLERANCE_PCT = 3;

parentPort.on('message', async (fixture) => {
  const started = Date.now();
  const base = { hunter: fixture.hunter, set: fixture.set, index: fixture.index, mode: fixture.mode, note: fixture.note };
  try {
    const build = await H.parseBuildCode(fixture.code);
    if (!build) throw new Error('build code did not decode');
    if (build.hunter !== fixture.hunter) {
      throw new Error(`code decodes as ${build.hunter}, fixture says ${fixture.hunter}`);
    }
    const cfg = H.cfgForImport(fixture.hunter, build);

    // ---- Parity (asymmetric -- see the header) -------------------------------------------
    const imported = await H.evaluateAllocation(cfg, build.talents, build.attributes);
    const expected = fixture.expectedLootScore;
    const parityDeltaPct = expected ? 100 * (imported.loot - expected) / expected : null;
    const parity = parityDeltaPct === null || Math.abs(parityDeltaPct) <= PARITY_TOLERANCE_PCT
      ? 'match'
      : (parityDeltaPct > 0 ? 'overcount' : 'undercount');

    // ---- Quality at the import's own budget ----------------------------------------------
    const scorer = await H.makeScorer(cfg, fixture.mode);
    const result = await H.Optimizer.optimize(cfg, { mode: fixture.mode, scorer });
    const optimized = await H.evaluateAllocation(cfg, result.best.talentAlloc, result.best.attrAlloc);

    parentPort.postMessage({
      ...base,
      ok: true,
      parity,
      level: build.level,
      fixtureLevel: fixture.level,
      expectedLootScore: expected,
      parityDeltaPct,
      talentBudget: cfg.TALENT_BUDGET,
      attributeBudget: cfg.ATTRIBUTE_BUDGET,
      importLoot: imported.loot,
      importStage: imported.stage,
      optimizedLoot: optimized.loot,
      optimizedStage: optimized.stage,
      lootDeltaPct: 100 * (optimized.loot - imported.loot) / imported.loot,
      stageDeltaPct: imported.stage ? 100 * (optimized.stage - imported.stage) / imported.stage : 0,
      evals: result.evals,
      cacheHits: result.cacheHits,
      supportsEnumerated: result.supportsEnumerated,
      supportsRealizable: result.supportsRealizable,
      seconds: (Date.now() - started) / 1000,
      optimizedTalents: result.best.talentAlloc,
      optimizedAttributes: result.best.attrAlloc,
      importTalents: build.talents,
      importAttributes: build.attributes,
    });
  } catch (err) {
    parentPort.postMessage({
      ...base,
      ok: false,
      error: String((err && err.stack) || err),
      seconds: (Date.now() - started) / 1000,
    });
  }
});
