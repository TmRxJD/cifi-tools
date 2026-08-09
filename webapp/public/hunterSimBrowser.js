// THE simulation entry point. Resolves a build's named parameters into the positional array
// release.wasm expects, and runs it.
//
// This is the only implementation. It runs unmodified in the page, in the optimizer's Web
// Workers, and under Node in tools/bench (which supplies a small fetch shim for the two
// assets). There used to be a second Node copy in tools/hunterSim.js; it had drifted into a
// materially different resolver -- no gem handling, no bossLootRate default -- so validation
// run through it disagreed with the app for reasons that looked like optimizer bugs. Deleted
// rather than resynced: two copies of this logic will always drift again.
//
// IMPORTANT: the wasm module carries its own internal PRNG state as a persistent global
// (not reset between calls, and not fed by any JS-side seed -- WebAssembly.Module.imports()
// confirms the ONLY import is env.abort, no Math.random/seed hookup). Confirmed by direct
// test: instantiating the module FRESH and calling EVALBORGE_WASM with identical args gives
// BIT-IDENTICAL output every time; reusing one long-lived instance across multiple calls
// (what this file used to do -- a single cached `wasmExportsPromise`) gives a SLIGHTLY
// DIFFERENT result each call, because the internal RNG state keeps advancing from wherever
// the previous call left it. The live site re-evaluates the same build to the exact same
// number every time (confirmed by the user), meaning it must instantiate fresh per
// evaluation rather than reusing one instance -- so we do the same here: cache the compiled
// Module (compiling is the expensive part) but instantiate a fresh instance -- and therefore
// fresh internal RNG state -- for every single evaluate/compileEvaluator call.
(function (global) {
  const WASM_EXPORT = { borge: 'EVALBORGE_WASM', ozzy: 'EVALOZZY_WASM', knox: 'EVALKNOX_WASM' };
  const IMPORT_OBJECT = { env: { abort: (a, b, c, d) => { throw new Error(`wasm abort at ${b}:${c}:${d}`); } } };

  // params.json and release.wasm sit next to this file at the site root, but relative fetch()
  // resolves against the *caller's* location -- and a Web Worker's location is the worker
  // script's own directory. A worker loaded from optimizer/ therefore asked for
  // optimizer/params.json and got a 404 ("Not found" is not valid JSON) at init. Resolving
  // against an explicit base fixes it for any load location instead of constraining where
  // workers are allowed to live; a worker in a subdirectory sets HUNTERSIM_ASSET_BASE before
  // importing this file (see optimizer/worker.js).
  function assetUrl(name) {
    return new URL(name, global.HUNTERSIM_ASSET_BASE || (typeof location !== 'undefined' ? location.href : undefined)).href;
  }

  let paramsPromise = null;
  function loadParams() {
    if (!paramsPromise) paramsPromise = fetch(assetUrl('params.json')).then((r) => r.json());
    return paramsPromise;
  }

  let wasmModulePromise = null;
  function loadWasmModule() {
    if (!wasmModulePromise) {
      wasmModulePromise = fetch(assetUrl('release.wasm'))
        .then((r) => r.arrayBuffer())
        .then((buf) => WebAssembly.compile(buf));
    }
    return wasmModulePromise;
  }

  // Returns a FRESH instance's exports every call -- deliberately not cached, see note above.
  async function loadWasm() {
    const mod = await loadWasmModule();
    const instance = await WebAssembly.instantiate(mod, IMPORT_OBJECT);
    return instance.exports;
  }

  // Ported verbatim from the live site's REAL build-list evaluator (extracted from
  // evaluationWorker-BKbzsoAA.js -- the actual worker function that computes Loot
  // Score/Stage, distinct from the step-simulation visualizer in the main bundle which has
  // a different, simpler resolver). Gem data is read from a SEPARATE `gemPlannerStore`
  // object (matching the real site's data model), not nested under `upgrades`.
  // GEM_UPGRADE_ALIASES itself lives in hunterDefs.js (window.GEM_UPGRADE_ALIASES, loaded
  // before this file) -- it's the one canonical copy shared with app.js's Overrides Cost
  // badge, instead of each keeping its own separately-maintained copy.

  function gemTree(state, tree) { return state.gemPlannerStore?.gemStates?.[tree]; }
  function sumGemUpgrades(state, tree) {
    const g = gemTree(state, tree);
    if (!g?.upgrades) return 0;
    return Object.values(g.upgrades).reduce((a, b) => a + (b || 0), 0);
  }
  function exodusGateUnlocked(state, gateOverrideName, nodeIndex) {
    if (state.overrides && gateOverrideName in state.overrides) return state.overrides[gateOverrideName] === 1;
    return gemTree(state, 'exodus')?.nodes?.[nodeIndex] || false;
  }

  function resolveParam(name, state) {
    if (name === 'upgrades.gems_nodes.exodus_temporalEvolutionCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      if (!exodusGateUnlocked(state, 'upgrades.gems_nodes.exodus_gem1', 0)) return 0;
      return sumGemUpgrades(state, 'temporal') + sumGemUpgrades(state, 'evolution');
    }
    if (name === 'upgrades.gems_nodes.exodus_gem3') {
      if (!exodusGateUnlocked(state, 'upgrades.gems_nodes.exodus_gem3', 2)) return 0;
      return sumGemUpgrades(state, 'power') + sumGemUpgrades(state, 'innovation');
    }
    if (name === 'upgrades.gems_nodes.exodus_powerInnovationCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      if (!exodusGateUnlocked(state, 'upgrades.gems_nodes.exodus_gem3', 2)) return 0;
      return sumGemUpgrades(state, 'power') + sumGemUpgrades(state, 'innovation');
    }
    if (name === 'upgrades.gems_nodes.exodus_gem5') {
      if (!exodusGateUnlocked(state, 'upgrades.gems_nodes.exodus_gem5', 4)) return 0;
      return sumGemUpgrades(state, 'attraction') + sumGemUpgrades(state, 'creation');
    }
    if (name === 'upgrades.gems_nodes.exodus_attractionCreationCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      if (!exodusGateUnlocked(state, 'upgrades.gems_nodes.exodus_gem5', 4)) return 0;
      return sumGemUpgrades(state, 'attraction') + sumGemUpgrades(state, 'creation');
    }
    if (name === 'upgrades.cms.milestoneCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      return state.upgrades?.cms?.milestoneCount || 0;
    }
    if (name === 'upgrades.gems_nodes.creation_galvTrinketsCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      if (!exodusGateUnlocked(state, 'upgrades.gems_nodes.creation_gem5', 4)) return 0;
      if (!state.upgrades?.trinkets) return 0;
      return Object.values(state.upgrades.trinkets).reduce((a, b) => a + (b || 0), 0);
    }
    if (state.overrides && name in state.overrides) {
      if (name === 'upgrades.diamondspecials.hunterloot') return 1 + 0.025 * (state.overrides[name] || 0);
      if (name === 'upgrades.diamondspecials.reviveboost') return 3 * (state.overrides[name] || 0);
      return state.overrides[name];
    }
    // Knox-only wasm param -- was falling through to the generic `return 0` default below
    // (it matches none of the other special-cases, isn't a talent/attribute/hunterStat, and
    // doesn't start with "upgrades."), meaning every Knox evaluation ran with boss loot
    // permanently zeroed out regardless of the build's actual boss-killing capability. 1
    // (full rate) is the correct default absent an override -- 0 was never intentional.
    if (name === 'bossLootRate') return state.overrides?.[name] ?? state.hunterStats?.bossLootRate ?? 1;
    if (name === 'iterations') return state.iterations ?? 1000;
    if (name === 'lvl') return state.level ?? 0;
    if (name === 'stage' || name === 'maxStage') return state.hunterStats?.stage ?? 0;
    if (state.talents && name in state.talents) return state.talents[name];
    if (state.attributes && name in state.attributes) return state.attributes[name];
    if (state.hunterStats && name in state.hunterStats) return state.hunterStats[name];
    if (name.startsWith('upgrades.')) {
      const parts = name.split('.');
      if (parts.length === 3 && parts[1] === 'gems_nodes') {
        const field = parts[2];
        const us = field.indexOf('_');
        if (us <= 0) return 0;
        const tree = field.substring(0, us);
        const suffix = field.substring(us + 1);
        const g = gemTree(state, tree);
        if (!g) return 0;
        if (suffix === 'level') return g.level || 0;
        if (suffix.startsWith('gem')) {
          const idx = parseInt(suffix.replace('gem', ''), 10) - 1;
          return (g.nodes || [])[idx] ? 1 : 0;
        }
        const realKey = global.GEM_UPGRADE_ALIASES[suffix] || suffix;
        return (g.upgrades || {})[realKey] || 0;
      }
      if (parts.length === 3) {
        const [, cat, field] = parts;
        if (cat === 'diamondspecials' && field === 'hunterloot') return 1 + 0.025 * (state.upgrades?.[cat]?.[field] || 0);
        if (cat === 'diamondspecials' && field === 'reviveboost') return 3 * (state.upgrades?.[cat]?.[field] || 0);
        let val = state.upgrades?.[cat]?.[field];
        if (val === undefined) {
          if (cat === 'relics' && field.startsWith('r')) {
            val = state.upgrades?.relics?.[field.substring(1)];
          }
          if (cat === 'inscryptions' && field.startsWith('i')) {
            val = state.upgrades?.inscryptions?.[field.substring(1)];
            if (val === undefined) val = state.upgrades?.inscryptions?.[`inscryp${field.substring(1)}`];
          }
        }
        return val || 0;
      }
      if (parts.length === 4) {
        const [, r, i, a] = parts;
        return state.upgrades?.[r]?.[i]?.[a] || 0;
      }
    }
    return 0;
  }

  async function buildArgs(hunter, state) {
    const PARAMS = await loadParams();
    const names = PARAMS[hunter];
    if (!names) throw new Error(`Unknown hunter: ${hunter}`);
    return names.map((name) => resolveParam(name, state));
  }

  function getStats(ex, hunter) {
    const prefix = { borge: '', ozzy: 'Ozzy', knox: 'Knox' }[hunter];
    const get = (name) => {
      const fnName = hunter === 'borge' ? `getLast${name}` : `getLast${prefix}${name}`;
      return typeof ex[fnName] === 'function' ? ex[fnName]() : undefined;
    };
    return {
      avgStage: get('AvgStage'), avgTime: get('AvgTime'), minStage: get('MinStage'), maxStage: get('MaxStage'),
      bossHpPercent: get('BossHpPercent'), bossKillRate: get('BossKillRate'),
      mat1: get('Mat1'), mat2: get('Mat2'), mat3: get('Mat3'), xp: get('Xp'),
    };
  }

  // Final post-upgrade combat stats, read via the same getLastBorge*/getLastOzzy*/getLastKnox*
  // exports the live site's worker uses to populate its "Build Stats" tab.
  const FINAL_STAT_NAMES = {
    borge: ['MaxHp', 'Atk', 'Regen', 'Dr', 'Evade', 'Effect', 'CritRate', 'CritPower', 'Reload'],
    ozzy: ['MaxHp', 'Atk', 'Regen', 'Dr', 'Evade', 'Effect', 'Multistrike', 'MultistrikePower', 'Reload'],
    knox: ['MaxHp', 'Atk', 'Regen', 'Dr', 'Block', 'Effect', 'Charge', 'ChargeGain', 'Reload', 'Sc'],
  };
  function getFinalStats(ex, hunter) {
    // Unlike the aggregate getters above (getLastAvgStage, no hunter prefix for borge), the
    // final-stat getters always carry the hunter prefix, including "Borge" for borge itself
    // (getLastBorgeMaxHp, not getLastMaxHp) -- confirmed directly against the wasm exports.
    const prefix = { borge: 'Borge', ozzy: 'Ozzy', knox: 'Knox' }[hunter];
    const out = {};
    (FINAL_STAT_NAMES[hunter] || []).forEach((name) => {
      const fnName = `getLast${prefix}${name}`;
      if (typeof ex[fnName] === 'function') out[name] = ex[fnName]();
    });
    return out;
  }

  // Per-stage hit-frequency histogram from the same Monte Carlo run, via
  // getProgressSize/getProgressStageAt/getProgressCountAt (getOzzyProgress*/getKnoxProgress*
  // for the other hunters) -- powers the live site's "Stage Distribution" tab.
  function getStageDistribution(ex, hunter) {
    const prefix = { borge: '', ozzy: 'Ozzy', knox: 'Knox' }[hunter];
    const sizeFn = ex[`get${prefix}ProgressSize`];
    const stageFn = ex[`get${prefix}ProgressStageAt`];
    const countFn = ex[`get${prefix}ProgressCountAt`];
    if (typeof sizeFn !== 'function' || typeof stageFn !== 'function' || typeof countFn !== 'function') return [];
    const size = sizeFn();
    const out = [];
    for (let i = 0; i < size; i++) out.push({ stage: stageFn(i), count: countFn(i) });
    return out.sort((a, b) => a.stage - b.stage);
  }

  async function evaluate(hunter, state) {
    const ex = await loadWasm();
    const fn = ex[WASM_EXPORT[hunter]];
    if (!fn) throw new Error(`Missing wasm export for ${hunter}`);
    const args = await buildArgs(hunter, state);
    const lootPerMin = fn(...args);
    return { lootPerMin, ...getStats(ex, hunter) };
  }

  // Same run as evaluate(), but also returns the final post-upgrade combat stats and the
  // per-stage hit histogram -- used by the Build Statistics modal (Build Stats / Stage
  // Distribution tabs) so it doesn't need its own copy of the wasm-loading/arg-building code.
  async function evaluateDetailed(hunter, state) {
    const ex = await loadWasm();
    const fn = ex[WASM_EXPORT[hunter]];
    if (!fn) throw new Error(`Missing wasm export for ${hunter}`);
    const args = await buildArgs(hunter, state);
    const lootPerMin = fn(...args);
    return {
      lootPerMin, ...getStats(ex, hunter),
      finalStats: getFinalStats(ex, hunter),
      stageDistribution: getStageDistribution(ex, hunter),
    };
  }

  // Fast-path compiled evaluator, same idea as the Node version: resolve every constant
  // param once, then only overwrite the talent/attribute slots per call.
  //
  // Base-stat purchase planning (hunterStatPathBrowser.js) needs a candidate's hunterStats
  // to vary too, which the original version baked into staticState at compile time. Passing
  // `cfg.STAT_KEYS` (a hunter's baseStatKeys) opts a given stat key into the same per-call
  // `dynamic` slot mechanism as talents/attributes -- evalFast's new 4th arg (`statAlloc`)
  // overrides cfg.hunterStats[key] per call instead of using the compiled-in value. Existing
  // callers (optimizer/worker.js) that don't pass STAT_KEYS or a 4th arg are unaffected.
  async function compileEvaluator(hunter, cfg) {
    const PARAMS = await loadParams();
    const names = PARAMS[hunter];
    if (!names) throw new Error(`Unknown hunter: ${hunter}`);

    const staticState = {
      level: cfg.level, hunterStats: cfg.hunterStats, overrides: cfg.baseOverrides, upgrades: cfg.globalUpgrades,
      gemPlannerStore: cfg.gemPlannerStore,
    };
    const talentIds = new Set(cfg.TALENTS.map((d) => d.id));
    const attrIds = new Set(cfg.ATTRIBUTES.map((d) => d.id));
    const statKeys = new Set(cfg.STAT_KEYS || []);
    // Full wasm param names (e.g. "upgrades.inscryptions.i13") for the build-card Effective
    // Path allocator (hunterStatPathBrowser.js's greedyPurchasePath), which also ranks
    // inscription-level candidates alongside base stats. Inscriptions are account-wide
    // (state.upgrades.inscryptions), same as base stats, so they're keyed by the same
    // dynamic-slot mechanism, just addressed by full param name instead of a bare stat key.
    const inscryptionParams = new Set(cfg.INSCRYPTION_PARAMS || []);
    const currentInscryptionLevels = {};
    (cfg.INSCRYPTION_PARAMS || []).forEach((p) => {
      const id = p.split('.')[2];
      currentInscryptionLevels[p] = cfg.globalUpgrades?.inscryptions?.[id] || 0;
    });

    const baseArgs = new Array(names.length);
    const dynamic = [];
    names.forEach((name, i) => {
      const overridden = staticState.overrides && name in staticState.overrides;
      if (name === 'iterations') dynamic.push({ index: i, kind: 'iterations' });
      else if (!overridden && talentIds.has(name)) dynamic.push({ index: i, kind: 'talent', id: name });
      else if (!overridden && attrIds.has(name)) dynamic.push({ index: i, kind: 'attribute', id: name });
      else if (!overridden && statKeys.has(name)) dynamic.push({ index: i, kind: 'stat', id: name });
      else if (!overridden && inscryptionParams.has(name)) dynamic.push({ index: i, kind: 'inscryption', id: name });
      else baseArgs[i] = resolveParam(name, staticState);
    });

    const args = baseArgs.slice();
    const mod = await loadWasmModule();

    // Every scoring call gets its OWN fresh instance (see the top-of-file note on why) --
    // otherwise the optimizer would be comparing candidates scored from different points
    // in a drifting internal RNG state, which is both non-reproducible and an unfair
    // comparison between candidates.
    return async function evalFast(talentAlloc, attrAlloc, iterations, statAlloc, inscryptionAlloc) {
      for (const d of dynamic) {
        if (d.kind === 'iterations') args[d.index] = iterations ?? 1000;
        else if (d.kind === 'talent') args[d.index] = talentAlloc[d.id] || 0;
        else if (d.kind === 'attribute') args[d.index] = attrAlloc[d.id] || 0;
        else if (d.kind === 'stat') args[d.index] = (statAlloc && statAlloc[d.id] !== undefined) ? statAlloc[d.id] : (cfg.hunterStats?.[d.id] || 0);
        else args[d.index] = (inscryptionAlloc && inscryptionAlloc[d.id] !== undefined) ? inscryptionAlloc[d.id] : currentInscryptionLevels[d.id];
      }
      const instance = await WebAssembly.instantiate(mod, IMPORT_OBJECT);
      const ex = instance.exports;
      const fn = ex[WASM_EXPORT[hunter]];
      const lootPerMin = fn(...args);
      return { lootPerMin, ...getStats(ex, hunter) };
    };
  }

  // Backs the Settings page's real "Clear Evaluation Cache" action -- drops the cached
  // compiled wasm module and the cached params.json fetch so the next evaluate() call
  // re-fetches/re-compiles from scratch (mirrors what the live site's own cache-clear does).
  function clearCache() { wasmModulePromise = null; paramsPromise = null; }

  global.HunterSim = { evaluate, evaluateDetailed, buildArgs, resolveParam, compileEvaluator, loadParams, loadWasm, clearCache };
})(typeof window !== 'undefined' ? window : self);
