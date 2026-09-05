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
    // WHICH BOSS THE REPORTED KILL RATE IS ABOUT -- and this was WRONG, in the one case that
    // matters most. It rounded UP (`ceil`), so a build reaching stage 303.8 was labelled
    // "boss at 400, kill rate 31.7%". It cannot have a kill rate against the 400 boss; it never
    // gets there. 31.7% is the rate at which it clears the boss at 300, which is exactly how it
    // ends up past 300 in the first place. The label contradicted the number beside it.
    //
    // The boss a run CONTESTS is the deepest boundary it actually reached, which is the floor:
    //     dies at 300.0   -> 300   (met it, killed none of the time)
    //     reaches 303.8   -> 300   (met it, killed 31.7% of the time, so some runs went past)
    //     reaches  99.7   ->   0   (never met one)
    // `ceil` agrees with `floor` for the first and third of those and disagrees for the second --
    // the boss-clearing build, i.e. precisely the case a boss investigation is looking at.
    const bossStage = Math.floor(result.maxStage / BOSS_INTERVAL) * BOSS_INTERVAL;
    const reachesBoss = bossStage >= BOSS_INTERVAL;
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
        + `(avg ${result.avgStage.toFixed(1)}), `
        + (reachesBoss ? `boss contested ${bossStage}, ` : 'no boss reached, ')
        + `kill rate ${result.bossKillRate}%, boss HP left ${result.bossHpPercent.toFixed(2)}%`,
    };
  }

  //
  // DISJUNCTIVE REGIME DECOMPOSITION.
  //
  // The loot objective is PIECEWISE in how many bosses a run clears, because the first kill of a
  // boss stage changes that stage's rewards. Measured on borge@73: the reference averages stage
  // 300.4963 and ours 299.9032 -- a 0.197% difference in depth for a 39.44% difference in loot.
  // That is a cliff, and one search asked to climb a flat surface will not find it. Nine different
  // methods returned the same wrong answer on one Knox build, and three separate hypotheses about
  // WHY were each falsified by measurement.
  //
  // Standard practice for a problem shaped like this is not a better hill climber, it is
  // decomposition: "a MINLP problem can be expressed as a set of subproblems, where the global
  // minimum is the optimal solution across all subproblems" (disjunctive programming). So instead
  // of hoping a stochastic search stumbles across a threshold we already KNOW the location of --
  // bosses stand every BOSS_INTERVAL stages -- solve one subproblem per regime and take the best.
  //
  // THIS IS NOT THE CROSS-SEED PASS THAT WAS REMOVED, and the difference is not cosmetic. The
  // cross-seed ran a search under a DIFFERENT objective and used its answer as a seed, so the
  // proxy decided which candidate you got. Here every subproblem maximises the TRUE objective --
  // loot -- and the regime enters only as a CONSTRAINT on the feasible set. The winner is chosen
  // across subproblems on pure loot. Nothing is ever scored on boss progress.
  //
  // The constraint is handled by Deb's feasibility rules (Deb 2000), which are parameter-free:
  //   1. both feasible            -> better objective value wins   (that is loot, unchanged)
  //   2. feasible beats infeasible
  //   3. both infeasible          -> smaller constraint violation wins
  // Rule 3 is the entire point. It supplies a gradient toward the cliff where the loot objective
  // has none, out of numbers the evaluator already returns.
  //
  // THE SEPARATOR RELIES ON LOOT BEING NON-NEGATIVE, which is asserted rather than assumed. Every
  // feasible build scores its own loot (>= 0); every infeasible one scores strictly below zero.
  // There is no magnitude to tune -- INFEASIBLE_BASE is a separator, not a weight.
  const INFEASIBLE_BASE = -1;

  /**
   * How many bosses the build actually CLEARS, from how far it gets.
   *
   * `floor(maxStage / BOSS_INTERVAL)` IS WRONG AND THE FIRST VERSION OF THIS USED IT. A run that
   * ends at exactly stage 300 died AT the 300 boss -- it cleared two, not three. The measured
   * borge@73 pair makes the distinction concrete, and it is the entire question for that build:
   *     ours       maxStage 300.0  kill 0     hp left 67.44%  -> cleared 2
   *     reference  maxStage 303.8  kill 31.7  hp left  3.43%  -> cleared 3
   * Under `floor` both read 3 and the constraint would call our build feasible, so the subproblem
   * aimed at the third boss would be satisfied by the build that cannot beat it -- the decomposition
   * would silently do nothing. This is the same off-by-one describeRun had, in the same place.
   *
   * `ceil - 1` is right at every boundary: 303.8 -> 3, 300.0 -> 2, 299.9 -> 2, 100.0 -> 0, 99.7 -> 0.
   *
   * NOTE the deliberate difference from boss-parity-check.js, which floors the AVERAGE stage. That
   * answers "how many bosses does the average run get past", which is what loot integrates. This
   * answers "how many can this build beat at all", which is what a feasibility constraint needs.
   * Two questions, two rules; conflating them is what the bug above was.
   */
  function regimeOf(result) {
    if (!result || !Number.isFinite(result.maxStage)) {
      throw new Error('regimeOf: result.maxStage is not a number');
    }
    return Math.max(0, Math.ceil(result.maxStage / BOSS_INTERVAL) - 1);
  }

  /**
   * How far short of `targetBosses` this run falls, as a continuous quantity.
   *
   * Whole bosses short, less the progress made on the one it is actually fighting. So a build that
   * reaches the boss and removes 96.6% of its HP violates by 0.034, while one that never scratches
   * it violates by 1.0 -- and the search can tell them apart, which under pure loot it cannot.
   *
   * bossHpPercent is only meaningful for a run stalled AT a wall (objective.js's own measurement:
   * it reads 0 both for a build that never reached one and one already past it). That is exactly
   * the case here -- violation is only ever computed for a build short of the target, and such a
   * build ends at the wall it failed to pass.
   */
  function constraintViolation(result, targetBosses) {
    const cleared = regimeOf(result);
    const short = targetBosses - cleared;
    if (short <= 0) return 0;
    // PROGRESS IS ONLY CREDITED TO A BUILD STALLED *AT* A WALL, AND THE FIRST VERSION WAS NOT, WHICH
    // MADE IT CALL AN UNREACHABLE REGIME FEASIBLE.
    //
    // bossHpPercent reads 0 in two completely different situations -- objective.js records the
    // measurement -- and only one of them means "nearly killed it":
    //     maxStage 300.0, hp 67.44  died AT the 300 boss, removed a third of it   <- meaningful
    //     maxStage 155.2, hp  0.00  cleared the 100 boss, died in open stages     <- meaningless
    // Crediting the second gives progress 1.0, so `short - progress` is 0 and a build that never
    // came near the target scores FEASIBLE. Caught on borge@35 by the decomposition smoke test:
    // that build reads exactly those numbers, and the subproblem aimed at 2 bosses would have
    // accepted it while `satisfied` (computed independently from regimeOf) correctly said no.
    //
    // A run stalled at a wall ends ON the boss stage, so the test is whether maxStage sits on a
    // BOSS_INTERVAL boundary. Anything else died between bosses, where the HP reading describes a
    // fight that is not the one being constrained.
    const onBoundary = Math.abs(result.maxStage / BOSS_INTERVAL - Math.round(result.maxStage / BOSS_INTERVAL)) < 1e-6;
    const hp = Number.isFinite(result.bossHpPercent) ? result.bossHpPercent : 100;
    const progress = onBoundary ? Math.max(0, Math.min(1, (100 - hp) / 100)) : 0;
    return short - progress;
  }

  /**
   * The objective for ONE subproblem: maximise `mode` subject to clearing `targetBosses` bosses.
   *
   * Feasible builds are ranked by the caller's real objective and nothing else, so within the
   * feasible set this subproblem is exactly the search that already exists.
   */
  function constrainedScoreFor(mode, result, ctx, targetBosses) {
    return constrainScore(scoreFor(mode, result, ctx), result, targetBosses);
  }

  /**
   * THE ONE PLACE THE FEASIBILITY RULE LIVES.
   *
   * Takes an already-computed objective value plus whatever carries maxStage/bossHpPercent -- the
   * full evaluator result, or the {kill, hp, maxStage} metadata a scorer rides alongside its
   * scores. Both callers go through here so the rule cannot be implemented twice and drift, which
   * is this codebase's most-repeated failure.
   */
  function constrainScore(baseScore, meta, targetBosses) {
    if (!Number.isFinite(targetBosses)) {
      throw new Error('constrainScore: targetBosses must be a number');
    }
    const shaped = { maxStage: meta.maxStage, bossHpPercent: Number.isFinite(meta.bossHpPercent) ? meta.bossHpPercent : meta.hp };
    const violation = constraintViolation(shaped, targetBosses);
    if (violation <= 0) {
      if (!(baseScore >= 0)) {
        throw new Error(`constrainScore: objective produced a negative or non-finite score `
          + `(${baseScore}); the feasible/infeasible separator assumes a non-negative objective`);
      }
      return baseScore;
    }
    return INFEASIBLE_BASE - violation;
  }

  const Objective = { MODES, scoreFor, regimeOf, constraintViolation, constrainedScoreFor,
    constrainScore,
    INFEASIBLE_BASE, pinnedAttrsFor, pathModes, modeOrThrow, bossTargetFor, contextFor, describeRun, BOSS_INTERVAL, KILL_ACHIEVED_BASE };

  if (typeof module !== 'undefined' && module.exports) module.exports = Objective;
  else global.OptimizerObjective = Objective;
})(typeof window !== 'undefined' ? window : globalThis);
