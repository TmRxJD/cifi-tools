'use strict';
const { evaluate } = require('./hunterSim');
const cfg = require('./ozzyConfig');

async function main() {
  const state = {
    level: cfg.level,
    iterations: 1000,
    hunterStats: cfg.hunterStats,
    talents: cfg.currentTalents,
    attributes: cfg.currentAttrs,
    overrides: cfg.baseOverrides,
    upgrades: cfg.globalUpgrades,
  };
  const r = await evaluate('ozzy', state);
  console.log('Computed:', r);
  console.log('\nSite said: Loot Score 72.81k, Ø Stage 170.0');
}

main().catch((e) => { console.error(e); process.exit(1); });
