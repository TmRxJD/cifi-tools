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

  // WHERE THE SIMULATION ENGINE COMES FROM, and why there are two answers.
  //
  // `release.wasm` is cifi-tools.com's compiled evaluator. It is THEIRS. Serving a copy of it from
  // our own site is redistribution, so the preferred source is the COMPANION EXTENSION
  // (see extension/), which fetches it into the user's own browser from the origin that owns it.
  // Nothing is copied and nothing is cached on a server of ours.
  //
  // The extension is required because cifi-tools.com sends no Access-Control-Allow-Origin header
  // on any path -- measured on GET and OPTIONS -- so page JavaScript cannot fetch it cross-origin
  // at all. That is a browser rule, not a policy choice, and no amount of page-side code works
  // around it.
  //
  // The local fallback exists for DEVELOPMENT, where the file sits next to this one. It is also
  // what the hosted site currently uses; removing it is a separate decision recorded in
  // THIRD-PARTY.md, and this loader is the one place that has to change when it is made.
  const BRIDGE_TIMEOUT_MS = 15000;
  // WHICH SOURCE ACTUALLY SERVED THE ENGINE, recorded and announced.
  //
  // Until now a working bridge and a missing one looked IDENTICAL from the outside: the bridge
  // logs nothing on success, so "no console output" meant either "it worked" or "the content
  // script never ran". That is unfalsifiable from the user's side, and it is the exact question
  // anyone installing the extension needs answered.
  //
  // `HunterSim.engineSource()` is the machine-readable form; the console line is for a human who
  // just installed the extension and wants to know whether it took.
  let engineSource = 'not loaded yet';
  function setEngineSource(src, detail) {
    engineSource = src;
    const msg = src === 'extension'
      ? `[cifi] engine loaded via the COMPANION EXTENSION from cifi-tools.com (${detail}) -- nothing is served from this site`
      : `[cifi] engine loaded from THIS SITE's own copy (${detail}). The companion extension is not active; see extension/README.md`;
    try { console.info(msg); } catch { /* console may be unavailable in a worker */ }
  }
  // Where cifi-tools serves its evaluator today. Changing this needs only a deploy of this file;
  // the extension validates the origin, not the exact path, precisely so that stays true.
  const ENGINE_PATH = '/wasm/release.wasm';

  function engineFromExtension() {
    // Detected from a data attribute the content script sets at document_start. A `window`
    // property would NOT work: a content script runs in an isolated world, so anything it assigns
    // to `window` is invisible here.
    if (typeof document === 'undefined'
      || document.documentElement?.dataset?.cifiCompanionBridge !== '1') {
      return Promise.resolve(null);   // not installed -- caller falls back
    }
    return new Promise((resolve) => {
      const id = `eng-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(value);
      };
      // A TIMEOUT IS NOT OPTIONAL. If the extension is installed but its service worker is asleep,
      // disabled mid-session, or its host permission was revoked, the reply simply never arrives
      // and the app would hang at startup with no error -- the worst failure shape available.
      const timer = setTimeout(() => finish(null), BRIDGE_TIMEOUT_MS);
      const onMessage = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.type !== 'cifi-companion:engine' || d.id !== id) return;
        if (!d.ok) { console.warn(`[cifi] companion bridge could not load the engine: ${d.error}`); finish(null); return; }
        const bin = atob(d.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        setEngineSource('extension', `${bytes.length} bytes`);
        finish(bytes.buffer);
      };
      window.addEventListener('message', onMessage);
      // The path is sent by the PAGE so that if cifi-tools ever renames or moves the engine, this
      // is a one-line site deploy rather than an extension update and a store review. The
      // extension pins the ORIGIN; we choose the file within it.
      window.postMessage({ type: 'cifi-companion:get-engine', id, path: ENGINE_PATH }, window.location.origin);
    });
  }

  let wasmModulePromise = null;
  function loadWasmModule() {
    if (!wasmModulePromise) {
      wasmModulePromise = engineFromExtension()
        .then((buf) => buf || fetch(assetUrl('release.wasm')).then((r) => {
          if (!r.ok) {
            throw new Error('The simulation engine is unavailable. Install the CIFI Tools '
              + 'Companion Bridge extension (see extension/README.md), which loads it from '
              + 'cifi-tools.com in your own browser.');
          }
          return r.arrayBuffer().then((b) => { setEngineSource('local', `${b.byteLength} bytes`); return b; });
        }))
        .then((buf) => WebAssembly.compile(buf));
    }
    return wasmModulePromise;
  }

  // INJECTION, FOR WORKERS. A Worker has no `document`, so it can never reach the companion
  // extension -- the bridge is a content script and content scripts do not run in workers. Left to
  // itself a worker would fall back to fetching `release.wasm` from our origin, which is precisely
  // the copy we are trying not to serve.
  //
  // So the MAIN THREAD resolves the engine once (through the extension) and hands each worker the
  // COMPILED MODULE. `WebAssembly.Module` is structured-cloneable, so it crosses postMessage
  // intact, and compiling once for the whole pool is strictly less work than N fetches.
  //
  // `expectInjectedWasm()` must be called BEFORE any evaluation so the fetch path is never taken:
  // it parks `wasmModulePromise` on a promise the injection settles. A worker that is promised an
  // engine and never given one therefore WAITS rather than quietly fetching a copy.
  let injectResolve = null;
  let injectReject = null;
  function expectInjectedWasm() {
    if (wasmModulePromise) return;
    wasmModulePromise = new Promise((res, rej) => { injectResolve = res; injectReject = rej; });
  }
  function setWasmModule(mod) {
    expectInjectedWasm();
    if (injectResolve) injectResolve(mod);
  }
  // The failure path is not optional: if the main thread cannot obtain the engine, every worker
  // must be told so its init can fail loudly. Without this they wait on a promise nothing will
  // ever settle, and the optimizer hangs with no error -- the worst shape available.
  function failWasmModule(err) {
    expectInjectedWasm();
    if (injectReject) injectReject(err instanceof Error ? err : new Error(String(err)));
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
  // A handful of sim params are derived only when a specific gem NODE is owned. The gate key names
  // its own tree and node -- `upgrades.gems_nodes.creation_gem5` is creation, node 5 -- so both are
  // parsed from the key rather than passed alongside it.
  //
  // The previous version was named for the exodus tree and hard-coded it, taking the node index as
  // a separate argument: two independent ways to get a gate wrong. The trinkets caller got both,
  // naming `creation_gem5` while being answered from EXODUS node 5, so trinkets were gated on an
  // unrelated tree and read 0 for any real account. Nothing caught it because a wrong gate returns
  // 0 rather than throwing, and a trinket is +0.001 per level -- small enough that the zeroed
  // parameter is invisible in an end-to-end output comparison. Deriving both halves from the one
  // key means the tree and the index can no longer disagree.
  function gemNodeGateUnlocked(state, gateOverrideName) {
    if (state.overrides && gateOverrideName in state.overrides) return state.overrides[gateOverrideName] === 1;
    const m = /^upgrades\.gems_nodes\.([a-z]+)_gem(\d+)$/.exec(gateOverrideName);
    if (!m) throw new Error(`gemNodeGateUnlocked: not a gem-node key: ${gateOverrideName}`);
    return gemTree(state, m[1])?.nodes?.[Number(m[2]) - 1] || false;
  }

  // TIER-2 RELICS ARE **NOT** GATED IN THE SIM. This is recorded because the opposite was briefly
  // implemented here on strong-looking but wrong evidence, and the way it went wrong is the
  // reusable part.
  //
  // Passing `relics.t2r7` through a BUILD CODE to cifi-tools produces byte-identical output at 0, 5
  // and 40 -- three runs, no change -- which reads exactly like a sim-side gate, and a level-70
  // Borge differed by 70% (55.12m here against the site's 16.54m). Setting Power gem 3 then made
  // the site agree exactly, which looked like confirmation.
  //
  // It was not. Setting t2r7 = 40 directly in the site's ACCOUNT state with Power gem **0** yields
  // 55.12m / stage 251.6 / mat1 3.74b -- identical to the Power-3 result. The site applies tier-2
  // relics regardless of gem level. What actually drops them is its IMPORT path: pasting a code
  // does not bring gem-locked tier-2 relics into the account, so the sim simply never saw them.
  //
  // The lesson: "the site's output did not move" answers a question about the whole PIPELINE, not
  // about the simulator. Before concluding a gate exists, set the value through the account -- the
  // path a real player uses -- rather than through an importer that may filter it.
  function resolveParam(name, state) {

    // exodus_temporalEvolutionCount is the ONE derived count, and this mirrors the live tool's own
    // resolver exactly: gate on exodus_gem1 (an override on the gate speaks for it), then sum the
    // temporal and evolution gem upgrades.
    if (name === 'upgrades.gems_nodes.exodus_temporalEvolutionCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      if (!gemNodeGateUnlocked(state, 'upgrades.gems_nodes.exodus_gem1')) return 0;
      return sumGemUpgrades(state, 'temporal') + sumGemUpgrades(state, 'evolution');
    }
    // NOTHING ELSE IN THE EXODUS FAMILY IS DERIVED, and getting that wrong cost two rounds of
    // work. `exodus_gem3` and `exodus_gem5` used to have branches here returning
    // sum(power)+sum(innovation) and sum(attraction)+sum(creation); a param-plumbing sweep then
    // found they also ignored explicit overrides, and the "fix" was to pair each with its Count
    // twin so an override on either set both.
    //
    // Checking the live bundle -- which is authoritative here, since cifi-tools was built with the
    // game's devs -- showed the whole premise was wrong. Its gem-state mapping is
    //   exodus: { nodes: { gem1..gem6, temporalEvolutionCount }, upgrades: {} }
    // and the loop that consumes it assigns `gems_nodes[gemN] = node ? 1 : 0`. So exodus_gem3 and
    // exodus_gem5 are 0/1 OWNED FLAGS, exactly like exodus_gem1 and exactly what our generic
    // resolver already returns -- they need no branch at all. And exodus_powerInnovationCount /
    // exodus_attractionCreationCount appear in NEITHER the nodes nor the upgrades map, and occur
    // exactly once each in the entire bundle (the param list), so the live tool never derives them:
    // they are plain override params defaulting to 0.
    //
    // They are therefore deliberately NOT special-cased here. Deriving them was a divergence from
    // the source dressed up as a convenience, and it made two arguments disagree with what the
    // original tool would send for the same account.
    if (name === 'upgrades.cms.milestoneCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      return state.upgrades?.cms?.milestoneCount || 0;
    }
    if (name === 'upgrades.gems_nodes.creation_galvTrinketsCount') {
      if (state.overrides && name in state.overrides) return state.overrides[name];
      if (!gemNodeGateUnlocked(state, 'upgrades.gems_nodes.creation_gem5')) return 0;
      // The live tool exposes the SUM as the override; we expose the three trinkets individually,
      // which is friendlier but only if those inputs actually arrive. They did not: this summed
      // only state.upgrades.trinkets, so a value typed into our Overrides panel for a single
      // trinket was silently discarded -- our override table advertised three keys that reached
      // nothing. Per-trinket overrides now take precedence over the stored level, trinket by
      // trinket, so both routes work and either can express the same account.
      const stored = state.upgrades?.trinkets || {};
      const ov = state.overrides || {};
      const ids = new Set([
        ...Object.keys(stored),
        ...Object.keys(ov).filter((k) => k.startsWith('upgrades.trinkets.')).map((k) => k.split('.')[2]),
      ]);
      let total = 0;
      ids.forEach((id) => {
        const key = `upgrades.trinkets.${id}`;
        total += (key in ov ? ov[key] : stored[id]) || 0;
      });
      return total;
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

  // POST-SIM MULTIPLIERS: upgrades the live tool applies to the evaluator's OUTPUT rather than
  // passing in as an argument.
  //
  // `upgrades.loopmods.roe` ("Ultima: Rule of Experience") has no slot in params.json for any
  // hunter, and it had been listed as inert-in-the-original on that basis. It is not. Measured
  // against cifi-tools with the value set in its account state: XP per run goes 6,660,000 ->
  // 49,220,000 at roe = 20000, a factor of 7.3904 against the 1.0001^20000 = 7.3883 its own
  // declaration predicts -- a 0.03% match -- while loot, stage and every material are untouched.
  // It is also NOT gem-gated in the sim: the result is identical with and without Temporal 4.
  //
  // "No wasm argument" therefore does not mean "does nothing". The bundle declares this one as
  // `upgradeType: "multiplicative", value: 1.0001, description: "EXP Gained"`, and applies it
  // outside the evaluator, exactly as it does the diamondspecials multipliers that resolveParam
  // already special-cases.
  const POST_SIM_XP_MULTIPLIERS = [
    { key: 'upgrades.loopmods.roe', perLevel: 1.0001 },
  ];

  function applyPostSimMultipliers(result, state) {
    if (!result || result.xp == null) return result;
    let xpMult = 1;
    for (const { key, perLevel } of POST_SIM_XP_MULTIPLIERS) {
      const level = resolveParam(key, state);
      if (level > 0) xpMult *= perLevel ** level;
    }
    if (xpMult !== 1) result.xp *= xpMult;
    return result;
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
    return applyPostSimMultipliers({ lootPerMin, ...getStats(ex, hunter) }, state);
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
    return applyPostSimMultipliers({
      lootPerMin, ...getStats(ex, hunter),
      finalStats: getFinalStats(ex, hunter),
      stageDistribution: getStageDistribution(ex, hunter),
    }, state);
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
    // Full wasm param names (e.g. "upgrades.inscryptions.i13", "upgrades.relics.r16") that the
    // Effective Path allocator varies alongside base stats. These are ACCOUNT-WIDE upgrades
    // (state.upgrades.<category>.<id>), same as base stats, so they use the same dynamic-slot
    // mechanism, just addressed by full param name instead of a bare stat key.
    //
    // This was INSCRYPTION_PARAMS and hardcoded the "inscryptions" category when reading the
    // player's current level. Relics are the same kind of thing bought with a different
    // currency, so the category is now parsed from the param name and one mechanism serves
    // both -- rather than a second, near-identical slot kind that could drift.
    const upgradeParams = new Set(cfg.UPGRADE_PARAMS || []);
    const currentUpgradeLevels = {};
    (cfg.UPGRADE_PARAMS || []).forEach((p) => {
      const [, category, id] = p.split('.');
      if (!category || !id) throw new Error(`UPGRADE_PARAMS entry "${p}" is not of the form upgrades.<category>.<id>`);
      currentUpgradeLevels[p] = cfg.globalUpgrades?.[category]?.[id] || 0;
    });

    const baseArgs = new Array(names.length);
    const dynamic = [];
    names.forEach((name, i) => {
      const overridden = staticState.overrides && name in staticState.overrides;
      if (name === 'iterations') dynamic.push({ index: i, kind: 'iterations' });
      else if (!overridden && talentIds.has(name)) dynamic.push({ index: i, kind: 'talent', id: name });
      else if (!overridden && attrIds.has(name)) dynamic.push({ index: i, kind: 'attribute', id: name });
      else if (!overridden && statKeys.has(name)) dynamic.push({ index: i, kind: 'stat', id: name });
      else if (!overridden && upgradeParams.has(name)) dynamic.push({ index: i, kind: 'upgrade', id: name });
      else baseArgs[i] = resolveParam(name, staticState);
    });

    const args = baseArgs.slice();
    const mod = await loadWasmModule();

    // Every scoring call gets its OWN fresh instance (see the top-of-file note on why) --
    // otherwise the optimizer would be comparing candidates scored from different points
    // in a drifting internal RNG state, which is both non-reproducible and an unfair
    // comparison between candidates.
    return async function evalFast(talentAlloc, attrAlloc, iterations, statAlloc, upgradeAlloc) {
      for (const d of dynamic) {
        if (d.kind === 'iterations') args[d.index] = iterations ?? 1000;
        else if (d.kind === 'talent') args[d.index] = talentAlloc[d.id] || 0;
        else if (d.kind === 'attribute') args[d.index] = attrAlloc[d.id] || 0;
        else if (d.kind === 'stat') args[d.index] = (statAlloc && statAlloc[d.id] !== undefined) ? statAlloc[d.id] : (cfg.hunterStats?.[d.id] || 0);
        else args[d.index] = (upgradeAlloc && upgradeAlloc[d.id] !== undefined) ? upgradeAlloc[d.id] : currentUpgradeLevels[d.id];
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

  // THE cancellation primitive for long-running sim work. It lives here because this module
  // loads before every consumer (incomeModel, the purchase path) and because everything worth
  // cancelling in this app is a chain of evaluations -- one definition, so "was this cancelled?"
  // cannot come to mean two different things.
  //
  // A single evaluate() call is ATOMIC: it is one synchronous wasm invocation and nothing can
  // interrupt it partway. So cancellation granularity is "between evaluations", and the useful
  // thing a caller can do is refuse to START one and refuse to return a result nobody wants.
  // Callers that run many evaluations should check between each -- checking only between larger
  // units means paying for the rest of the unit after the user has already walked away.
  const ABORTED = 'HunterSimAborted';
  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      const err = new Error('Computation was cancelled');
      err.name = ABORTED;
      throw err;
    }
  }
  function isAbort(err) { return !!err && err.name === ABORTED; }

    // A user-facing diagnostic, because "did the extension take?" is otherwise unanswerable without
  // reading the network panel. Reports what the page can see BEFORE any engine load, so it
  // distinguishes "content script never ran" from "bridge ran and failed".
  function bridgeStatus() {
    const marked = typeof document !== 'undefined'
      && document.documentElement?.dataset?.cifiCompanionBridge === '1';
    return {
      contentScriptDetected: marked,
      engineSource,
      verdict: marked
        ? (engineSource === 'extension' ? 'OK -- engine came from the extension'
          : engineSource === 'local' ? 'extension present but the engine came from THIS SITE (bridge failed -- check the console for the reason)'
            : 'extension present, engine not loaded yet')
        : 'extension NOT detected on this page -- check the URL matches the manifest, and reload the page AFTER loading the extension',
    };
  }

global.HunterSim = { engineSource: () => engineSource, bridgeStatus, expectInjectedWasm, setWasmModule, failWasmModule, loadWasmModule,
    evaluate, evaluateDetailed, buildArgs, resolveParam, compileEvaluator, loadParams, loadWasm,
    clearCache, throwIfAborted, isAbort, ABORTED,
    // Exposed so a liveness check can tell "changes no wasm argument" apart from "does nothing":
    // these are applied to the evaluator's OUTPUT, so they are live without owning an argument.
    POST_SIM_XP_MULTIPLIERS,
  };
})(typeof window !== 'undefined' ? window : self);
