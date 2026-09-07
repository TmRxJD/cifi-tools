'use strict';
// THE ONE DEFINITION OF "THIS BUILD FAILED". Used by run.js (the gate) and summarize.js (the
// reporter), so they cannot disagree about what a failure is.
//
// THEY DID DISAGREE, AND IT PRODUCED A WRONG REPORT. Each carried its own copy. run.js was updated
// so parity is a two-sided DIAGNOSTIC and every mode is judged on its own objective; summarize.js
// kept the older rule -- parity-overcount as a failure, and `push ? stage : loot` with no boss
// case. On the same 42-build sweep run.js reported 1 failure and summarize.js reported 2, one of
// them a boss build flagged for shedding loot, which is what a boss build is FOR.
//
// That is the drift this project bans elsewhere (two copies of nodeWeight; two copies of the
// violation rule). A verdict is a rule, and a rule gets one home.

/**
 * PARITY IS NOT A FAILURE, IN EITHER DIRECTION.
 *
 * It used to fail any build scoring ABOVE its recorded number, justified by "nothing can make it
 * land above one". The full 182-build sweep disproved that: three builds overcount (+4.7% to
 * +7.2%), three undercount (-5.4%), and the direction FLIPS between adjacent levels (72/73/74),
 * clustered at the stage-300 boss boundary where the metric is threshold-sensitive. A recorded
 * score and a code-only evaluation describe DIFFERENT ACCOUNT STATES -- a share code carries only
 * CODE_PARAMS -- so the sign of their difference carries no information about correctness.
 *
 * It stays REPORTED because non-uniform error can reorder candidates even though a constant bias
 * cannot.
 */
function parityIsFatal() { return false; }

/**
 * Judge a result on the objective its build was made for.
 *
 * `importObjective`/`optimizedObjective` come from OptimizerObjective's own MODES table, so the
 * verdict cannot drift from what the optimizer maximised. Older result files predate those fields,
 * hence the fallback -- without it, `--resume` over an old file would crash rather than degrade.
 */
function failureOf(res) {
  if (!res.ok) return `ERROR ${String(res.error || '').split('\n')[0]}`;

  if (Number.isFinite(res.importObjective) && Number.isFinite(res.optimizedObjective)) {
    if (res.optimizedObjective < res.importObjective) {
      const kills = Number.isFinite(res.importKillRate)
        ? `  (kill ${res.importKillRate.toFixed(1)}% -> ${(res.optimizedKillRate || 0).toFixed(1)}%)` : '';
      return `${String(res.mode).toUpperCase()} objective ${res.importObjective.toFixed(2)} -> `
        + `${res.optimizedObjective.toFixed(2)}${kills}`;
    }
    return null;
  }

  // Legacy fallback for result files written before per-mode objectives were recorded.
  if (res.mode === 'push') {
    return res.optimizedStage < res.importStage
      ? `STAGE ${res.importStage.toFixed(2)} -> ${res.optimizedStage.toFixed(2)}` : null;
  }
  return res.optimizedLoot < res.importLoot
    ? `LOOT ${res.importLoot.toFixed(2)} -> ${res.optimizedLoot.toFixed(2)}` : null;
}

/** Short category for summaries. Derived from failureOf so the two can never disagree. */
function categoryOf(res) {
  if (!res.ok) return 'error';
  const why = failureOf(res);
  if (!why) return null;
  if (/^ERROR/.test(why)) return 'error';
  if (/objective/.test(why)) return `${res.mode}-regression`;
  if (/^STAGE/.test(why)) return 'stage-regression';
  return 'loot-regression';
}

/**
 * The SECONDARY metric, reported and never fatal. A boss or push build trading loot for its actual
 * goal is succeeding, not failing -- gating on both would fail a build for doing its job.
 */
function secondaryWarningOf(res) {
  if (!res.ok) return null;
  if (res.mode === 'push' || res.mode === 'boss' || res.mode === 'bossTimeless') {
    return res.optimizedLoot < res.importLoot ? `loot ${res.lootDeltaPct.toFixed(2)}%` : null;
  }
  return res.optimizedStage < res.importStage ? `stage ${res.stageDeltaPct.toFixed(2)}%` : null;
}

module.exports = { failureOf, categoryOf, secondaryWarningOf, parityIsFatal };
