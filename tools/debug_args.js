'use strict';
const { buildArgs, PARAMS } = require('./hunterSim');

const state = { level: 50, stage: 1, iterations: 300, stats: { hp: 1000, atk: 200, regen: 20, dr: 15, evade: 5, effect: 10, critchance: 20, critpower: 150, atkspeed: 10, revival: 0 }, talents: {}, upgrades: { 'relics.r7': 100 } };
const args = buildArgs('borge', state);
PARAMS.borge.forEach((name, i) => {
  if (args[i] !== 0 || name.includes('r7') || name.includes('hunterloot')) {
    console.log(i, name, '=', args[i]);
  }
});
