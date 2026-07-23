'use strict';
const { evaluate } = require('./hunterSim');

// Pulled directly from your cifi-tools.com localStorage['hunter-data'].
const hunterStatsBorge = {
  hp: 210, atk: 188, regen: 120, dr: 32, evade: 35, effect: 38, critchance: 54, critpower: 50, atkspeed: 26,
  stage: 173, revival: 0, loth: 0, ua: 0, impeccable: 0, omen: 0, ll: 0, pog: 0, ultima: 0, tfow: 0,
  ares: 0, ylith: 0, spartan: 0, timeless: 0, baal: 0, sensors: 0, htb: 0, lfin: 0, exp: 0, atlas: 0,
  weak: 0, battle: 0, mino: 0, hermes: 0, athena: 0,
};

const globalUpgrades = {
  'relics.r4': 8, 'relics.r7': 8,
  'shardmilestones.m0': 70,
  'inscryptions.i3': 8, 'inscryptions.i4': 6, 'inscryptions.i11': 3, 'inscryptions.i13': 8,
  'inscryptions.i14': 5, 'inscryptions.i23': 5, 'inscryptions.i24': 8, 'inscryptions.i27': 10,
  'inscryptions.i31': 10, 'inscryptions.i32': 8, 'inscryptions.i33': 6, 'inscryptions.i36': 5,
  'inscryptions.i37': 7, 'inscryptions.i44': 10, 'inscryptions.i40': 10,
  'loopmods.scavenger': 25, 'loopmods.scavenger2': 25, 'loopmods.trample': 1,
  'iap.travpack': 1,
  'ultima.ulti': 1,
  'diamondspecials.reviveboost': 10, 'diamondspecials.hunterloot': 10,
  'diamondcards.gaiden': 1, 'diamondcards.iridian': 1,
  // from gemPlanner_store localStorage: gemStates.attraction.upgrades["borge-loot-bonus"]
  'gems_nodes.attraction_lootBorge': 4,
};

// Build "Borge Loot" (id 1784668726053) -- site's cached result: lootPerMin=95308.97,
// avgStage=169.2754, mat1=1017365932.47, mat2=935641613.29, mat3=680130757.92, xp=426835697.57
const borgeLoot = {
  level: 39,
  iterations: 1000,
  hunterStats: hunterStatsBorge,
  talents: { revival: 2, loth: 5, ua: 0, impeccable: 10, omen: 0, ll: 7, pog: 15, tfow: 0, ultima: 0 },
  attributes: { ares: 1, ylith: 1, spartan: 6, timeless: 5, baal: 6, sensors: 6, htb: 4, lfin: 10, exp: 6, atlas: 0, weak: 6, battle: 0, athena: 0, mino: 0, hermes: 0 },
  overrides: {
    hp: 210, atk: 181, regen: 128, dr: 32, evade: 36, effect: 37, critchance: 53, critpower: 50, atkspeed: 27,
    'upgrades.relics.r4': 8, 'upgrades.inscryptions.i60': 1,
    'upgrades.gems_nodes.attraction_level': 3, 'upgrades.gems_nodes.attraction_catchUp': 2,
  },
  upgrades: globalUpgrades,
};

async function main() {
  const r = await evaluate('borge', borgeLoot);
  console.log('Computed:', r);
  console.log('\nSite cache said: lootPerMin=95308.97 avgStage=169.2754 mat1=1017365932 mat2=935641613 mat3=680130757 xp=426835697');
}

main().catch((e) => { console.error(e); process.exit(1); });
