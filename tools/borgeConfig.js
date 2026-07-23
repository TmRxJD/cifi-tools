'use strict';
// Pulled from your cifi-tools.com "Borge Loot" Build Creator (Talents 39/39, Attributes 117/117)
// and validated against the site's own cached simulation output (see validate.js).

// Talents: 1 point per level (levels sum to the talent budget directly).
const TALENTS = [
  { id: 'revival', label: 'Death Is My Companion', maxLevel: 2 },
  { id: 'loth', label: 'Life of the Hunt', maxLevel: 5 },
  { id: 'ua', label: 'The Unfair Advantage', maxLevel: 5 },
  { id: 'impeccable', label: 'Impeccable Impacts', maxLevel: 10 },
  { id: 'omen', label: 'The Omen Of Defeat', maxLevel: 10 },
  { id: 'll', label: 'Call Me Lucky Loot', maxLevel: 10 },
  { id: 'pog', label: 'Presence Of A God', maxLevel: 15 },
  { id: 'tfow', label: 'The Fires of War', maxLevel: 15 },
];
const TALENT_BUDGET = 39; // Talents 39/39 in your current build

// Attributes: cost per level varies by node.
const ATTRIBUTES = [
  // no "/max" shown in the UI (same pattern as Ozzy's lotl/exo) -- likely uncapped,
  // the point budget is the real constraint.
  { id: 'ares', label: 'Soul Of Ares', cost: 1, maxLevel: 999 },
  { id: 'ylith', label: 'Essence Of Ylith', cost: 1, maxLevel: 999 },
  { id: 'spartan', label: 'Spartan Lineage', cost: 2, maxLevel: 6 },
  { id: 'timeless', label: 'Timeless Mastery', cost: 3, maxLevel: 5 },
  { id: 'baal', label: 'Book Of Baal', cost: 3, maxLevel: 6 },
  { id: 'sensors', label: 'Superior Sensors', cost: 2, maxLevel: 6 },
  { id: 'htb', label: 'Helltouch Barrier', cost: 2, maxLevel: 10 },
  { id: 'lfin', label: 'Lifedrain Inhaler', cost: 2, maxLevel: 10 },
  { id: 'exp', label: 'Explosive Punches', cost: 3, maxLevel: 6 },
  { id: 'atlas', label: 'The Atlas Protocol', cost: 3, maxLevel: 6 },
  { id: 'weak', label: 'Weakspot Analysis', cost: 2, maxLevel: 6 },
  { id: 'battle', label: 'Born For Battle', cost: 5, maxLevel: 3 },
  { id: 'mino', label: 'Soul Of The Minotaur', cost: 2, maxLevel: 20 },
  { id: 'hermes', label: 'Soul Of Hermes', cost: 2, maxLevel: 20 },
  { id: 'athena', label: 'Soul Of Athena', cost: 15, maxLevel: 1 },
];
const ATTRIBUTE_BUDGET = 117; // Attributes 117/117 in your current build

// Unlock rules pulled from main.js's ATTRIBUTE_DEPENDENCIES / ATTRIBUTE_MIN_VALUE for Borge.
// A node needs >=1 point in every listed dependency AND (if minValue>0) at least
// that many total points already spent across all STRICTLY LOWER-tier nodes
// (nodes whose own minValue is smaller) before it can receive its first point.
const ATTRIBUTE_DEPENDENCIES = {
  ylith: ['ares'], baal: ['ares'], htb: ['ares'], exp: ['htb'],
  spartan: ['ylith'], timeless: ['spartan'], sensors: ['baal'], lfin: ['htb'],
  atlas: ['sensors'], weak: ['exp'], battle: ['spartan'], athena: ['battle'],
  mino: ['atlas'], hermes: ['weak'],
};
const ATTRIBUTE_MIN_VALUE = {
  ares: 0, ylith: 0, spartan: 0, timeless: 0, baal: 0, sensors: 0, htb: 0, lfin: 0, exp: 0,
  atlas: 75, weak: 75, battle: 75, mino: 150, hermes: 150, athena: 180,
};

// Your account-wide state (from localStorage hunter-data + gemPlanner_store).
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
  'gems_nodes.attraction_lootBorge': 4,
};

// Base-stat overrides carried over from your "Borge Loot" build (these are the
// hp/atk/etc + a few upgrade-level overrides your build pins independently of
// the global upgrade levels above -- e.g. a different relic r4 level for this build).
const baseOverrides = {
  hp: 210, atk: 181, regen: 128, dr: 32, evade: 36, effect: 37, critchance: 53, critpower: 50, atkspeed: 27,
  'upgrades.relics.r4': 8, 'upgrades.inscryptions.i60': 1,
  'upgrades.gems_nodes.attraction_level': 3, 'upgrades.gems_nodes.attraction_catchUp': 2,
};

// Your current real allocation (the "Borge Loot" build), used as the baseline to beat.
const currentTalents = { revival: 2, loth: 5, ua: 0, impeccable: 10, omen: 0, ll: 7, pog: 15, tfow: 0 };
const currentAttrs = { ares: 1, ylith: 1, spartan: 6, timeless: 5, baal: 6, sensors: 6, htb: 4, lfin: 10, exp: 6, atlas: 0, weak: 6, battle: 0, athena: 0, mino: 0, hermes: 0 };

module.exports = {
  hunter: 'borge',
  level: 39,
  TALENTS, TALENT_BUDGET,
  ATTRIBUTES, ATTRIBUTE_BUDGET,
  ATTRIBUTE_DEPENDENCIES, ATTRIBUTE_MIN_VALUE,
  hunterStats: hunterStatsBorge, globalUpgrades, baseOverrides,
  currentTalents, currentAttrs,
};
