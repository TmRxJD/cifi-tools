'use strict';
const { evaluate } = require('./hunterSim');
const fs = require('fs');

(async () => {
  const base = { level: 50, stage: 1, iterations: 300, stats: { hp: 1000, atk: 200, regen: 20, dr: 15, evade: 5, effect: 10, critchance: 20, critpower: 150, atkspeed: 10, revival: 0 }, talents: {}, upgrades: {} };
  const r0 = await evaluate('borge', base);
  const s1 = JSON.parse(JSON.stringify(base)); s1.upgrades['relics.r7'] = 100;
  const r1 = await evaluate('borge', s1);
  const s2 = JSON.parse(JSON.stringify(base)); s2.upgrades['diamondspecials.hunterloot'] = 10;
  const r2 = await evaluate('borge', s2);
  const s3 = JSON.parse(JSON.stringify(base)); s3.upgrades['shardmilestones.m0'] = 50;
  const r3 = await evaluate('borge', s3);
  fs.writeFileSync('out.json', JSON.stringify({ r0, r1, r2, r3 }, null, 2));
  console.log('done');
})();
