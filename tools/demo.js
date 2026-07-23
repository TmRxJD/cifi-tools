'use strict';
const { evaluate } = require('./hunterSim');

// Placeholder baseline stats -- replace with your actual in-game Borge stats.
const baseline = {
  level: 50,
  stage: 1,
  iterations: 500,
  stats: {
    hp: 1000, atk: 200, regen: 20, dr: 15, evade: 5, effect: 10,
    critchance: 20, critpower: 150, atkspeed: 10, revival: 0,
  },
  talents: {},
  upgrades: {
    'relics.r4': 0, 'relics.r7': 0, 'relics.r16': 0, 'relics.r19': 0,
    'inscryptions.i44': 0,
  },
};

async function main() {
  const base = await evaluate('borge', baseline);
  console.log('Baseline:', base);

  console.log('\nSweeping inscryptions.i44 (Loot Reward, x1.08/level, max 10):');
  for (let lvl = 0; lvl <= 10; lvl++) {
    const state = JSON.parse(JSON.stringify(baseline));
    state.upgrades['inscryptions.i44'] = lvl;
    const r = await evaluate('borge', state);
    console.log(`  i44=${lvl}: lootPerMin=${r.lootPerMin.toFixed(2)} avgStage=${r.avgStage}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
