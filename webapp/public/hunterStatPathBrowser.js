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

  function groupByResource(candidates) {
    const groups = {};
    candidates.forEach((c) => { (groups[c.resource] || (groups[c.resource] = [])).push(c); });
    return groups;
  }

  function purchaseCostOf(hunter, CF, cand, nextLevel) {
    return cand.kind === 'stat' ? CF.baseStatCostAtLevel(cand.key, nextLevel, hunter) : CF.inscryptionCostAtLevel(cand.key, nextLevel);
  }
  function capOf(def, cand) {
    return cand.kind === 'stat' ? def.statCaps?.[cand.key] : cand.maxLevel;
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
  async function greedyResourceColumn(hunter, cfg, evalFast, def, CF, candidates, currentStats, currentInsc, targetSteps, iterations, onProgress) {
    const stats = { ...currentStats };
    const insc = { ...currentInsc };
    let baselineSim = await evalFast(cfg.talents, cfg.attributes, iterations, stats, insc);

    const steps = [];
    for (let i = 0; i < targetSteps; i++) {
      await yieldToUI();
      if (onProgress) onProgress(i, targetSteps);
      let best = null;
      for (const cand of candidates) {
        const curLevel = cand.kind === 'stat' ? (stats[cand.key] || 0) : (insc[`upgrades.inscryptions.${cand.key}`] || 0);
        const nextLevel = curLevel + 1;
        const cap = capOf(def, cand);
        if (isFinite(cap) && nextLevel > cap) continue;
        const cost = purchaseCostOf(hunter, CF, cand, nextLevel);
        if (!cost || cost <= 0) continue;

        const candStats = cand.kind === 'stat' ? { ...stats, [cand.key]: nextLevel } : stats;
        const candInsc = cand.kind === 'inscryption' ? { ...insc, [`upgrades.inscryptions.${cand.key}`]: nextLevel } : insc;
        const candidateSim = await evalFast(cfg.talents, cfg.attributes, iterations, candStats, candInsc);
        const { delta } = window.HunterStatPath.marginalValue(baselineSim, candidateSim);
        const valuePerCost = delta / cost;

        if (!best || valuePerCost > best.valuePerCost) best = { cand, nextLevel, cost, candStats, candInsc, candidateSim, valuePerCost };
      }
      if (!best) break; // every candidate capped out / no cost formula left -- nothing left to rank

      Object.assign(stats, best.candStats);
      Object.assign(insc, best.candInsc);
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
  function resourcesFor(hunter, includeInscriptions) {
    const def = window.HUNTER_DEFS[hunter];
    const CF = window.CostFormulas;
    const candidates = buildStatCandidates(hunter, def, CF).concat(includeInscriptions ? buildInscryptionCandidates(hunter, def, CF) : []);
    return [...new Set(candidates.map((c) => c.resource))];
  }

  /**
   * THE purchase-path walk. One implementation, two candidate pools.
   *
   * `includeInscriptions` false -> base stats only (the Hunter Stats page's "Effective Path").
   * `includeInscriptions` true  -> stats plus this hunter's inscription levels (the build
   * card's "Effective Path"). Talents/attributes are deliberately excluded from both: they are
   * point-budget-gated by level rather than currency-gated, and belong to the Optimize flow.
   * Relics are excluded too -- different currency, not modeled.
   *
   * These were two near-identical functions that had already drifted apart on fidelity. Same
   * walk, same ranking, one place to change.
   *
   * cfg: { level, talents, attributes, hunterStats, baseOverrides, globalUpgrades,
   *        gemPlannerStore, TALENTS, ATTRIBUTES }
   * onProgress(resource, done, total) fires as each resource's column advances.
   */
  async function greedyPurchasePath(hunter, cfg, targetSteps, includeInscriptions, onProgress) {
    const def = window.HUNTER_DEFS[hunter];
    const CF = window.CostFormulas;
    const statCandidates = buildStatCandidates(hunter, def, CF);
    const inscCandidates = includeInscriptions ? buildInscryptionCandidates(hunter, def, CF) : [];
    const inscryptionParams = inscCandidates.map((c) => `upgrades.inscryptions.${c.key}`);

    const evalFast = await HunterSim.compileEvaluator(hunter, {
      ...cfg,
      STAT_KEYS: statCandidates.map((c) => c.key),
      INSCRYPTION_PARAMS: inscryptionParams,
    });

    const currentInsc = {};
    inscryptionParams.forEach((p) => { currentInsc[p] = cfg.globalUpgrades?.inscryptions?.[p.split('.')[2]] || 0; });

    // Resources are independent currencies, so their columns are computed in parallel -- this
    // also roughly halves/thirds wall-clock time vs. running them one after another.
    const entries = Object.entries(groupByResource([...statCandidates, ...inscCandidates]));
    const results = await Promise.all(entries.map(([resource, group]) => greedyResourceColumn(
      hunter, cfg, evalFast, def, CF, group, cfg.hunterStats, currentInsc, targetSteps, SEARCH_ITERATIONS,
      onProgress && ((done, total) => onProgress(resource, done, total)),
    )));
    const columns = {};
    entries.forEach(([resource], i) => { columns[resource] = results[i]; });
    return { columns };
  }

  global.resourcesFor = resourcesFor;
  global.greedyPurchasePath = greedyPurchasePath;
})(window);
