// THE definition of what each optimize mode is trying to maximize.
//
// One place. The search, the scoring workers and the benchmark all score through this, so a mode
// cannot mean one thing during the search and another when the winner is chosen -- the exact
// mismatch that produced the old "it said better but nothing changed" behaviour.
//
// Every objective is a single number, higher is better, computed from one evaluate() result.
(function (global) {
  'use strict';

  /**
   * Boss objectives are LEXICOGRAPHIC, not a weighted blend, and the reason matters.
   *
   * Measured on a real Borge build:
   *   - bossKillRate responds strongly to offence (95.7 -> 85.7 -> 64.5 -> 43.8 -> 0 as Soul Of
   *     Ares is stripped), so it is a genuine gradient, not a flag.
   *   - Lucky Loot 0 -> 12 leaves killRate and bossHpPercent untouched while loot goes
   *     2.22e7 -> 3.20e7. It cannot help kill a boss; it can only enrich one.
   *
   * BELOW A KILL, bossHpPercent ALONE IS NOT A USABLE GRADIENT -- measured, scaling one build
   * down to 75/50/25/10/0% of its levels:
   *     100%  stage 237.1  bossHp%  0
   *      75%  stage 200.0  bossHp% 47.0
   *      50%  stage 200.0  bossHp% 74.0
   *      25%  stage 179.3  bossHp%  0
   *       0%  stage 135.8  bossHp%  0
   * It reads 0 both for a build that never reaches the wall AND for one already past it, and is
   * only meaningful for builds stalled AT the wall. Scoring on (100 - bossHpPercent) therefore
   * gave an empty build the same maximum non-kill score as the strongest non-killing build.
   * avgStage is the monotone signal (135.8 -> 237.1), and the two compose exactly: stage
   * separates builds at different walls, and where stage ties at a wall (200.0 == 200.0) the HP
   * reading is precisely what discriminates (74.0 vs 47.0 remaining).
   *
   * So, three tiers:
   *   no kill  -> how far the build gets (avgStage), then how little boss HP is left among
   *               builds stuck at the same wall. Loot is deliberately NOT scored here: a build
   *               that farms well but cannot kill the boss is a failure at this objective, and
   *               letting loot contribute would trade away kill progress for it.
   *   kill     -> maximize the kill rate; among builds with the SAME kill rate, prefer more loot.
   *               That is the overflow channel, and it is why Lucky Loot takes points only once
   *               they cost nothing in boss capability -- no special-casing, it falls out of the
   *               ordering.
   *
   * The scales keep the tiers from bleeding into each other. Any kill (>= 1e9) outranks every
   * non-kill (stage caps the term far below that). killRate carries 0.1 resolution, so one step
   * is 100 units at x1000, while the loot term is a log capped near 60 -- a loot gain can never
   * buy back even a tenth of a percent of kill rate.
   */
  const KILL_RATE_SCALE = 1000;
  // Bosses stand every 100 stages. A run that ends within a few stages of one is being held up by
  // it; a run that dies well past one is limited by something else entirely.
  const BOSS_INTERVAL = 100;
  const BOSS_STALL_MARGIN = 5;

  const KILL_ACHIEVED_BASE = 1e9; // any kill outranks every not-yet-killing build
  const STAGE_PROGRESS_SCALE = 1e4;
  // Reaching the target boss at all outranks every build that cannot, by more than the stage
  // term can ever reach, and still sits far below any actual kill.
  const REACHED_TARGET_BASE = 1e7;
  const LOOT_TIEBREAK_SCALE = 5;

  /**
   * The NEXT boss the account has not killed yet, from its highest stage reached.
   *
   * Bosses stand every 100 stages, so an account at 104 has cleared the 100 boss and its next
   * one is 200; an account at 99 has cleared none and its next is 100. This is the same rule the
   * third-party cifi.mysticdrew.net optimizer uses (`floor(level / 100) * 100 + 100`), arrived at
   * independently, which is worth noting because nothing in our own data pins it.
   *
   * WHY IT MATTERS: without it the boss objective maximises the kill rate on whatever boss the
   * run happens to reach, which for an account past 100 is a boss it has ALREADY KILLED. That is
   * a build for a fight the player has no reason to take. The objective is "kill the next one",
   * always -- the first kill is what changes the stage's rewards.
   */
  /**
   * The scoring context for a cfg: the boss target derived from that account's highest stage.
   *
   * One definition, used by the browser worker and the Node bench alike, so the two cannot come
   * to different conclusions about which boss is being fought. `stage` lives in baseOverrides for
   * an imported build and in hunterStats for account state; both are read, override first, which
   * is the same precedence resolveParam uses.
   */
  function contextFor(cfg) {
    const stage = (cfg && cfg.baseOverrides && cfg.baseOverrides.stage)
      ?? (cfg && cfg.hunterStats && cfg.hunterStats.stage)
      ?? (cfg && cfg.overrides && cfg.overrides.stage)
      ?? 0;
    return { bossTarget: bossTargetFor(stage) };
  }

  function bossTargetFor(highestStageReached) {
    const reached = Math.max(0, Math.floor(Number(highestStageReached) || 0));
    return Math.floor(reached / 100) * 100 + 100;
  }

  /**
   * `ctx.bossTarget` is the stage of the boss being aimed at. Absent, the objective keeps its old
   * target-agnostic behaviour, which is right for the Effective Path (it never changes the
   * account's stage) but NOT for the optimizer, which always supplies one.
   */
  function bossScore(r, ctx) {
    const target = ctx && Number.isFinite(ctx.bossTarget) ? ctx.bossTarget : null;
    const killRate = r.bossKillRate || 0;
    const maxStage = Number.isFinite(r.maxStage) ? r.maxStage : 0;

    // TIER 0, only when a target is known: can the build even GET to that boss?
    //
    // The evaluator has no boss-target input -- `stage` is a power multiplier, not a selector
    // (measured: the same build at stage 0 -> 300 goes from killRate 0 to 99.4 while the run
    // still ends around 100-106) -- so "am I fighting the target boss" has to be read off how
    // deep the run gets. A build that never reaches the target is ranked purely on progress
    // TOWARD it, which is what makes "give me the best shot at the 200 boss" answerable even when
    // the honest answer is "you cannot get there yet". The reported kill chance then says so.
    if (target !== null && maxStage < target) {
      const stage = Number.isFinite(r.avgStage) ? r.avgStage : 0;
      // Deliberately below every reached-the-target score, and ordered by depth. bossHpPercent is
      // NOT used here: it describes whichever earlier boss the run met, not the target.
      return stage * STAGE_PROGRESS_SCALE + maxStage;
    }

    if (killRate <= 0) {
      // Reaching it (or target unknown) but not killing it: how far it gets, then how little boss
      // HP is left at that wall.
      const stage = Number.isFinite(r.avgStage) ? r.avgStage : 0;
      const remaining = Number.isFinite(r.bossHpPercent) ? r.bossHpPercent : 100;
      return REACHED_TARGET_BASE + stage * STAGE_PROGRESS_SCALE + (100 - remaining);
    }
    const loot = Math.max(0, r.lootPerMin || 0);
    return KILL_ACHIEVED_BASE
      + killRate * KILL_RATE_SCALE
      + Math.log10(1 + loot) * LOOT_TIEBREAK_SCALE;
  }

  /**
   * mode -> { label, score(evalResult), pinnedAttrs? }
   *
   * `pinnedAttrs` names attributes the search must hold at maximum. It is how
   * "boss + timeless" differs from "boss": Timeless Mastery does not help kill anything --
   * measured, kill rate is identical at Timeless 0 and 5 -- it multiplies the loot the kill
   * yields (+1.83M per level, perfectly linear on the build measured). Players who want the
   * kill NOW take `boss`; players willing to wait until the kill pays maximally take
   * `bossTimeless`, which reserves the points to max Timeless first and optimizes the rest
   * around it.
   */
  const MODES = {
    loot: {
      label: 'Loot Score',
      help: 'Maximises loot per minute — the default for farming.',
      score: (r) => r.lootPerMin,
    },
    push: {
      label: 'Ø Stage (push)',
      help: 'Maximises average stage reached, trading loot for depth.',
      score: (r) => r.avgStage,
    },
    boss: {
      label: 'Boss kill (as soon as possible)',
      help: 'Maximises the boss kill rate and stops there. Points that cannot improve the kill go '
        + 'to loot instead, which is where Call Me Lucky Loot picks up its overflow.',
      score: bossScore,
    },
    bossTimeless: {
      label: 'Boss kill with Timeless maxed (max boss loot)',
      help: 'As above, but reserves the points to max Timeless Mastery first. Timeless does not '
        + 'help kill the boss — it multiplies what the kill pays — so this is the '
        + '"wait until the kill is worth the most" plan.',
      score: bossScore,
      pinnedAttrs: ['timeless'],
    },
  };

  function modeOrThrow(mode) {
    const spec = MODES[mode];
    if (!spec) throw new Error(`Unknown optimize mode "${mode}" (expected one of ${Object.keys(MODES).join(', ')})`);
    return spec;
  }

  /** Score one evaluate() result under a mode. */
  function scoreFor(mode, result, ctx) {
    return modeOrThrow(mode).score(result, ctx);
  }


  function pinnedAttrsFor(mode) {
    return modeOrThrow(mode).pinnedAttrs || [];
  }

  /**
   * Modes the PURCHASE PATH can meaningfully offer.
   *
   * The path buys stats, inscriptions and relics with currency; it never reallocates talent or
   * attribute points (those are level-gated and belong to Optimize). A mode whose only
   * difference from another is `pinnedAttrs` therefore cannot behave differently here --
   * offering `bossTimeless` in a path picker would show the user a choice that changes nothing.
   *
   * Derived from the one MODES table rather than listed separately, so a new pinned mode is
   * excluded automatically and a new real mode appears automatically.
   */
  function pathModes() {
    return Object.fromEntries(Object.entries(MODES).filter(([, spec]) => !spec.pinnedAttrs));
  }

  /**
   * Describe a run in terms that CANNOT be misread, because the conclusions are stated rather
   * than left to be inferred from raw fields.
   *
   * THIS EXISTS BECAUSE READING THE RAW FIELDS PRODUCED TWO WRONG DIAGNOSES IN ONE SESSION.
   * A Knox run returning `avgStage 96.1, maxStage 100, bossKillRate 0, bossHpPercent 99.996` was
   * first reported as "already kills its stage-100 boss" (from contaminated stats) and then as
   * "does not reach stage 100 at all" (reading the AVERAGE as the reach). Both were wrong, and the
   * truth -- reaches the boss, does no damage to it, dies there -- was sitting in `maxStage` and
   * `bossHpPercent` the whole time. Each misreading was about to start its own investigation.
   *
   * `avgStage` is where runs END ON AVERAGE. `maxStage` is how far the build GETS. They answer
   * different questions and the names do not say so, which is the whole problem. So this returns
   * booleans and a named regime; a report quotes a labelled fact instead of paraphrasing a number.
   *
   * The three regimes are the game's own, per the project owner: you reach a boss several levels
   * before you can kill it (and until then dying to it quickly is correct play), and once you can
   * kill it, farming it beats pushing until you can go well past. A build is only comparable to
   * another in the same regime -- that is what made the -66.27% Ozzy builds look broken when they
   * were the optimum of a different regime.
   */
  function describeRun(result, highestStageReached) {
    if (!result) throw new Error('describeRun: result is required');
    for (const f of ['avgStage', 'maxStage', 'minStage', 'bossKillRate', 'bossHpPercent']) {
      if (!Number.isFinite(result[f])) throw new Error(`describeRun: result.${f} is not a number`);
    }
    // Which boss this run meets: the next one at or above where the run actually gets to.
    const bossStage = Math.ceil(result.maxStage / BOSS_INTERVAL) * BOSS_INTERVAL
      || BOSS_INTERVAL;
    const reachesBoss = result.maxStage >= bossStage - 1e-9
      || Math.floor(result.maxStage / BOSS_INTERVAL) >= 1;
    const killsBoss = result.bossKillRate > 0;
    const regime = killsBoss ? 'kills-boss'
      : (reachesBoss ? 'reaches-cannot-kill' : 'cannot-reach-boss');
    return {
      regime,
      bossStage,
      reachesBoss,
      killsBoss,
      bossKillRatePct: result.bossKillRate,
      bossHpRemainingPct: result.bossHpPercent,
      stageMin: result.minStage,
      stageAvg: result.avgStage,
      stageMax: result.maxStage,
      lootPerMin: result.lootPerMin,
      // One line that says the whole thing, so a report cannot restate it wrongly.
      summary: `${regime}: reaches stage ${result.maxStage.toFixed(1)} at best `
        + `(avg ${result.avgStage.toFixed(1)}), boss at ${bossStage}, `
        + `kill rate ${result.bossKillRate}%, boss HP left ${result.bossHpPercent.toFixed(2)}%`,
    };
  }

  const Objective = { MODES, scoreFor, pinnedAttrsFor, pathModes, modeOrThrow, bossTargetFor, contextFor, describeRun, BOSS_INTERVAL, KILL_ACHIEVED_BASE };

  if (typeof module !== 'undefined' && module.exports) module.exports = Objective;
  else global.OptimizerObjective = Objective;
})(typeof window !== 'undefined' ? window : globalThis);
