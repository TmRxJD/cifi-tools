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
  const LOOT_TIEBREAK_SCALE = 5;

  function bossScore(r) {
    const killRate = r.bossKillRate || 0;
    if (killRate <= 0) {
      // Not killing it yet: how far it gets, then how little boss HP is left at that wall.
      const stage = Number.isFinite(r.avgStage) ? r.avgStage : 0;
      const remaining = Number.isFinite(r.bossHpPercent) ? r.bossHpPercent : 100;
      return stage * STAGE_PROGRESS_SCALE + (100 - remaining);
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
  function scoreFor(mode, result) {
    return modeOrThrow(mode).score(result);
  }

  /** Attribute ids this mode requires to be held at maximum, or an empty array. */
  function pinnedAttrsFor(mode) {
    return modeOrThrow(mode).pinnedAttrs || [];
  }

  const Objective = { MODES, scoreFor, pinnedAttrsFor, modeOrThrow };

  if (typeof module !== 'undefined' && module.exports) module.exports = Objective;
  else global.OptimizerObjective = Objective;
})(typeof window !== 'undefined' ? window : globalThis);
