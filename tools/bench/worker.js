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

// SCORE A RESULT UNDER A MODE'S OWN OBJECTIVE, using OptimizerObjective's table rather than a
// second copy of the scoring rules. Two copies of an objective is exactly the drift this project
// has watched break benches before (ship-test duplicating nodeWeight and staying on `max`).
function objectiveOf(mode, r, scoreCtx) {
  const M = H.Objective && H.Objective.MODES && H.Objective.MODES[mode];
  if (!M || typeof M.score !== 'function') {
    throw new Error(`worker: no objective for mode "${mode}" -- a fixture declares a mode the `
      + 'optimizer does not implement, and grading it on loot would silently measure the wrong thing');
  }
  // THE SAME CONTEXT THE SEARCH SCORED WITH. Without it a boss mode is graded at bossTarget=null,
  // which skips the "can it even reach the target" tier entirely -- so the gate would rank builds
  // by a different rule than the one the optimizer maximised. Two scoring rules for one mode is the
  // drift this repo bans, and here it would silently reverse verdicts.
  return M.score(r, scoreCtx);
}

// Monte Carlo tolerance for parity. The recorded scores are also rounded in the fixture files
// (several to 3 significant figures, e.g. "1.58k" as 1580), so this covers recording precision
// as well as simulation variance.
const PARITY_TOLERANCE_PCT = 3;

parentPort.on('message', async (fixture) => {
  const started = Date.now();
  // `uid` and `name` are carried through so a result can be joined back to its fixture. Without
  // them a diagnostic has to reconstruct the identity from hunter+set+index, and `index` is NOT
  // unique per hunter -- Borge's loot fixtures run 0-61 in one set and 0-10 again in another --
  // which is exactly the ambiguity findFixture refuses to guess through.
  const base = {
    hunter: fixture.hunter, set: fixture.set, index: fixture.index, mode: fixture.mode,
    note: fixture.note, uid: fixture.uid, name: fixture.name, bossStage: fixture.bossStage,
  };
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
    // A BOSS FIXTURE MUST NAME THE BOSS IT CONTESTS, OR THE OBJECTIVE AIMS AT THE WRONG ONE.
    //
    // `Objective.contextFor` derives the target from the account's highest stage -- correct in the
    // app, where hunterStats carries it. A fixture decoded from a SHARE CODE has no stage at all,
    // so the target fell back to bossTargetFor(0) = the stage-100 boss for every build.
    //
    // Measured on borge@72, whose note says "boss kill stage 300": with target 100 BOTH builds sit
    // in the kill-achieved tier, where ranking is kill RATE -- so a build killing the easy 200 boss
    // at 99.9% outscored the import killing the hard 300 boss at 15.8%, and the gate PASSED a build
    // that had lost 90% of its loot and 44 stages. That is exactly the failure the boss target was
    // introduced to prevent ("a build for a fight there is no reason to take").
    //
    // The fixtures state it in their own notes ("boss kill stage 300"), so it is now explicit data.
    // A boss-mode fixture WITHOUT one is a defect, not a default: silently aiming at stage 100
    // would resume grading every boss build against a boss it cleared long ago.
    const bossModes = ['boss', 'bossTimeless'];
    let scoreCtx;
    if (bossModes.includes(fixture.mode)) {
      if (!Number.isFinite(fixture.bossStage)) {
        throw new Error(`fixture ${fixture.uid} is mode "${fixture.mode}" but declares no bossStage; `
          + 'without it the objective aims at the stage-100 boss and grades the build against a '
          + 'fight it already won');
      }
      scoreCtx = { bossTarget: fixture.bossStage };
    }
    const scorer = await H.makeScorer(cfg, fixture.mode, scoreCtx);
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
      // THE MODE'S OWN OBJECTIVE, from OptimizerObjective rather than a second copy of the rule.
      // Without this the gate can only compare loot and stage, so a `boss` build has to be judged
      // on one of them -- and the loot branch would FAIL a boss build for shedding loot, which is
      // exactly what it is built to do. Carrying the objective score makes each mode gradeable on
      // the question it was optimised for.
      importObjective: objectiveOf(fixture.mode, imported, scoreCtx),
      optimizedObjective: objectiveOf(fixture.mode, optimized, scoreCtx),
      importKillRate: imported.bossKillRate,
      optimizedKillRate: optimized.bossKillRate,
      lootDeltaPct: 100 * (optimized.loot - imported.loot) / imported.loot,
      stageDeltaPct: imported.stage ? 100 * (optimized.stage - imported.stage) / imported.stage : 0,
      evals: result.evals,
      cacheHits: result.cacheHits,
      diag: result.diag,
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
