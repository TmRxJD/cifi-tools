'use strict';
// Pulled from cifi-tools.com's Knox Build Creator (cost/max-level table only --
// this is static game data, not account-specific).
//
// NOT YET USABLE: your account has no Knox build (level 1, 0 points spent), so
// hunterStats/globalUpgrades/currentTalents/currentAttrs below are unset. Fill
// these in from your actual Knox build (same fields as borgeConfig.js /
// ozzyConfig.js) once you've leveled Knox, then validate against a live
// Knox Simulator result before trusting optimizer output for this hunter.

const TALENTS = [
  { id: 'revival', label: 'Death Is My Companion', maxLevel: 2 },
  { id: 'calyp', label: "Calypso's Advantage", maxLevel: 5 },
  { id: 'ua', label: 'The Unfair Advantage', maxLevel: 5 },
  { id: 'ghost', label: 'Ghost Bullets', maxLevel: 15 },
  { id: 'omen', label: 'The Omen Of Defeat', maxLevel: 10 },
  { id: 'll', label: 'Call Me Lucky Loot', maxLevel: 10 },
  { id: 'pog', label: 'Presence Of A God', maxLevel: 10 },
  { id: 'finish', label: 'Finishing Move', maxLevel: 15 },
];
const TALENT_BUDGET = null; // depends on Knox's level -- read from Build Creator once you have a build

const ATTRIBUTES = [
  { id: 'kraken', label: 'Release The Kraken', cost: 1, maxLevel: 999 }, // uncapped, same pattern as Borge ares/ylith
  { id: 'soul', label: 'Soul Amplification', cost: 1, maxLevel: 100 },
  { id: 'dead', label: 'Dead Men Tell No Tales', cost: 2, maxLevel: 10 },
  { id: 'spa', label: 'Space Pirate Armory', cost: 2, maxLevel: 50 },
  { id: 'pl', label: 'A Pirates Life for Knox', cost: 3, maxLevel: 10 },
  { id: 'time', label: 'Timeless Mastery', cost: 3, maxLevel: 5 },
  { id: 'sear', label: 'Searious Efficiency', cost: 2, maxLevel: 5 },
  { id: 'pct', label: 'Passive Charge Tank', cost: 4, maxLevel: 10 },
  { id: 'kot', label: 'King Of Torpedos', cost: 5, maxLevel: 5 },
  { id: 'fe', label: 'Fortification Elixir', cost: 2, maxLevel: 10 },
  { id: 'sop', label: 'Shield of Poseidon', cost: 3, maxLevel: 10 },
];
const ATTRIBUTE_BUDGET = null; // depends on Knox's level

// Unlock rules pulled from main.js's ATTRIBUTE_DEPENDENCIES / ATTRIBUTE_MIN_VALUE for Knox
// (all min-values are 0 for Knox -- only the dependency chain gates anything).
const ATTRIBUTE_DEPENDENCIES = {
  soul: ['kraken'], dead: ['soul'], spa: ['kraken'], pl: ['spa'], time: ['pl'],
  sear: ['kraken'], pct: ['sear'], kot: ['pct'], fe: ['kraken'], sop: ['fe'],
};
const ATTRIBUTE_MIN_VALUE = {
  kraken: 0, soul: 0, dead: 0, spa: 0, pl: 0, time: 0, sear: 0, pct: 0, kot: 0, fe: 0, sop: 0,
};

const hunterStats = null; // TODO: hp/atk/regen/dr/block/effect/charge/chargeGain/reload/proj/stage/<talent+attr names>:0
const globalUpgrades = null; // TODO: same shape as borgeConfig.js / ozzyConfig.js globalUpgrades
const baseOverrides = {};
const currentTalents = null;
const currentAttrs = null;

module.exports = {
  hunter: 'knox',
  level: null,
  TALENTS, TALENT_BUDGET,
  ATTRIBUTES, ATTRIBUTE_BUDGET,
  ATTRIBUTE_DEPENDENCIES, ATTRIBUTE_MIN_VALUE,
  hunterStats, globalUpgrades, baseOverrides,
  currentTalents, currentAttrs,
};
