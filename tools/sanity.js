'use strict';
const { evaluate } = require('./hunterSim');

(async () => {
  const base = { level: 50, stage: 1, iterations: 300, stats: { hp: 1000, atk: 200, regen: 20, dr: 15, evade: 5, effect: 10, critchance: 20, critpower: 150, atkspeed: 10, revival: 0 }, talents: {}, upgrades: {} };
  const r1 = await evaluate('borge', base);
  console.log('base atk=200', r1.lootPerMin, r1.avgStage);

  const hi = JSON.parse(JSON.stringify(base)); hi.stats.atk = 5000;
  const r2 = await evaluate('borge', hi);
  console.log('atk=5000', r2.lootPerMin, r2.avgStage);

  const hihp = JSON.parse(JSON.stringify(base)); hihp.stats.hp = 100000;
  const r3 = await evaluate('borge', hihp);
  console.log('hp=100000', r3.lootPerMin, r3.avgStage);

  const loot = JSON.parse(JSON.stringify(base)); loot.upgrades['relics.r7'] = 100;
  const r4 = await evaluate('borge', loot);
  console.log('r7=100 (loot x1.05^100=131x)', r4.lootPerMin, r4.avgStage);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
