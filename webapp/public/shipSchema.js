'use strict';
// CIFI ship/fleet save schema: field map for the Fleet/Ship-Rank system, extracted the same
// way as saveImport.js (decoded save JSON -> documented field names), verified against
// bridge/test-fixtures/sample-save-decoded.json. This is a SEPARATE module from saveImport.js
// on purpose -- saveImport.js's `unmapped` contract is consumed by the existing hunter-build
// UI and shouldn't grow new categories until a ship tool actually needs them wired in.
//
// Confidence notes:
//   HIGH (confirmed against the real sample save's field names and values): per-ship Rank/
//     RankPoints/RankProgress, Unlocked/FirstUnlocked, CrewLevel/CrewAutomationLevel, EvoLevel,
//     per-ship RU automation goal + applied-goal fields (11 slots), loadout list fields, ship
//     count (8, with Ship8 missing loadout-2/3/selected/names/icons/OuroUnlock/RankThisTR and
//     having extra UnlockTutorial*/Respec fields -- Ship8 reads as a later-added/bonus ship
///     with a slightly different UI, not a parsing bug).
//   CORRECTED (2026-07-28, via live save diff on a real account, see
//     tools/shipReverseEngineering notes): `Ship{n}RU{k}AutomationLevelGoal` /
//     `AppliedRU{k}AutomationLevelGoal` are NOT the current install level -- they never changed
//     when a real install was purchased in-game. They are an auto-buy TARGET setting only.
//     The real, currently-installed level lives in the separate global RU registry below, as
//     `RU{id}{Category}Level` (e.g. installing 1 point into Ship5's "On-Site Printing Vehicles"
//     node changed `RU11ShardLevel` 2->3 and nothing else under `Ship5RU*`). Cost per install
//     confirmed flat at 1 ship rank point regardless of current level.
//   UNCONFIRMED: the full id mapping from each ship's 11-node grid position to its RU{id}
//     (only RU11 = Ship5 grid position 4 "On-Site Printing Vehicles" confirmed so far -- one
//     diff per node is needed per ship, each spending a real, non-refundable rank point).
//     Node names/descriptions/max-levels for all 11 of Ship5's ("Demeter") grid positions were
//     read directly from the game's own upgrade-detail popups (in order): 1 "Liquid Extraction
//     Tech" (+2.5% all Generator output/crew, max 25), 2 "Canned Mineral Water" (+0.02%
//     MK1+MK4 output/Op Completed/crew, max 125), 3 "The Hexagonal Advantage" (+0.001% Mod
//     Points/Op Completed/crew, max 25), 4 "On-Site Printing Vehicles" = RU11 (+3% Cells/Op
//     Completed/crew, max 125), 5 "Better Mineral Extraction" (+1% Shards/crew, max 1250),
//     6 "Ahead of the Curve" (+1 completed op/crew on new-run start, max 25), 7 "Rare Organism
//     Detection" (+0.2% Cells/Op Completed/crew, max 125), 8 "On-Site GPR Hotspot Scanners"
//     (+0.08% Shards/Op Completed/crew, max 625), 9 "Shardlytics" (+0.1% MK3+MK6 output/Op
//     Completed/crew, max 50), 10 "Bi-Product Goo" (+0.02% MK2+MK5 output/Op Completed/crew,
//     max 125), 11 "Phylogenetic Analysis" (+0.04% Research Points/Op Completed/crew, max 275).
//     Do NOT assume other ships share this exact grid layout/order -- verify per ship.
//   NOT MAPPED YET (aggregate stats only, no per-item breakdown found): loop mods
//     (AchievementLoopModsLevel etc. are totals/achievements, not a per-mod level list),
//     shard milestones (same -- TotalShardMilestones is an aggregate, not itemized).

const SHIP_IDS = [1, 2, 3, 4, 5, 6, 7, 8];

// Slots 1-11 are the RU automation goals every ship exposes (`Ship{n}RU{k}AutomationLevelGoal`
// / `Ship{n}AppliedRU{k}AutomationLevelGoal`). This is distinct from the global RU registry
// below (RU0..RU~110), which tracks each RU node's own Active/Level/CurrentDrain state.
const SHIP_RU_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function realNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'fakeValue' in v) return v.fakeValue;
  if (typeof v === 'object' && 'mantissa' in v) return v; // BigDouble -- kept as-is
  return v;
}

/**
 * @typedef {Object} ShipRecord
 * @property {number} rank            - Ship{n}Rank
 * @property {number} rankPoints      - Ship{n}RankPoints (unspent points available to install)
 * @property {*} rankProgress         - Ship{n}RankProgress (BigDouble, progress toward next rank)
 * @property {boolean} unlocked       - Ship{n}Unlocked
 * @property {string|undefined} firstUnlocked - Ship{n}FirstUnlocked (timestamp string)
 * @property {number} crewLevel       - Ship{n}CrewLevel
 * @property {number} crewAutomationLevel - Ship{n}CrewAutomationLevel
 * @property {boolean} crewAutomationPurchased - Ship{n}CrewAutomationPurchased
 * @property {number} evoLevel        - Ship{n}EvoLevel
 * @property {boolean} evoAutomationOn - Ship{n}EvoAutomationOn
 * @property {Object<number, number>} ruGoal    - slot -> Ship{n}RU{slot}AutomationLevelGoal (target install level)
 * @property {Object<number, number>} ruApplied - slot -> Ship{n}AppliedRU{slot}AutomationLevelGoal (currently installed level)
 * @property {number[]} loadoutList   - Ship{n}LoadoutList (primary loadout slot assignment array)
 * @property {number} loadoutSelected - Ship{n}LoadoutSelected
 */

/**
 * Extracts per-ship rank/RU-install/loadout state from a decoded CIFI save.
 * @param {Object} save - decoded save JSON (see decodeSaveText in saveImport.js)
 * @returns {Object<number, ShipRecord>} keyed by ship id (1-8)
 */
function mapSaveToShips(save) {
  const ships = {};
  SHIP_IDS.forEach((n) => {
    const p = `Ship${n}`;
    if (save[`${p}Unlocked`] === undefined) return; // ship not present in this save's schema version

    const ruGoal = {};
    const ruApplied = {};
    SHIP_RU_SLOTS.forEach((slot) => {
      const goal = save[`${p}RU${slot}AutomationLevelGoal`];
      const applied = save[`${p}AppliedRU${slot}AutomationLevelGoal`];
      if (goal !== undefined) ruGoal[slot] = realNum(goal);
      if (applied !== undefined) ruApplied[slot] = realNum(applied);
    });

    ships[n] = {
      rank: realNum(save[`${p}Rank`]),
      rankPoints: realNum(save[`${p}RankPoints`]),
      rankProgress: realNum(save[`${p}RankProgress`]),
      unlocked: !!save[`${p}Unlocked`],
      firstUnlocked: save[`${p}FirstUnlocked`],
      crewLevel: realNum(save[`${p}CrewLevel`]),
      crewAutomationLevel: realNum(save[`${p}CrewAutomationLevel`]),
      crewAutomationPurchased: !!save[`${p}CrewAutomationPurchased`],
      evoLevel: realNum(save[`${p}EvoLevel`]),
      evoAutomationOn: !!save[`${p}EvoAutomationOn`],
      ruGoal,
      ruApplied,
      loadoutList: Array.isArray(save[`${p}LoadoutList`]) ? save[`${p}LoadoutList`] : [],
      loadoutSelected: realNum(save[`${p}LoadoutSelected`]),
    };
  });
  return ships;
}
window.mapCifiSaveToShips = mapSaveToShips;

// Generator tier unlock state is a GLOBAL flag (not per-ship) -- `MK{n}UnlockedBool`, verified
// directly against a live save (2026-07-29 diff) via ADB: MK1-8 all `true` (Cell generators
// unlocked so far), MK9-12 all `false` (not yet reached).
function mapSaveToUnlockedGens(save) {
  const unlockedGens = {};
  for (let n = 1; n <= 12; n++) {
    const v = save[`MK${n}UnlockedBool`];
    if (v !== undefined) unlockedGens[n] = !!v;
  }
  return unlockedGens;
}
window.mapCifiSaveToUnlockedGens = mapSaveToUnlockedGens;

// Per-ship "per X" progression counters that scale ship install node effects (see
// SHIP_GEAR_FIELDS in shipsPage.js) -- verified directly against a live save via ADB
// (2026-07-29 diff). Precise per-ship field list corrected after user feedback: these are NOT
// one shared account-wide pool -- each ship's nodes only reference ITS OWN specific counters
// (Cradle needs manually-purchased MK2 gens and MK3 gens as TWO SEPARATE counts, not one
// generic "manual generators"; Koios needs Studies/Research levels/Research completions as
// three distinct values, etc).
//   manualMK2Gens/manualMK3Gens -> CellGeneratorsMK{2,3}Manual (BigDouble, per-tier manual buy
//     count -- confirmed distinct from the MK1/4-8 tiers Cradle's nodes don't reference).
//   totalManualGens -> ManualGensThisLR ("This Loop Reset" = current run). CORRECTED: an earlier
//     version of this mapping used ManualGensAllTime, which is a LIFETIME-across-traversals
//     counter (21.9M on the diffed account) -- wildly larger than the real current-run total
//     (confirmed by summing CellGeneratorsMK{1-8}Manual by hand: ~48.6k, matching
//     ManualGensThisLR's 48.5k almost exactly, and matching the account holder's own real-time
//     in-game reading of ~28.7k on just MK1 manual). Ship install nodes want the CURRENT
//     manually-purchased count, not an all-time-across-resets figure.
//   hardwareUpgrades/softwareUpgrades -> the REAL per-tier fields, found after the account
//     holder gave a live reference point (Mk3 Hardware 441 / Software 454). The save has 24
//     numbered `TU{n}Level` slots (2 per generator tier, up to 12 tiers -- only TU1-16 unlocked
//     on the diffed account, i.e. 8 tiers). Within each tier's pair the LOWER-numbered slot is
//     Hardware and the higher is Software (confirmed: TU5=443 / TU6=457 for tier 3, matching the
//     441/454 reference almost exactly -- the few points of drift are just real-time progress
//     between when the account holder read their live value and when this save was pulled).
//     hardwareUpgrades = sum of TU1,3,5,7,9,11,13,15,17,19,21,23 (odd); softwareUpgrades = sum
//     of TU2,4,6,...,24 (even); techUpgrades (combined, for nodes that don't distinguish) = sum
//     of both. Summing all 16 unlocked slots on the diffed account (2831 Hardware + 2888
//     Software = 5719) exactly matches a separate `TechUpsThisLR` field -- cross-confirms this
//     is the right data. CORRECTED from an earlier version that used TechUpgradesAllTime (a
//     lifetime-across-traversals counter, 4.1M) and then a second wrong attempt that used
//     TechUpgradeLevelsThisConstruction (201k, some other combined stat, NOT this) split 50/50
//     as a guess -- neither was the real per-tier Hardware/Software data.
//   loopModsOwned -> LoopModLevelsThisTraversal. INTERPRETIVE: no field represents "count of
//     DISTINCT loop mods owned" (only summed-level aggregates and achievement-tier numbers
//     exist) -- using the sum-of-levels field on the working assumption that's what "Loop Mod
//     owned" scaling actually means in-game (consistent with how idle games in this genre
//     usually implement compounding "owned X" scaling).
//   loopFillsThisRun -> LoopsFilled (matches HighestLoopsFilledThisTR exactly -- already a
//     this-run-scoped counter despite the unqualified name).
//   loopResetsDone -> LoopResetsPerformedAllTime (exact name match; "Loop Prestige done").
//   automationsUnlocked -> derived by counting the 12 `MK{n}AutomationPurchased` booleans.
//   ticksThisLoop -> TicksThisLoop (BigDouble) -- NOT TicksAllTime (an earlier version of this
//     mapping wrongly used the all-time total; Hephaestus's nodes want the CURRENT loop's count).
//   operationsCompleted -> NewSMOperationsAllTime (BigDouble; shared by Demeter + Koios --
//     the legacy `SMOperationsAllTime` field is dead/always 0 on the diffed account).
//   studiesThisLR -> StudiesThisLoop (BigDouble; "LR" = Loop Reset, i.e. "this loop").
//   researchLevels -> ResearchLevelsThisConstruction (sum of levels across the Research
//     Catalogue tree, matching the node text's "level in Researches").
//   totalCompletedResearch -> FullyCompletedResearches (exact name match).
//   missionsCompleted -> MissionsCompletedAllTime (exact name match).
//   meltdown -> HighestMeltdown (0.337 on the diffed account -- MeltdownStep, used in an
//     earlier version of this mapping, is a different unrelated integer counter (192) despite
//     the name; HighestMeltdown/AchievementMeltdownProgress both hold the real fractional value
//     the game's own Meltdown UI shows).
// realNum() deliberately leaves BigDouble {mantissa,exponent} objects as-is (currency values
// can reach e300+, well past what a plain number can hold) -- but every BigDouble field used
// here stays small enough (observed exponent ~4-10) to collapse to an ordinary number, which
// the numeric <input> and the arithmetic in computeResourceBonuses both need.
function bigDoubleToNumber(v) {
  const n = realNum(v);
  // Every counter that goes through here is a whole-number COUNT (ticks/operations/studies) --
  // round off the mantissa*10^exponent floating-point noise (e.g. 2054768.0000000002) rather
  // than showing it raw.
  if (n && typeof n === 'object' && 'mantissa' in n) return Math.round(n.mantissa * Math.pow(10, n.exponent));
  return n;
}
function mapSaveToShipGear(save) {
  const gear = {};
  if (save.CellGeneratorsMK2Manual !== undefined) gear.manualMK2Gens = bigDoubleToNumber(save.CellGeneratorsMK2Manual);
  if (save.CellGeneratorsMK3Manual !== undefined) gear.manualMK3Gens = bigDoubleToNumber(save.CellGeneratorsMK3Manual);
  if (save.ManualGensThisLR !== undefined) gear.totalManualGens = bigDoubleToNumber(save.ManualGensThisLR);
  let hardwareUpgrades = 0; let softwareUpgrades = 0; let anyTuField = false;
  for (let n = 1; n <= 24; n++) {
    const v = save[`TU${n}Level`];
    if (v === undefined) continue;
    anyTuField = true;
    if (n % 2 === 1) hardwareUpgrades += bigDoubleToNumber(v); else softwareUpgrades += bigDoubleToNumber(v);
  }
  if (anyTuField) {
    gear.hardwareUpgrades = hardwareUpgrades;
    gear.softwareUpgrades = softwareUpgrades;
    gear.techUpgrades = hardwareUpgrades + softwareUpgrades;
  }
  if (save.LoopModLevelsThisTraversal !== undefined) gear.loopModsOwned = realNum(save.LoopModLevelsThisTraversal);
  if (save.LoopsFilled !== undefined) gear.loopFillsThisRun = realNum(save.LoopsFilled);
  if (save.LoopResetsPerformedAllTime !== undefined) gear.loopResetsDone = realNum(save.LoopResetsPerformedAllTime);
  let automationsUnlocked = 0;
  let anyAutomationField = false;
  for (let n = 1; n <= 12; n++) {
    const v = save[`MK${n}AutomationPurchased`];
    if (v !== undefined) { anyAutomationField = true; if (v) automationsUnlocked++; }
  }
  if (anyAutomationField) gear.automationsUnlocked = automationsUnlocked;
  if (save.TicksThisLoop !== undefined) gear.ticksThisLoop = bigDoubleToNumber(save.TicksThisLoop);
  if (save.NewSMOperationsAllTime !== undefined) gear.operationsCompleted = bigDoubleToNumber(save.NewSMOperationsAllTime);
  if (save.StudiesThisLoop !== undefined) gear.studiesThisLR = bigDoubleToNumber(save.StudiesThisLoop);
  if (save.ResearchLevelsThisConstruction !== undefined) gear.researchLevels = realNum(save.ResearchLevelsThisConstruction);
  if (save.FullyCompletedResearches !== undefined) gear.totalCompletedResearch = realNum(save.FullyCompletedResearches);
  if (save.MissionsCompletedAllTime !== undefined) gear.missionsCompleted = realNum(save.MissionsCompletedAllTime);
  if (save.HighestMeltdown !== undefined) gear.meltdown = realNum(save.HighestMeltdown);
  return gear;
}
window.mapCifiSaveToShipGear = mapSaveToShipGear;

// Gear Sets: each of the 22 real pieces' level + owned state, verified directly against a live
// save via ADB (2026-07-29 diff) -- `{Color}Item{N}Level` matches REAL_GEAR_PIECES exactly (3
// Purple + 4 Orange + 5 Red + 5 Green + 5 Blue = 22). NOTE: the save also has a same-shaped
// `{Color}Item{N}Unlocked` boolean, but on the diffed account every one of those is `false`
// while the pieces clearly have real (400+) levels -- that flag evidently means something other
// than "owned" (an unclaimed-reward flag, maybe), so `owned` is derived from level > 0 instead,
// which is unambiguous (can't have a level without owning the piece).
const GEAR_COLOR_PREFIX = { Purple: 3, Orange: 4, Red: 5, Green: 5, Blue: 5 };
function mapSaveToGearLevels(save) {
  const levels = {}; // "{Color}{N}" -> level
  Object.entries(GEAR_COLOR_PREFIX).forEach(([color, count]) => {
    for (let i = 1; i <= count; i++) {
      const v = save[`${color}Item${i}Level`];
      if (v !== undefined) levels[`${color}${i}`] = realNum(v);
    }
  });
  return levels;
}
window.mapCifiSaveToGearLevels = mapSaveToGearLevels;

// Academy/Dark Academy Badges: `Badge{n}Acquired` / `DarkBadge{n}Acquired`, verified directly
// against a live save via ADB (2026-07-29 diff) -- position in the save's numbering matches
// position in the wiki's own Academy_Badges/Dark_Academy_Badges tables (Innovation Badge is
// the 2nd Academy Badge -> Badge2Acquired; Dark Innovation Badge is the 1st Dark Academy Badge
// -> DarkBadge1Acquired). Confirmed Badge2Acquired=true on the diffed account.
function mapSaveToFleetBadges(save) {
  return {
    badge_innovation: !!save.Badge2Acquired,
    badge_dark_innovation: !!save.DarkBadge1Acquired,
  };
}
window.mapCifiSaveToFleetBadges = mapSaveToFleetBadges;

// Loop Mods DO have a per-mod level field (`LM{n}Level`, some with a second `LM{n}v2Level`) --
// contradicts the earlier "aggregate only" note above, found via this same live diff. BUT the
// exact id offset against the wiki's Loop_Modifications table "#" column is NOT confirmed: the
// first 6 ship SP-transmission mods matched a clean `wikiId - 1` offset (LM35=15 for wiki #36
// Cradle, LM36-40 all plausible in-range for wiki #37-41), but wiki #42 (Zeus, stated max 25)
// mapped to LM41Level=2078 -- a value 80x over that mod's own max, meaning the wiki's "#"
// column is NOT a stable 1:1 id (likely just the wiki table's row order) and this offset breaks
// down. Deliberately NOT wired in until one specific mod's real LM index is confirmed via an
// isolated diff (buy exactly 1 level of a known mod, see which LM{n}Level changes).

/**
 * @typedef {Object} ResearchUnitNode
 * @property {boolean} active   - RU{id}Active
 * @property {number} level     - RU{id}Level
 * @property {*} currentDrain   - RU{id}CurrentDrain (BigDouble)
 * @property {Object<string, number>} [categoryLevels] - only present for low ids (RU0-RU13 in
 *   the sample save): Academy/Auto/Gen/Loop/Ouroboros/Research/Shard/Tech level breakdown.
 *   UNCONFIRMED whether this category set is fixed-length or grows with future updates --
 *   read it as a dynamic set of `${prefix}Level` suffixes, not a hardcoded list.
 *   CONFIRMED this is where the real per-ship-install level actually lives (see the top-of-file
 *   note): e.g. `categoryLevels.Shard` on RU11 is Ship5's "On-Site Printing Vehicles" level.
 */

const RU_CATEGORY_SUFFIXES = ['Academy', 'Auto', 'Gen', 'Loop', 'Ouroboros', 'Research', 'Shard', 'Tech'];

/**
 * Extracts the global Research-Unit registry (RU0..RU~110) from a decoded CIFI save.
 * Distinct from per-ship RU install goals (see mapSaveToShips) -- this is each RU node's own
 * standalone state, id space and meaning not yet correlated to the per-ship slots 1-11.
 * @param {Object} save
 * @returns {Object<number, ResearchUnitNode>}
 */
function mapSaveToResearchUnits(save) {
  const rus = {};
  let id = 0;
  while (save[`RU${id}Active`] !== undefined || save[`RU${id}Level`] !== undefined) {
    const node = {
      active: !!save[`RU${id}Active`],
      level: realNum(save[`RU${id}Level`]),
      currentDrain: realNum(save[`RU${id}CurrentDrain`]),
    };
    const categoryLevels = {};
    RU_CATEGORY_SUFFIXES.forEach((suffix) => {
      const v = save[`RU${id}${suffix}Level`];
      if (v !== undefined) categoryLevels[suffix] = realNum(v);
    });
    if (Object.keys(categoryLevels).length > 0) node.categoryLevels = categoryLevels;
    rus[id] = node;
    id += 1;
  }
  return rus;
}
window.mapCifiSaveToResearchUnits = mapSaveToResearchUnits;
