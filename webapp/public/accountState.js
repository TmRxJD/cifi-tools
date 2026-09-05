// THE account state. One object describing "this hunter, this build, this account" -- and a set
// of ADAPTERS that project it into whatever shape a consumer needs.
//
// WHY THIS EXISTS, because the alternative was tried for a long time and failed repeatedly.
//
// There used to be three hand-written builders (evalStateFor, cfgFor, statPathCfgFor) plus a
// fourth partial copy inside the optimizer's runner (serializeCfg), each assembling the same
// account from the same store by hand. CLAUDE.md defended that as correct, with the instruction
// "if you add an account-state field to one, add it to all three in the same change". That
// instruction is not a design; it is a standing invitation to drift, and every one of these was a
// real, shipped divergence found by reading the four side by side:
//
//   * statPathCfgFor passed `baseOverrides: {}` -- the purchase path evaluated every candidate
//     with the build's own overrides thrown away.
//   * statPathCfgFor passed RAW `d.talents` / `d.attributes`, so its caps were the static ones:
//     Call Me Lucky Loot capped at 10 for an account that owns Attraction node 2 and can reach 12.
//   * statPathCfgFor skipped the advanced-talent filter the other two apply.
//   * serializeCfg listed the worker's fields by hand; an earlier version omitted gemPlannerStore
//     and the optimizer scored every candidate in a gem-less world while the build card scored the
//     real one. The recorded fix was a comment asking the next person to remember.
//
// None of these threw. They produced a plausible number that disagreed with another plausible
// number somewhere else in the app, which is the single most expensive kind of bug in this project.
//
// THE RULE: this file owns the account. Consumers take an adapter. An adapter may DROP fields the
// consumer genuinely cannot use, and may RESHAPE names the consumer's API demands, but it may not
// INVENT a value or read the store itself. If a consumer needs something new, it goes in the
// canonical object once and every adapter sees it.
(function (global) {
  /**
   * Build the canonical state.
   *
   * Inputs are passed EXPLICITLY rather than read from globals, so this is constructible under
   * Node (the benches) with no DOM and no store singleton -- which is what makes it possible for a
   * bench to test the same object the app uses instead of assembling a fifth lookalike.
   *
   * @param {object}  o
   * @param {string}  o.hunter
   * @param {object}  o.build                 { level, talents, attributes, overrides }
   * @param {object}  o.hunterStats           the ACCOUNT's base stats (includes `stage`)
   * @param {object}  o.globalUpgrades        FLAT store form ("relics.r4": 12)
   * @param {object}  o.gems                  gem states by tree
   * @param {boolean} o.showAdvancedTalents   whether advanced talents may receive NEW points
   */
  function build({ hunter, build: b, hunterStats, globalUpgrades, gems, showAdvancedTalents }) {
    if (!hunter) throw new Error('AccountState: hunter is required');
    if (!b) throw new Error('AccountState: build is required');
    const defs = global.HUNTER_DEFS[hunter];
    if (!defs) throw new Error(`AccountState: unknown hunter "${hunter}"`);

    // THE STATS MUST BELONG TO THIS HUNTER, AND A MISMATCH MUST THROW RATHER THAN SCORE.
    //
    // Every hunter has its own base-stat vocabulary -- Ozzy has multichance/multipower/evade,
    // Knox has block/charge/chargeGain/reload/proj, Borge has critchance/critpower. Hand one
    // hunter's stats to another and the evaluator does NOT fail: the foreign keys resolve to
    // nothing, the missing ones default, and it returns a perfectly plausible number for a build
    // nobody has. That is the worst possible failure mode, and it already cost a day -- a Knox
    // build scored with Ozzy's stats (and Ozzy's stage 201 instead of Knox's 100) read as 0.48%
    // BELOW the account's own build, when measured correctly it is 18.48% ABOVE. A whole
    // investigation into a Knox "refinement depth defect" chased a bug in the measurement.
    //
    // The trap is that `evalStateFor(build, iterations)` in app.js takes no hunter -- it reads the
    // `currentHunter` global, which is right for the app and wrong for any bench or console script
    // that loops over hunters. Rather than fix the call sites and hope, the check lives HERE,
    // because every path (cfgFor, evalStateFor, the benches, the optimizer) funnels through this
    // one constructor. It cannot be bypassed by writing a new caller.
    if (hunterStats) {
      const allowed = new Set(defs.baseStatKeys);
      const foreign = Object.keys(hunterStats).filter((k) => !allowed.has(k));
      if (foreign.length) {
        throw new Error(`AccountState: hunterStats for "${hunter}" carries field(s) `
          + `${foreign.join(', ')} that belong to a different hunter -- `
          + `${hunter} declares ${defs.baseStatKeys.join(', ')}. `
          + 'This is almost always another hunter’s stats, which would score a plausible '
          + 'but meaningless build rather than fail.');
      }
    }

    const buildOverrides = b.overrides || {};
    // Caps are resolved ONCE, here, for this account -- never re-derived per consumer. Borge's
    // Call Me Lucky Loot caps at 12 rather than 10 once Attraction gem node 2 is owned, and a
    // consumer reading the static cap rejects a legal build.
    const capCtx = { gemPlannerStore: { gemStates: gems }, buildOverrides };

    // The advanced-talent rule: a talent the account has not unlocked may not receive NEW points,
    // but points already in it are part of a legal current allocation and are kept.
    const talentDefs = defs.talents.filter(
      (t) => !t.advanced || showAdvancedTalents || (b.talents?.[t.id] || 0) > 0,
    );

    return Object.freeze({
      hunter,
      level: b.level,
      talents: b.talents,
      attributes: b.attributes,
      hunterStats,
      buildOverrides,
      // Nested form ({relics: {r4: 12}}) is what the simulator's resolveParam walks; the flat form
      // is the store's. Converted once here so no consumer has to remember which it holds.
      upgrades: global.buildNestedUpgrades(globalUpgrades),
      gems,
      TALENTS: global.resolveMaxLevels(talentDefs, capCtx),
      ATTRIBUTES: global.resolveMaxLevels(defs.attributes, capCtx),
      ATTRIBUTE_DEPENDENCIES: defs.attributeDependencies,
      ATTRIBUTE_MIN_VALUE: defs.attributeMinValue,
      TALENT_BUDGET: global.talentBudgetForLevel(b.level),
      ATTRIBUTE_BUDGET: global.attributeBudgetForLevel(b.level),
    });
  }

  // --- Adapters ---------------------------------------------------------------------------
  // Each is a pure projection. Read them together: what differs between them is exactly what the
  // consuming API demands, and nothing else.

  /** For HunterSim.evaluate / evaluateDetailed -- the build card, stats modal, share dialog. */
  function simState(acct, iterations) {
    return {
      level: acct.level,
      iterations,
      hunterStats: acct.hunterStats,
      talents: acct.talents,
      attributes: acct.attributes,
      overrides: acct.buildOverrides,
      upgrades: acct.upgrades,
      gemPlannerStore: { gemStates: acct.gems },
    };
  }

  /** For HunterSim.compileEvaluator + HunterOptimizer.optimize. */
  function optimizerCfg(acct) {
    return {
      hunter: acct.hunter,
      level: acct.level,
      hunterStats: acct.hunterStats,
      baseOverrides: acct.buildOverrides,
      globalUpgrades: acct.upgrades,
      gemPlannerStore: { gemStates: acct.gems },
      TALENTS: acct.TALENTS,
      ATTRIBUTES: acct.ATTRIBUTES,
      ATTRIBUTE_DEPENDENCIES: acct.ATTRIBUTE_DEPENDENCIES,
      ATTRIBUTE_MIN_VALUE: acct.ATTRIBUTE_MIN_VALUE,
      TALENT_BUDGET: acct.TALENT_BUDGET,
      ATTRIBUTE_BUDGET: acct.ATTRIBUTE_BUDGET,
    };
  }

  /**
   * For greedyPurchasePath, which varies BASE STATS and upgrade levels while holding the
   * allocation fixed -- the mirror image of the optimizer.
   */
  function pathCfg(acct) {
    return {
      level: acct.level,
      talents: acct.talents,
      attributes: acct.attributes,
      hunterStats: acct.hunterStats,
      baseOverrides: acct.buildOverrides,
      globalUpgrades: acct.upgrades,
      gemPlannerStore: { gemStates: acct.gems },
      TALENTS: acct.TALENTS,
      ATTRIBUTES: acct.ATTRIBUTES,
    };
  }

  /**
   * The fields a scoring Worker needs, DERIVED from the optimizer config rather than re-listed.
   *
   * A Worker cannot receive functions, so this is a structural-clone-safe subset -- but which
   * subset is decided here, next to the other adapters, and asserted. The previous hand-written
   * copy silently omitted gemPlannerStore once; a missing field now throws at the boundary
   * instead of producing a worker that scores a different game.
   */
  const WORKER_FIELDS = [
    'hunter', 'level', 'hunterStats', 'baseOverrides', 'globalUpgrades', 'gemPlannerStore',
    'TALENTS', 'ATTRIBUTES',
  ];
  function workerCfg(cfg) {
    const out = {};
    for (const f of WORKER_FIELDS) {
      if (cfg[f] === undefined) {
        throw new Error(`AccountState.workerCfg: "${f}" is missing -- a worker built from this `
          + 'would score a different account than the page displays');
      }
      out[f] = cfg[f];
    }
    return out;
  }

  global.AccountState = { build, simState, optimizerCfg, pathCfg, workerCfg, WORKER_FIELDS };
}(typeof window !== 'undefined' ? window : globalThis));
