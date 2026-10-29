// Player-derived resource income rates. Entirely computed from the player's own simulated
// farm loop (HunterSim.evaluate's mat1/mat2/mat3 per-run yield and avgTime), matching the
// exact perDayRate computation already used by app.js's Override Costs modal (r.matX *
// runsPerDay, runsPerDay = 1440 / r.avgTime) -- no hardcoded rates anywhere.
(function (global) {
  // Runs a fresh sim at the player's CURRENT state (real hunterStats + the given baseline
  // talents/attributes/level -- this tool has no single "current real build" concept, so the
  // caller picks which build represents the player's actual loadout) to get the farm-loop
  // numbers a stat-purchase plan should be budgeted against.
  // `signal` is optional. A single evaluate() is one atomic wasm call, so this cannot be
  // interrupted partway -- what it can do is refuse to start work nobody is waiting for, and
  // refuse to hand back a result for a superseded run. That is the whole of what "abortable"
  // can mean here, and it is worth doing: the caller then has one uniform way to cancel instead
  // of a special case that has to be guarded at every call site.
  async function currentRates(hunter, cfg, iterations, signal) {
    HunterSim.throwIfAborted(signal);
    // Ranking and income consume the SAME frozen account/build projection. Reading the live
    // store again here could price a plan for a different allocation or account snapshot.
    const r = await HunterSim.evaluate(hunter, {
      level: cfg.level, hunterStats: cfg.hunterStats, talents: cfg.talents, attributes: cfg.attributes,
      overrides: cfg.baseOverrides, upgrades: cfg.globalUpgrades,
      gemPlannerStore: cfg.gemPlannerStore, iterations,
    });
    HunterSim.throwIfAborted(signal);
    // Missing yields must not become NaN prices that silently drop every purchase.
    for (const key of ['avgTime', 'mat1', 'mat2', 'mat3']) {
      if (!Number.isFinite(r[key]) || r[key] < 0 || (key === 'avgTime' && r[key] === 0)) {
        throw new Error(`IncomeModel.currentRates: invalid simulation field ${key}`);
      }
    }
    const runsPerDay = 1440 / Number(r.avgTime);
    const perDay = { mat1: Number(r.mat1) * runsPerDay, mat2: Number(r.mat2) * runsPerDay, mat3: Number(r.mat3) * runsPerDay };
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
