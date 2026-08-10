// Greedy marginal-loot-ROI allocator for hunter upgrade purchases (base stats + inscription
// levels). Each material resource (mat1/mat2/mat3, and for Ozzy the separate inscription
// currency HBM) is an independent currency that never competes with the others, so each gets
// its OWN independent greedy walk and its own ordered column -- one resource's queue never
// has to be reordered around another's. Every candidate within a column is ranked purely by
// its real marginal effect on lootPerMin (see hunterStatPath.js) -- there is no hardcoded
// notion of "defensive" vs "offensive" stats or of game phases baked into the ranking itself.
(function (global) {
  // Coarse per-candidate fidelity, taken from the optimizer rather than chosen again here.
  // This file previously carried TWO different values (150 for the stat-only path, 100 for the
  // build-card path) for the same kind of screening, so the same candidate could rank
  // differently depending on which entry point you came through. There is one coarse fidelity
  // in this app and optimizer/search.js defines it.
  const SEARCH_ITERATIONS = global.HunterOptimizer.SCREEN_ITERATIONS;

  function buildStatCandidates(hunter, def, CF) {
    return def.baseStatKeys
      .filter((k) => CF.baseStatResource(hunter, k)) // excludes 'stage' -- no resource/cost, not purchasable
      .map((key) => ({ kind: 'stat', key, resource: CF.baseStatResource(hunter, key) }));
  }

  function buildInscryptionCandidates(hunter, def, CF) {
    const resource = CF.inscryptionResource(hunter);
    if (!resource) return []; // Knox has no modeled inscription resource
    return (def.globalUpgrades.inscryptions?.items || []).map((item) => ({
      kind: 'inscryption', key: item.id, label: item.label, maxLevel: item.maxLevel, resource,
    }));
  }

  // Relics are ACCOUNT-WIDE and bought with Fragments, a currency none of the stat/inscription
  // columns compete for -- so they form their own independent column, same as every other
  // resource here.
  //
  // No relic is filtered out by hand, including the ones measured to do nothing (Borge r7/r19,
  // Ozzy r7, Knox t2r5 -- see CLAUDE.md). The walk ranks by REAL measured marginal effect, so
  // an inert relic scores a delta of exactly 0 and loses to anything that moves the number. It
  // falls out of the ranking rather than needing a maintained blocklist -- and if the game ever
  // makes one of them matter, this picks that up with no code change.
  function buildRelicCandidates(hunter, def, CF) {
    const resource = CF.relicResource(hunter);
    // Knox has no modeled relic currency -- the live tool doesn't price Knox relics either
    // (its resource table carries no Fragments entry). Not guessed here; see CLAUDE.md.
    if (!resource) return [];
    return (def.globalUpgrades.relics?.items || []).map((item) => ({
      kind: 'relic', key: item.id, label: item.label, maxLevel: item.maxLevel, resource,
    }));
  }

  function groupByResource(candidates) {
    const groups = {};
    candidates.forEach((c) => { (groups[c.resource] || (groups[c.resource] = [])).push(c); });
    return groups;
  }

  function purchaseCostOf(hunter, CF, cand, nextLevel) {
    if (cand.kind === 'stat') return CF.baseStatCostAtLevel(cand.key, nextLevel, hunter);
    if (cand.kind === 'relic') return CF.relicCostAtLevel(cand.key, nextLevel);
    return CF.inscryptionCostAtLevel(cand.key, nextLevel);
  }
  function capOf(def, cand) {
    return cand.kind === 'stat' ? def.statCaps?.[cand.key] : cand.maxLevel;
  }
  // Full wasm param name for a non-stat candidate. Stats are addressed by bare key instead.
  function upgradeParamOf(cand) {
    if (cand.kind === 'inscryption') return `upgrades.inscryptions.${cand.key}`;
    if (cand.kind === 'relic') return `upgrades.relics.${cand.key}`;
    throw new Error(`upgradeParamOf: "${cand.kind}" is not an upgrade-param candidate`);
  }

  // Yields between steps so a long run of sequential wasm calls doesn't block the UI thread for
  // the whole computation -- without this the modal appears (it's inserted before any of this
  // runs) but the page stops responding/repainting until the entire multi-hundred-call
  // computation finishes, which reads as "hard lag."
  //
  // setTimeout, NOT requestAnimationFrame. rAF is paused entirely in a backgrounded tab, so the
  // walk made zero progress whenever the tab wasn't visible -- switch away mid-computation and
  // you came back to a modal frozen exactly where you left it (confirmed directly:
  // document.hidden === true and the run sat at the same step indefinitely). A macrotask yield
  // still lets the browser repaint between steps and keeps running when hidden.
  function yieldToUI() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // One resource's independent greedy walk -- candidates here only vary THIS resource's own
  // stats/inscriptions; everything outside this group stays pinned at the player's current
  // real values, since the point is that this column's recommendation shouldn't depend on
  // (or wait on) any other resource's queue.
  //
  // Always walks the full targetSteps regardless of whether a step's marginal ROI is
  // positive -- the point of this view is "here's the next N in ranked order for this
  // resource," not "here's how many are worth buying." It only stops early if literally
  // nothing is purchasable anymore (every candidate capped out or missing a cost formula).
  async function greedyResourceColumn(hunter, cfg, evalFast, def, CF, candidates, currentStats, currentUpgrades, targetSteps, iterations, mode, onProgress) {
    const stats = { ...currentStats };
    const upgrades = { ...currentUpgrades };
    let baselineSim = await evalFast(cfg.talents, cfg.attributes, iterations, stats, upgrades);

    const steps = [];
    for (let i = 0; i < targetSteps; i++) {
      await yieldToUI();
      if (onProgress) onProgress(i, targetSteps);
      let best = null;
      for (const cand of candidates) {
        const param = cand.kind === 'stat' ? null : upgradeParamOf(cand);
        const curLevel = param ? (upgrades[param] || 0) : (stats[cand.key] || 0);
        const nextLevel = curLevel + 1;
        const cap = capOf(def, cand);
        if (isFinite(cap) && nextLevel > cap) continue;
        const cost = purchaseCostOf(hunter, CF, cand, nextLevel);
        if (!cost || cost <= 0) continue;

        const candStats = param ? stats : { ...stats, [cand.key]: nextLevel };
        const candUpgrades = param ? { ...upgrades, [param]: nextLevel } : upgrades;
        const candidateSim = await evalFast(cfg.talents, cfg.attributes, iterations, candStats, candUpgrades);
        const { delta } = window.HunterStatPath.marginalValue(baselineSim, candidateSim, mode);
        const valuePerCost = delta / cost;

        if (!best || valuePerCost > best.valuePerCost) best = { cand, nextLevel, cost, candStats, candUpgrades, candidateSim, valuePerCost };
      }
      if (!best) break; // every candidate capped out / no cost formula left -- nothing left to rank

      Object.assign(stats, best.candStats);
      Object.assign(upgrades, best.candUpgrades);
      baselineSim = best.candidateSim;
      steps.push({
        kind: best.cand.kind, key: best.cand.key, label: best.cand.label, level: best.nextLevel,
        cost: best.cost, resource: best.cand.resource,
      });
    }
    if (onProgress) onProgress(targetSteps, targetSteps);
    return { steps, finalSim: baselineSim };
  }

  // Every resource here has an independent candidate pool, so the resource list -- and
  // therefore what a progress UI needs to render BEFORE any computation starts -- is knowable
  // synchronously up front.
  function resourcesFor(hunter, includeAccountUpgrades) {
    const def = window.HUNTER_DEFS[hunter];
    const CF = window.CostFormulas;
    const candidates = buildStatCandidates(hunter, def, CF).concat(accountUpgradeCandidates(hunter, def, CF, includeAccountUpgrades));
    return [...new Set(candidates.map((c) => c.resource))];
  }

  // Inscriptions and relics are both account-wide purchases in their own currencies, and both
  // belong to the build-card path but not the bare stats page. One list so the two entry points
  // cannot disagree about what the path considers.
  function accountUpgradeCandidates(hunter, def, CF, include) {
    if (!include) return [];
    return buildInscryptionCandidates(hunter, def, CF).concat(buildRelicCandidates(hunter, def, CF));
  }

  /**
   * THE purchase-path walk. One implementation, two candidate pools.
   *
   * `includeAccountUpgrades` false -> base stats only (the Hunter Stats page's "Effective
   * Path"). true -> stats plus this hunter's account-wide purchases: inscription levels AND
   * relic levels, each in its own currency column. Talents/attributes are deliberately excluded
   * from both: they are point-budget-gated by level rather than currency-gated, and belong to
   * the Optimize flow.
   *
   * These were two near-identical functions that had already drifted apart on fidelity. Same
   * walk, same ranking, one place to change.
   *
   * cfg: { level, talents, attributes, hunterStats, baseOverrides, globalUpgrades,
   *        gemPlannerStore, TALENTS, ATTRIBUTES }
   * onProgress(resource, done, total) fires as each resource's column advances.
   */
  async function greedyPurchasePath(hunter, cfg, targetSteps, includeAccountUpgrades, mode = 'loot', onProgress) {
    // Fail loudly on an unknown or path-inapplicable mode. A mode with pinnedAttrs (bossTimeless)
    // cannot behave differently here -- the path never reallocates attributes -- so accepting it
    // would show the user a choice that silently does nothing.
    if (!window.OptimizerObjective.pathModes()[mode]) {
      throw new Error(`greedyPurchasePath: "${mode}" is not a purchase-path mode (expected one of `
        + `${Object.keys(window.OptimizerObjective.pathModes()).join(', ')})`);
    }
    const def = window.HUNTER_DEFS[hunter];
    const CF = window.CostFormulas;
    const statCandidates = buildStatCandidates(hunter, def, CF);
    const upgradeCandidates = accountUpgradeCandidates(hunter, def, CF, includeAccountUpgrades);
    const upgradeParams = upgradeCandidates.map(upgradeParamOf);

    const evalFast = await HunterSim.compileEvaluator(hunter, {
      ...cfg,
      STAT_KEYS: statCandidates.map((c) => c.key),
      UPGRADE_PARAMS: upgradeParams,
    });

    const currentUpgrades = {};
    upgradeParams.forEach((p) => {
      const [, category, id] = p.split('.');
      currentUpgrades[p] = cfg.globalUpgrades?.[category]?.[id] || 0;
    });

    // Resources are independent currencies, so their columns are computed in parallel -- this
    // also roughly halves/thirds wall-clock time vs. running them one after another.
    const entries = Object.entries(groupByResource([...statCandidates, ...upgradeCandidates]));
    const results = await Promise.all(entries.map(([resource, group]) => greedyResourceColumn(
      hunter, cfg, evalFast, def, CF, group, cfg.hunterStats, currentUpgrades, targetSteps, SEARCH_ITERATIONS, mode,
      onProgress && ((done, total) => onProgress(resource, done, total)),
    )));
    const columns = {};
    entries.forEach(([resource], i) => { columns[resource] = results[i]; });
    return { columns };
  }

  global.resourcesFor = resourcesFor;
  global.greedyPurchasePath = greedyPurchasePath;
})(window);
