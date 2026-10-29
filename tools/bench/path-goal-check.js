'use strict';
// Small, controlled results isolate recommendation math; the real-WASM path tests run separately.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const H = require('./harness.js');
process.on('uncaughtException', error => { console.error(error); process.exit(1); });
const sb = H.browserSandbox();
sb.HunterOptimizer = { FINAL_ITERATIONS: 5000 };
for (const file of ['hunterStatPath.js', 'incomeModel.js', 'hunterStatPathBrowser.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../webapp/public', file), 'utf8'), sb);
}
const O = sb.OptimizerObjective;
const base = { lootPerMin: 1000, avgStage: 100, maxStage: 101, bossKillRate: 50, bossHpPercent: 0 };
const rich = { ...base, lootPerMin: 1e12 };
const ctx = { bossTarget: 100, purpose: 'purchasePath' };
assert.equal(O.pathGain(O.pathProgress('boss', base, ctx), O.pathProgress('boss', rich, ctx)).delta, 0);
assert(O.scoreFor('boss', rich) > O.scoreFor('boss', base), 'known-bad control: search loot tie-break must reproduce the original false purchase gain');
const tiny = { ...base, bossKillRate: base.bossKillRate + 1e-10 };
assert(O.pathGain(O.pathProgress('boss', base, ctx), O.pathProgress('boss', tiny, ctx)).delta > 0, 'raw tiny gain survives tier offsets');
assert.deepEqual(O.scoreFor('boss', base, ctx), O.pathProgress('boss', base, ctx), 'worker purpose uses canonical path progress');

let candidates = ['hp', 'atk'];
let effects = { hp: { kill: 1, loot: 1 }, atk: { kill: 0, loot: 100 } };
let costs = { hp: 2, atk: 1 };
let evaluated = 0, supplied;
sb.HUNTER_DEFS.borge = { ...sb.HUNTER_DEFS.borge, baseStatKeys: candidates, statCaps: { hp: Infinity, atk: Infinity } };
sb.CostFormulas.baseStatResource = () => 'mat1';
sb.CostFormulas.baseStatCostAtLevel = key => costs[key];
sb.HunterSim.compileEvaluator = async (hunter, cfg) => {
  supplied = cfg;
  return async (talentAlloc, attrAlloc, iterations, hunterStats) => {
      evaluated++;
      const r = { ...base };
      for (const key of candidates) {
        r.bossKillRate += (hunterStats[key] || 0) * effects[key].kill;
        r.lootPerMin += (hunterStats[key] || 0) * effects[key].loot;
      }
      return r;
  };
};
const cfg = { level: 40, talents: { revival: 1 }, attributes: {}, hunterStats: { hp: 0, atk: 0, stage: 100 }, baseOverrides: {}, globalUpgrades: {}, gemPlannerStore: { gemStates: {} }, TALENTS: [], ATTRIBUTES: [] };
async function plan(mode, timing = null, count = 1) {
  return (await sb.greedyPurchasePath('borge', cfg, count, false, mode, null, null, timing)).columns.mat1;
}
async function run() {
  assert.equal((await plan('boss')).steps[0].key, 'hp', 'boss purchases improve kills, never loot-only gains');
  assert.equal((await plan('loot')).steps[0].key, 'atk', 'goal choice changes the recommendation');
  assert.equal(supplied.level, cfg.level);
  assert.deepEqual(supplied.talents, cfg.talents);
  costs = { hp: 24 * 365 * 2, atk: 24 * 3 };
  effects = { hp: { kill: 40, loot: 1e8 }, atk: { kill: 0.01, loot: 1 } };
  const timing = { perHour: { mat1: 1 }, horizonHours: 24 * 7 };
  const short = await plan('boss', timing, 3);
  assert.deepEqual(Array.from(short.steps, s => s.key), ['atk', 'atk'], 'two-year purchase excluded and cumulative six-day queue fits seven days');
  assert.equal(short.stopReason, 'no-affordable-candidate');
  assert.equal((await plan('boss')).steps[0].key, 'hp', 'unlimited control preserves the long-term choice');
  candidates = ['hp'];
  sb.HUNTER_DEFS.borge.baseStatKeys = candidates;
  effects.hp = { kill: 0, loot: 0 }; costs.hp = 1;
  evaluated = 0;
  const zero = await plan('boss');
  assert.equal(zero.steps.length, 0, 'a sole zero-gain option is not a recommendation');
  assert.equal(zero.stopReason, 'no-improvement');
  assert.equal(evaluated, 2, 'baseline and sole candidate are both evaluated');
  effects.hp.kill = -1;
  assert.equal((await plan('boss')).steps.length, 0, 'harmful sole option is excluded');
  let evaluatedState;
  sb.HunterSim.evaluate = async (hunter, state) => { evaluatedState = state; return { avgTime: 60, mat1: 100, mat2: 200, mat3: 300 }; };
  const rates = await sb.IncomeModel.currentRates('borge', cfg, 5000);
  assert.equal(evaluatedState.level, cfg.level);
  assert.deepEqual(evaluatedState.talents, cfg.talents);
  assert.deepEqual(evaluatedState.hunterStats, cfg.hunterStats);
  assert.deepEqual(evaluatedState.overrides, cfg.baseOverrides);
  assert.equal(rates.perHour.mat1, 100);
  for (const key of ['avgTime', 'mat1', 'mat2', 'mat3']) {
    for (const value of [undefined, NaN, Infinity, -1, ...(key === 'avgTime' ? [0] : [])]) {
      sb.HunterSim.evaluate = async () => ({ avgTime: 60, mat1: 100, mat2: 200, mat3: 300, [key]: value });
      await assert.rejects(sb.IncomeModel.currentRates('borge', cfg, 5000), new RegExp(`invalid simulation field ${key}`));
    }
  }
  console.log('PASS Effective Path goals: loot-only boss negative control, raw gains, purpose/context, objective-specific recommendations, finite/cumulative window, sole zero/negative options, one build/account snapshot for income and scoring');
}
run().catch(error => { console.error(error); process.exit(1); });
