// Manual smoke test / usage example for the two evaluators, run directly with:
//   node example-compare.mjs
// (the actual MCP tools in server.mjs call the same two functions).
import { evaluateOnClone, shutdownClone } from './clone-eval.mjs';
import { evaluateOnLiveSite, shutdownLiveBrowser } from './live-eval.mjs';

const testBuild = {
  level: 41,
  talents: { revival: 2, loth: 5, ua: 0, impeccable: 10, omen: 0, ll: 9, pog: 15, ultima: 0, tfow: 0 },
  attributes: { ares: 1, ylith: 1, spartan: 6, timeless: 5, baal: 6, sensors: 6, htb: 2, lfin: 10, exp: 6, weak: 6, atlas: 0, battle: 2, mino: 0, hermes: 0, athena: 0 },
  baseStats: { hp: 210, atk: 188, regen: 120, dr: 32, evade: 35, effect: 38, critchance: 54, critpower: 50, atkspeed: 26, stage: 173 },
  globalUpgrades: { 'relics.r4': 13, 'relics.r7': 11, 'relics.r16': 1, 'inscryptions.i3': 8, 'inscryptions.i4': 6 },
};

console.log('Evaluating on live site...');
const live = await evaluateOnLiveSite('borge', testBuild);
console.log('LIVE:', live);

console.log('\nEvaluating on clone...');
const clone = await evaluateOnClone('borge', testBuild);
console.log('CLONE:', clone);

console.log('\nlootScore  live=%s  clone=%s', live.lootScore, clone.lootPerMin.toFixed(1));
console.log('avgStage   live=%s  clone=%s', live.avgStage, clone.avgStage.toFixed(2));
console.log('avgTime(m) live=%s  clone=%s', live.avgTimeMinutes, clone.avgTime.toFixed(2));

await shutdownLiveBrowser();
await shutdownClone();
