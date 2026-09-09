// Pure ROI value function for ranking hunter upgrade purchases. No hardcoded phase model,
// no stage-push proxy, no boss-reachability heuristics -- every purchase (defensive,
// offensive, an inscription level, a relic level) is ranked ENTIRELY by how much it moves the
// player's own simulated score under the objective they picked. Whether "glass cannon" or
// "invest in survivability" is correct at any given point falls out of that ROI comparison on
// its own -- it is never asserted by this file, because a hardcoded phase rule is only as
// correct as our own guess and would silently mis-rank any account whose real numbers don't
// match that guess (see the build-card Effective Path feedback that led to this rewrite: an
// earlier weighted-phase version recommended HP/DR/Regen purchases during what should have been
// a pure glass-cannon stretch).
(function (global) {
  /**
   * Marginal value of one purchase, under one objective.
   *
   * The objective is NOT redefined here -- it comes from optimizer/objective.js, the same table
   * the optimizer and its workers score through. That matters most for the boss modes: "what
   * should I buy to kill the boss" and "what should the optimizer allocate to kill the boss"
   * must mean the same thing, or the two screens would send the player in different directions.
   *
   * In 'loot' this is exactly what it always was, a lootPerMin difference, because that is what
   * the loot objective returns.
   *
   * Note on boss scale: the boss objective is lexicographic, so a purchase that turns a non-kill
   * into a kill produces a delta around 1e9 while ordinary improvements are far smaller. That is
   * the intent -- the thing that unlocks the kill should outrank everything else -- and dividing
   * by cost still orders correctly within each tier.
   */
  function marginalValue(baselineSim, candidateSim, mode = 'loot') {
    if (!baselineSim || !candidateSim) return { delta: -Infinity };
    const Objective = global.OptimizerObjective;
    if (!Objective) throw new Error('marginalValue: optimizer/objective.js must load before this file');
    return { delta: Objective.scoreFor(mode, candidateSim) - Objective.scoreFor(mode, baselineSim) };
  }

  // Purely COSMETIC, post-hoc label for the UI -- describes what the sim's own numbers say is
  // currently true (are boss kills happening at all, how reliably), for display only. It never
  // feeds back into which purchase gets picked -- ranking above is the only thing that decides
  // that, so this label can't skew results the way a scoring-time phase weight would.
  function describePhase(sim) {
    const kill = sim && typeof sim.bossKillRate === 'number' ? sim.bossKillRate : 0;
    if (kill <= 0) return 'glassCannon';
    if (kill < 0.85) return 'survival';
    return 'farm';
  }

  global.HunterStatPath = { marginalValue, describePhase };
})(window);
