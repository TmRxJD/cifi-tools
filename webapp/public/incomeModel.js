// Player-derived resource income rates. Entirely computed from the player's own simulated
// farm loop (HunterSim.evaluate's mat1/mat2/mat3 per-run yield and avgTime), matching the
// exact perDayRate computation already used by app.js's Override Costs modal (r.matX *
// runsPerDay, runsPerDay = 1440 / r.avgTime) -- no hardcoded rates anywhere.
(function (global) {
  // Runs a fresh sim at the player's CURRENT state (real hunterStats + the given baseline
  // talents/attributes/level -- this tool has no single "current real build" concept, so the
  // caller picks which build represents the player's actual loadout) to get the farm-loop
  // numbers a stat-purchase plan should be budgeted against.
  async function currentRates(hunter, storeState, baseline, iterations) {
    const h = storeState[hunter];
    const r = await HunterSim.evaluate(hunter, {
      level: baseline.level, hunterStats: h.hunterStats, talents: baseline.talents, attributes: baseline.attributes,
      overrides: {}, upgrades: window.buildNestedUpgrades(storeState.globalUpgrades),
      gemPlannerStore: { gemStates: storeState.gems }, iterations: iterations || 1000,
    });
    const runsPerDay = r.avgTime ? 1440 / r.avgTime : 0;
    const perDay = { mat1: r.mat1 * runsPerDay, mat2: r.mat2 * runsPerDay, mat3: r.mat3 * runsPerDay };
    const perHour = { mat1: perDay.mat1 / 24, mat2: perDay.mat2 / 24, mat3: perDay.mat3 / 24 };
    return { runsPerDay, perDay, perHour, sim: r };
  }

  // Hours of farming (at the given perHour rates) needed to accumulate `cost` of `resKey`,
  // assuming nothing currently banked (this app doesn't track a live currency balance).
  function hoursToAfford(cost, perHour, resKey) {
    const rate = perHour ? perHour[resKey] : undefined;
    if (!cost) return 0;
    if (!rate) return Infinity;
    return cost / rate;
  }

  function fmtHours(hours) {
    if (!isFinite(hours)) return '—';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 48) return `${hours.toFixed(1)}h`;
    const days = hours / 24;
    if (days < 365) return `${days.toFixed(1)}d`;
    const years = days / 365;
    if (years < 1000) return `${years.toFixed(1)}y`;
    return `${years.toExponential(1)}y`; // cost curves at high levels can be absurdly far off -- still honest, just readable
  }

  global.IncomeModel = { currentRates, hoursToAfford, fmtHours };
})(window);
