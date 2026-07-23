'use strict';
// Pulled from your cifi-tools.com Ozzy Build Creator (Talents 50/50, Attributes 150/150)
// and validated against the site's live "Ozzy Push" result.

const TALENTS = [
  { id: 'revival', label: 'Death Is My Companion', maxLevel: 2 },
  { id: 'boon', label: "Tricksters Boon", maxLevel: 1 },
  { id: 'ua', label: 'The Unfair Advantage', maxLevel: 5 },
  { id: 'needles', label: 'Thousand Needles', maxLevel: 10 },
  { id: 'omen', label: 'The Omen Of Decay', maxLevel: 10 },
  { id: 'll', label: 'Call Me Lucky Loot', maxLevel: 10 },
  { id: 'crip', label: 'Crippling Shots', maxLevel: 15 },
  { id: 'echo', label: 'Echo Bullets', maxLevel: 20 },
];
const TALENT_BUDGET = 50;

// lotl/exo showed no "/max" in the UI (same as Borge's ares/ylith) -- likely uncapped;
// the point budget is the real constraint so a high ceiling is a safe stand-in.
const ATTRIBUTES = [
  { id: 'lotl', label: 'Living Off The Land', cost: 1, maxLevel: 999 },
  { id: 'exo', label: 'Exo Piercers', cost: 1, maxLevel: 999 },
  { id: 'scorp', label: 'Shimmering Scorpions', cost: 3, maxLevel: 5 },
  { id: 'timeless', label: 'Timeless Mastery', cost: 3, maxLevel: 5 },
  { id: 'ibu', label: 'Wings Of Ibu', cost: 2, maxLevel: 5 },
  { id: 'exterm', label: 'Extermination Protocol', cost: 2, maxLevel: 5 },
  { id: 'snek', label: 'Soul Of Snek', cost: 3, maxLevel: 5 },
  { id: 'vect', label: 'Vectid Elixir', cost: 2, maxLevel: 10 },
  { id: 'cycle', label: 'The Cycle Of Death', cost: 3, maxLevel: 5 },
  { id: 'deal', label: 'A Deal With Death', cost: 5, maxLevel: 3 },
  { id: 'medusa', label: 'Gift Of Medusa', cost: 3, maxLevel: 5 },
  { id: 'dance', label: 'Dance Of Dashes', cost: 3, maxLevel: 4 },
  { id: 'sisters', label: 'Blessing Of The Sisters', cost: 15, maxLevel: 1 },
  { id: 'scarab', label: 'Blessing Of The Scarab', cost: 2, maxLevel: 20 },
  { id: 'cat', label: 'Blessing Of The Cat', cost: 2, maxLevel: 20 },
];
const ATTRIBUTE_BUDGET = 150;

// Unlock rules pulled from main.js's ATTRIBUTE_DEPENDENCIES / ATTRIBUTE_MIN_VALUE for Ozzy.
const ATTRIBUTE_DEPENDENCIES = {
  exo: ['lotl'], ibu: ['lotl'], scorp: ['exo'], timeless: ['exo'], exterm: ['ibu'],
  snek: ['exterm'], vect: ['exterm'], cycle: ['snek'], deal: ['cycle'], medusa: ['exterm'],
  dance: ['scorp'], sisters: ['deal'], scarab: ['medusa'], cat: ['dance'],
};
const ATTRIBUTE_MIN_VALUE = {
  lotl: 0, exo: 0, scorp: 0, timeless: 0, ibu: 0, exterm: 0, snek: 0, vect: 0, cycle: 0,
  deal: 90, medusa: 90, dance: 90, sisters: 180, scarab: 150, cat: 150,
};

const hunterStatsOzzy = {
  hp: 221, atk: 220, regen: 163, dr: 50, evade: 30, effect: 37, multichance: 36, multipower: 27, atkspeed: 27,
  stage: 168, revival: 0, boon: 0, ua: 0, needles: 0, omen: 0, ll: 0, crip: 0, ultima: 0, echo: 0,
  lotl: 0, exo: 0, scorp: 0, timeless: 0, ibu: 0, exterm: 0, snek: 0, vect: 0, cycle: 0, deal: 0,
  medusa: 0, dance: 0, sisters: 0, scarab: 0, cat: 0,
};

// Same account-wide global upgrades as Borge (shared pools) plus Ozzy's own gem loot bonus.
const globalUpgrades = {
  'relics.r4': 8, 'relics.r7': 8,
  'shardmilestones.m0': 70,
  'inscryptions.i31': 10, 'inscryptions.i32': 8, 'inscryptions.i33': 6, 'inscryptions.i36': 5,
  'inscryptions.i37': 7, 'inscryptions.i40': 10,
  'loopmods.scavenger2': 25,
  'iap.travpack': 1,
  'ultima.ulti': 1,
  'diamondspecials.reviveboost': 10, 'diamondspecials.hunterloot': 10,
  'diamondcards.iridian': 1,
  'gems_nodes.attraction_lootOzzy': 1,
};

const baseOverrides = {};

// Your current real allocation (the "Ozzy Push" build), used as the baseline to beat.
const currentTalents = { revival: 2, boon: 1, ua: 5, needles: 10, omen: 10, ll: 0, crip: 14, echo: 8 };
const currentAttrs = { lotl: 57, exo: 1, scorp: 5, timeless: 0, ibu: 5, exterm: 5, snek: 5, vect: 0, cycle: 5, deal: 3, medusa: 0, dance: 4, sisters: 0, scarab: 0, cat: 0 };

module.exports = {
  hunter: 'ozzy',
  level: 50,
  TALENTS, TALENT_BUDGET,
  ATTRIBUTES, ATTRIBUTE_BUDGET,
  ATTRIBUTE_DEPENDENCIES, ATTRIBUTE_MIN_VALUE,
  hunterStats: hunterStatsOzzy,
  globalUpgrades, baseOverrides,
  currentTalents, currentAttrs,
};
