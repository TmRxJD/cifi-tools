'use strict';
// Fleet page: a whole-fleet install optimizer (visuals-first pass; the real solver algorithm
// is still to come -- see "Generate Loadout" below, which currently does a simple greedy
// placeholder, not the real optimizer). Modeled visually after SirRed's CIFI Ouroboros Helper
// Tool (the closest existing community tool) but restyled to match this project's own
// hunter-sim UI, and showing all 8 ships in one canvas at once instead of cycling through them.
//
// SHIP_NODE_CATALOG is keyed by the COMMUNITY "install code" number (e.g. CRA1..CRA11,
// DEM1..DEM11), pulled directly from cifi.fandom.com's per-ship wiki pages (name/effect/max
// level/unlock requirement, verbatim) -- this is the same numbering the community and the
// Gear Sets table use, NOT the physical grid-tap-order I originally used. Two independent
// live diffs (Ship1 and Ship5, done before this correction) matched the wiki's name+gate
// pairs exactly, which is what let us derive GRID_TO_CODE below with real confidence.
//
// `source`: 'confirmed' = name/effect/gate cross-checked against a live save diff. 'wiki' =
// transcribed as-is from cifi.fandom.com, including a couple of internally-inconsistent MK-tier
// mentions in the source text itself (flagged inline) that weren't "corrected" by guessing.
//
// `max`: the wiki's BASE level cap (re-confirmed against every ship's cifi.fandom.com page
// 2026-07-30) -- NOT the researched value. An earlier version of this catalog baked
// live-captured max values in directly instead (e.g. "wiki said Mitosis Enhancements max 250,
// live confirmed max is 1250"), which silently mixed base and x5'd numbers depending on whether
// the specific account/ship being diffed had Research #68 "Fleet Analysis 1" tier 1 ("All Rank
// Installs Max LV x5") at the time -- some nodes ended up correctly 5x, others 10x/50x by
// accident, others still at 1x, entirely inconsistent. Use nodeMaxLevel(shipId, slot) (defined
// near GEN_TIERS) everywhere an EFFECTIVE cap is needed -- it applies the x5 research multiplier
// on top of this base value, in one place, so it can never drift out of sync again.
//
// `ruId`: which RU{id}{Category}Level field in the global RU registry (see shipSchema.js)
// holds this node's real current install level. For Cradle (ruId 1-11) and 5 of Demeter's
// nodes this was individually diffed and confirmed identity (ruId === code). The remaining
// nodes here (Demeter's other 6, and ALL of Auxesia/Zagreus/Hephaestus/Koios/Zeus) were never
// individually diffed, but a live save pull (2026-07-29) let us check the identity assumption
// against 16 already-independently-confirmed data points across 2 ships -- ruId === code held
// with ZERO exceptions in all 16. Applied by structural analogy from that consistent pattern
// (the RU registry has the identical id-1..11-per-category shape for every ship), not guessed
// from nothing -- but still worth a real per-node diff later if any single ship's numbers look
// off in-game, since it's inferred rather than individually verified for these 60 nodes.
const SHIP_NODE_CATALOG = {
  1: { // Cradle -- ranks up by manually purchasing generators. RU category "Gen".
    1: { source: 'confirmed', name: 'Mitosis Enhancements', max: 250, ruId: 1, effect: '+10% Cells gained, per crew member' },
    2: { source: 'confirmed', name: 'Improved Timing Belts', max: 25, ruId: 2, gateAtTotalInstalls: 5, effect: '+5% MK1 output, per crew member' },
    3: { source: 'confirmed', name: 'Improved Printing Engines', max: 25, ruId: 3, gateAtTotalInstalls: 5, effect: '+5% MK2 output, per crew member' },
    4: { source: 'confirmed', name: 'Printer Tweaks', max: 20, ruId: 4, gateAtTotalInstalls: 25, gearKey: 'manualMK2Gens', effect: '+0.5% MK1 Generator output, per manually purchased MK2 Generator, per crew member' },
    5: { source: 'confirmed', name: 'Improved Capacitors', max: 20, ruId: 5, gateAtTotalInstalls: 25, effect: '+3% MK3 output, per crew member' },
    6: { source: 'confirmed', name: 'Improved Cooling Systems', max: 10, ruId: 6, gateAtTotalInstalls: 40, effect: '+3% MK4 output, per crew member' },
    7: { source: 'confirmed', name: 'Printer Modulization', max: 15, ruId: 7, gateAtTotalInstalls: 40, gearKey: 'manualMK3Gens', effect: '+0.4% MK2 Generator output, per manually purchased MK3 Generator, per crew member' },
    // Nodes 8-11: `max` corrected 2026-07-31 by direct screenshot comparison against a live
    // account (real caps 500/250/150/200 at 5x research vs this catalog's previous
    // 50/125/75/100 -- the wiki's base values for these 4 "corner" nodes specifically were
    // stale by exactly half; nodes 1-7 matched the wiki fine). `ruId` for 9 and 11 SWAPPED at
    // the same time -- the account's real level (63) showed up on node 11 (Brain Capacity
    // Genetics) in this tool but on node 9 (Improved Generator Equipment) in the real game, same
    // icon/position in both, confirming a pure ruId mis-assignment rather than a layout bug.
    // Only Cradle has been re-verified this way -- Demeter/Auxesia/Zagreus/Hephaestus/Koios/
    // Zeus's nodes 8-11 (and the ruId-identity assumption generally) still need the same check.
    8: { source: 'confirmed', name: 'Molecule Infusing Tech', max: 100, ruId: 8, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.005% output of all Generators, per manual generator purchased, per crew member' },
    9: { source: 'confirmed', name: 'Improved Generator Equipment', max: 50, ruId: 11, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.027% Cells gained, per manual generator purchased, per crew member' },
    10: { source: 'confirmed', name: 'On-Site Mining Printers', max: 30, ruId: 10, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.006% Shards gained, per manual generator purchased, per crew member' },
    11: { source: 'confirmed', name: 'Brain Capacity Genetics', max: 40, ruId: 9, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.007% Research Points gained, per manual generator purchased, per crew member' },
  },
  2: { // Auxesia -- unlocks Tech Upgrades.
    1: { source: 'wiki', ruId: 1, name: 'Improved Tech Software', max: 250, effect: '+1% final output of Tech Software upgrades, per crew member' },
    2: { source: 'wiki', ruId: 2, name: 'Improved Tech Hardware', max: 15, gateAtTotalInstalls: 5, effect: '+1% final output of Tech Hardware upgrades, per crew member' },
    3: { source: 'wiki', ruId: 3, name: 'Precise Calculations', max: 15, gateAtTotalInstalls: 5, gearKey: 'techUpgrades', effect: '+0.1% Cells gained, per Tech Upgrade currently purchased, per crew member' },
    4: { source: 'wiki', ruId: 4, name: 'Optimized Chipsets', max: 20, gateAtTotalInstalls: 25, gearKey: 'techUpgrades', effect: '+0.1% MK3 output, per Tech Upgrade currently purchased, per crew member (wiki text as-is -- likely meant MK1 given the node order/name)' },
    5: { source: 'wiki', ruId: 5, name: 'Optimized Power Supplies', max: 20, gateAtTotalInstalls: 25, gearKey: 'techUpgrades', effect: '+0.1% MK2 output, per Tech Upgrade currently purchased, per crew member' },
    6: { source: 'wiki', ruId: 6, name: 'Optimized Hard Drives', max: 15, gateAtTotalInstalls: 50, gearKey: 'techUpgrades', effect: '+0.05% MK3 output, per Tech Upgrade currently purchased, per crew member' },
    7: { source: 'wiki', ruId: 7, name: 'Optimized Cell Vacuum', max: 15, gateAtTotalInstalls: 50, gearKey: 'techUpgrades', effect: '+0.05% MK4 output, per Tech Upgrade currently purchased, per crew member' },
    // Nodes 8/11: `max`/`ruId` corrected 2026-07-31 by direct screenshot comparison against a
    // live account -- same pattern found on Cradle: node 9 and node 11's real levels were
    // swapped (the account's real level showed up on node 9 in-game but node 11 in this tool),
    // and node 8's/node 11's base caps were understated (real caps 125/150 at 5x vs this
    // catalog's previous 75/100).
    8: { source: 'wiki', ruId: 8, name: 'Modified Cell Turbines', max: 25, gateAtTotalInstalls: 100, gearKey: 'hardwareUpgrades', effect: '+0.04% output of all Generators, per Hardware Upgrade purchased, per crew member' },
    9: { source: 'wiki', ruId: 11, name: 'Bio-Mech Cell Coating', max: 30, gateAtTotalInstalls: 100, gearKey: 'softwareUpgrades', effect: '+1.32% Cells gained, per Software Upgrade purchased, per crew member' },
    10: { source: 'wiki', ruId: 10, name: 'Shard-Based Cooling Towers', max: 10, gateAtTotalInstalls: 100, gearKey: 'hardwareUpgrades', effect: '+0.02% Shards gained, per Hardware Upgrade purchased, per crew member' },
    11: { source: 'wiki', ruId: 9, name: 'Robo-Engineer Assistants', max: 30, gateAtTotalInstalls: 100, gearKey: 'softwareUpgrades', effect: '+0.08% Research Points gained, per Software Upgrade purchased, per crew member' },
  },
  3: { // Zagreus -- ranks up by filling Loops. Unlocks Loop Mods / Mod Points.
    1: { source: 'wiki', ruId: 1, name: 'Accumulation Theory', max: 250, gearKey: 'loopModsOwned', effect: '+0.5% Cells Gained, per Loop Modification owned, per crew member' },
    2: { source: 'wiki', ruId: 2, name: 'Feedback Theory', max: 10, gateAtTotalInstalls: 5, gearKey: 'loopFillsThisRun', effect: '+0.1% MK1, MK2, MK3 outputs, per loop filled this run, per crew member' },
    3: { source: 'wiki', ruId: 3, name: 'Deja Vu Theory', max: 10, gateAtTotalInstalls: 5, gearKey: 'loopResetsDone', effect: '+0.1% Mod Points Gained, per Loop Prestige done, per crew member' },
    4: { source: 'wiki', ruId: 4, name: 'Data Theory', max: 20, gateAtTotalInstalls: 20, gearKey: 'loopModsOwned', effect: '+0.05% MK2 output, per Loop Mod owned, per crew member' },
    5: { source: 'wiki', ruId: 5, name: 'Flashback Theory', max: 20, gateAtTotalInstalls: 20, gearKey: 'loopModsOwned', effect: '+0.05% MK3 output, per Loop Mod owned, per crew member' },
    6: { source: 'wiki', ruId: 6, name: 'Observation Theory', max: 20, gateAtTotalInstalls: 20, gearKey: 'loopModsOwned', effect: '+0.01% MK4 output, per Loop Mod owned, per crew member' },
    7: { source: 'wiki', ruId: 7, name: 'Reflection Theory', max: 20, gateAtTotalInstalls: 40, gearKey: 'loopModsOwned', effect: '+0.01% MK3 output, per Loop Mod owned, per crew member (wiki text as-is -- possibly meant "all Generators")' },
    // Nodes 8/9/10/11: `max` corrected 2026-07-31 by direct screenshot comparison against a
    // live account (real caps 150/50/125/100 at 5x). Node 9/11 levels also swapped -- same
    // pattern as Cradle/Auxesia/Hephaestus (account-confirmed directly: real has 1 point on
    // node 9 and 0 on node 11, this tool previously showed the reverse).
    8: { source: 'wiki', ruId: 8, name: 'Loop Throttle Integrations', max: 30, gateAtTotalInstalls: 100, gearKey: 'loopModsOwned', effect: '+0.01% output of all Generators, per Loop Mod purchased, per crew member' },
    9: { source: 'wiki', ruId: 11, name: 'C.E.L.L. Mainframe Integration', max: 10, gateAtTotalInstalls: 100, gearKey: 'loopFillsThisRun', effect: '+10% Cells Gained, per Loop Filled this run, per crew member' },
    10: { source: 'wiki', ruId: 10, name: 'Mining Data Block System', max: 25, gateAtTotalInstalls: 100, gearKey: 'loopModsOwned', effect: '+0.04% Shards Gained, per Loop Mod owned, per crew member' },
    11: { source: 'wiki', ruId: 9, name: 'Databyte Integrations', max: 20, gateAtTotalInstalls: 100, gearKey: 'loopFillsThisRun', effect: '+0.05% Research Points gained, per Loop Filled this run, per crew member' },
  },
  4: { // Hephaestus -- ranks up by accumulating Cells. Unlocks Automation.
    1: { source: 'wiki', ruId: 1, name: 'Production Line Connections', max: 250, gearKey: 'automationsUnlocked', effect: '+4% MK1, MK2, MK3, MK4 outputs, per Automation owned, per crew member' },
    2: { source: 'wiki', ruId: 2, name: 'Delivery Drones', max: 5, gateAtTotalInstalls: 5, gearKey: 'ticksThisLoop', effect: '+0.0003% final output of Software & Hardware Tech Upgrades, per Tick completed, per crew member' },
    3: { source: 'wiki', ruId: 3, name: 'Modifications Connection', max: 5, gateAtTotalInstalls: 5, gearKey: 'automationsUnlocked', effect: '+0.2% Mod Points Gained, per Automation purchased, per crew member' },
    4: { source: 'wiki', ruId: 4, name: 'Heavy Duty Grabbies', max: 15, gateAtTotalInstalls: 20, gearKey: 'automationsUnlocked', effect: '+5% Cells Gained, per Automation purchased, per crew member' },
    5: { source: 'wiki', ruId: 5, name: 'Manual Overkill', max: 15, gateAtTotalInstalls: 20, gearKey: 'totalManualGens', effect: '+0.1% Cells Gained, per manually purchased generator, per crew member' },
    6: { source: 'wiki', ruId: 6, name: 'Accumulation Modification', max: 5, gateAtTotalInstalls: 60, gearKey: 'totalManualGens', effect: '+0.001% Mod Points Gained, per manually purchased generator, per crew member' },
    7: { source: 'wiki', ruId: 7, name: 'Fiver Connection', max: 20, gateAtTotalInstalls: 60, gearKey: 'automationsUnlocked', effect: '+2% MK3 output, per Automation owned, per crew member (wiki text as-is -- name suggests MK5)' },
    // Nodes 9-11: `max`/`ruId` corrected 2026-07-31 by direct screenshot comparison against a
    // live account -- same node-9/11 level swap as Cradle/Auxesia, plus 9/10/11 all share the
    // same real cap (425 at 5x = base 85), not the smaller/differing wiki values previously
    // stored. Node 8 already matched (base 40 -> 200 at 5x) and is unchanged.
    8: { source: 'wiki', ruId: 8, name: 'Faster Transportation', max: 40, gateAtTotalInstalls: 100, effect: '+1% output of all Generators, per crew member (wiki notes: shows as 0.01% in-game)' },
    9: { source: 'wiki', ruId: 11, name: 'Factory Maintaining Drone', max: 85, gateAtTotalInstalls: 100, gearKey: 'ticksThisLoop', effect: '+0.001% Cells Gained, per Tick Completed, per crew member' },
    10: { source: 'wiki', ruId: 10, name: 'Auto-Mining Machina', max: 85, gateAtTotalInstalls: 100, gearKey: 'ticksThisLoop', effect: '+0.0001% Shards Gained, per Tick Completed, per crew member' },
    11: { source: 'wiki', ruId: 9, name: 'Improved Blueprints', max: 85, gateAtTotalInstalls: 100, gearKey: 'ticksThisLoop', effect: '+0.0002% Research Points Gained, per Tick Completed, per crew member' },
  },
  5: { // Demeter -- ranks up by completing Operations. Unlocks Shard Mining.
    1: { source: 'confirmed', name: 'Ahead of the Curve', max: 5, ruId: 1, effect: '+1 completed operation per crew member on new-run start (no immediate shards)' },
    2: { source: 'confirmed', name: 'Better Mineral Extraction', max: 250, ruId: 2, effect: '+1% Shards Gained, per crew member' },
    3: { source: 'confirmed', name: 'Rare Organism Detection', max: 25, ruId: 3, gearKey: 'operationsCompleted', effect: '+0.2% Cells Gained, per Operation Completed, per crew member' },
    4: { source: 'confirmed', name: 'Canned Mineral Water', max: 25, ruId: 4, gateAtTotalInstalls: 10, gearKey: 'operationsCompleted', effect: '+0.02% MK1 & MK4 outputs, per Operation Completed, per crew member' },
    5: { source: 'confirmed', name: 'Bi-Product Goo', max: 25, ruId: 5, gateAtTotalInstalls: 10, gearKey: 'operationsCompleted', effect: '+0.02% MK2 & MK5 outputs, per Operation Completed, per crew member' },
    6: { source: 'confirmed', name: 'The Hexagonal Advantage', max: 5, ruId: 6, gateAtTotalInstalls: 25, gearKey: 'operationsCompleted', effect: '+0.001% Mod Points gained, per Operation Completed, per crew member' },
    7: { source: 'confirmed', name: 'Shardlytics', max: 10, ruId: 7, gateAtTotalInstalls: 25, gearKey: 'operationsCompleted', effect: '+0.1% MK3 & MK6 outputs, per Operation Completed, per crew member' },
    // Node 9/11 ruId swapped (same universal pattern), node 10's cap corrected 2026-07-31,
    // account-confirmed directly: real cap 625 at 5x (base 125, not 15).
    8: { source: 'confirmed', name: 'Liquid Extraction Tech', max: 5, ruId: 8, gateAtTotalInstalls: 100, effect: '+2.5% output of all Generators, per crew member' },
    9: { source: 'confirmed', name: 'On-Site Printing Vehicles', max: 25, ruId: 11, gateAtTotalInstalls: 100, gearKey: 'operationsCompleted', effect: '+3% Cells Gained, per Operation Completed, per crew member' },
    10: { source: 'confirmed', name: 'On-Site GPR Hotspot Scanners', max: 125, ruId: 10, gateAtTotalInstalls: 100, gearKey: 'operationsCompleted', effect: '+0.08% Shards Gained, per Operation Completed, per crew member' },
    11: { source: 'confirmed', name: 'Phylogenetic Analysis', max: 55, ruId: 9, gateAtTotalInstalls: 100, gearKey: 'operationsCompleted', effect: '+0.04% Research Points gained, per Operation Completed, per crew member' },
  },
  6: { // Koios -- ranks up by completing Studies. Unlocks Research Points. Wiki page had no
    // explicit unlock-requirement numbers (different page format from the others) -- gates
    // unconfirmed for this ship. `max` values are the wiki's BASE cap (see nodeMaxLevel).
    1: { source: 'wiki', ruId: 1, name: 'The Venn Hypothesis', max: 250, gearKey: ['studiesThisLR', 'operationsCompleted'], effect: '+0.25% Cells gained, per completed Study & Operation, per crew member' },
    2: { source: 'wiki', ruId: 2, name: 'Unobtanium Drills', max: 5, gearKey: 'studiesThisLR', effect: '+0.003% Shards gained, per Study completed, per crew member' },
    3: { source: 'wiki', ruId: 3, name: 'Modification Thesis', max: 5, gearKey: 'totalCompletedResearch', effect: '+2.5% Mod Points gained, per fully completed Research, per crew member' },
    4: { source: 'wiki', ruId: 4, name: 'The Study of Threesium', max: 5, gearKey: 'researchLevels', effect: '+0.5% MK3 & MK6 outputs, per level in Researches (a maxed Research counts as 3), per crew member' },
    5: { source: 'wiki', ruId: 5, name: 'The Big Brainium Thesis', max: 5, gearKey: 'studiesThisLR', effect: '+0.001% Research Points gained, per Study completed, per crew member' },
    6: { source: 'wiki', ruId: 6, name: 'The Connectivity Thesis', max: 10, effect: '+1% Mod Points & Shards gained, per crew member' },
    7: { source: 'wiki', ruId: 7, name: 'The Overclocking Thesis', max: 10, gearKey: 'studiesThisLR', effect: '+0.1% MK1, MK2, MK3, MK4, MK5, MK6 outputs, per Study completed, per crew member' },
    // Nodes 8-11: `max` corrected 2026-07-31, account-confirmed directly (real caps
    // 300/150/200/750 at 5x). Node 9/11 ruId swapped -- same universal pattern.
    8: { source: 'wiki', ruId: 8, name: 'Modified Portable Arcade', max: 60, effect: '+3% output of all Generators, per crew member' },
    9: { source: 'wiki', ruId: 11, name: 'Improved Mk1 Printing Fuel', max: 30, gearKey: 'studiesThisLR', effect: '+1% Cells gained, per Study completed, per crew member' },
    10: { source: 'wiki', ruId: 10, name: 'Shard Scanning Breakthrough', max: 40, gearKey: 'studiesThisLR', effect: '+0.01% Shards gained, per Study completed, per crew member' },
    11: { source: 'wiki', ruId: 9, name: 'Robo-Research Assistants', max: 150, gearKey: 'studiesThisLR', effect: '+0.02% Research Points gained, per Study completed, per crew member' },
  },
  7: { // Zeus -- ranks up by completing Missions. Unlocks Academy Points / Gear Sets. Wiki page
    // had no explicit unlock-requirement numbers -- gates below are user-confirmed directly
    // (not wiki-sourced): Z1/2/3 open at start, Z4/5 at 2 total installs, Z6/7 at 50, Z8-11 at
    // 100. `max` values are the wiki's BASE cap (see nodeMaxLevel).
    1: { source: 'wiki', ruId: 1, name: 'Academy Janitor Bots', max: 250, gearKey: 'missionsCompleted', effect: '+50% Cells gained, per Mission Completed, per crew member' },
    2: { source: 'confirmed', ruId: 2, name: 'Perfect Student Blueprint', max: 1, effect: '+10% Academy Points gained, per crew member' },
    3: { source: 'confirmed', ruId: 3, name: 'Material Scavenger Vehicles', max: 1, effect: '+25% Mission Materials gained, per crew member' },
    // Node 4/7 `max` corrected 2026-07-31, account-confirmed directly (real caps 75/250 at 5x).
    4: { source: 'confirmed', ruId: 4, name: 'Academy Mining Bots', max: 15, gateAtTotalInstalls: 2, gearKey: 'missionsCompleted', effect: '+0.5% Cells & Shards gained, per Mission Completed, per crew member' },
    5: { source: 'confirmed', ruId: 5, name: 'Database Brain-Link Integration', max: 20, gateAtTotalInstalls: 2, gearKey: 'missionsCompleted', effect: '+0.5% Cells & Research Points gained, per Mission Completed, per crew member' },
    6: { source: 'confirmed', ruId: 6, name: 'Academy Auto-Scrappers', max: 15, gateAtTotalInstalls: 50, effect: '+10% Mission Materials & Mod Points gained, per crew member' },
    7: { source: 'confirmed', ruId: 7, name: 'On-Site Auto Construction', max: 50, gateAtTotalInstalls: 50, effect: '+1% Academy Points gained & All Gens output, per crew member' },
    // Nodes 8-11: `max` corrected 2026-07-31, account-confirmed directly (all four corners cap
    // at 250 at 5x = base 50). Node 9/11 ruId swapped -- same universal pattern.
    8: { source: 'confirmed', ruId: 8, name: 'Remote Printing Facilities', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+1% All Gens output, per Mission Completed, per crew member' },
    9: { source: 'confirmed', ruId: 11, name: 'Academy Flight-Kicks', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+5% Cells gained, per Mission Completed, per crew member' },
    10: { source: 'confirmed', ruId: 10, name: 'Orbital Hotspot Scanner', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+1% Shards gained, per Mission Completed, per crew member' },
    11: { source: 'confirmed', ruId: 9, name: 'Cluster Scans', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+1% Research Points gained, per Mission Completed, per crew member' },
  },
};

// Fleet Boosts: Inscryptions and Loop Mods that directly grant Ship Rank Points and/or Crew
// (or a flat % bonus per rank-up/crew, via `pctEffect`, folded into computeResourceBonuses
// below). Transcribed from cifi.fandom.com/wiki/Inscryptions and /wiki/Loop_Modifications --
// re-surveyed in full (49 Inscryptions, 281 Loop Mods) to confirm every ship/fleet-flavored
// entry is captured, including Cost Modification / Automation Module items which don't affect
// any resource total (no cost/currency model exists in this tool) but are still listed for
// visibility via `note`.
const FLEET_BOOST_ITEMS = [
  // `saveId` = the shared inscryptions.i{n} globalUpgrades key that saveImport.js's
  // FLEET_INSCRYPTION_IDS sweep populates from the save's real `IS{n}Level` field -- Inscription
  // items read/write there (see getBoostLevel/setBoostLevel) instead of the custom
  // fleetBoosts.levels store, so importing a save autofills them exactly like every hunter
  // inscription already does.
  // "Free X Rank-Up" grants a RANK directly (already-applied, permanent) -- distinct from `sp`
  // (an unspent rank POINT still waiting to be spent). Modeled as `rank: 1` per level so it adds
  // straight onto the imported save's Rank the same way `crew` grants add onto Crew, instead of
  // being folded into the "Points available to spend" total where it doesn't belong.
  { key: 'insc48', saveId: 'i48', name: 'Inscryption #48: Free Cradle Rank-Up', source: 'Inscryption', max: 8, ship: 1, grants: [{ ships: [1], rank: 1 }] },
  { key: 'insc49', saveId: 'i49', name: 'Inscryption #49: Free Cradle Crew', source: 'Inscryption', max: 10, ship: 1, grants: [{ ships: [1], crew: 8 }] },
  // #50-68: same max/grant pattern as Cradle's #48/#49, confirmed by the user directly (the
  // wiki's Inscryptions table only documents up to #49 -- it's missing every other ship's pair).
  { key: 'insc50', saveId: 'i50', name: 'Inscryption #50: Free Auxesia Rank-Up', source: 'Inscryption', max: 8, ship: 2, grants: [{ ships: [2], rank: 1 }] },
  { key: 'insc51', saveId: 'i51', name: 'Inscryption #51: Free Auxesia Crew', source: 'Inscryption', max: 10, ship: 2, grants: [{ ships: [2], crew: 8 }] },
  { key: 'insc53', saveId: 'i53', name: 'Inscryption #53: Free Zagreus Rank-Up', source: 'Inscryption', max: 8, ship: 3, grants: [{ ships: [3], rank: 1 }] },
  { key: 'insc54', saveId: 'i54', name: 'Inscryption #54: Free Zagreus Crew', source: 'Inscryption', max: 10, ship: 3, grants: [{ ships: [3], crew: 8 }] },
  { key: 'insc55', saveId: 'i55', name: 'Inscryption #55: Free Hephaestus Rank-Up', source: 'Inscryption', max: 8, ship: 4, grants: [{ ships: [4], rank: 1 }] },
  { key: 'insc56', saveId: 'i56', name: 'Inscryption #56: Free Hephaestus Crew', source: 'Inscryption', max: 10, ship: 4, grants: [{ ships: [4], crew: 8 }] },
  { key: 'insc64', saveId: 'i64', name: 'Inscryption #64: Free Demeter Rank-Up', source: 'Inscryption', max: 8, ship: 5, grants: [{ ships: [5], rank: 1 }] },
  { key: 'insc65', saveId: 'i65', name: 'Inscryption #65: Free Demeter Crew', source: 'Inscryption', max: 10, ship: 5, grants: [{ ships: [5], crew: 8 }] },
  { key: 'insc67', saveId: 'i67', name: 'Inscryption #67: Free Koios Rank-Up', source: 'Inscryption', max: 8, ship: 6, grants: [{ ships: [6], rank: 1 }] },
  { key: 'insc68', saveId: 'i68', name: 'Inscryption #68: Free Koios Crew', source: 'Inscryption', max: 10, ship: 6, grants: [{ ships: [6], crew: 8 }] },
  { key: 'lm_cra_sp', name: 'Cradle Rank Point Transmission', source: 'Loop Mod', max: 50, ship: 1, grants: [{ ships: [1], sp: 1 }] },
  { key: 'lm_aux_sp', name: 'Auxesia Rank Point Transmission', source: 'Loop Mod', max: 50, ship: 2, grants: [{ ships: [2], sp: 1 }] },
  { key: 'lm_zag_sp', name: 'Zagreus Rank Point Transmission', source: 'Loop Mod', max: 50, ship: 3, grants: [{ ships: [3], sp: 1 }] },
  { key: 'lm_hep_sp', name: 'Hephaestus Rank Point Transmission', source: 'Loop Mod', max: 50, ship: 4, grants: [{ ships: [4], sp: 1 }] },
  { key: 'lm_dem_sp', name: 'Demeter Rank Point Transmission', source: 'Loop Mod', max: 50, ship: 5, grants: [{ ships: [5], sp: 1 }] },
  { key: 'lm_koi_sp', name: 'Koios Rank Point Transmission', source: 'Loop Mod', max: 25, ship: 6, grants: [{ ships: [6], sp: 1 }] },
  { key: 'lm_zeus_sp', name: 'Zeus Rank Point Transmission', source: 'Loop Mod', max: 25, ship: 7, grants: [{ ships: [7], sp: 1 }] },
  { key: 'lm_fleet_sp', name: 'Fleet Rank Point Transmissions', source: 'Loop Mod', max: 25, grants: [{ ships: [1, 2, 3, 4, 5, 6, 7], sp: 1 }] },
  { key: 'lm_rule_cradle', name: 'Ultima Loop Mod: Rule of the Cradle', source: 'Loop Mod', max: 7, ship: 1, grants: [{ ships: [1], sp: 8 }], pctEffect: { ships: [1], resource: 'allGens', perLevel: 8, per: 'rank' }, note: "Doesn't count toward rank-up requirement. Also grants +8% All Gens output per Cradle rank-up." },
  { key: 'lm_rule_loyalty', name: 'Ultima Loop Mod: Rule of Loyalty', source: 'Loop Mod', max: 999, grants: [{ ships: [1, 2, 3, 4, 5, 6, 7], sp: 1, crew: 1 }], note: 'Ouroboros excluded. No level cap in-game; neither grant counts toward rank-up requirement.' },
  { key: 'lm_rule_destruction', name: 'Ultima Loop Mod: Rule of Destruction', source: 'Loop Mod', max: 10, grants: [{ ships: [1, 2, 3, 4, 5, 6, 7], sp: 3 }], note: 'Also 2% MP per Player Level, crew costs -1e20, x50 Shards, x3 AP.' },
  { key: 'lm_algd_delta', name: 'Accumulative Level Growth Module Delta', source: 'Loop Mod', max: 10, grants: [{ ships: [1, 2, 5], sp: 3 }], note: 'Also +12%/Player-Level to Cells and +6 flat LP.' },
  { key: 'lm_algd_fenix', name: 'Accumulative Level Growth Module Fenix', source: 'Loop Mod', max: 5, grants: [{ ships: [1, 2, 5], sp: 6 }, { ships: [3, 4, 6], sp: 4 }] },
  // Rank Benefits Modules -- % increase to a specific resource per rank-up, multiplicative.
  { key: 'lm_rb_cra', name: 'Cradle Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 1, grants: [], pctEffect: { ships: [1], resource: 'cells', perLevel: 2.5, per: 'rank' } },
  { key: 'lm_rb_aux', name: 'Auxesia Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 2, grants: [], pctEffect: { ships: [2], resource: 'mk1', perLevel: 0.7, per: 'rank' }, note: 'Applies to MK1, MK2, MK3 & MK4 outputs collectively.' },
  { key: 'lm_rb_zag', name: 'Zagreus Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 3, grants: [], pctEffect: { ships: [3], resource: 'modPoints', perLevel: 2, per: 'rank' } },
  { key: 'lm_rb_hep', name: 'Hephaestus Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 4, grants: [], pctEffect: { ships: [4], resource: 'mk5', perLevel: 3, per: 'rank' } },
  { key: 'lm_rb_dem', name: 'Demeter Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 5, grants: [], pctEffect: { ships: [5], resource: 'shards', perLevel: 2, per: 'rank' } },
  { key: 'lm_rb_koi', name: 'Koios Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 6, grants: [], pctEffect: { ships: [6], resource: 'researchPoints', perLevel: 1, per: 'rank' } },
  { key: 'lm_rb_zeus', name: 'Zeus Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 7, grants: [], pctEffect: { ships: [7], resource: 'missionMaterials', perLevel: 1, per: 'rank' } },
  // Crew Motivation Modules -- % increase to a specific resource per crew member, multiplicative.
  { key: 'lm_cm_cra', name: 'Cradle Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 1, grants: [], pctEffect: { ships: [1], resource: 'mk1', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_aux', name: 'Auxesia Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 2, grants: [], pctEffect: { ships: [2], resource: 'mk2', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_zag', name: 'Zagreus Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 3, grants: [], pctEffect: { ships: [3], resource: 'mk3', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_hep', name: 'Hephaestus Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 4, grants: [], pctEffect: { ships: [4], resource: 'mk4', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_dem', name: 'Demeter Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 5, grants: [], pctEffect: { ships: [5], resource: 'mk5', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_koi', name: 'Koios Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 6, grants: [], pctEffect: { ships: [6], resource: 'researchPoints', perLevel: 2, per: 'crew' } },
  { key: 'lm_cm_zeus', name: 'Zeus Crew Motivation Module', source: 'Loop Mod', max: 10, ship: 7, grants: [], pctEffect: { ships: [7], resource: 'academyPoints', perLevel: 0.5, per: 'crew' } },
  // Cost Modification Modules -- divide crew/evolution/generator costs. No cost model exists
  // in this tool (it works off install budgets, not currency), so these are listed for
  // tracking only, not wired into any calculation.
  { key: 'lm_cost_cra', name: 'Cradle Cost Modification Module', source: 'Loop Mod', max: 200, ship: 1, grants: [], note: 'Divides cost of Cradle crew, evolution, and MK1 generators by 10.' },
  { key: 'lm_cost_aux', name: 'Auxesia Cost Modification Module', source: 'Loop Mod', max: 200, ship: 2, grants: [], note: 'Divides cost of Auxesia crew, evolution, and MK2 generators by 10.' },
  { key: 'lm_cost_zag', name: 'Zagreus Cost Modification Module', source: 'Loop Mod', max: 200, ship: 3, grants: [], note: 'Divides cost of Zagreus crew, evolution, and MK3 generators by 10.' },
  { key: 'lm_cost_hep', name: 'Hephaestus Cost Modification Module', source: 'Loop Mod', max: 200, ship: 4, grants: [], note: 'Divides cost of Hephaestus crew, evolution, and MK4 generators by 10.' },
  { key: 'lm_cost_dem', name: 'Demeter Cost Modification Module', source: 'Loop Mod', max: 200, ship: 5, grants: [], note: 'Divides cost of Demeter crew, evolution, and MK5 generators by 10.' },
  { key: 'lm_cost_koi', name: 'Koios Cost Modification Module', source: 'Loop Mod', max: 200, ship: 6, grants: [], note: 'Divides cost of Koios crew, evolution, and MK6 generators by 10.' },
  { key: 'lm_cost_zeus', name: 'Zeus Cost Modification Module', source: 'Loop Mod', max: 200, ship: 7, grants: [], note: 'Divides cost of Zeus crew, evolution, and MK7 generators by 10.' },
  { key: 'lm_cost_fleet', name: 'Fleet Cost Modification Module', source: 'Loop Mod', max: 200, grants: [], note: 'Divides cost of all ships crew, evolutions, and MK1-7 generators by 100000.' },
];
// Academy Badges / Dark Academy Badges (traded for Innovation/Dark Cores) -- binary
// purchased-or-not toggles that multiply ship rank-install power directly, folded into
// computeResourceBonuses via `computeFleetBadgeMultipliers()` just like Research #78.
// Dark Innovation Badge is still wiki-sourced (cifi.fandom.com/wiki/Dark_Academy_Badges),
// unconfirmed against a live account. Innovation Badge's mult was ALSO wiki-sourced as x3
// (cifi.fandom.com/wiki/Academy_Badges) but corrected to x7 -- account-confirmed directly
// against a real node's in-game "Total Bonus" readout (Cradle's Mitosis Enhancements showed
// x1.23m in-game; this tool's own formula, otherwise matching, only reached x175.30k at x3 --
// x7 closes that exact gap).
const FLEET_BADGE_ITEMS = [
  { key: 'badge_innovation', name: 'Innovation Badge', source: 'Badge', ships: [1, 2, 3, 4], mult: 7, note: 'Cradle, Auxesia, Zagreus & Hephaestus rank installs gain x7 power.' },
  { key: 'badge_dark_innovation', name: 'Dark Innovation Badge', source: 'Badge', ships: [1, 2, 3, 4, 5, 6, 7], mult: 3, note: 'All ship rank installs gain x3 power.' },
];
function defaultFleetBadges() {
  const owned = {};
  FLEET_BADGE_ITEMS.forEach((item) => { owned[item.key] = false; });
  return { owned };
}
function getFleetBadges() {
  if (!window.store) return defaultFleetBadges();
  if (!window.store.fleetBadges || !window.store.fleetBadges.owned) window.store.fleetBadges = defaultFleetBadges();
  return window.store.fleetBadges;
}
// Combined multiplier from owned badges (both stack multiplicatively if owned) -> { [shipId]: mult }
function computeFleetBadgeMultipliers() {
  const badges = getFleetBadges();
  const mults = {};
  FLEET_BADGE_ITEMS.forEach((item) => {
    if (!badges.owned[item.key]) return;
    item.ships.forEach((shipId) => { mults[shipId] = (mults[shipId] || 1) * item.mult; });
  });
  return mults;
}
function defaultFleetBoosts() {
  const levels = {};
  FLEET_BOOST_ITEMS.forEach((item) => { levels[item.key] = 0; });
  return { levels };
}
function getFleetBoosts() {
  if (!window.store) return defaultFleetBoosts();
  if (!window.store.fleetBoosts || !window.store.fleetBoosts.levels) window.store.fleetBoosts = defaultFleetBoosts();
  return window.store.fleetBoosts;
}
// Inscription items store their level under the SAME globalUpgrades key the real save's
// generic inscryptions.i{n} import already populates (see FLEET_INSCRYPTION_IDS in
// saveImport.js) -- so importing a save autofills them exactly like every hunter inscription.
// Loop Mod items have no confirmed save field for loop-mod levels yet, so they still fall back
// to the tool's own custom fleetBoosts.levels store (manual entry only).
function getBoostLevel(item) {
  if (item.source === 'Inscryption' && item.saveId && window.store) {
    return window.store.globalUpgrades?.[`inscryptions.${item.saveId}`] || 0;
  }
  return getFleetBoosts().levels[item.key] || 0;
}
function setBoostLevel(item, v) {
  const clamped = Math.max(0, Math.min(item.max, v));
  if (item.source === 'Inscryption' && item.saveId && window.store) {
    if (!window.store.globalUpgrades) window.store.globalUpgrades = {};
    window.store.globalUpgrades[`inscryptions.${item.saveId}`] = clamped;
  } else {
    getFleetBoosts().levels[item.key] = clamped;
  }
}
// Sums every Fleet Boost item's grants at its current level -> { [shipId]: { sp, crew, rank } }.
function computeFleetBoostTotals() {
  const totals = {};
  FLEET_BOOST_ITEMS.forEach((item) => {
    const level = getBoostLevel(item);
    if (!level) return;
    item.grants.forEach((grant) => {
      grant.ships.forEach((shipId) => {
        if (!totals[shipId]) totals[shipId] = { sp: 0, crew: 0, rank: 0 };
        totals[shipId].sp += (grant.sp || 0) * level;
        totals[shipId].crew += (grant.crew || 0) * level;
        totals[shipId].rank += (grant.rank || 0) * level;
      });
    });
  });
  return totals;
}
// Every Fleet Boost item's pctEffect at its current level for one ship -> { [resource]: multiplier }
// `per: 'rank'` scales by that ship's rank-up count (input.rank); `per: 'crew'` by its crew
// count (base + boost grants). Each item's own % converts to its own (1 + pct/100) multiplier and
// multiplies into the resource's running total -- see computeResourceBonuses for why (matches how
// node effects now combine too).
function computeFleetPctBonuses(shipId) {
  const input = getShipInput(shipId);
  const boostTotals = computeFleetBoostTotals()[shipId];
  const crew = (input.crew || 0) + (boostTotals?.crew || 0);
  const rank = (input.rank || 0) + (boostTotals?.rank || 0);
  const mults = {};
  FLEET_BOOST_ITEMS.forEach((item) => {
    if (!item.pctEffect) return;
    const level = getBoostLevel(item);
    if (!level || !item.pctEffect.ships.includes(shipId)) return;
    const scale = item.pctEffect.per === 'crew' ? crew : rank;
    const pct = item.pctEffect.perLevel * level * scale;
    if (!pct) return;
    const res = item.pctEffect.resource;
    mults[res] = (mults[res] || 1) * additiveToMultiplier(pct);
  });
  return mults;
}

// Ship display names + portrait assets (canonical order 1-7; Ship8 is a special/later ship
// not covered by the wiki's ship list -- seen in-game as "The Ouroboros").
// NOTE: in-game ship names/portraits appear to cycle across Ouroboros constructions -- these
// are the wiki's canonical names, used as the default label, not a guarantee of what a given
// account currently shows.
const SHIP_NAMES = { 1: 'Cradle', 2: 'Auxesia', 3: 'Zagreus', 4: 'Hephaestus', 5: 'Demeter', 6: 'Koios', 7: 'Zeus', 8: 'Ouroboros' };
const SHIP_PORTRAITS = { 1: 'cradle', 2: 'auxesia', 3: 'zagreus', 4: 'hephaestus', 5: 'demeter', 6: 'koios', 7: 'zeus', 8: 'ouroboros' };
// What each ship actually ranks up by, per cifi.fandom.com's ship pages -- drives the Ship
// Setup page's "progress toward next rank" field label.
const SHIP_RANKUP_METRIC = { 1: 'Generators Purchased', 3: 'Loops Filled', 4: 'Cells Accumulated', 5: 'Operations Completed', 6: 'Studies Completed', 7: 'Missions Completed' };
// Community shorthand prefix for install codes (e.g. "CRA1", "DEM8") -- matches
// cifi.fandom.com's per-ship pages and the Gear Sets table.
const SHIP_CODE_PREFIX = { 1: 'CRA', 2: 'AUX', 3: 'ZAG', 4: 'HEP', 5: 'DEM', 6: 'KOI', 7: 'ZEUS' };
// Real node icon assets, downloaded from cifi.fandom.com's per-ship pages (webapp/public/
// assets/nodes/{CODE}.png, e.g. CRA1.png, DEM8.png). Koios/Zeus/Ouroboros have no wiki
// assets -- those paths 404 and the <img onerror> falls back to a plain tile.
function nodeIconPath(shipId, code) {
  const prefix = SHIP_CODE_PREFIX[shipId];
  return prefix ? `assets/nodes/${prefix}${code}.png` : null;
}

// Which global RU registry category (see shipSchema.js) each ship's 11-slot grid reads from.
// Confirmed for ships 1 and 5 via live diffs. Ships 2-4,6,7 are guesses based on process of
// elimination + thematic fit with their wiki node names -- NOT yet confirmed via a diff.
const SHIP_CATEGORY = { 1: 'Gen', 2: 'Tech', 3: 'Loop', 4: 'Auto', 5: 'Shard', 6: 'Research', 7: 'Academy' };

// Rows as tapped on the real in-game grid while diffing Ship1/Ship5 -- an 11-node 4/3/4
// honeycomb (row 1 = grid positions 1-4, row 2 staggered = 5-7, row 3 = 8-11). GRID_TO_CODE
// maps each physical grid position to its SHIP_NODE_CATALOG code number; derived from the
// Ship1 AND Ship5 diffs independently producing the exact same permutation (matched by
// cross-referencing each grid position's measured name+gate against the wiki's code+gate),
// so it's applied to every ship rather than re-deriving per-ship.
const SHIP_GRID_ROWS = [[1, 2, 3, 4], [5, 6, 7], [8, 9, 10, 11]];
const GRID_TO_CODE = [8, 4, 6, 9, 2, 1, 3, 10, 7, 5, 11];
const CODE_TO_GRID = Object.fromEntries(GRID_TO_CODE.map((code, i) => [code, i + 1]));

// MK9/MK10 are real, confirmed-to-exist generator tiers beyond the base 8 -- the save schema
// already has CellGeneratorsMK9Level/MK10Level fields (also MK11/12, but nothing found ties
// those to any reachable content yet, so they're left out for now). Unlocking them is gem-gated
// (Ouroboros Gems Collection), but no wiki/community source states the exact level/gem
// requirement -- the wiki's own Evolution gem entry (the tree that grants "+All Generators
// Output", thematically the most likely candidate) is marked "Currently unattainable" even by
// documented players, meaning nobody's confirmed it publicly yet. Rather than guess a gating
// rule, MK9/10 are wired in as ordinary entries in the existing "Unlocked Generator Tiers"
// checklist (Ship Setup page) -- manually toggled off by default, and auto-imported from the
// save's real MK9UnlockedBool/MK10UnlockedBool fields once you do unlock them (that import path
// already read up to MK12 -- see mapSaveToUnlockedGens in shipSchema.js -- it just had nothing
// past MK8 to write into before now).
const GEN_TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// SHIP_NODE_CATALOG's `max` fields store the WIKI BASE level cap (confirmed against
// cifi.fandom.com's per-ship pages 2026-07-30) -- NOT the researched value. Research #68 "Fleet
// Analysis 1" tier 1 ("All Rank Installs Max LV x5") multiplies EVERY ship's install caps by 5
// account-wide once researched. An earlier version of this catalog baked live-captured max
// values in directly instead, which silently mixed base and x5'd numbers depending on whether
// the specific account/ship being diffed had that research at the time -- inconsistent by
// construction (some nodes correctly 5x, others accidentally 10x/50x, others still at 1x).
// getFleetResearch/computeFleetResearchShipMultipliers are defined further down (hoisted).
function installCapMultiplier() {
  return (getFleetResearch().levels.fleetAnalysis1 || 0) >= 1 ? 5 : 1;
}
function nodeMaxLevel(shipId, slot) {
  const base = SHIP_NODE_CATALOG[shipId]?.[slot]?.max || 0;
  return base * installCapMultiplier();
}

// ---- Resource-bonus aggregation (rough, visuals-first -- see effectResources/gearMultiplierFor
// notes) ----
const RESOURCE_KEYWORDS = [
  ['cells', /cells/i], ['shards', /shards/i], ['researchPoints', /research points/i],
  ['modPoints', /mod points/i], ['academyPoints', /academy points/i], ['missionMaterials', /mission materials/i],
];
// Tags a node's effect text with every resource/generator-tier it touches. A node can list
// MULTIPLE things (e.g. "Cells & Research Points gained") or a specific MK range
// ("MK1-MK4 output") -- all matches get the same per-level percentage from that one node.
function effectResources(effect) {
  const tags = RESOURCE_KEYWORDS.filter(([, re]) => re.test(effect)).map(([r]) => r);
  if (/all generators|all gens\b/i.test(effect)) tags.push('allGens');
  const mkRange = effect.match(/mk\s?(\d)(?:\s?[-–&](?:\s?mk\s?)?(\d))?/i);
  if (mkRange) {
    const start = parseInt(mkRange[1], 10);
    const end = mkRange[2] ? parseInt(mkRange[2], 10) : start;
    for (let i = start; i <= end && i <= 12; i++) tags.push(`mk${i}`);
  }
  // Tech Software/Hardware Upgrade OUTPUT nodes (Auxesia 1/2, Hephaestus 2's "Software & Hardware
  // Tech Upgrades" combined wording) aren't a final resource at all -- boosting their "output"
  // means your Tech Upgrade COUNT itself compounds faster over time, which several OTHER
  // Auxesia nodes then convert into Cells/Shards/RP ("+X%, per Tech Upgrade currently
  // purchased"). That's structurally the same role a generator tier plays for Cells -- an
  // intermediate pool that compounds before feeding a final resource -- so these get tracked
  // and Meltdown-melted the same way generator tiers are, instead of falling through to the
  // untracked/uninvested 'other' bucket.
  if (/tech (software|hardware) upgrades|software\s*&\s*hardware tech upgrades|hardware\s*&\s*software tech upgrades/i.test(effect)) {
    if (/hardware/i.test(effect)) tags.push('techHardware');
    if (/software/i.test(effect)) tags.push('techSoftware');
  }
  if (!tags.length) tags.push('other');
  return tags;
}
const TECH_UPGRADE_TAGS = ['techSoftware', 'techHardware'];
const RESOURCE_LABELS = {
  cells: 'Cells', allGens: 'All Gens', shards: 'Shards', researchPoints: 'Research Points', modPoints: 'Mod Points',
  academyPoints: 'Academy Points', missionMaterials: 'Mission Materials', other: 'Tech Bonuses',
  techSoftware: 'Tech Software Output', techHardware: 'Tech Hardware Output',
  ...Object.fromEntries(GEN_TIERS.map((n) => [`mk${n}`, `MK${n}`])),
};
// Fixed display order for the fleet totals readout -- Cells, All Gens, then generator tiers
// in numeric order, then the rest -- instead of sorting by magnitude (which scattered MK
// tiers out of order and made the readout hard to scan).
const RESOURCE_ORDER = ['cells', 'allGens', ...GEN_TIERS.map((n) => `mk${n}`), 'techSoftware', 'techHardware', 'shards', 'researchPoints', 'modPoints', 'academyPoints', 'missionMaterials', 'other'];
function sortResourceEntries(totals) {
  return Object.entries(totals).sort((a, b) => RESOURCE_ORDER.indexOf(a[0]) - RESOURCE_ORDER.indexOf(b[0]));
}

// Account-wide progression counters that scale a node's "per X" qualifier -- entered per-ship
// on the Ship Setup modal (NOT a generic account-wide pool: each ship's nodes only reference
// ITS OWN specific counters, e.g. Cradle's nodes never care about Missions Completed). Each
// node in SHIP_NODE_CATALOG names its counter directly via `gearKey` (a few nodes need two
// counters summed together, e.g. Koios node 1 wants Studies+Operations combined -- `gearKey` is
// an array there). Replaces an earlier regex-matched-on-effect-text version that couldn't tell
// "manually purchased MK2 Generator" apart from "MK3 Generator" or "manual generator" (all three
// matched the same regex and silently shared one counter) -- see SHIP_GEAR_FIELDS below for the
// full per-ship field list + labels shown on the Ship Setup modal.
// NOTE: these are NOT "Gear" -- Gear (see renderGearSetsPage) is the separate Academy-Points-
// crafted equipment system with its own per-color set bonuses and per-piece install buffs.
function gearMultiplierFor(gearKey, gear) {
  if (!gearKey) return 1;
  if (Array.isArray(gearKey)) return gearKey.reduce((sum, k) => sum + (gear[k] || 0), 0);
  return gear[gearKey] || 0;
}

// WITHIN one node, going up a level is confirmed linear/additive (c = 1 + level*a*b/100, a =
// %-per-level, b = crew * gear qualifier count) -- verified three times against real account
// data: the wiki's own documented per-level improvement curve (100%, 50%, 33.33%, 25%... i.e.
// exactly 1/(L-1), which only falls out of a pure linear total) and two live screenshot matches
// on Cradle's Mitosis Enhancements (level 18 -> x1.23m, level 19 -> x1.30m). ACROSS different
// nodes/ships/Fleet-Boost-items feeding the SAME resource, combination is multiplicative, not
// additive: every bonus card the game shows displays an "x" multiplier, never a "+" percentage,
// and the wiki's Calculations page states the game's default is "all percentage-based bonuses
// are multiplicative when stacked, unless told otherwise" (no ship-install node is marked
// "(additive)" in its own effect text). This is an inference from those two signals, not a
// live cross-source diff (the game doesn't expose a combined-total display to diff against) --
// treat it at the same confidence tier as a `source: 'wiki'` catalog entry, not `'confirmed'`.
// A single node's own contribution at a given level, in raw %/100 terms (not yet converted to a
// multiplier) -- computeResourceBonuses converts THIS to its own (1+pct/100) factor before
// multiplying it in; factored out separately so the node's OWN tooltip can show its real "Total
// Bonus" (the same value the in-game upgrade detail panel shows for that one node) without
// duplicating the crew/gear/research/badge math in two places.
function nodeOwnBonusPct(shipId, slot, level) {
  const meta = SHIP_NODE_CATALOG[shipId]?.[slot];
  if (!meta || !level) return 0;
  const m = meta.effect.match(/([\d.]+)%/);
  if (!m) return 0;
  const gear = getShipGear();
  const crew = (getShipInput(shipId).crew || 0) + (computeFleetBoostTotals()[shipId]?.crew || 0);
  const gearMult = gearMultiplierFor(meta.gearKey, gear);
  const badgeMult = computeFleetBadgeMultipliers()[shipId] || 1;
  const researchMult = (computeFleetResearchShipMultipliers()[shipId] || 1) * badgeMult;
  const gearNodeMult = computeGearNodeMultiplier(Number(shipId), Number(slot));
  return parseFloat(m[1]) * level * crew * gearMult * researchMult * gearNodeMult;
}
// Returns { [resource]: multiplier } for one ship -- every node's own (1+pct/100) factor
// multiplies directly into the running per-resource total (see the note above nodeOwnBonusPct
// for why this is multiplicative, not additive, across different nodes/items).
function computeResourceBonuses(shipId, levels) {
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  const mults = {};
  Object.entries(levels || {}).forEach(([slot, lvl]) => {
    if (!lvl) return;
    const meta = catalog[slot];
    if (!meta) return;
    const pct = nodeOwnBonusPct(shipId, slot, lvl);
    if (!pct) return;
    const factor = additiveToMultiplier(pct);
    effectResources(meta.effect).forEach((res) => { mults[res] = (mults[res] || 1) * factor; });
  });
  // Fleet Boost items with a pctEffect (Rank Benefits / Crew Motivation Modules, Rule of the
  // Cradle) grant a flat % to one specific resource, independent of install levels -- each
  // item's own factor multiplies into the same per-resource totals as the nodes above.
  mergeResourceTotals(mults, computeFleetPctBonuses(shipId));
  // Gear Set piece-owned flat multipliers (x25 Shards etc, see computeGearSetBonusMultipliers)
  // are a multiplier on the FINAL resource total across the whole fleet, not a per-ship
  // contribution -- applied once at the Fleet page's grand-total display instead of per-ship
  // here, same as before.
  return mults;
}

// Combines multiple { [resource]: multiplier } maps by multiplying matching keys together (see
// the note above nodeOwnBonusPct for why cross-source combination is multiplicative).
function mergeResourceTotals(target, add) {
  Object.entries(add).forEach(([k, v]) => { target[k] = (target[k] || 1) * v; });
  return target;
}

// c = 1 + (additive total / 100) -- the game rounds to 2 decimal places when it displays this.
function additiveToMultiplier(additivePct) { return 1 + additivePct / 100; }
// Ship/gear bonuses can run just as huge as hunter-side costs (gear at high level, badges +
// research stacking multiplicatively) -- use the SAME k/m/b/t/... suffix notation the real
// game itself uses for big numbers (CostFormulas.fmtBig, a verbatim port of the live bundle's
// own formatter) instead of scientific notation, for consistency across every page. Below
// 1000 it still needs more than 2 decimals for tiny bonuses (fmtBig floors those to "1.00",
// same misleading "looks like zero" problem toFixed(2) had) -- scale precision there instead.
function formatMult(x) {
  if (x >= 1000) return window.CostFormulas ? window.CostFormulas.fmtBig(x) : x.toExponential(2).replace('e+', 'e');
  if (x >= 10) return x.toFixed(1);
  if (x >= 1.01) return x.toFixed(2);
  return x.toFixed(4);
}

function shipDisplayName(n) { return SHIP_NAMES[n] || `Ship ${n}`; }

// ---- Store accessors ----
function getShipStore() { return (window.store && window.store.ships) || {}; }

function defaultShipInput(shipId) {
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  const installs = {};
  Object.keys(catalog).forEach((slot) => { installs[slot] = 0; });
  return { rank: 0, crew: 0, evo: 0, rankPoints: 0, installs };
}
function getShipInput(shipId) {
  if (!window.store) return defaultShipInput(shipId);
  if (!window.store.shipInputs) window.store.shipInputs = {};
  if (!window.store.shipInputs[shipId]) window.store.shipInputs[shipId] = defaultShipInput(shipId);
  return window.store.shipInputs[shipId];
}
// Unlocked Generator Tiers is a GLOBAL flag (MK{n}UnlockedBool in the save) -- ONE value for
// the whole account, not something each ship asks for separately. Shown once on the Fleet page.
function defaultUnlockedGens() {
  const g = {};
  GEN_TIERS.forEach((n) => { g[n] = n === 1; });
  return g;
}
function getUnlockedGens() {
  if (!window.store) return defaultUnlockedGens();
  if (!window.store.unlockedGens || !Object.keys(window.store.unlockedGens).length) window.store.unlockedGens = defaultUnlockedGens();
  return window.store.unlockedGens;
}
// Generator tiers unlock strictly in order in the real game -- you can't have MK6 without
// MK1-5, and you can't drop MK4 while keeping MK5+ (it'd just re-unlock next sync anyway).
// Checking a tier force-unlocks every tier below it; unchecking one force-locks every tier at
// or above it.
function setUnlockedGenTier(unlockedGens, n, checked) {
  GEN_TIERS.forEach((tier) => {
    if (checked && tier <= n) unlockedGens[tier] = true;
    if (!checked && tier >= n) unlockedGens[tier] = false;
  });
}
// Which "per X" counters each ship's OWN nodes reference (see SHIP_NODE_CATALOG's gearKey
// fields) -- shown as that ship's "Progression Counters" section on its Ship Setup modal.
// totalManualGens is shared by Cradle+Hephaestus (same underlying save stat, ManualGensAllTime)
// and operationsCompleted is shared by Demeter+Koios (NewSMOperationsAllTime) -- editing either
// ship's copy of a shared field updates the same store value.
const SHIP_GEAR_FIELDS = {
  1: [['manualMK2Gens', 'Manually Purchased MK2 Generators'], ['manualMK3Gens', 'Manually Purchased MK3 Generators'], ['totalManualGens', 'Total Manually Purchased Generators']],
  2: [['techUpgrades', 'Tech Upgrades Purchased (combined)'], ['hardwareUpgrades', 'Hardware Upgrades Purchased'], ['softwareUpgrades', 'Software Upgrades Purchased']],
  3: [['loopModsOwned', 'Loop Mods Owned'], ['loopFillsThisRun', 'Loop Fills This Run'], ['loopResetsDone', 'Loop Resets Done']],
  4: [['automationsUnlocked', 'Automations Unlocked'], ['ticksThisLoop', 'Ticks This Loop'], ['totalManualGens', 'Total Manually Purchased Generators']],
  5: [['operationsCompleted', 'Operations Completed']],
  6: [['operationsCompleted', 'Operations Completed'], ['studiesThisLR', 'Studies This Loop Reset'], ['researchLevels', 'Research Levels'], ['totalCompletedResearch', 'Total Completed Research']],
  7: [['missionsCompleted', 'Missions Completed']],
};
function defaultShipGear() {
  return {
    manualMK2Gens: 0, manualMK3Gens: 0, totalManualGens: 0, techUpgrades: 0, hardwareUpgrades: 0, softwareUpgrades: 0,
    loopModsOwned: 0, loopFillsThisRun: 0, loopResetsDone: 0, automationsUnlocked: 0, ticksThisLoop: 0,
    operationsCompleted: 0, studiesThisLR: 0, researchLevels: 0, totalCompletedResearch: 0, missionsCompleted: 0,
    meltdown: 0, focusWeights: { cells: 5, shards: 5, researchPoints: 5, modPoints: 5, missionMaterials: 5, academyPoints: 5 },
  };
}
function getShipGear() {
  if (!window.store) return defaultShipGear();
  if (!window.store.shipGear || !Object.keys(window.store.shipGear).length) window.store.shipGear = defaultShipGear();
  // Migrate any account still on the old flat/wrong-grained counter set (pre-restructure) --
  // drop the stale keys, backfill any new ones this account hasn't seen yet.
  const defaults = defaultShipGear();
  Object.keys(defaults).forEach((k) => { if (!(k in window.store.shipGear)) window.store.shipGear[k] = defaults[k]; });
  Object.keys(defaults.focusWeights).forEach((k) => { if (!(k in window.store.shipGear.focusWeights)) window.store.shipGear.focusWeights[k] = defaults.focusWeights[k]; });
  return window.store.shipGear;
}

// Gear Sets: the real data, transcribed verbatim from cifi.fandom.com/wiki/Gear_Sets. Each
// piece has TWO install targets (per-ship code numbers, matching SHIP_NODE_CATALOG's keys):
// its own level buffs Install 1 by x1.01/level and Install 2 by x1.02/level, MULTIPLICATIVELY
// against that ONE node's own contribution (see computeGearNodeMultiplier, wired into
// computeResourceBonuses). Each piece's own Set Bonus activates once that piece is owned (see
// computeGearSetBonusMultipliers) -- not per-color, since pieces sharing a color have distinct
// bonus text.
// ship id lookup for the wiki's shorthand prefixes (note: the Gear Sets page uses "HEPH" for
// Hephaestus while the ship's own page uses "HEP" -- both aliased here).
const GEAR_SHIP_PREFIX_TO_ID = { CRA: 1, AUX: 2, ZAG: 3, HEP: 4, HEPH: 4, DEM: 5, KOI: 6, ZEUS: 7 };
function parseInstallCode(code) {
  const m = code.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { ship: GEAR_SHIP_PREFIX_TO_ID[m[1]], code: Number(m[2]) };
}
const REAL_GEAR_PIECES = [
  { name: 'Oceanic Specimen', color: 'Purple', setBonus: 'x25 Shards Gained', install1: 'KOI6', install2: 'DEM2' },
  { name: 'Venomous Specimen', color: 'Purple', setBonus: 'x999 Cells Gained', install1: 'KOI4', install2: 'HEPH3' },
  { name: 'Curious Specimen', color: 'Purple', setBonus: 'x25 Research Points Gained', install1: 'KOI5', install2: 'AUX6' },
  { name: 'Terran Fuel Cell', color: 'Orange', setBonus: 'x1.5 Academy Points Gained', install1: 'KOI7', install2: 'AUX5' },
  { name: 'Diamond Infused Cell', color: 'Orange', setBonus: 'Gain 3000 Diamonds', install1: 'KOI3', install2: 'AUX4' },
  { name: 'Ceti-Powered Energy Cell', color: 'Orange', setBonus: 'x7 Research Points Gained', install1: 'KOI6', install2: 'AUX1' },
  { name: 'Ixion Infused Cell', color: 'Orange', setBonus: 'x7 Shards Gained', install1: 'KOI2', install2: 'AUX3' },
  { name: 'Cell Based Loop Tank', color: 'Red', setBonus: 'x75 Cells Gained', install1: 'HEPH1', install2: 'ZAG3' },
  { name: 'Field Hard Drive', color: 'Red', setBonus: 'x2 Research Points Gained', install1: 'DEM1', install2: 'ZAG4' },
  { name: 'Gravity Bomb', color: 'Red', setBonus: 'x1.5 Academy Points Gained', install1: 'ZAG2', install2: 'ZAG5' },
  { name: 'Gamma Round', color: 'Red', setBonus: 'x60 Cells Gained', install1: 'ZAG7', install2: 'ZAG1' },
  { name: 'Loop Gun', color: 'Red', setBonus: 'x10 Mod Points Gained', install1: 'DEM6', install2: 'ZAG6' },
  { name: 'Cell Battery', color: 'Green', setBonus: 'x500 Cells Gained', install1: 'CRA1', install2: 'HEPH5' },
  { name: 'Constructor Suit', color: 'Green', setBonus: 'x2.5 Mod Points Gained', install1: 'ZAG2', install2: 'HEPH6' },
  { name: 'Research Supplies', color: 'Green', setBonus: 'x8 Research Points Gained', install1: 'KOI5', install2: 'HEPH1' },
  { name: 'Cell Gun', color: 'Green', setBonus: 'x1.5 Academy Points Gained', install1: 'DEM6', install2: 'HEPH7' },
  { name: 'Drone Shield', color: 'Green', setBonus: 'x750 Cells Gained', install1: 'HEPH4', install2: 'HEPH2' },
  { name: 'Scout Droid', color: 'Blue', setBonus: 'x10 Research Points Gained', install1: 'AUX2', install2: 'DEM3' },
  { name: 'Mining Drone', color: 'Blue', setBonus: 'x15 Shards Gained', install1: 'DEM2', install2: 'DEM1' },
  { name: 'Chrysis Suit', color: 'Blue', setBonus: 'x320 Cells Gained', install1: 'HEPH5', install2: 'DEM4' },
  { name: 'Beta-Rounds', color: 'Blue', setBonus: 'x80 Cells Gained', install1: 'HEPH3', install2: 'DEM7' },
  { name: 'Shard Gun', color: 'Blue', setBonus: 'x1.5 Academy Points Gained', install1: 'DEM6', install2: 'DEM5' },
];
function defaultGearSets() {
  return { pieces: REAL_GEAR_PIECES.map((p) => ({ ...p, level: 0, owned: false })) };
}
function getGearSets() {
  if (!window.store) return defaultGearSets();
  if (!window.store.gearSets || !('pieces' in window.store.gearSets)) window.store.gearSets = defaultGearSets();
  return window.store.gearSets;
}
// A gear piece's own level buffs its 2 target installs MULTIPLICATIVELY (x1.01/level for
// install1, x1.02/level for install2) -- this multiplies that ONE node's own contribution
// before it's added into the resource totals, not the resource total as a whole. Returns the
// combined multiplier for one ship/slot (product across every piece that targets it).
function computeGearNodeMultiplier(shipId, slot) {
  const gearSets = getGearSets();
  let mult = 1;
  gearSets.pieces.forEach((p) => {
    if (!p.level) return;
    const i1 = parseInstallCode(p.install1);
    const i2 = parseInstallCode(p.install2);
    if (i1 && i1.ship === shipId && i1.code === slot) mult *= Math.pow(1.01, p.level);
    if (i2 && i2.ship === shipId && i2.code === slot) mult *= Math.pow(1.02, p.level);
  });
  return mult;
}
// Each piece's own Set Bonus (e.g. "x25 Shards Gained") activates once THAT piece is owned --
// confirmed per-piece, not per-color: pieces sharing a color have distinct bonus text (e.g.
// Purple's 3 pieces grant x25 Shards / x999 Cells / x25 Research Points respectively), so this
// cannot be "one shared bonus once the whole color is complete." A flat multiplier on top of
// the whole resource total, independent of install level. Returns { [resource]: multiplier }
// (multiple owned pieces hitting the same resource stack multiplicatively). Non-resource
// bonuses (flat Diamond grants) aren't tracked -- no Diamond total exists in this tool.
function computeGearSetBonusMultipliers() {
  const gearSets = getGearSets();
  const mults = {};
  gearSets.pieces.forEach((p) => {
    if (!p.owned) return;
    const m = p.setBonus.match(/^x([\d.]+)\s+(.+?)\s+Gained$/i);
    if (!m) return;
    const resources = effectResources(m[2]);
    resources.forEach((res) => { mults[res] = (mults[res] || 1) * parseFloat(m[1]); });
  });
  return mults;
}

// `cats` is an object of booleans, one per granular import category (see IMPORT_SHIP_CATEGORIES
// below) -- every piece here used to be a single all-or-nothing call, bundling things like Ship
// Ranks/Installs, Gear Sets, Academy Badges, and Fleet Research together with no way to import
// just one. Omit `cats` (or pass nothing truthy) to apply nothing -- callers must opt in per
// piece, same convention as the rest of the checklist-driven import.
window.applyImportedShipData = function applyImportedShipData(save, cats = {}) {
  if (!window.store) return;
  if (cats.shipRanks) {
    window.store.ships = window.mapCifiSaveToShips(save);
    window.store.researchUnits = window.mapCifiSaveToResearchUnits(save);
  }
  if (cats.unlockedGens) {
    Object.assign(getUnlockedGens(), window.mapCifiSaveToUnlockedGens(save));
  }
  if (cats.shipGear) {
    // Fleet Stats & Meltdown have no existing "raw store + manual Autofill button" step like
    // Ship Setup does -- applied straight into the live editable store on import, per-field, so
    // a value this save doesn't confirm (loopMods, studiesCompleted) is left as whatever the
    // user already had instead of being zeroed out.
    const gearUpdates = window.mapCifiSaveToShipGear(save);
    Object.assign(getShipGear(), gearUpdates);
  }
  if (cats.fleetResearch) {
    // Fleet Analysis 1/2 (Research #68/#78) -- direct field match, RU{68,78}Level.
    const research = getFleetResearch();
    if (save.RU68Level !== undefined) research.levels.fleetAnalysis1 = realNum(save.RU68Level);
    if (save.RU78Level !== undefined) research.levels.fleetAnalysis2 = realNum(save.RU78Level);
  }
  if (cats.gearSets) {
    const gearLevels = window.mapCifiSaveToGearLevels(save);
    const gearSets = getGearSets();
    const seenPerColor = {};
    gearSets.pieces.forEach((p) => {
      seenPerColor[p.color] = (seenPerColor[p.color] || 0) + 1;
      const level = gearLevels[`${p.color}${seenPerColor[p.color]}`];
      if (level != null) { p.level = level; p.owned = level > 0; }
    });
  }
  if (cats.fleetBadges) {
    Object.assign(getFleetBadges().owned, window.mapCifiSaveToFleetBadges(save));
  }
  window.saveStore();
};

// Copies real account state (rank/crew/evo/rank points + confirmed RU-registry levels) into
// the editable Ship Setup baseline for one ship, or all ships if shipId omitted.
function autofillShipInputFromSave(shipId) {
  const ships = getShipStore();
  const rus = (window.store && window.store.researchUnits) || {};
  const ids = shipId ? [shipId] : Object.keys(ships);
  ids.forEach((id) => {
    const rec = ships[id];
    if (!rec) return;
    const input = getShipInput(id);
    const category = SHIP_CATEGORY[id];
    input.rank = rec.rank;
    input.crew = rec.crewLevel;
    input.evo = rec.evoLevel;
    input.rankPoints = rec.rankPoints;
    const catalog = SHIP_NODE_CATALOG[id] || {};
    Object.keys(catalog).forEach((slot) => {
      const meta = catalog[slot];
      const real = (meta.ruId != null && category) ? rus[meta.ruId]?.categoryLevels?.[category] : undefined;
      if (real != null) input.installs[slot] = real;
    });
  });
  window.saveStore();
}

// ============================= Ship Setup page (sidebar) =============================
function renderShipSetupPage(root) {
  const ships = getShipStore();
  root.innerHTML = `
    <div class="mb-4 rounded-lg overflow-hidden shadow-lg">
      <div class="bg-gradient-to-r from-blue-900 to-gray-800 px-5 py-4 border-b border-gray-600 flex items-center justify-between">
        <div><h1 class="text-xl font-bold">Ship Setup</h1><p class="text-xs text-gray-300 mt-0.5">Your fleet's current real state -- the Fleet optimizer starts planning from here. Check "Fleet / Ship Setup" in Import Save to autofill this from your save.</p></div>
      </div>
      <div class="bg-gray-800/70 px-5 py-2.5 flex items-center gap-2 flex-wrap">
        <span class="text-xs text-gray-400 flex-shrink-0">Unlocked Generator Tiers</span>
        <div id="shipSetupPageUnlockedGens" class="flex gap-1 flex-wrap"></div>
      </div>
    </div>
    <div class="grid gap-3" id="shipSetupList" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));"></div>`;

  const unlockedGens = getUnlockedGens();
  const gensEl = document.getElementById('shipSetupPageUnlockedGens');
  gensEl.innerHTML = GEN_TIERS.map((n) => `
    <label class="flex items-center gap-1 px-2 py-0.5 bg-gray-700 rounded text-xs text-gray-300 cursor-pointer">
      <input type="checkbox" data-gen="${n}" ${unlockedGens[n] ? 'checked' : ''} class="accent-blue-500" /> MK${n}
    </label>`).join('');
  gensEl.querySelectorAll('input[data-gen]').forEach((cb) => {
    cb.addEventListener('change', () => {
      setUnlockedGenTier(unlockedGens, Number(cb.dataset.gen), cb.checked);
      window.saveStore();
      renderShipSetupPage(root);
    });
  });

  const boostTotals = computeFleetBoostTotals();
  const listEl = document.getElementById('shipSetupList');
  for (let n = 1; n <= 8; n++) {
    const rec = ships[n];
    const input = getShipInput(n);
    const portrait = SHIP_PORTRAITS[n];
    const spent = Object.values(input.installs).reduce((a, b) => a + b, 0);
    const boost = boostTotals[n];
    const researchSp = computeFleetResearchSp();
    const totalSp = input.rankPoints + (boost?.sp || 0) + researchSp;
    const totalCrew = input.crew + (boost?.crew || 0);
    const totalRank = input.rank + (boost?.rank || 0);
    const pointsLabel = totalSp !== input.rankPoints ? `${totalSp} <span class="text-gray-500">(${input.rankPoints})</span>` : input.rankPoints;
    const crewLabel = totalCrew !== input.crew ? `${totalCrew} <span class="text-gray-500">(${input.crew})</span>` : input.crew;
    const rankLabel = totalRank !== input.rank ? `${totalRank} <span class="text-gray-500">(${input.rank})</span>` : input.rank;
    const card = document.createElement('div');
    card.className = `bg-gray-800 rounded-lg border border-gray-700 p-3 ${!rec ? 'opacity-50' : ''}`;
    card.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        ${portrait ? `<img src="assets/ships/${portrait}.png" class="w-10 h-10 object-contain flex-shrink-0" alt="${shipDisplayName(n)}" />` : ''}
        <span class="font-medium text-white text-sm">${shipDisplayName(n)}</span>
      </div>
      <div class="grid grid-cols-2 gap-1 text-xs text-gray-400 mb-2">
        <div>Rank <span class="text-white font-medium">${rankLabel}</span></div>
        <div>Points <span class="text-blue-400 font-medium">${pointsLabel}</span></div>
        <div>Crew <span class="text-white font-medium">${crewLabel}</span></div>
        <div>Evo <span class="text-white font-medium">${input.evo}</span></div>
        <div>Installed <span class="text-white font-medium">${spent}</span></div>
      </div>
      <button data-edit class="w-full px-2 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs">Edit</button>`;
    card.querySelector('[data-edit]').onclick = () => openShipSetupEditor(n);
    listEl.appendChild(card);
  }
}

let editingSetupShipId = null;

function openShipSetupEditor(shipId) {
  editingSetupShipId = shipId;
  const input = getShipInput(shipId);
  document.getElementById('shipBuildModalShipName').textContent = shipDisplayName(shipId);
  document.getElementById('shipSetupRank').value = input.rank;
  document.getElementById('shipSetupCrew').value = input.crew;
  document.getElementById('shipSetupEvo').value = input.evo;
  document.getElementById('shipSetupRankPoints').value = input.rankPoints;

  const gear = getShipGear();
  const gearWrap = document.getElementById('shipSetupGearWrap');
  const gearFields = SHIP_GEAR_FIELDS[shipId] || [];
  gearWrap.classList.toggle('hidden', !gearFields.length);
  document.getElementById('shipSetupGearFields').innerHTML = gearFields.map(([key, label]) => `
    <div><label class="block text-xs text-gray-400 mb-1">${label}</label>
      <input type="number" min="0" data-gear="${key}" value="${gear[key] || 0}" class="w-full bg-gray-800 border border-gray-600 rounded-md px-2 py-1.5 text-white text-sm" /></div>`).join('');
  document.querySelectorAll('#shipSetupGearFields input[data-gear]').forEach((el) => {
    el.addEventListener('change', () => { gear[el.dataset.gear] = Number(el.value) || 0; window.saveStore(); renderShipSetupHexGrid(); });
  });

  document.getElementById('shipBuildModal').classList.remove('hidden');
  renderShipSetupHexGrid();
}

function renderShipSetupHexGrid() {
  const input = getShipInput(editingSetupShipId);
  const catalog = SHIP_NODE_CATALOG[editingSetupShipId] || {};
  const spent = Object.values(input.installs).reduce((a, b) => a + b, 0);
  document.getElementById('shipSetupTotalSpent').textContent = spent;
  renderHexGrid(document.getElementById('shipInstallsGrid'), catalog, input.installs, {
    shipId: editingSetupShipId,
    onChange: renderShipSetupHexGrid,
    gateCheck: () => true, // Setup is raw current state, not a plan -- no gate enforcement.
  });
}

document.getElementById('closeShipBuildModalBtn').onclick = () => document.getElementById('shipBuildModal').classList.add('hidden');
document.getElementById('updateShipBuildBtn').onclick = () => {
  const input = getShipInput(editingSetupShipId);
  input.rank = Number(document.getElementById('shipSetupRank').value) || 0;
  input.crew = Number(document.getElementById('shipSetupCrew').value) || 0;
  input.evo = Number(document.getElementById('shipSetupEvo').value) || 0;
  input.rankPoints = Number(document.getElementById('shipSetupRankPoints').value) || 0;
  window.saveStore();
  document.getElementById('shipBuildModal').classList.add('hidden');
  if (document.getElementById('shipSetupList')) renderShipSetupPage(document.getElementById('pageRoot'));
};

// ============================= Shared hex-grid renderer =============================
// Renders the real in-game 4/3/4 staggered honeycomb. `levels` is mutated in place.
// options.gateCheck(meta, spentExcludingThis) -> bool decides if a locked node can be
// clicked; options.readOnly disables all interaction (used for loadout result cards).
function renderHexGrid(container, catalog, levels, options = {}) {
  container.innerHTML = '';
  container.className = 'flex flex-col items-center gap-1.5';
  const spent = Object.values(levels).reduce((a, b) => a + b, 0);
  const budget = options.budget;

  SHIP_GRID_ROWS.forEach((row, rowIdx) => {
    const rowEl = document.createElement('div');
    rowEl.className = `flex gap-1.5 ${rowIdx === 1 ? 'mx-9' : ''}`;
    row.forEach((gridPos) => {
      const slot = GRID_TO_CODE[gridPos - 1]; // grid position -> catalog code number
      const meta = catalog[slot];
      if (!meta) { rowEl.appendChild(document.createElement('div')); return; }
      const level = levels[slot] || 0;
      const gateCheck = options.gateCheck || ((m, s) => !m.gateAtTotalInstalls || s >= m.gateAtTotalInstalls);
      const gateMet = gateCheck(meta, spent - level);
      const maxLevel = options.shipId ? nodeMaxLevel(options.shipId, slot) : meta.max;
      const canInc = !options.readOnly && level < maxLevel && gateMet && (budget == null || spent < budget);
      const canDec = !options.readOnly && level > 0;
      const maxed = level >= maxLevel;
      const locked = !gateMet;
      // Wrapper holds the hex (icon fills the frame edge-to-edge) plus the level/max readout
      // BELOW the frame -- not overlaid on top of the icon.
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col items-center select-none';
      const codeLabel = options.shipId ? `${SHIP_CODE_PREFIX[options.shipId] || ''}${slot} -- ` : '';
      // "Total Bonus" mirrors the in-game upgrade detail panel's own readout for this exact
      // node (e.g. Cradle's Mitosis Enhancements at level 18 shows "Total Bonus x1.23m" in-game)
      // -- lets you directly cross-check this tool's formula against what the game itself shows,
      // rather than trusting the math blind. Only computable with a real shipId + real account
      // crew/gear/research context, so it's omitted for grid renders that don't provide one.
      const bonusLine = options.shipId
        ? `\nTotal Bonus: x${formatMult(additiveToMultiplier(nodeOwnBonusPct(options.shipId, slot, level)))}`
        : '';
      // meta.source is either 'confirmed' (the base %/level was directly verified against a real
      // account's displayed values, e.g. via the Total Bonus cross-check above) or 'wiki' (taken
      // from the community wiki table, never independently verified -- see the koi1/Venn
      // Hypothesis bug, which was exactly this: a wiki-sourced node whose real behavior turned
      // out to depend on a save field this tool was reading wrong). Surfaced here so unconfirmed
      // nodes are visibly distinguishable instead of silently trusted the same as confirmed ones.
      const unconfirmed = meta.source === 'wiki';
      const sourceLine = unconfirmed ? '\n⚠ Unconfirmed (wiki-sourced, not verified against a real account)' : '';
      wrap.title = `${codeLabel}${meta.name}\n${meta.effect.replace(/^\+/, '')}${bonusLine}${sourceLine}${locked ? `\nLocked -- needs ${meta.gateAtTotalInstalls}+ total points spent first` : ''}${options.readOnly ? '' : '\nClick: +1  Right-click: -1'}`;
      // The icon deliberately overflows the hex frame slightly instead of being clipped to it
      // -- that's how it looks in the real game. So the clip-path hex (`hexBg`) and the icon
      // image are separate layers: hexBg provides the clipped background/border shape, and the
      // image sits on top of it, unclipped, sized a bit larger than the frame and centered.
      const hexSize = options.small ? 56 : 76;
      const hexHeight = Math.round(hexSize * 0.866);
      const tile = document.createElement('div');
      tile.className = 'relative';
      tile.style.cssText = `width:${hexSize}px;height:${hexHeight}px;`;
      const hexBg = document.createElement('div');
      hexBg.className = `absolute inset-0 transition-colors ${
        locked ? 'bg-gray-900' : maxed ? 'bg-blue-900/60' : 'bg-gray-700'
      } ${options.readOnly ? '' : locked ? 'cursor-not-allowed' : 'hover:bg-gray-600 cursor-pointer'}`;
      hexBg.style.cssText = 'clip-path:polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%);border:1px solid #4b5563;';
      tile.appendChild(hexBg);
      if (unconfirmed && !locked) {
        const dot = document.createElement('div');
        dot.className = 'absolute rounded-full bg-amber-500';
        dot.style.cssText = 'width:6px;height:6px;top:2px;right:2px;box-shadow:0 0 2px #000;';
        tile.appendChild(dot);
      }
      const iconPath = options.shipId ? nodeIconPath(options.shipId, slot) : null;
      if (iconPath) {
        const img = document.createElement('img');
        img.src = iconPath;
        img.className = locked ? 'opacity-30' : 'opacity-95';
        img.style.cssText = `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:${Math.round(hexSize * 1.035)}px;height:${Math.round(hexHeight * 1.035)}px;object-fit:contain;pointer-events:none;`;
        img.onerror = () => img.remove();
        tile.appendChild(img);
      }
      const label = document.createElement('div');
      label.className = `text-center -mt-2 ${locked ? 'text-gray-600' : 'text-gray-200'}`;
      label.innerHTML = `<span class="${options.small ? 'text-[10px]' : 'text-xs'} font-semibold">${level}</span><span class="${options.small ? 'text-[8px]' : 'text-[10px]'} text-gray-400">/${maxLevel}</span>`;
      wrap.appendChild(tile);
      wrap.appendChild(label);
      if (!options.readOnly) {
        wrap.onclick = () => { if (canInc) { levels[slot] = level + 1; options.onChange && options.onChange(); } };
        wrap.oncontextmenu = (e) => { e.preventDefault(); if (canDec) { levels[slot] = level - 1; options.onChange && options.onChange(); } };
      }
      rowEl.appendChild(wrap);
    });
    container.appendChild(rowEl);
  });
}

// Fleet Stats & Meltdown as a standalone page is GONE -- progression counters now live directly
// on each relevant ship's Ship Setup modal (see SHIP_GEAR_FIELDS + openShipSetupEditor), and
// Meltdown moved onto the Fleet page itself (a much more frequently-changed value that doesn't
// belong buried behind an extra page).

// ============================= Gear Sets page (sidebar) =============================
const GEAR_COLOR_STYLES = {
  Purple: 'border-purple-500 bg-purple-900/20', Orange: 'border-orange-500 bg-orange-900/20',
  Red: 'border-red-500 bg-red-900/20', Green: 'border-green-500 bg-green-900/20', Blue: 'border-blue-500 bg-blue-900/20',
};
function installLabel(code) {
  const parsed = parseInstallCode(code);
  if (!parsed) return code;
  const meta = SHIP_NODE_CATALOG[parsed.ship]?.[parsed.code];
  return `${code} -- ${meta ? meta.name : '?'} (${shipDisplayName(parsed.ship)})`;
}
// Renders one install target as: [real node icon] x{computed multiplier at current level}
// {node name} -- {code} (code last, per request), instead of the generic "x1.0N/level" text.
function installMultDisplay(code, perLevelMult, level) {
  const parsed = parseInstallCode(code);
  const icon = parsed ? nodeIconPath(parsed.ship, parsed.code) : null;
  const computed = Math.pow(perLevelMult, level || 0);
  // Icon + multiplier only -- the node name/code was cluttering the card; hover still shows
  // which install this is via the title tooltip.
  return `<div class="flex items-center gap-1.5 text-xs text-gray-300" title="${escapeHtml(installLabel(code))}">
    ${icon ? `<img src="${icon}" style="width:18px;height:18px;object-fit:contain;" onerror="this.remove()" />` : ''}
    <span class="text-white font-medium">x${formatMult(computed)}</span>
  </div>`;
}
function renderGearSetsPage(root) {
  const gearSets = getGearSets();
  root.innerHTML = `
    <div class="mb-4 rounded-lg overflow-hidden shadow-lg">
      <div class="bg-gradient-to-r from-blue-900 to-gray-800 px-5 py-4 border-b border-gray-600">
        <h1 class="text-xl font-bold">Gear Sets</h1>
        <p class="text-xs text-gray-300 mt-0.5">Crafted/leveled with Academy Points (unlocked via Zeus). Data transcribed from cifi.fandom.com/wiki/Gear_Sets. Each piece's own level buffs its 2 target installs multiplicatively (x1.01/level, x1.02/level), and each piece's own Set Bonus applies once owned -- both feed into the Fleet page's resource totals.</p>
      </div>
    </div>
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4" id="gearPiecesContainer"></div>`;

  const container = document.getElementById('gearPiecesContainer');
  const byColor = {};
  gearSets.pieces.forEach((p) => { (byColor[p.color] = byColor[p.color] || []).push(p); });

  Object.entries(byColor).forEach(([color, pieces]) => {
    const ownedCount = pieces.filter((p) => p.owned).length;
    const section = document.createElement('div');
    section.className = 'mb-5 last:mb-0';
    section.innerHTML = `<h3 class="text-white font-medium mb-2 flex items-center gap-2">${color} Set <span class="text-xs text-gray-400 font-normal">(${ownedCount}/${pieces.length} owned${ownedCount === pieces.length ? ' -- SET BONUS ACTIVE' : ''})</span></h3>
      <div class="space-y-2" data-pieces></div>`;
    const list = section.querySelector('[data-pieces]');
    pieces.forEach((piece) => {
      const row = document.createElement('div');
      row.className = `grid grid-cols-2 sm:grid-cols-5 gap-2 items-center rounded p-2 border-l-4 ${GEAR_COLOR_STYLES[color] || 'border-gray-500 bg-gray-700/40'}`;
      row.innerHTML = `
        <div class="flex items-center gap-1.5"><input type="checkbox" data-f="owned" ${piece.owned ? 'checked' : ''} class="accent-blue-500" /><span class="text-sm text-white">${escapeHtml(piece.name)}</span></div>
        <div><label class="block text-[10px] text-gray-400">Level</label><input type="number" min="0" data-f="level" value="${piece.level || 0}" class="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs" /></div>
        <div class="text-xs text-gray-400"><span class="text-gray-500">Set Bonus:</span> ${escapeHtml(piece.setBonus)}</div>
        ${installMultDisplay(piece.install1, 1.01, piece.level)}
        ${installMultDisplay(piece.install2, 1.02, piece.level)}`;
      row.querySelectorAll('[data-f]').forEach((el) => {
        el.addEventListener('change', () => {
          const key = el.dataset.f;
          piece[key] = key === 'owned' ? el.checked : (Number(el.value) || 0);
          window.saveStore();
          renderGearSetsPage(root);
        });
      });
      list.appendChild(row);
    });
    container.appendChild(section);
  });
}

// ============================= Fleet page (main optimizer canvas) =============================
let fleetTabRenaming = false;
function renderFleetPage(root) {
  const tabState = getLoadoutTabs();
  const loadout = getActiveLoadout();
  const totals = {};
  // Per-resource, per-ship breakdown of the multiplier factors that feed each totals-row's
  // combined multiplier -- kept alongside `totals` (not derived from it) purely so the totals
  // row can show a hover breakdown of exactly which ships are contributing how much, without
  // re-running computeResourceBonuses a second time.
  const breakdown = {}; // res -> [{ shipId, mult }]
  // Ships the active loadout didn't touch (unchecked, or skipped by Zaglag) still have real
  // current installs contributing real bonuses -- fall back to Ship Setup's baseline for those
  // instead of dropping them out of the total entirely. Ships 1-7 always -- NOT gated on
  // getShipStore() (raw imported-save fields), which can be empty/stale even when
  // getShipInput() (the actual editable install levels used by every other page) has real
  // points in it.
  for (let n = 1; n <= 7; n++) {
    const shipTotals = computeResourceBonuses(n, loadout.perShip[n]?.levels || getShipInput(n).installs);
    mergeResourceTotals(totals, shipTotals);
    Object.entries(shipTotals).forEach(([res, mult]) => {
      if (!mult || mult === 1) return;
      (breakdown[res] = breakdown[res] || []).push({ shipId: n, mult });
    });
  }
  const sortedTotals = sortResourceEntries(totals);
  const gearSetMults = computeGearSetBonusMultipliers();

  root.innerHTML = `
    <div class="mb-4 rounded-lg overflow-hidden shadow-lg">
      <div class="bg-gradient-to-r from-blue-900 to-gray-800 px-5 py-4 border-b border-gray-600 flex items-center justify-between gap-3 flex-wrap">
        <div><h1 class="text-xl font-bold">Fleet Optimizer</h1><p class="text-xs text-gray-300 mt-0.5">Ships not touched by the active loadout show their current Ship Setup baseline.</p></div>
        <button id="newLoadoutBtn" class="flex items-center space-x-1 px-3 py-2 rounded-full bg-gradient-to-r from-purple-600 to-purple-800 hover:from-purple-700 hover:to-purple-900 text-white font-semibold shadow-lg text-xs sm:text-sm flex-shrink-0">${iconSvg('plus', 16)}<span>Optimize Loadout</span></button>
      </div>
      <div class="bg-gray-800/70 px-3 py-2 border-b border-gray-700 flex items-center gap-2 flex-wrap" id="loadoutTabsRow"></div>
      <div class="bg-gray-800 p-3 flex flex-wrap gap-2" id="fleetTotalsRow">
        ${sortedTotals.length ? sortedTotals.map(([res, mult]) => {
          const gearSetMult = gearSetMults[res] || 1;
          const contributors = (breakdown[res] || []).slice().sort((a, b) => b.mult - a.mult)
            .map(({ shipId, mult: m }) => `${shipDisplayName(shipId)}: x${formatMult(m)}`);
          const titleLines = [
            `${RESOURCE_LABELS[res] || res} -- contributing factors (multiply together):`,
            ...contributors,
            gearSetMult !== 1 ? `Gear Set Bonus: x${formatMult(gearSetMult)}` : null,
          ].filter(Boolean);
          return `
          <div class="bg-gray-700/60 rounded-lg px-3 py-1.5 text-center cursor-help" title="${escapeHtml(titleLines.join('\n'))}">
            <div class="text-[10px] text-gray-400">${RESOURCE_LABELS[res] || res}</div>
            <div class="text-sm font-semibold text-green-400">x${formatMult(mult * gearSetMult)}</div>
          </div>`;
        }).join('') : '<div class="text-xs text-gray-500 py-1">No install data yet -- visit Ship Setup to autofill from your save.</div>'}
      </div>
    </div>
    <div class="grid gap-4" id="fleetCanvas" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));"></div>`;

  document.getElementById('newLoadoutBtn').onclick = openNewLoadoutModal;

  // Tab bar: click to switch, pencil/trash only on the active tab to keep the row uncluttered,
  // "+" to add (up to MAX_LOADOUT_TABS). Rename is an inline text input swapped in for the
  // active pill (not window.prompt(), which doesn't reliably fire in every browser context).
  const tabsRow = document.getElementById('loadoutTabsRow');
  const activeTab = tabState.tabs.find((t) => t.id === tabState.activeId);
  tabState.tabs.forEach((tab) => {
    const isActive = tab.id === tabState.activeId;
    if (isActive && fleetTabRenaming) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = tab.name;
      input.className = 'px-2 py-1 rounded-full text-xs font-medium bg-gray-900 text-white border border-purple-500 w-32';
      const commit = () => { fleetTabRenaming = false; renameLoadoutTab(tab.id, input.value.trim()); renderFleetPage(root); };
      input.onblur = commit;
      input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { fleetTabRenaming = false; renderFleetPage(root); } };
      tabsRow.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return;
    }
    const pill = document.createElement('button');
    pill.className = `px-3 py-1 rounded-full text-xs font-medium ${isActive ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`;
    pill.textContent = tab.name;
    pill.onclick = () => { tabState.activeId = tab.id; window.saveStore(); renderFleetPage(root); };
    tabsRow.appendChild(pill);
  });
  const renameBtn = document.createElement('button');
  renameBtn.className = 'text-gray-400 hover:text-white text-xs px-1';
  renameBtn.title = 'Rename this loadout';
  renameBtn.innerHTML = iconSvg('edit', 14);
  renameBtn.onclick = () => { fleetTabRenaming = true; renderFleetPage(root); };
  tabsRow.appendChild(renameBtn);
  if (tabState.tabs.length > 1) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'text-gray-400 hover:text-red-400 text-xs px-1';
    deleteBtn.title = 'Delete this loadout';
    deleteBtn.innerHTML = iconSvg('trash', 14);
    deleteBtn.onclick = () => { if (confirm(`Delete "${activeTab.name}"?`)) { deleteLoadoutTab(activeTab.id); renderFleetPage(root); } };
    tabsRow.appendChild(deleteBtn);
  }
  if (tabState.tabs.length < MAX_LOADOUT_TABS) {
    const addBtn = document.createElement('button');
    addBtn.className = 'px-2 py-1 rounded-full text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 ml-1';
    addBtn.textContent = '+ Add';
    addBtn.onclick = () => { addLoadoutTab(); renderFleetPage(root); };
    tabsRow.appendChild(addBtn);
  }

  const canvas = document.getElementById('fleetCanvas');
  for (let n = 1; n <= 7; n++) {
    const catalog = SHIP_NODE_CATALOG[n];
    if (!catalog) continue;
    // A ship left out of this loadout (unchecked, or skipped by Zaglag) has no perShip entry --
    // fall back to its real current installs instead of an empty grid, since it wasn't touched.
    const levels = loadout.perShip[n]?.levels || getShipInput(n).installs;
    const clicks = loadout.perShip[n]?.clicks || [];
    const portrait = SHIP_PORTRAITS[n];
    const input = getShipInput(n);
    const totalInstalls = Object.values(levels).reduce((a, b) => a + (b || 0), 0);
    const card = document.createElement('div');
    card.className = 'relative bg-gray-800 rounded-lg border border-gray-700 p-3 flex flex-col items-center';
    // The Zaglag checklist icon only appears on Zagreus's card, and only once a loadout has
    // actually been generated with Zaglag checked (see generateLoadoutBtn) -- never shown
    // before the optimizer has run.
    const zaglagBadge = (n === 3 && loadout.zaglagChecklist)
      ? `<button data-zaglag-badge class="absolute top-2 right-2 w-7 h-7 rounded-full bg-amber-600 hover:bg-amber-500 flex items-center justify-center text-white text-sm" title="Zaglag readiness checklist">📋</button>`
      : '';
    card.innerHTML = `
      ${zaglagBadge}
      <div class="flex items-center gap-2 mb-2 self-start">
        ${portrait ? `<img src="assets/ships/${portrait}.png" class="w-8 h-8 object-contain" alt="${shipDisplayName(n)}" />` : ''}
        <span class="font-medium text-white text-sm">${shipDisplayName(n)}</span>
      </div>
      <div class="flex gap-3 text-[10px] text-gray-400 mb-2 self-start" title="Rank/Crew are your real Ship Setup values -- Installs is the total shown in the grid below (this loadout's plan, or your real current installs if this ship wasn't touched).">
        <span>Rank <span class="text-gray-200 font-semibold">${input.rank || 0}</span></span>
        <span>Evo <span class="text-gray-200 font-semibold">${input.evo || 0}</span></span>
        <span>Crew <span class="text-gray-200 font-semibold">${input.crew || 0}</span></span>
        <span>Installs <span class="text-gray-200 font-semibold">${totalInstalls}</span></span>
      </div>
      <div data-hexgrid></div>
      <div class="flex gap-2 w-full mt-3">
        <button data-order class="flex-1 px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs">Install Order</button>
        <button data-path class="flex-1 px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs">Effective Path</button>
      </div>
      <button data-optimize class="w-full mt-2 px-2 py-1.5 bg-purple-700 hover:bg-purple-600 text-white rounded text-xs font-medium">Optimize This Ship</button>`;
    renderHexGrid(card.querySelector('[data-hexgrid]'), catalog, levels, { readOnly: true, small: true, shipId: n });
    card.querySelector('[data-order]').onclick = () => openLoadoutDetail(n, levels, 'order', clicks);
    card.querySelector('[data-path]').onclick = () => openLoadoutDetail(n, levels, 'path', clicks);
    card.querySelector('[data-optimize]').onclick = () => openOptimizeShipModal(n);
    if (n === 3 && loadout.zaglagChecklist) {
      card.querySelector('[data-zaglag-badge]').onclick = () => openZaglagChecklistModal(loadout.zaglagChecklist);
    }
    canvas.appendChild(card);
  }
}

// Shared by the Optimize Loadout and Optimize This Ship modals -- renders the 6 focus-weight
// sliders into `container` against `weightsObj`, and wires the given preset button to load the
// community-reported priority ordering into that same object.
function renderFocusWeightSliders(container, weightsObj, presetBtn, onChange) {
  container.innerHTML = '';
  Object.entries(weightsObj).forEach(([key, val]) => {
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="flex justify-between text-xs text-gray-300 mb-1"><span>${RESOURCE_LABELS[key] || key}</span><span data-val>${val}</span></div>
      <input type="range" min="0" max="10" value="${val}" data-weight="${key}" class="w-full accent-blue-500" />`;
    container.appendChild(row);
  });
  container.querySelectorAll('input[data-weight]').forEach((el) => {
    el.oninput = () => { el.previousElementSibling.querySelector('[data-val]').textContent = el.value; };
    el.addEventListener('change', () => { weightsObj[el.dataset.weight] = Number(el.value); window.saveStore(); if (onChange) onChange(); });
  });
  if (presetBtn) {
    presetBtn.onclick = () => {
      Object.assign(weightsObj, defaultShipGear().focusWeights);
      window.saveStore();
      renderFocusWeightSliders(container, weightsObj, presetBtn, onChange);
    };
  }
}
function openNewLoadoutModal() {
  const grid = document.getElementById('newLoadoutShipPoints');
  grid.innerHTML = '';
  const boostTotals = computeFleetBoostTotals();
  const optSettings = getOptimizerSettings();
  for (let n = 1; n <= 8; n++) {
    if (!SHIP_NODE_CATALOG[n]) continue;
    const input = getShipInput(n);
    // Prefilled with what's ALREADY installed, not unspent Rank Points -- this field is a
    // TARGET total to aim for (typically over your next run, as you slowly earn more points),
    // not an assumption you have the full amount in hand right now. Raise it to plan ahead.
    const prefill = Object.values(input.installs).reduce((a, b) => a + b, 0);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<label class="flex items-center gap-1.5 text-xs text-gray-400 mb-1">
        <input type="checkbox" data-ship-enabled="${n}" ${optSettings.shipEnabled[n] !== false ? 'checked' : ''} class="accent-purple-500" />
        ${shipDisplayName(n)}${boostTotals[n]?.sp ? ` <span class="text-green-500">(${boostTotals[n].sp} from boosts)</span>` : ''}
      </label>
      <input type="number" min="0" data-ship-points="${n}" value="${prefill}" class="w-full bg-gray-700 border border-gray-600 rounded-md px-2 py-1.5 text-white text-sm" />`;
    grid.appendChild(wrap);
  }
  document.querySelectorAll('[data-ship-enabled]').forEach((cb) => {
    cb.addEventListener('change', () => { optSettings.shipEnabled[cb.dataset.shipEnabled] = cb.checked; window.saveStore(); });
  });
  document.getElementById('newLoadoutZaglag').checked = optSettings.zaglag;
  document.getElementById('newLoadoutZaglag').addEventListener('change', (e) => { optSettings.zaglag = e.target.checked; window.saveStore(); });
  document.getElementById('newLoadoutPrepForLongRun').checked = optSettings.prepForLongRun;
  document.getElementById('newLoadoutPrepForLongRun').addEventListener('change', (e) => { optSettings.prepForLongRun = e.target.checked; window.saveStore(); });
  document.getElementById('newLoadoutShortRun').checked = optSettings.runLength === 'short';
  document.getElementById('newLoadoutShortRun').addEventListener('change', (e) => { optSettings.runLength = e.target.checked ? 'short' : 'long'; window.saveStore(); });
  // Focus weights live here (not the Fleet Stats page) -- they're an input to THIS solve, not
  // a persistent fleet-wide account stat. Meltdown lives here too now (moved off the Fleet page
  // header -- it's a per-run input to planning, not a fleet-wide display value).
  const gear = getShipGear();
  document.getElementById('newLoadoutMeltdown').value = gear.meltdown;
  document.getElementById('newLoadoutMeltdown').onchange = (e) => { gear.meltdown = Number(e.target.value) || 0; window.saveStore(); };
  renderFocusWeightSliders(document.getElementById('newLoadoutFocusWeights'), gear.focusWeights, document.getElementById('newLoadoutWeightPresetBtn'));
  document.getElementById('newLoadoutModal').classList.remove('hidden');
}
document.getElementById('closeNewLoadoutModalBtn').onclick = () => document.getElementById('newLoadoutModal').classList.add('hidden');

// ============================= Real optimizer =============================
// Which user-facing focus-weight slider governs each effectResources() tag. All generator-
// tier gains (allGens, mk1-8) feed the "cells" weight -- generator output ultimately becomes
// Cells, and the spec's 6-way weight split (Cells/MP/Shards/RP/Materials/Academy) doesn't carve
// out a separate "generator output" slider. `other` (untagged effects, e.g. flat "+1 completed
// operation" with no %) gets no weight -- it's never picked by the marginal-value pass, only
// touched by the 1-free-point seed pass below.
const RESOURCE_TO_WEIGHT_BUCKET = {
  cells: 'cells', allGens: 'cells', shards: 'shards', researchPoints: 'researchPoints',
  modPoints: 'modPoints', academyPoints: 'academyPoints', missionMaterials: 'missionMaterials',
  techSoftware: 'cells', techHardware: 'cells', // intermediate compounding pools feeding Cells/Shards/RP -- see effectResources
  ...Object.fromEntries(GEN_TIERS.map((n) => [`mk${n}`, 'cells'])),
};
// Explicit tie-break order, lower number wins -- only ever consulted when two candidates'
// weighted spent/value ratio is EXACTLY equal (most commonly right after a gate opens, when
// several categories/nodes get baselined to the same starting ratio simultaneously). This never
// overrides the real weight/value math, it only decides ties that math is genuinely indifferent
// between.
const CATEGORY_TIE_PRIORITY = { missionMaterials: 1, modPoints: 2, shards: 3, researchPoints: 4, academyPoints: 4, cells: 5 };
function nodeTiePriority(tags) {
  if (tags.includes('techSoftware') || tags.includes('techHardware')) return 1;
  if (tags.includes('allGens')) return 5;
  if (tags.includes('cells')) return 6;
  if (tags.some((t) => /^mk\d+$/.test(t))) return 7;
  return 4; // Shards/RP/MP/AP/Materials nodes -- ties within these categories are rare/inconsequential
}
// Raw per-point value of a node, in that node's OWN resource units (e.g. "% Cells/point" or
// "% Shards/point") -- NOT weight-adjusted. Comparing THIS number directly across different
// resources is meaningless (a "10%/level Cells" node and a "0.001%/level Shards" node aren't
// remotely comparable just because both are percentages -- the whole node catalog's Shard
// nodes happen to run several orders of magnitude smaller per-point than its Cells nodes). That
// mismatch was the real bug in an earlier version of this optimizer: equal 50/50 weights still
// dumped everything into Cells, because raw pct magnitude silently dominated the weight.
// Meltdown -- two-pool model (unverified against a real confirmed formula, but internally
// consistent and monotonic across the whole 0-1+ range): direct Cells/Shards/RP/MP/Academy/
// Materials bonuses are Meltdown-immune and add straight to their own pool. Generator tiers
// (Mk1-Mk8) are melted -- each tier's OWN real cumulative pool (this account's actual current
// total for that tier, from crew/gear/research/real installed levels, not a fictional "0") gets
// raised to the Meltdown exponent, so a node's real marginal value depends on how saturated its
// specific tier already is. An "All Gens" node touches all 8 tiers at once, so its value is the
// product of each tier's own melted marginal ratio -- tiers that are already heavily saturated
// contribute almost nothing further, while under-invested tiers dominate the score. This uses
// ONLY real account data (current per-tier totals, the stored Meltdown value) -- no invented
// constants. It does NOT change what budget/plan the optimizer outputs (that's still a from-zero
// simulation per the earlier fix) -- it only changes how a candidate node's real relative value
// is judged, which is a different question from what the final plan displays.
function nodeLinearIncrement(shipId, slot) {
  const meta = SHIP_NODE_CATALOG[shipId]?.[slot];
  if (!meta) return 0;
  const m = meta.effect.match(/([\d.]+)%/);
  if (!m) return 0;
  const gear = getShipGear();
  const crew = (getShipInput(shipId).crew || 0) + (computeFleetBoostTotals()[shipId]?.crew || 0);
  const gearMult = gearMultiplierFor(meta.gearKey, gear);
  const researchMult = (computeFleetResearchShipMultipliers()[shipId] || 1) * (computeFleetBadgeMultipliers()[shipId] || 1);
  const gearNodeMult = computeGearNodeMultiplier(Number(shipId), Number(slot));
  return parseFloat(m[1]) * crew * gearMult * researchMult * gearNodeMult;
}
const MELTDOWN_POOL_EPS = 1e-6;
// Generator-like intermediate pools: the 8 MK tiers, plus Tech Software/Hardware Upgrade output
// (see effectResources) -- all of these compound before feeding a final resource, so they get
// tracked and Meltdown-melted the same way, distinct from a direct final-resource bonus.
function isGenLikeTag(tag) { return /^mk\d+$/.test(tag) || TECH_UPGRADE_TAGS.includes(tag); }
// Real current total for each Meltdown-relevant pool ('cells', 'mk1'..'mk8', techSoftware/
// techHardware), summed from this ship's ACTUAL installed levels (not the optimizer's
// hypothetical from-zero plan).
function computeShipRealPoolTotals(shipId) {
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  const installs = getShipInput(shipId).installs || {};
  const pools = { cells: MELTDOWN_POOL_EPS };
  GEN_TIERS.forEach((n) => { pools[`mk${n}`] = MELTDOWN_POOL_EPS; });
  TECH_UPGRADE_TAGS.forEach((t) => { pools[t] = MELTDOWN_POOL_EPS; });
  Object.keys(catalog).forEach((slot) => {
    const level = installs[slot] || 0;
    if (level <= 0) return;
    const increment = nodeLinearIncrement(shipId, slot) * level;
    const tags = effectResources(catalog[slot].effect);
    if (tags.includes('allGens')) {
      GEN_TIERS.forEach((n) => { pools[`mk${n}`] = (pools[`mk${n}`] || MELTDOWN_POOL_EPS) + increment; });
    }
    tags.forEach((tag) => {
      if (tag === 'cells' || isGenLikeTag(tag)) pools[tag] = (pools[tag] || MELTDOWN_POOL_EPS) + increment;
    });
  });
  return pools;
}
// Gear qualifiers that keep climbing over the course of a single run (ticks/operations/studies/
// missions/loop-fills all accumulate as you play), vs. ones that are effectively static within a
// run (loop mods owned, automations unlocked, manually-purchased generators, tech upgrades --
// these only change through deliberate one-off purchases, not just time passing). A node gated
// on a GROWING qualifier is worth more than its current snapshot suggests, since by the time
// you've bought it you'll be benefiting from a higher count for most of the run, not the count
// at the moment of purchase. GROWTH_VALUE_BOOST is a modest, clearly-flagged heuristic (not a
// measured constant) -- there's no way to know the "true" average growth without knowing your
// actual run length, so this errs conservative rather than inventing a precise multiplier.
const GROWTH_GEAR_KEYS = new Set(['ticksThisLoop', 'operationsCompleted', 'studiesThisLR', 'missionsCompleted', 'loopFillsThisRun']);
const GROWTH_VALUE_BOOST = 1.5;
function nodeScalesWithGrowth(gearKey) {
  if (!gearKey) return false;
  return Array.isArray(gearKey) ? gearKey.some((k) => GROWTH_GEAR_KEYS.has(k)) : GROWTH_GEAR_KEYS.has(gearKey);
}
// Run Length tactic: skews the optimizer's Cells-vs-Generators preference within the "cells"
// weight bucket (see RESOURCE_TO_WEIGHT_BUCKET -- both direct Cells nodes and all Generator-tier
// nodes feed that one slider, so there's otherwise no way to prefer one over the other). Direct
// Cells nodes pay off immediately; Generator nodes pay off by compounding output over time, so
// they're worth relatively more the longer the run is. Long is the default (most runs are long
// relative to how fast a Cells-only node saturates) -- Short is an explicit opt-in for players
// about to reset/traverse soon. These multipliers are a modest, clearly-flagged heuristic (not a
// measured constant, same spirit as GROWTH_VALUE_BOOST) -- there's no way to know the "true"
// relative value without knowing your actual run length in advance.
const RUN_LENGTH_BIAS = {
  short: { cells: 1.35, gen: 0.7 },
  long: { cells: 0.7, gen: 1.35 },
};
function runLengthBiasFor(runLength) {
  return RUN_LENGTH_BIAS[runLength] || RUN_LENGTH_BIAS.long;
}
// Marginal value of spending one more point on `slot` right now, given the current (real +
// whatever this optimization run has hypothetically added so far) pool totals. Mutates nothing.
function poolAdjustedNodeValue(shipId, slot, pools, runLength) {
  const meta = SHIP_NODE_CATALOG[shipId]?.[slot];
  if (!meta) return 0;
  const increment = nodeLinearIncrement(shipId, slot) * (nodeScalesWithGrowth(meta.gearKey) ? GROWTH_VALUE_BOOST : 1);
  if (increment <= 0) return 0;
  const tags = effectResources(meta.effect);
  const genTiers = tags.filter(isGenLikeTag);
  const isAllGens = tags.includes('allGens');
  if (!isAllGens && genTiers.length === 0 && !tags.includes('cells')) return increment; // Shards/RP/MP/Academy/Materials -- flat linear value, no pool tracking (known gap, not modeled yet)
  const meltdown = getShipGear().meltdown || 0;
  const bias = runLengthBiasFor(runLength);
  if (!isAllGens && genTiers.length === 0) {
    // Direct Cells: bypasses the Meltdown EXPONENT (exponent 1, no melt), but is NOT exempt from
    // real diminishing returns -- it still saturates relative to its own (typically enormous,
    // real-account) pool. This is what lets Generator nodes naturally overtake as a run
    // progresses: Cells' pool grows huge fast (it gets first pick early since it's un-melted),
    // so its OWN relative marginal gain shrinks toward ~0 quickly, while less-saturated
    // Generator tiers keep offering a comparatively bigger relative jump despite the melt.
    const base = pools.cells || MELTDOWN_POOL_EPS;
    return (((base + increment) / base - 1) * 100) * bias.cells;
  }
  const affectedTiers = isAllGens ? GEN_TIERS.map((n) => `mk${n}`) : genTiers;
  let ratio = 1;
  affectedTiers.forEach((tier) => {
    const base = pools[tier] || MELTDOWN_POOL_EPS;
    ratio *= Math.pow((base + increment) / base, meltdown);
  });
  return ((ratio - 1) * 100) * bias.gen;
}
// Real allocator -- weighted round-robin ACROSS RESOURCE CATEGORIES, not a single global
// ranking. Two things this fixes over an earlier "highest constant marginal value wins"
// version: (1) that version compared raw %/point across DIFFERENT resources directly, so equal
// weights still got swamped by whichever resource's nodes happen to have larger raw percentages
// in the catalog (Cells nodes run ~10-1000x bigger per point than Shards/RP nodes) -- fixed by
// only ever comparing raw value WITHIN one resource category at a time, after using weights to
// decide which category gets the next point; (2) that version kept re-picking the single best
// node until it hit max before moving on, i.e. bulk-buying one node at a time -- not what you
// want if you might only get a handful of points before your next run and need a sane
// partial-budget snapshot at every step, not just the final one. This version chooses, for
// EACH point one at a time, whichever weighted resource category is currently most under its
// target share (spent-so-in-that-category / weight, lowest wins), then the single best node
// within that category for just that one point -- so the click order stays interleaved and
// proportional to your weights at every partial budget, not just the end state.
// Always plans from a clean slate (every node at 0), regardless of what's actually installed
// right now -- `budget` is the total number of points to distribute as if starting over, not a
// target to reach on top of existing installs. Real current installs are a separate concern
// (see "Effective Path" in openLoadoutDetail, which uses this same ideal sequence's tail to
// advise what to buy next from wherever you really are).
function optimizeShipInstalls(shipId, budget, weights, prepForLongRun, runLength) {
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  const levels = {};
  const clicks = [];
  let spent = 0;
  const slots = Object.keys(catalog);
  const unlockedGens = getUnlockedGens();
  const gateMetFor = (slot) => {
    const meta = catalog[slot];
    const level = levels[slot] || 0;
    if (meta.gateAtTotalInstalls && (spent - level) < meta.gateAtTotalInstalls) return false;
    // A node tied to ONE specific generator tier (not All Gens, not a direct-resource node) is
    // pointless to invest in before that tier is actually unlocked -- e.g. MK9/10, which most
    // accounts won't have yet (gem-gated, see GEN_TIERS). All-Gens nodes stay eligible
    // regardless, since they still do real work on whichever tiers ARE unlocked.
    const tags = effectResources(meta.effect);
    const singleTier = !tags.includes('allGens') && tags.find((t) => /^mk\d+$/.test(t));
    if (singleTier) {
      const tierNum = Number(singleTier.slice(2));
      if (tierNum > 1 && unlockedGens[tierNum] === false) return false;
    }
    return true;
  };
  // AOTC (Demeter's "Ahead of the Curve", slot 1): its payoff lands at the start of the NEXT
  // loop reset, not the active run, so it can't be scored by the normal marginal-value engine
  // (no % in its effect text, no immediate resource gain to weigh against anything else).
  // Community approach: max it outright once Demeter's budget is comfortably large (>=15) or
  // when explicitly prepping for a long run; otherwise skip it entirely (not even the usual "1
  // free point in everything" seed) so scarce points go straight into direct multipliers
  // instead.
  if (shipId === 5 && (budget >= 15 || prepForLongRun)) {
    const needed = Math.min(nodeMaxLevel(shipId, 1), budget - spent);
    if (needed > 0) { levels[1] = needed; spent += needed; for (let i = 0; i < needed; i++) clicks.push('1'); }
  }
  // Which resource categories this ship's nodes actually touch, and each one's Cells-scaling
  // flag for the meltdown adjustment (see computeResourceBonuses' meltdown note -- this only
  // steers the optimizer's category preference, it doesn't change what the Fleet totals report).
  const categoryOf = {}; // slot -> [categories]
  const touchedCategories = new Set();
  slots.forEach((slot) => {
    const cats = [...new Set(effectResources(catalog[slot].effect).map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))];
    categoryOf[slot] = cats;
    cats.forEach((c) => touchedCategories.add(c));
  });
  // Step 1: secure the base bonus in every currently-open node that feeds a category you
  // actually weighted (a weight of 0 means "don't invest here at all," so it shouldn't get a
  // free seed point either -- matches the hand-off spec's "get something in everything before
  // specializing," scoped to what you actually want).
  slots.forEach((slot) => {
    if (spent >= budget) return;
    if (shipId === 5 && slot === '1') return; // handled by the AOTC policy above, not this generic seed
    if (!categoryOf[slot].some((c) => (weights[c] || 0) > 0)) return;
    if (gateMetFor(slot) && (levels[slot] || 0) === 0 && nodeMaxLevel(shipId, slot) > 0) { levels[slot] = 1; spent += 1; clicks.push(slot); }
  });
  const categorySpent = {};
  touchedCategories.forEach((c) => { categorySpent[c] = 0; });
  // Points spent per NODE so far -- used to give every eligible node within a category its fair
  // share PROPORTIONAL to its real value (spent/value ratio, same fair-queueing pattern as
  // categories above), instead of either maxing one node out before ever touching the next
  // (winner-take-all) or splitting evenly regardless of value (just as wrong -- an "All Gens"
  // node would score identically to a flat Cells node purely for being eligible, ignoring a real
  // value gap). This determines HOW MANY points each node ends up with; see "no consecutive
  // repeats" below for how those same picks get spread out in TIME without changing that total.
  const nodeSpent = {};
  slots.forEach((s) => { nodeSpent[s] = 0; });
  // Meltdown pool totals -- seeded from this ship's REAL current state, then mutated as THIS
  // optimization run hypothetically adds points, so later picks correctly see a more-saturated
  // pool than earlier ones (real, account-grounded diminishing returns per generator tier,
  // instead of an arbitrary queueing rule). Independent of `levels`/`spent` above, which stay a
  // from-zero plan per the earlier fix -- this only feeds the value comparison, not the output.
  const pools = computeShipRealPoolTotals(shipId);
  // exclude lets the main loop forbid one specific slot (the previous pick) for this iteration
  // only. This does NOT change which nodes end up with how many points overall (verified: same
  // final per-node totals with or without it) -- it only re-times an already-optimal, value-
  // proportional sequence of picks so they're delivered interleaved instead of in one unbroken
  // burst, which is all "never buy 20 of the same thing in a row" actually requires.
  const nodeEligible = (slot, exclude) => slot !== exclude && (levels[slot] || 0) < nodeMaxLevel(shipId, slot) && gateMetFor(slot);
  const categoryHasEligibleNode = (c, exclude) => slots.some((slot) => categoryOf[slot].includes(c) && nodeEligible(slot, exclude));
  const bestNodeIn = (c, exclude) => {
    let bestSlot = null; let bestRatio = Infinity; let bestPriority = Infinity; let bestScore = -Infinity;
    slots.forEach((slot) => {
      if (!categoryOf[slot].includes(c) || !nodeEligible(slot, exclude)) return;
      const score = Math.max(poolAdjustedNodeValue(shipId, slot, pools, runLength), 1e-9);
      const ratio = nodeSpent[slot] / score;
      const priority = nodeTiePriority(effectResources(catalog[slot].effect));
      const better = ratio < bestRatio
        || (ratio === bestRatio && priority < bestPriority)
        || (ratio === bestRatio && priority === bestPriority && score > bestScore);
      if (better) { bestRatio = ratio; bestPriority = priority; bestSlot = slot; bestScore = score; }
    });
    return bestSlot;
  };
  // Step 2: one point at a time, spend on whichever weighted category is most under its fair
  // share, then the most under-served node within it (round-robin, see nodeSpent above). A
  // weight of 0 means truly excluded -- it only ever gets a point as a last resort, when every
  // weighted category has nothing eligible right now, purely to keep total installs climbing
  // toward whatever gate is blocking them.
  //
  // categoryBaseline exists to fix a real skew: categories don't all unlock at the same time
  // (e.g. Cradle's Shards node needs 100 total installs, but its Cells-tier nodes are open from
  // 0), so a category that had to sit out the early game accumulates a categorySpent of 0 while
  // an always-open category's categorySpent climbs the whole time just because it was the only
  // thing available -- not because the player weighted it higher. Comparing raw spent/weight
  // ratios directly at that point makes the newcomer look "owed" a monopoly to catch up, which
  // is exactly the "hard focus Shards until max, ignoring Cells entirely" bug this fixes: each
  // category's ratio gets baselined to the CURRENT front-runner's ratio the moment it first
  // becomes eligible, so from then on the two compete on their real weights only.
  const categoryBaseline = {};
  const categoryActivated = {};
  touchedCategories.forEach((c) => { categoryBaseline[c] = 0; categoryActivated[c] = false; });
  const ratioOf = (c) => categorySpent[c] / weights[c] - categoryBaseline[c];
  // Picks the next (category, node) to spend on, optionally forbidding one slot for this pick.
  // Returns null if nothing eligible under that constraint.
  const selectNext = (exclude) => {
    const positiveCats = [...touchedCategories].filter((c) => (weights[c] || 0) > 0);
    let minActiveRatio = null;
    positiveCats.forEach((c) => {
      if (!categoryActivated[c]) return;
      const r = ratioOf(c);
      if (minActiveRatio == null || r < minActiveRatio) minActiveRatio = r;
    });
    positiveCats.forEach((c) => {
      if (categoryActivated[c] || !categoryHasEligibleNode(c, exclude)) return;
      categoryBaseline[c] = categorySpent[c] / weights[c] - (minActiveRatio ?? 0);
      categoryActivated[c] = true;
    });
    const eligiblePositive = positiveCats.filter((c) => categoryHasEligibleNode(c, exclude))
      .sort((a, b) => (ratioOf(a) - ratioOf(b)) || (CATEGORY_TIE_PRIORITY[a] || 9) - (CATEGORY_TIE_PRIORITY[b] || 9));
    let pickedCat = eligiblePositive[0] ?? null;
    if (pickedCat == null) {
      // Nothing weighted has anything to spend on right now -- fall back to a 0-weighted
      // category purely to advance total installs past whatever's gating the real targets.
      pickedCat = [...touchedCategories].find((c) => (weights[c] || 0) <= 0 && categoryHasEligibleNode(c, exclude)) ?? null;
    }
    if (pickedCat == null) return null;
    return bestNodeIn(pickedCat, exclude);
  };
  let lastPickedSlot = null;
  while (spent < budget) {
    let pickedSlot = selectNext(lastPickedSlot);
    if (pickedSlot == null) pickedSlot = selectNext(null); // no alternative to the last pick -- allow the repeat
    if (pickedSlot == null) {
      // Truly nothing eligible anywhere right now -- drop any category with no room left at
      // all (every node feeding it maxed for good), then see if anything else can still open.
      [...touchedCategories].forEach((c) => {
        if (!slots.some((slot) => categoryOf[slot].includes(c) && (levels[slot] || 0) < nodeMaxLevel(shipId, slot))) touchedCategories.delete(c);
      });
      if (![...touchedCategories].some((c) => categoryHasEligibleNode(c, null))) break;
      continue;
    }
    lastPickedSlot = pickedSlot;
    levels[pickedSlot] = (levels[pickedSlot] || 0) + 1;
    nodeSpent[pickedSlot] += 1;
    spent += 1;
    clicks.push(pickedSlot);
    categoryOf[pickedSlot].forEach((c) => { categorySpent[c] += 1; }); // credit every category this node feeds
    const increment = nodeLinearIncrement(shipId, pickedSlot);
    const pickedTags = effectResources(catalog[pickedSlot].effect);
    if (pickedTags.includes('allGens')) {
      GEN_TIERS.forEach((n) => { pools[`mk${n}`] = (pools[`mk${n}`] || MELTDOWN_POOL_EPS) + increment; });
    }
    pickedTags.forEach((tag) => {
      if (tag === 'cells' || isGenLikeTag(tag)) pools[tag] = (pools[tag] || MELTDOWN_POOL_EPS) + increment;
    });
  }
  return { levels, clicks };
}
// Per-ship "include in Optimize Loadout" toggle + the Zaglag tactic toggle: while active,
// Zagreus is skipped by the batch optimizer (as if not yet unlocked, leaving its budget unspent
// while the other ships are optimized normally) UNTIL computeZaglagChecklist() reports every
// reachable Mod-Points node ready -- at that point Zagreus is automatically folded back into the
// batch with no further action needed (see generateLoadoutBtn). "Optimize This Ship" (single-ship
// button) ignores both toggles -- an explicit per-ship action always runs regardless of batch
// settings.
function defaultOptimizerSettings() {
  const shipEnabled = {};
  for (let n = 1; n <= 7; n++) shipEnabled[n] = true;
  return { shipEnabled, zaglag: false, prepForLongRun: false, runLength: 'long' };
}
function getOptimizerSettings() {
  if (!window.store) return defaultOptimizerSettings();
  if (!window.store.optimizerSettings) window.store.optimizerSettings = defaultOptimizerSettings();
  if (!window.store.optimizerSettings.runLength) window.store.optimizerSettings.runLength = 'long';
  return window.store.optimizerSettings;
}

// ============================= Loadout tabs =============================
// Named loadout tabs on the Fleet page (3 by default, up to 7 total) -- replaces the old single
// "currentLoadout" so different weight/tactic setups can be planned side by side without
// overwriting each other. Each tab is self-contained: its own perShip result and (if Zaglag was
// used to generate it) its own Zaglag readiness checklist.
const MAX_LOADOUT_TABS = 7;
function defaultLoadoutTabs() {
  return {
    tabs: [
      { id: 1, name: 'Loadout 1', perShip: {}, zaglagChecklist: null },
      { id: 2, name: 'Loadout 2', perShip: {}, zaglagChecklist: null },
      { id: 3, name: 'Loadout 3', perShip: {}, zaglagChecklist: null },
    ],
    activeId: 1,
    nextId: 4,
  };
}
function getLoadoutTabs() {
  if (!window.store) return defaultLoadoutTabs();
  if (!window.store.loadoutTabs) window.store.loadoutTabs = defaultLoadoutTabs();
  return window.store.loadoutTabs;
}
function getActiveLoadout() {
  const state = getLoadoutTabs();
  return state.tabs.find((t) => t.id === state.activeId) || state.tabs[0];
}
function addLoadoutTab() {
  const state = getLoadoutTabs();
  if (state.tabs.length >= MAX_LOADOUT_TABS) return;
  const id = state.nextId++;
  state.tabs.push({ id, name: `Loadout ${id}`, perShip: {}, zaglagChecklist: null });
  state.activeId = id;
  window.saveStore();
}
function deleteLoadoutTab(id) {
  const state = getLoadoutTabs();
  if (state.tabs.length <= 1) return; // always leave at least one
  state.tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeId === id) state.activeId = state.tabs[0].id;
  window.saveStore();
}
function renameLoadoutTab(id, name) {
  const state = getLoadoutTabs();
  const tab = state.tabs.find((t) => t.id === id);
  if (tab && name) { tab.name = name; window.saveStore(); }
}

// Zaglag readiness checklist -- dynamically built from every non-Zagreus ship's REAL current
// installs: any node that boosts Mod Points (the resource that drives Zagreus's own rank-up) is
// a readiness requirement once its own gate is actually open on that ship right now -- 1 point
// is enough to count as "covered" (this is a readiness gate, not an allocation target). A node
// still locked behind a gate you haven't reached yet is left off the list entirely rather than
// demanded early -- "reasonably within reach" per the hand-off, not a hard prerequisite on
// something you can't even open. Replaces an earlier static 3-item list (HEP3/HEP6/DEM2) that
// was an unverified placeholder, not derived from the account's real Mod-Points-node layout.
// The optimal MOMENT to unlock Zagreus still can't be predicted from a static save snapshot (it
// depends on real-time progression rate this tool has no way to observe) -- so this stays a
// post-hoc readiness gate, computed once "Optimize Loadout" actually runs with Zaglag checked.
function computeZaglagChecklist() {
  const items = [];
  for (let shipId = 1; shipId <= 7; shipId++) {
    if (shipId === 3) continue; // Zagreus isn't part of its own readiness gate
    const catalog = SHIP_NODE_CATALOG[shipId] || {};
    const installs = getShipInput(shipId).installs;
    const spent = Object.values(installs).reduce((a, b) => a + b, 0);
    Object.entries(catalog).forEach(([slot, meta]) => {
      if (!effectResources(meta.effect).includes('modPoints')) return;
      const currentLevel = installs[slot] || 0;
      const gateOpen = !meta.gateAtTotalInstalls || (spent - currentLevel) >= meta.gateAtTotalInstalls;
      if (!gateOpen) return; // not reasonably within reach yet
      items.push({ shipId, slot: Number(slot), name: meta.name, targetLevel: 1, currentLevel, isReady: currentLevel >= 1 });
    });
  }
  return items;
}

// Optimizes just ONE ship in place -- prefills its budget the same way "Optimize Loadout"
// does (current Rank Points + any Fleet Boost SP grants + Research #68's SP), runs the real
// optimizer, and merges the result into the existing loadout (creating one if none is active
// yet) rather than replacing every other ship's plan.

let optimizeShipModalShipId = null;
// Opens a per-ship version of Optimize Loadout -- its own budget + its own weight sliders
// (sharing the same persistent gear.focusWeights object as the main modal, so adjustments made
// here carry over there too), so you can weight one ship differently without touching the
// fleet-wide batch settings.
function openOptimizeShipModal(shipId) {
  optimizeShipModalShipId = shipId;
  document.getElementById('optimizeShipTitle').textContent = `Optimize ${shipDisplayName(shipId)}`;
  const input = getShipInput(shipId);
  const prefill = Object.values(input.installs).reduce((a, b) => a + b, 0);
  document.getElementById('optimizeShipPoints').value = prefill;
  const gear = getShipGear();
  const optSettings = getOptimizerSettings();
  const prepWrap = document.getElementById('optimizeShipPrepForLongRunWrap');
  prepWrap.classList.toggle('hidden', shipId !== 5);
  document.getElementById('optimizeShipPrepForLongRun').checked = optSettings.prepForLongRun;
  document.getElementById('optimizeShipPrepForLongRun').onchange = (e) => { optSettings.prepForLongRun = e.target.checked; window.saveStore(); };
  document.getElementById('optimizeShipShortRun').checked = optSettings.runLength === 'short';
  document.getElementById('optimizeShipShortRun').onchange = (e) => { optSettings.runLength = e.target.checked ? 'short' : 'long'; window.saveStore(); };
  renderFocusWeightSliders(document.getElementById('optimizeShipFocusWeights'), gear.focusWeights, document.getElementById('optimizeShipWeightPresetBtn'));
  document.getElementById('optimizeShipModal').classList.remove('hidden');
}
document.getElementById('closeOptimizeShipModalBtn').onclick = () => document.getElementById('optimizeShipModal').classList.add('hidden');
document.getElementById('optimizeShipGenerateBtn').onclick = () => {
  const shipId = optimizeShipModalShipId;
  const budget = Number(document.getElementById('optimizeShipPoints').value) || 0;
  const gear = getShipGear();
  const optSettings = getOptimizerSettings();
  const prepForLongRun = shipId === 5 && optSettings.prepForLongRun;
  const { levels, clicks } = optimizeShipInstalls(shipId, budget, gear.focusWeights, prepForLongRun, optSettings.runLength);
  const activeLoadout = getActiveLoadout();
  activeLoadout.perShip[shipId] = { budget, levels, clicks };
  window.saveStore();
  document.getElementById('optimizeShipModal').classList.add('hidden');
  renderFleetPage(document.getElementById('pageRoot'));
};

function openZaglagChecklistModal(checklist) {
  const allReady = checklist.every((it) => it.isReady);
  document.getElementById('zaglagChecklistBody').innerHTML = `
    <p class="text-xs text-gray-400 mb-3">${allReady ? 'Ready! Zagreus was included in this batch.' : 'Zaglag recommended: wait until these non-Zagreus prerequisites are reached -- Zagreus was left out of this batch.'}</p>
    <ul class="space-y-1.5">
      ${checklist.map((it) => `
        <li class="flex justify-between text-sm bg-gray-700/50 rounded px-3 py-1.5">
          <span class="${it.isReady ? 'text-green-400' : 'text-gray-300'}">${it.isReady ? '✓' : '○'} ${shipDisplayName(it.shipId)} -- ${escapeHtml(it.name)}</span>
          <span class="text-white font-medium">${it.currentLevel}<span class="text-gray-500">/${it.targetLevel}</span></span>
        </li>`).join('')}
    </ul>`;
  document.getElementById('zaglagChecklistModal').classList.remove('hidden');
}
document.getElementById('closeZaglagChecklistModalBtn').onclick = () => document.getElementById('zaglagChecklistModal').classList.add('hidden');

document.getElementById('generateLoadoutBtn').onclick = () => {
  const optSettings = getOptimizerSettings();
  const gear = getShipGear();
  const activeLoadout = getActiveLoadout();
  // The Zaglag checklist is computed HERE, before this batch runs, so it can decide whether
  // Zagreus is still being delayed for THIS generate -- once every reachable Mod-Points node on
  // the other ships has its 1-point readiness requirement met, Zagreus is automatically folded
  // back into the batch and optimized normally, same as any other ship. An empty checklist
  // (nothing reachable yet) does NOT count as ready -- that's "too early to tell", not "done".
  const zaglagChecklist = optSettings.zaglag ? computeZaglagChecklist() : null;
  const zaglagReady = !!zaglagChecklist && zaglagChecklist.length > 0 && zaglagChecklist.every((it) => it.isReady);
  const perShip = {};
  document.querySelectorAll('[data-ship-points]').forEach((el) => {
    const shipId = Number(el.dataset.shipPoints);
    if (optSettings.shipEnabled[shipId] === false) return; // unchecked -- leave untouched, not part of this batch
    if (optSettings.zaglag && shipId === 3 && !zaglagReady) return; // still delaying Zagreus
    const budget = Number(el.value) || 0;
    const { levels, clicks } = optimizeShipInstalls(shipId, budget, gear.focusWeights, shipId === 5 && optSettings.prepForLongRun, optSettings.runLength);
    perShip[shipId] = { budget, levels, clicks };
  });
  activeLoadout.perShip = perShip;
  activeLoadout.zaglagChecklist = zaglagChecklist;
  window.saveStore();
  document.getElementById('newLoadoutModal').classList.add('hidden');
  renderFleetPage(document.getElementById('pageRoot'));
};

// Expands a click sequence into ONE LINE PER CLICK (not grouped by node) -- unlike
// condenseClicks, this is meant to make the real interleaving visible: if the allocator spent
// 130 points, this returns 130 steps in the exact order they were spent, proving no node was
// bulk-bought before another was even touched.
function expandClicks(clicks, catalog, startLevels, shipId) {
  const running = { ...startLevels };
  return clicks.map((slot) => {
    running[slot] = (running[slot] || 0) + 1;
    return {
      name: catalog[slot]?.name || `Slot ${slot}`,
      icon: shipId ? nodeIconPath(shipId, Number(slot)) : null,
      level: running[slot],
      max: shipId ? nodeMaxLevel(shipId, slot) : catalog[slot]?.max,
    };
  });
}
// "Install Order" = the actual per-click sequence used to reach this card's shown levels from
// its Ship Setup baseline. "Effective Path" = the real optimizer's marginal-value ranking
// continued for the next batch of points beyond that, i.e. what to buy next as you earn more.
function openLoadoutDetail(shipId, levels, mode, clicks) {
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  document.getElementById('loadoutDetailTitle').textContent = `${shipDisplayName(shipId)} -- ${mode === 'order' ? 'Install Order' : 'Effective Path'}`;
  let lines;
  let note;
  let nextClicks = null; // only set for 'path' mode -- needed below to commit a confirmed prefix
  if (mode === 'order') {
    lines = expandClicks(clicks || [], catalog, {}, shipId);
    note = 'Every individual point-spend to build this card\'s levels from scratch, in the exact order the optimizer picked them -- interleaved across nodes, never bulk-bought into one node before touching another.';
  } else {
    // Effective Path answers "what should I buy next, right now" -- it finds where your REAL
    // current total install count sits along this same ideal sequence, then shows the next 30
    // ideal clicks past that point. The ideal allocator is a strict one-point-at-a-time greedy
    // process with no backtracking, so any prefix of a larger budget's sequence is identical to
    // the sequence for that smaller budget -- meaning "ideal sequence up to my real total" is a
    // stable reference point even though your real per-node distribution likely doesn't match it.
    const gear = getShipGear();
    const optSettings = getOptimizerSettings();
    const prepForLongRun = shipId === 5 && optSettings.prepForLongRun;
    const realTotal = Object.values(getShipInput(shipId).installs).reduce((a, b) => a + b, 0);
    const full = optimizeShipInstalls(shipId, realTotal + 30, gear.focusWeights, prepForLongRun, optSettings.runLength);
    const atRealTotal = optimizeShipInstalls(shipId, realTotal, gear.focusWeights, prepForLongRun, optSettings.runLength);
    nextClicks = full.clicks.slice(realTotal);
    lines = expandClicks(nextClicks, catalog, atRealTotal.levels, shipId);
    note = 'Every individual point-spend for the next points beyond your current total (once you earn them), in order, following the ideal allocation path -- interleaved across nodes, never bulk-bought. Click an item once you\'ve actually installed it in-game to confirm your real installs up to that point.';
  }
  const body = document.getElementById('loadoutDetailBody');
  body.innerHTML = `
    <p class="text-xs text-gray-500 mb-3">${note}</p>
    <ol class="space-y-1.5">
      ${lines.length ? lines.map((l, i) => `
        <li data-path-item="${i}" class="flex items-center justify-between text-sm bg-gray-700/50 rounded px-3 py-1.5 ${mode === 'path' ? 'cursor-pointer hover:bg-gray-700' : ''}">
          <span class="flex items-center gap-2 text-gray-300">${i + 1}. ${l.icon ? `<img src="${l.icon}" class="w-5 h-5" />` : ''}${escapeHtml(l.name)}</span>
          <span class="flex items-center gap-2">
            <span class="text-white font-medium">${l.level}<span class="text-gray-500">/${l.max}</span></span>
            ${mode === 'path' ? `<button data-confirm-up-to="${i}" class="hidden w-6 h-6 flex-shrink-0 rounded-full bg-green-600 hover:bg-green-500 text-white items-center justify-center text-xs" title="I've installed up to here -- update my real installs">✓</button>` : ''}
          </span>
        </li>`).join('') : '<li class="text-xs text-gray-500">No points to allocate.</li>'}
    </ol>`;
  if (mode === 'path' && nextClicks.length) {
    // Click a row to reveal its confirm checkmark (only one revealed at a time); the checkmark
    // itself commits every click UP TO AND INCLUDING that row into the ship's real installs,
    // then re-opens this same modal so it recomputes from the new real total.
    body.querySelectorAll('[data-path-item]').forEach((li) => {
      li.onclick = () => {
        body.querySelectorAll('[data-confirm-up-to]').forEach((b) => { b.classList.add('hidden'); b.classList.remove('flex'); });
        const btn = li.querySelector('[data-confirm-up-to]');
        btn.classList.remove('hidden');
        btn.classList.add('flex');
      };
    });
    body.querySelectorAll('[data-confirm-up-to]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const upTo = Number(btn.dataset.confirmUpTo);
        const installs = getShipInput(shipId).installs;
        nextClicks.slice(0, upTo + 1).forEach((slot) => { installs[slot] = (installs[slot] || 0) + 1; });
        window.saveStore();
        openLoadoutDetail(shipId, levels, 'path', clicks);
        renderFleetPage(document.getElementById('pageRoot'));
      };
    });
  }
  document.getElementById('loadoutDetailModal').classList.remove('hidden');
}
document.getElementById('closeLoadoutDetailModalBtn').onclick = () => document.getElementById('loadoutDetailModal').classList.add('hidden');

// ============================= Fleet Boosts page (sidebar) =============================
// Renders FLEET_BOOST_ITEMS of the given source ('Inscryption' or 'Loop Mod') into any
// container -- shared by the Inscriptions page's "Fleet" tab and the Loop Mods page's "Show
// Fleet Mods" toggle, so these items live inside the existing hunter upgrade pages instead of
// a separate page.
// Builds the effectBox lines describing what one Fleet Boost item does per level.
function fleetBoostEffectLines(item) {
  const lines = [];
  item.grants.forEach((g) => {
    if (g.sp) lines.push({ label: `${g.ships.map(shipDisplayName).join('/')} SP`, value: `${g.sp}` });
    if (g.crew) lines.push({ label: `${g.ships.map(shipDisplayName).join('/')} Crew`, value: `${g.crew}` });
  });
  if (item.pctEffect) {
    const pe = item.pctEffect;
    const perLabel = pe.per === 'crew' ? 'crew member' : 'rank-up';
    lines.push({ label: `${RESOURCE_LABELS[pe.resource] || pe.resource} / ${perLabel}`, value: `${pe.perLevel}%` });
  }
  return lines;
}
// Renders one Fleet Boost item as a card matching the real Upgrades page's own card style
// exactly (title + level badge, effectBox, chevron/progress-bar/chevron row) -- see
// renderUpgradeInput in app.js, which this mirrors.
function renderFleetBoostCard(item, rerender) {
  const level = getBoostLevel(item);
  const cap = item.max;
  const card = document.createElement('div');
  card.className = 'relative rounded-xl overflow-hidden border border-gray-700/50 bg-gradient-to-br from-gray-800/80 via-gray-800/60 to-gray-900/80 p-4 flex flex-col';
  const lines = fleetBoostEffectLines(item);
  const canDec = level > 0;
  const canInc = level < cap;
  const pct = cap ? (level / cap) * 100 : 0;
  card.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-3">
      <h3 class="font-semibold text-white truncate min-w-0 flex-1 text-[1.05rem]" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
      <div class="px-3 py-1 rounded-lg bg-gray-900/70 border border-gray-700/30"><span class="font-bold text-lg text-gray-300">${level}</span><span class="text-xs text-gray-500">/${cap}</span></div>
    </div>
    ${effectBox(lines)}
    ${item.note ? `<div class="text-xs text-amber-500/90 mb-3">${escapeHtml(item.note)}</div>` : ''}
    <div class="flex items-center justify-between mt-auto pt-2 gap-1.5">
      <button data-min class="ctrl-btn ctrl-btn--gray" ${canDec ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-left', 16)}${iconSvg('chevron-left', 16, '-ml-2.5')}</button>
      <button data-dec class="ctrl-btn ctrl-btn--gray" ${canDec ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-left', 16)}</button>
      <div class="w-full rounded-full overflow-hidden relative h-2 border border-gray-500/20 flex-1 h-5">
        <div class="absolute inset-0 bg-gray-800/90 rounded-full"></div>
        <div class="h-full relative rounded-full transition-all duration-300 overflow-hidden bg-gradient-to-r from-gray-600 via-gray-500 to-gray-400" style="width:${pct}%"></div>
      </div>
      <button data-inc class="ctrl-btn ctrl-btn--gray" ${canInc ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-right', 16)}</button>
      <button data-max class="ctrl-btn ctrl-btn--gray" ${canInc ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-right', 16)}${iconSvg('chevron-right', 16, '-ml-2.5')}</button>
    </div>`;
  const setLevel = (v) => {
    setBoostLevel(item, v);
    window.saveStore();
    rerender();
  };
  card.querySelector('[data-inc]').onclick = () => setLevel(level + 1);
  card.querySelector('[data-dec]').onclick = () => setLevel(level - 1);
  card.querySelector('[data-max]').onclick = () => setLevel(level + 10);
  card.querySelector('[data-min]').onclick = () => setLevel(level - 10);
  return card;
}
// Renders one Badge as a card matching the real Upgrades page's boolean-upgrade card style
// (title + Active/Inactive + toggle switch) -- see renderUpgradeInput's isBoolean branch.
function renderFleetBadgeCard(item, rerender) {
  const badges = getFleetBadges();
  const owned = !!badges.owned[item.key];
  const card = document.createElement('div');
  card.className = 'relative rounded-xl overflow-hidden border border-gray-700/50 bg-gradient-to-br from-gray-800/80 via-gray-800/60 to-gray-900/80 p-4 flex flex-col';
  card.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-2">
      <h3 class="font-semibold text-white text-[1.05rem]" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
      <span class="text-xs font-semibold ${owned ? 'text-green-400' : 'text-gray-500'}">${owned ? 'Active' : 'Inactive'}</span>
    </div>
    ${effectBox([{ label: `${item.ships.map(shipDisplayName).join('/')} Install Power`, value: `x${item.mult}` }])}
    <label class="flex items-center cursor-pointer mt-auto"><input type="checkbox" ${owned ? 'checked' : ''} class="sr-only peer" /><div class="w-10 h-5 bg-gray-700 peer-checked:bg-green-600 rounded-full transition-colors relative"><div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div></div></label>`;
  card.querySelector('input').onchange = (e) => {
    badges.owned[item.key] = e.target.checked;
    window.saveStore();
    rerender();
  };
  return card;
}
// Renders every Fleet Boost item of the given source ('Inscryption', 'Loop Mod', or 'Badge')
// into `container` -- shared by the Inscriptions page's "Fleet" tab, the Loop Mods page's
// "Show Fleet Mods" toggle, and the Research page's Badges section. Grouped by which ship the
// item affects (single-ship items get their own heading; multi-ship/all-fleet items are
// grouped under "Fleet-Wide"), matching the per-ship organization used everywhere else in the
// Fleet tooling, and using the exact same card style as the real Upgrades page.
function renderFleetBoostItemsInto(container, source) {
  container.className = 'col-span-full space-y-5';
  container.innerHTML = '';
  const rerender = () => renderFleetBoostItemsInto(container, source);

  const items = source === 'Badge' ? FLEET_BADGE_ITEMS : FLEET_BOOST_ITEMS.filter((i) => i.source === source);
  if (!items.length) return;

  const groups = new Map(); // shipId|'fleet' -> items[]
  items.forEach((item) => {
    const shipIds = source === 'Badge' ? item.ships : (item.ship ? [item.ship] : null);
    const key = shipIds && shipIds.length === 1 ? shipIds[0] : 'fleet';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const order = [1, 2, 3, 4, 5, 6, 7, 'fleet'];
  order.filter((k) => groups.has(k)).forEach((k) => {
    const section = document.createElement('div');
    const heading = document.createElement('h3');
    heading.className = 'text-sm font-semibold text-gray-300 mb-2 uppercase tracking-wide';
    heading.textContent = k === 'fleet' ? 'Fleet-Wide' : shipDisplayName(k);
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4';
    groups.get(k).forEach((item) => {
      grid.appendChild(source === 'Badge' ? renderFleetBadgeCard(item, rerender) : renderFleetBoostCard(item, rerender));
    });
    section.appendChild(heading);
    section.appendChild(grid);
    container.appendChild(section);
  });
}
window.renderFleetBoostItemsInto = renderFleetBoostItemsInto;

// ============================= Research page (Utility Upgrades sidebar) =============================
// Per cifi.fandom.com/wiki/Research_Catalogue -- only the two ship-install-relevant researches
// (#68, #78); the other ~78 aren't ship-specific. Each research's levels are treated as
// CUMULATIVE (reaching level N keeps every tier 1..N's effect) -- this is an assumption (the
// wiki doesn't state it explicitly), flagged here rather than silently guessed.
const FLEET_RESEARCH_ITEMS = [
  {
    key: 'fleetAnalysis1', name: 'Fleet Analysis 1 (Research #68)', max: 6,
    tiers: [
      'All Rank Installs Max LV x5',
      '+20 All Ships Rank Points & LP',
      '+30 All Ships Rank Points & LP',
      '+40 All Ships Rank Points & LP',
      '+50 All Ships Rank Points & LP',
      '+60 All Ships Rank Points & LP',
    ],
    // Tier 1's "All Rank Installs Max LV x5" is what nodeMaxLevel()/installCapMultiplier()
    // (near GEN_TIERS) check for -- SHIP_NODE_CATALOG's `max` fields store the wiki BASE cap
    // uniformly, and this tier's level (>=1) is the single switch that multiplies it by 5
    // everywhere a node's effective cap is used, so it can never drift out of sync per-node.
  },
  {
    key: 'fleetAnalysis2', name: 'Fleet Analysis 2 (Research #78)', max: 6,
    tiers: [
      'Cradle Installs Bonus x5', 'Auxesia Installs Bonus x5', 'Zagreus Installs Bonus x5',
      'Hephaestus Installs Bonus x5', 'Demeter Installs Bonus x5', 'Koios Installs Bonus x5',
    ],
    shipOrder: [1, 2, 3, 4, 5, 6], // which ship each tier's x5 applies to, cumulative
  },
];
function defaultFleetResearch() {
  const levels = {};
  FLEET_RESEARCH_ITEMS.forEach((item) => { levels[item.key] = 0; });
  return { levels };
}
function getFleetResearch() {
  if (!window.store) return defaultFleetResearch();
  if (!window.store.fleetResearch || !window.store.fleetResearch.levels) window.store.fleetResearch = defaultFleetResearch();
  return window.store.fleetResearch;
}
// Fleet Analysis 1's SP grants (tiers 2-6, cumulative) -- added on top of Fleet Boosts' totals
// for all 7 ships equally.
function computeFleetResearchSp() {
  const research = getFleetResearch();
  const level = research.levels.fleetAnalysis1 || 0;
  const tierSp = [0, 20, 30, 40, 50, 60];
  let sp = 0;
  for (let i = 2; i <= level; i++) sp += tierSp[i - 1];
  return sp;
}
// Fleet Analysis 2's per-ship x5 multiplier, cumulative by tier (tier N unlocks ship
// shipOrder[N-1]) -- returns { [shipId]: 5 } for every ship unlocked so far.
function computeFleetResearchShipMultipliers() {
  const research = getFleetResearch();
  const level = research.levels.fleetAnalysis2 || 0;
  const item = FLEET_RESEARCH_ITEMS[1];
  const mults = {};
  for (let i = 1; i <= level; i++) mults[item.shipOrder[i - 1]] = 5;
  return mults;
}

// Same card shell as renderUpgradeInput/renderFleetBoostCard (title + level badge, tier list,
// chevron/progress-bar/chevron row) -- research tiers stand in for the usual effectBox lines.
function renderFleetResearchCard(item, rerender) {
  const research = getFleetResearch();
  const level = research.levels[item.key] || 0;
  const cap = item.max;
  const card = document.createElement('div');
  card.className = 'relative rounded-xl overflow-hidden border border-gray-700/50 bg-gradient-to-br from-gray-800/80 via-gray-800/60 to-gray-900/80 p-4 flex flex-col';
  const canDec = level > 0;
  const canInc = level < cap;
  const pct = cap ? (level / cap) * 100 : 0;
  card.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-3">
      <h3 class="font-semibold text-white truncate min-w-0 flex-1 text-[1.05rem]" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
      <div class="px-3 py-1 rounded-lg bg-gray-900/70 border border-gray-700/30"><span class="font-bold text-lg text-gray-300">${level}</span><span class="text-xs text-gray-500">/${cap}</span></div>
    </div>
    <div class="bg-gray-900/50 p-3 rounded-md w-full mb-3">
      <ol class="text-xs space-y-1 pl-4 list-decimal">
        ${item.tiers.map((t, i) => `<li class="${i < level ? 'text-green-400' : 'text-gray-500'}">${escapeHtml(t)}</li>`).join('')}
      </ol>
    </div>
    <div class="flex items-center justify-between mt-auto pt-2 gap-1.5">
      <button data-min class="ctrl-btn ctrl-btn--gray" ${canDec ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-left', 16)}${iconSvg('chevron-left', 16, '-ml-2.5')}</button>
      <button data-dec class="ctrl-btn ctrl-btn--gray" ${canDec ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-left', 16)}</button>
      <div class="w-full rounded-full overflow-hidden relative h-2 border border-gray-500/20 flex-1 h-5">
        <div class="absolute inset-0 bg-gray-800/90 rounded-full"></div>
        <div class="h-full relative rounded-full transition-all duration-300 overflow-hidden bg-gradient-to-r from-gray-600 via-gray-500 to-gray-400" style="width:${pct}%"></div>
      </div>
      <button data-inc class="ctrl-btn ctrl-btn--gray" ${canInc ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-right', 16)}</button>
      <button data-max class="ctrl-btn ctrl-btn--gray" ${canInc ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-right', 16)}${iconSvg('chevron-right', 16, '-ml-2.5')}</button>
    </div>`;
  const setLevel = (v) => {
    research.levels[item.key] = Math.max(0, Math.min(cap, v));
    window.saveStore();
    rerender();
  };
  card.querySelector('[data-inc]').onclick = () => setLevel(level + 1);
  card.querySelector('[data-dec]').onclick = () => setLevel(level - 1);
  card.querySelector('[data-max]').onclick = () => setLevel(level + 10);
  card.querySelector('[data-min]').onclick = () => setLevel(level - 10);
  return card;
}
function renderResearchPage(root) {
  root.innerHTML = `
    <div class="mb-4 rounded-lg overflow-hidden shadow-lg">
      <div class="bg-gradient-to-r from-blue-900 to-gray-800 px-5 py-4 border-b border-gray-600">
        <h1 class="text-xl font-bold">Research</h1>
        <p class="text-xs text-gray-300 mt-0.5">Ship-install-relevant Research Center entries.</p>
      </div>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" id="researchList"></div>`;
  const list = document.getElementById('researchList');
  const rerender = () => renderResearchPage(root);
  FLEET_RESEARCH_ITEMS.forEach((item) => { list.appendChild(renderFleetResearchCard(item, rerender)); });
}

window.renderFleetPage = renderFleetPage;
window.renderShipSetupPage = renderShipSetupPage;
window.renderGearSetsPage = renderGearSetsPage;
window.renderResearchPage = renderResearchPage;
function renderBadgesPage(root) {
  root.innerHTML = `
    <div class="mb-4 rounded-lg overflow-hidden shadow-lg">
      <div class="bg-gradient-to-r from-blue-900 to-gray-800 px-5 py-4 border-b border-gray-600">
        <h1 class="text-xl font-bold">Academy Badges</h1>
        <p class="text-xs text-gray-300 mt-0.5">Traded for Innovation/Dark Cores in the Space Academy.</p>
      </div>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" id="badgeList"></div>`;
  renderFleetBoostItemsInto(document.getElementById('badgeList'), 'Badge');
}
window.renderBadgesPage = renderBadgesPage;
