// Pure ROI value function for ranking hunter upgrade purchases. No hardcoded phase model,
// no stage-push proxy, no boss-reachability heuristics -- every purchase (defensive,
// offensive, or an inscription level) is ranked ENTIRELY by how much it moves the player's
// own simulated lootPerMin, the sim's canonical throughput metric which already blends
// regular loot AND boss loot across the whole Monte Carlo run distribution. Whether "glass
// cannon" or "invest in survivability" is correct at any given point falls out of that ROI
// comparison on its own -- it is never asserted by this file, because a hardcoded phase rule
// is only as correct as our own guess and would silently mis-rank any account whose real
// numbers don't match that guess (see the build-card Effective Path feedback that led to this
// rewrite: an earlier weighted-phase version recommended HP/DR/Regen purchases during what
// should have been a pure glass-cannon stretch).
(function (global) {
  function marginalValue(baselineSim, candidateSim) {
    if (!baselineSim || !candidateSim) return { delta: -Infinity };
    return { delta: (candidateSim.lootPerMin || 0) - (baselineSim.lootPerMin || 0) };
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
