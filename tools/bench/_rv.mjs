import { evaluateOnClone } from '../../compare-mcp/clone-eval.mjs';
const B = {
  level: 70,
  talents: { revival: 2, loth: 5, ua: 5, impeccable: 10, omen: 5, ll: 10, pog: 15, tfow: 15 },
  attributes: { ares: 60, ylith: 10, spartan: 6, timeless: 5, baal: 6, sensors: 6, htb: 10, lfin: 10, exp: 6, weak: 6, atlas: 6, battle: 3 },
  baseStats: { hp: 320, atk: 300, regen: 220, dr: 40, evade: 45, effect: 50, critchance: 75, critpower: 70, atkspeed: 40 },
  iterations: 1000,
};
const a = await evaluateOnClone('borge', { ...B, globalUpgrades: {} });
const b = await evaluateOnClone('borge', { ...B, globalUpgrades: { 'loopmods.roe': 20000 } });
console.log('clone xp  roe0:', a.xp.toPrecision(9), ' roe20000:', b.xp.toPrecision(9), ' ratio', (b.xp/a.xp).toFixed(4));
console.log('site xp   roe0: 6660000  roe20000: 49220000  ratio 7.3904');
console.log('clone loot unchanged?', a.lootPerMin === b.lootPerMin, ' mat1 unchanged?', a.mat1 === b.mat1);
