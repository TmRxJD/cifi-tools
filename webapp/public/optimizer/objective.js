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
      crossSeedFrom: 'boss',
    },
    push: {
      label: 'Ø Stage (push)',
      help: 'Maximises average stage reached, trading loot for depth.',
      score: (r) => r.avgStage,
      crossSeedFrom: 'boss',
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

  /** Attribute ids this mode requires to be held at maximum, or an empty array. */
  /**
   * WHY THERE IS NO CROSS-SEEDING BETWEEN OBJECTIVES.
   *
   * A pass used to run a `boss` search inside `loot` and enter its answer as a loot candidate,
   * to get past builds that stall at an unkilled boss. That was wrong on the game's own terms.
   *
   * Node effects are ASYMMETRIC: some are weaker against bosses, some only apply to bosses. A
   * boss build therefore deliberately funds boss-positive nodes and avoids boss-reduced ones,
   * while a push build -- which already goes past the boss and kills mostly normal enemies --
   * happily takes the boss-reduced nodes. So a boss-shaped allocation is not "a stronger version"
   * of a loot or push allocation; it is tuned for a different fight. Injecting one into the loot
   * search offers a candidate built to the wrong asymmetry, and costs a full second search to do
   * it.
   *
   * If loot genuinely is capped by an unkilled boss, that shows up in `lootPerMin` on its own --
   * the score is what we are after -- and the fix belongs in the search's ability to get there,
   * not in borrowing an answer from an objective that wants something else.
   */
  /**
   * Which objective should ALSO be searched, its answer entered here as an ordinary candidate.
   *
   * IT IS A NAVIGATION AID, NOT A SECOND METRIC. The candidate is judged at Stage 3 on the
   * caller's objective like every other finalist, so it only wins if it genuinely farms more.
   * Boss HP is a smooth, low-variance signal that steers into build shapes `loot` cannot reach on
   * its own -- near a boss threshold a kill is a rare event, and at screening fidelity the loot
   * difference between "almost kills" and "never kills" is unresolvable noise.
   *
   * MEASURED, and this is why it is here rather than deleted: on a real level-62 Ozzy that kills
   * its boss 50-67% of the time, removing this pass took the result from 39,881,450 to 11,879,496
   * -- a 3.3x loss on lootPerMin alone. Refinement hands the polish ~34M with it and ~11.8M
   * without; the polish only ever adds the last 16%.
   *
   * Five loot-native routes to those builds were tried and measured failing: concentrated
   * screening shapes, gate-paying fills, deterministic annealing, wider refinement, and ranking
   * non-killing builds by boss progress (which fixed Knox and cost borge@26 73%).
   */
  function crossSeedFor(mode) {
    return modeOrThrow(mode).crossSeedFrom || null;
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

  const Objective = { MODES, scoreFor, pinnedAttrsFor, pathModes, modeOrThrow, crossSeedFor, bossTargetFor, contextFor, KILL_ACHIEVED_BASE };

  if (typeof module !== 'undefined' && module.exports) module.exports = Objective;
  else global.OptimizerObjective = Objective;
})(typeof window !== 'undefined' ? window : globalThis);
