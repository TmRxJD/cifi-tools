'use strict';
// Standalone caller for CIFI Tools' battle/loot simulator (release.wasm).
// Reimplements only the thin JS glue that resolves named build parameters
// into the positional array the wasm expects -- all the actual relic/
// inscryption/gem math happens inside the wasm itself, so results match
// cifi-tools.com exactly for the same inputs.

const fs = require('fs');
const path = require('path');

const PARAMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'params.json'), 'utf8'));

const WASM_EXPORT = { borge: 'EVALBORGE_WASM', ozzy: 'EVALOZZY_WASM', knox: 'EVALKNOX_WASM' };

let wasmExportsPromise = null;
function loadWasm(wasmPath = path.join(__dirname, 'release.wasm')) {
  if (!wasmExportsPromise) {
    wasmExportsPromise = (async () => {
      const buf = fs.readFileSync(wasmPath);
      const mod = await WebAssembly.compile(buf);
      const instance = await WebAssembly.instantiate(mod, {
        env: { abort: (a, b, c, d) => { throw new Error(`wasm abort at ${b}:${c}:${d}`); } },
      });
      return instance.exports;
    })();
  }
  return wasmExportsPromise;
}

// state shape mirrors cifi-tools.com's own hunter-data localStorage record:
// {
//   level, iterations,
//   hunterStats: { hp, atk, regen, dr, evade, effect, critchance, critpower, atkspeed, stage, revival, <talent/attr names>: 0, ... }, // account-wide base, per hunter
//   talents: { loth, ua, impeccable, omen, ... },     // THIS BUILD's talent point allocation
//   attributes: { ares, ylith, spartan, ... },        // THIS BUILD's attribute point allocation
//   overrides: { hp: 210, 'upgrades.relics.r4': 8, ... }, // THIS BUILD's per-field overrides (full param names, highest priority)
//   upgrades: { 'relics.r4': 8, 'inscryptions.i44': 10, 'gems_nodes.creation_gem1': 1, ... } // account-wide global upgrade levels (dotted path minus 'upgrades.' prefix)
// }
function resolveParam(name, state) {
  if (state.overrides && name in state.overrides) {
    if (name === 'upgrades.diamondspecials.hunterloot') return 1 + 0.025 * (state.overrides[name] || 0);
    if (name === 'upgrades.diamondspecials.reviveboost') return 3 * (state.overrides[name] || 0);
    return state.overrides[name];
  }
  if (name === 'iterations') return state.iterations ?? 1000;
  if (name === 'lvl') return state.level ?? 0;
  if (name === 'stage' || name === 'maxStage') return state.hunterStats?.stage ?? 0;
  if (state.talents && name in state.talents) return state.talents[name];
  if (state.attributes && name in state.attributes) return state.attributes[name];
  if (state.hunterStats && name in state.hunterStats) return state.hunterStats[name];
  if (name.startsWith('upgrades.')) {
    const rest = name.slice('upgrades.'.length);
    if (rest === 'diamondspecials.hunterloot') return 1 + 0.025 * (state.upgrades?.[rest] ?? 0);
    if (rest === 'diamondspecials.reviveboost') return 3 * (state.upgrades?.[rest] ?? 0);
    return state.upgrades?.[rest] ?? 0;
  }
  return 0;
}

function buildArgs(hunter, state) {
  const names = PARAMS[hunter];
  if (!names) throw new Error(`Unknown hunter: ${hunter}`);
  return names.map((name) => resolveParam(name, state));
}

async function evaluate(hunter, state) {
  const ex = await loadWasm();
  const fn = ex[WASM_EXPORT[hunter]];
  if (!fn) throw new Error(`Missing wasm export for ${hunter}`);
  const args = buildArgs(hunter, state);
  const lootPerMin = fn(...args);

  const prefix = { borge: '', ozzy: 'Ozzy', knox: 'Knox' }[hunter];
  const get = (name) => {
    const fnName = hunter === 'borge' ? `getLast${name}` : `getLast${prefix}${name}`;
    return typeof ex[fnName] === 'function' ? ex[fnName]() : undefined;
  };

  return {
    lootPerMin,
    avgStage: get('AvgStage'),
    avgTime: get('AvgTime'),
    minStage: get('MinStage'),
    maxStage: get('MaxStage'),
    bossHpPercent: get('BossHpPercent'),
    bossKillRate: get('BossKillRate'),
    mat1: get('Mat1'),
    mat2: get('Mat2'),
    mat3: get('Mat3'),
    xp: get('Xp'),
  };
}

// Fast-path evaluator for search loops: resolves every CONSTANT param (global
// upgrades, base hunterStats, level/stage/iterations, build overrides) exactly
// once, then reuses one mutable args array across thousands of calls -- each
// call only overwrites the handful of indices that actually vary (the talent
// and attribute allocations), instead of re-running resolveParam over all
// ~100 names every time.
function compileEvaluator(hunter, cfg) {
  const names = PARAMS[hunter];
  if (!names) throw new Error(`Unknown hunter: ${hunter}`);

  const staticState = {
    level: cfg.level,
    hunterStats: cfg.hunterStats,
    overrides: cfg.baseOverrides,
    upgrades: cfg.globalUpgrades,
    // talents/attributes intentionally omitted: those are the dynamic part.
  };

  const talentIds = new Set(cfg.TALENTS.map((d) => d.id));
  const attrIds = new Set(cfg.ATTRIBUTES.map((d) => d.id));

  const baseArgs = new Array(names.length);
  const dynamic = []; // { index, kind: 'talent'|'attribute'|'iterations', id }

  names.forEach((name, i) => {
    const overridden = staticState.overrides && name in staticState.overrides;
    if (name === 'iterations') {
      dynamic.push({ index: i, kind: 'iterations' });
    } else if (!overridden && talentIds.has(name)) {
      dynamic.push({ index: i, kind: 'talent', id: name });
    } else if (!overridden && attrIds.has(name)) {
      dynamic.push({ index: i, kind: 'attribute', id: name });
    } else {
      baseArgs[i] = resolveParam(name, staticState);
    }
  });

  const args = baseArgs.slice(); // mutable working copy, reused every call

  return async function evalFast(talentAlloc, attrAlloc, iterations) {
    for (const d of dynamic) {
      if (d.kind === 'iterations') args[d.index] = iterations ?? 1000;
      else if (d.kind === 'talent') args[d.index] = talentAlloc[d.id] || 0;
      else args[d.index] = attrAlloc[d.id] || 0;
    }
    const ex = await loadWasm();
    const fn = ex[WASM_EXPORT[hunter]];
    const lootPerMin = fn(...args);

    const prefix = { borge: '', ozzy: 'Ozzy', knox: 'Knox' }[hunter];
    const get = (name) => {
      const fnName = hunter === 'borge' ? `getLast${name}` : `getLast${prefix}${name}`;
      return typeof ex[fnName] === 'function' ? ex[fnName]() : undefined;
    };

    return {
      lootPerMin,
      avgStage: get('AvgStage'),
      avgTime: get('AvgTime'),
      minStage: get('MinStage'),
      maxStage: get('MaxStage'),
      bossHpPercent: get('BossHpPercent'),
      bossKillRate: get('BossKillRate'),
      mat1: get('Mat1'),
      mat2: get('Mat2'),
      mat3: get('Mat3'),
      xp: get('Xp'),
    };
  };
}

module.exports = { evaluate, buildArgs, resolveParam, PARAMS, loadWasm, compileEvaluator };
