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
// `source`: 'game' = every machine-checkable field of this node is verified against the GAME by a
// bench -- not against the wiki, and not against a screenshot. All 77 nodes are now at that level:
//   name             -> node-name-check.js        (the fleet tooltip titles in the scene)
//   effect's %       -> node-coefficient-check.js (FleetManager's authored baseBonusByCategory)
//   effect's "per X" -> node-counter-check.js     (the counter each RU<Cat><n>Bonus getter reads)
//   gate + base cap  -> ship-node-gate-check.js   (RU<n><Cat>Requirement / RU<n><Cat>MaxLevel)
// The effect PROSE is transcribed word-for-word from the node's own in-game tooltip, which is the
// same text the scene would carry if descriptions were not populated at runtime -- reading it off
// the screen and reading it out of an asset are the same claim about the same string. Its two
// machine-readable parts (the percentage and the "per X" counter) are checked against the game's
// code on top of that, so nothing here is wiki-sourced any more.
// `node-effect-probe.js` additionally proves every node actually MOVES the tool's output, which is
// the failure verification alone cannot catch: a node can have the right name, coefficient, gate,
// cap and counter and still be inert if its effect string does not parse or its resource tag routes
// nowhere.
// A node added later without that verification must NOT be marked 'game'; the UI flags anything
// that is not, so the distinction keeps working for the next addition.
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
    1: { source: 'game', name: 'Mitosis Enhancements', max: 250, ruId: 1, effect: '+10% Cells gained, per crew member' },
    2: { source: 'game', name: 'Improved Timing Belts', max: 25, ruId: 2, gateAtTotalInstalls: 5, effect: '+5% MK1 output, per crew member' },
    3: { source: 'game', name: 'Improved Printing Engines', max: 25, ruId: 3, gateAtTotalInstalls: 5, effect: '+5% MK2 output, per crew member' },
    4: { source: 'game', name: 'Printer Tweaks', max: 20, ruId: 4, gateAtTotalInstalls: 25, gearKey: 'manualMK2Gens', effect: '+0.5% MK1 Generator output, per manually purchased MK2 Generator, per crew member' },
    5: { source: 'game', name: 'Improved Capacitors', max: 20, ruId: 5, gateAtTotalInstalls: 25, effect: '+3% MK3 output, per crew member' },
    6: { source: 'game', name: 'Improved Cooling Systems', max: 10, ruId: 6, gateAtTotalInstalls: 40, effect: '+3% MK4 output, per crew member' },
    7: { source: 'game', name: 'Printer Modulization', max: 15, ruId: 7, gateAtTotalInstalls: 40, gearKey: 'manualMK3Gens', effect: '+0.4% MK2 Generator output, per manually purchased MK3 Generator, per crew member' },
    // Nodes 8-11: `max` corrected 2026-07-31 by direct screenshot comparison against a live
    // account (real caps 500/250/150/200 at 5x research vs this catalog's previous
    // 50/125/75/100 -- the wiki's base values for these 4 "corner" nodes specifically were
    // stale by exactly half; nodes 1-7 matched the wiki fine). `ruId` for 9 and 11 SWAPPED at
    // the same time -- the account's real level (63) showed up on node 11 (Brain Capacity
    // Genetics) in this tool but on node 9 (Improved Generator Equipment) in the real game, same
    // icon/position in both, confirming a pure ruId mis-assignment rather than a layout bug.
    // Only Cradle has been re-verified this way -- Demeter/Auxesia/Zagreus/Hephaestus/Koios/
    // Zeus's nodes 8-11 (and the ruId-identity assumption generally) still need the same check.
    8: { source: 'game', name: 'Molecule Infusing Tech', max: 100, ruId: 8, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.005% output of all Generators, per manual generator purchased, per crew member' },
    9: { source: 'game', name: 'Improved Generator Equipment', max: 50, ruId: 11, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.027% Cells gained, per manual generator purchased, per crew member' },
    10: { source: 'game', name: 'On-Site Mining Printers', max: 30, ruId: 10, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.006% Shards gained, per manual generator purchased, per crew member' },
    11: { source: 'game', name: 'Brain Capacity Genetics', max: 40, ruId: 9, gateAtTotalInstalls: 100, gearKey: 'totalManualGens', effect: '+0.007% Research Points gained, per manual generator purchased, per crew member' },
  },
  2: { // Auxesia -- unlocks Tech Upgrades.
    1: { source: 'game', ruId: 1, name: 'Improved Tech Software', max: 250, effect: '+1% final output of Tech Software upgrades, per crew member' },
    2: { source: 'game', ruId: 2, name: 'Improved Tech Hardware', max: 15, gateAtTotalInstalls: 5, effect: '+1% final output of Tech Hardware upgrades, per crew member' },
    3: { source: 'game', ruId: 3, name: 'Precise Calculations', max: 15, gateAtTotalInstalls: 5, gearKey: 'techUpgrades', effect: '+0.1% Cells gained, per Tech Upgrade currently purchased, per crew member' },
    4: { source: 'game', ruId: 4, name: 'Optimized Chipsets', max: 20, gateAtTotalInstalls: 25, gearKey: 'techUpgrades', effect: '+0.1% MK3 output, per Tech Upgrade currently purchased, per crew member (wiki text as-is -- likely meant MK1 given the node order/name)' },
    5: { source: 'game', ruId: 5, name: 'Optimized Power Supplies', max: 20, gateAtTotalInstalls: 25, gearKey: 'techUpgrades', effect: '+0.1% MK2 output, per Tech Upgrade currently purchased, per crew member' },
    // Nodes 6/7 `max` corrected 2026-09-02 against SirRed's CIFI Ouroboros Helper Tool (its
    // Assembly-CSharp.dll is plain Mono IL, decompiled directly) -- same wiki-understated-cap
    // pattern as nodes 8/11 below (real cap 100 at 5x = base 20, not 15), just not caught by the
    // earlier screenshot pass because that only checked nodes 8-11.
    // max 15, not the wiki's 20: `RU6TechMaxLevel`/`RU7TechMaxLevel` are 15 in the authored
    // FleetManager data. `source: 'confirmed'` covers name/effect/GATE (save-diffed), never the
    // cap -- caps were transcribed from the wiki, and these two were stale there.
    6: { source: 'game', ruId: 6, name: 'Optimized Hard Drives', max: 15, gateAtTotalInstalls: 50, gearKey: 'techUpgrades', effect: '+0.05% MK3 output, per Tech Upgrade currently purchased, per crew member' },
    7: { source: 'game', ruId: 7, name: 'Optimized Cell Vacuum', max: 15, gateAtTotalInstalls: 50, gearKey: 'techUpgrades', effect: '+0.05% MK4 output, per Tech Upgrade currently purchased, per crew member' },
    // Nodes 8/11: `max`/`ruId` corrected 2026-07-31 by direct screenshot comparison against a
    // live account -- same pattern found on Cradle: node 9 and node 11's real levels were
    // swapped (the account's real level showed up on node 9 in-game but node 11 in this tool),
    // and node 8's/node 11's base caps were understated (real caps 125/150 at 5x vs this
    // catalog's previous 75/100).
    8: { source: 'game', ruId: 8, name: 'Modified Cell Turbines', max: 25, gateAtTotalInstalls: 100, gearKey: 'hardwareUpgrades', effect: '+0.04% output of all Generators, per Hardware Upgrade purchased, per crew member' },
    9: { source: 'game', ruId: 11, name: 'Bio-Mech Cell Coating', max: 30, gateAtTotalInstalls: 100, gearKey: 'softwareUpgrades', effect: '+1.32% Cells gained, per Software Upgrade purchased, per crew member' },
    // Coefficient corrected 2026-09-02 against SirRed's decompiled formula (0.0003f, i.e. 0.03%
    // -- the wiki's 0.02% was off by half again, same error class as the max-cap wiki mistakes
    // already fixed elsewhere on this ship).
    10: { source: 'game', ruId: 10, name: 'Shard-Based Cooling Towers', max: 10, gateAtTotalInstalls: 100, gearKey: 'hardwareUpgrades', effect: '+0.03% Shards gained, per Hardware Upgrade purchased, per crew member' },
    11: { source: 'game', ruId: 9, name: 'Robo-Engineer Assistants', max: 30, gateAtTotalInstalls: 100, gearKey: 'softwareUpgrades', effect: '+0.08% Research Points gained, per Software Upgrade purchased, per crew member' },
  },
  3: { // Zagreus -- ranks up by filling Loops. Unlocks Loop Mods / Mod Points.
    1: { source: 'game', ruId: 1, name: 'Accumulation Theory', max: 250, gearKey: 'loopModsOwned', effect: '+0.5% Cells Gained, per Loop Modification owned, per crew member' },
    2: { source: 'game', ruId: 2, name: 'Feedback Theory', max: 10, gateAtTotalInstalls: 5, gearKey: 'loopFillsThisRun', effect: '+0.1% MK1, MK2, MK3 outputs, per loop filled this run, per crew member' },
    3: { source: 'game', ruId: 3, name: 'Deja Vu Theory', max: 10, gateAtTotalInstalls: 5, gearKey: 'loopResetsDone', effect: '+0.1% Mod Points Gained, per Loop Prestige done, per crew member' },
    4: { source: 'game', ruId: 4, name: 'Data Theory', max: 20, gateAtTotalInstalls: 20, gearKey: 'loopModsOwned', effect: '+0.05% MK2 output, per Loop Mod owned, per crew member' },
    5: { source: 'game', ruId: 5, name: 'Flashback Theory', max: 20, gateAtTotalInstalls: 20, gearKey: 'loopModsOwned', effect: '+0.05% MK3 output, per Loop Mod owned, per crew member' },
    // gateAtTotalInstalls corrected 2026-09-02 against the game's own FleetManager scene data
    // (tools/reference/research.json, RU6.Requirement=40) -- the wiki said 20, matching slot
    // 4/5's gate instead of the real value, which actually matches slot 7's 40.
    6: { source: 'game', ruId: 6, name: 'Observation Theory', max: 20, gateAtTotalInstalls: 40, gearKey: 'loopModsOwned', effect: '+0.01% MK4 output, per Loop Mod owned, per crew member' },
    7: { source: 'game', ruId: 7, name: 'Reflection Theory', max: 20, gateAtTotalInstalls: 40, gearKey: 'loopModsOwned', effect: '+0.01% MK3 output, per Loop Mod owned, per crew member (wiki text as-is -- possibly meant "all Generators")' },
    // Nodes 8/9/10/11: `max` corrected 2026-07-31 by direct screenshot comparison against a
    // live account (real caps 150/50/125/100 at 5x). Node 9/11 levels also swapped -- same
    // pattern as Cradle/Auxesia/Hephaestus (account-confirmed directly: real has 1 point on
    // node 9 and 0 on node 11, this tool previously showed the reverse).
    8: { source: 'game', ruId: 8, name: 'Loop Throttle Integrations', max: 30, gateAtTotalInstalls: 100, gearKey: 'loopModsOwned', effect: '+0.01% output of all Generators, per Loop Mod purchased, per crew member' },
    9: { source: 'game', ruId: 11, name: 'C.E.L.L. Mainframe Integration', max: 10, gateAtTotalInstalls: 100, gearKey: 'loopFillsThisRun', effect: '+10% Cells Gained, per Loop Filled this run, per crew member' },
    10: { source: 'game', ruId: 10, name: 'Mining Data Block System', max: 25, gateAtTotalInstalls: 100, gearKey: 'loopModsOwned', effect: '+0.04% Shards Gained, per Loop Mod owned, per crew member' },
    11: { source: 'game', ruId: 9, name: 'Databyte Integrations', max: 20, gateAtTotalInstalls: 100, gearKey: 'loopFillsThisRun', effect: '+0.05% Research Points gained, per Loop Filled this run, per crew member' },
  },
  4: { // Hephaestus -- ranks up by accumulating Cells. Unlocks Automation.
    1: { source: 'game', ruId: 1, name: 'Production Line Connections', max: 250, gearKey: 'automationsUnlocked', effect: '+4% MK1, MK2, MK3, MK4 outputs, per Automation owned, per crew member' },
    2: { source: 'game', ruId: 2, name: 'Delivery Drones', max: 5, gateAtTotalInstalls: 5, gearKey: 'ticksThisLoop', effect: '+0.0003% final output of Software & Hardware Tech Upgrades, per Tick completed, per crew member' },
    3: { source: 'game', ruId: 3, name: 'Modifications Connection', max: 5, gateAtTotalInstalls: 5, gearKey: 'automationsUnlocked', effect: '+0.2% Mod Points Gained, per Automation purchased, per crew member' },
    4: { source: 'game', ruId: 4, name: 'Heavy Duty Grabbies', max: 15, gateAtTotalInstalls: 20, gearKey: 'automationsUnlocked', effect: '+5% Cells Gained, per Automation purchased, per crew member' },
    5: { source: 'game', ruId: 5, name: 'Manual Overkill', max: 15, gateAtTotalInstalls: 20, gearKey: 'totalManualGens', effect: '+0.1% Cells Gained, per manually purchased generator, per crew member' },
    6: { source: 'game', ruId: 6, name: 'Accumulation Modification', max: 5, gateAtTotalInstalls: 60, gearKey: 'totalManualGens', effect: '+0.001% Mod Points Gained, per manually purchased generator, per crew member' },
    7: { source: 'game', ruId: 7, name: 'Fiver Connection', max: 20, gateAtTotalInstalls: 60, gearKey: 'automationsUnlocked', effect: '+2% MK3 output, per Automation owned, per crew member (wiki text as-is -- name suggests MK5)' },
    // Nodes 9-11: `max`/`ruId` corrected 2026-07-31 by direct screenshot comparison against a
    // live account -- same node-9/11 level swap as Cradle/Auxesia, plus 9/10/11 all share the
    // same real cap (425 at 5x = base 85), not the smaller/differing wiki values previously
    // stored. Node 8 already matched (base 40 -> 200 at 5x) and is unchanged.
    8: { source: 'game', ruId: 8, name: 'Faster Transportation', max: 40, gateAtTotalInstalls: 100, effect: '+1% output of all Generators, per crew member (wiki notes: shows as 0.01% in-game)' },
    9: { source: 'game', ruId: 11, name: 'Factory Maintainer Drone', max: 85, gateAtTotalInstalls: 100, gearKey: 'ticksThisLoop', effect: '+0.001% Cells Gained, per Tick Completed, per crew member' },
    10: { source: 'game', ruId: 10, name: 'Auto-Mining Machina', max: 85, gateAtTotalInstalls: 100, gearKey: 'ticksThisLoop', effect: '+0.0001% Shards Gained, per Tick Completed, per crew member' },
    11: { source: 'game', ruId: 9, name: 'Improved Blueprints', max: 85, gateAtTotalInstalls: 100, gearKey: 'ticksThisLoop', effect: '+0.0002% Research Points Gained, per Tick Completed, per crew member' },
  },
  5: { // Demeter -- ranks up by completing Operations. Unlocks Shard Mining.
    1: { source: 'game', name: 'Ahead of the Curve', max: 5, ruId: 1, effect: '+1 completed operation per crew member on new-run start (no immediate shards)' },
    // REVERTED to open-from-start 2026-09-03. A `gateAtTotalInstalls: 1` was added here the day
    // before, from SirRed's CIFI Ouroboros Helper Tool. The GAME's own authored value is
    // `RU2ShardRequirement = 0` and `RU3ShardRequirement = 0` -- both slots ARE open from the
    // start, which is what this catalog said originally. Same failure as the Demeter coefficient
    // incident: a third-party tool overrode a correct value, and inference lost to authored data.
    // SirRed's tool is a baseline, never the source of truth.
    2: { source: 'game', name: 'Better Mineral Extraction', max: 250, ruId: 2, effect: '+1% Shards Gained, per crew member' },
    3: { source: 'game', name: 'Rare Organism Detection', max: 25, ruId: 3, gearKey: 'operationsCompleted', effect: '+0.2% Cells Gained, per Operation Completed, per crew member' },
    4: { source: 'game', name: 'Canned Mineral Water', max: 25, ruId: 4, gateAtTotalInstalls: 10, gearKey: 'operationsCompleted', effect: '+0.02% MK1 & MK4 outputs, per Operation Completed, per crew member' },
    5: { source: 'game', name: 'Bi-Product Goo', max: 25, ruId: 5, gateAtTotalInstalls: 10, gearKey: 'operationsCompleted', effect: '+0.02% MK2 & MK5 outputs, per Operation Completed, per crew member' },
    // REVERTED to 0.001% 2026-09-02, later the same day. It had just been "corrected" to 0.01%
    // against a reading of SirRed's decompiled constants; the GAME's own authored value is
    // RU6ShardBaseBonus = 1e-05, i.e. 0.001% -- so the original wiki figure was right and the
    // correction was a 10x error. Read straight out of the FleetManager MonoBehaviour via
    // reconstructed type trees (tools/il2cpp-cli/typetree.py); asserted by
    // tools/bench/node-coefficient-check.js. Neighbouring nodes confirm the ruId mapping is sound:
    // RU4Shard/RU5Shard are 0.02% and RU8Shard is 2.5%, all matching this catalog exactly.
    6: { source: 'game', name: 'The Hexagonal Advantage', max: 5, ruId: 6, gateAtTotalInstalls: 25, gearKey: 'operationsCompleted', effect: '+0.001% Mod Points gained, per Operation Completed, per crew member' },
    7: { source: 'game', name: 'Shardlytics', max: 10, ruId: 7, gateAtTotalInstalls: 25, gearKey: 'operationsCompleted', effect: '+0.1% MK3 & MK6 outputs, per Operation Completed, per crew member' },
    // Node 9/11 ruId swapped (same universal pattern), node 10's cap corrected 2026-07-31,
    // account-confirmed directly: real cap 625 at 5x (base 125, not 15).
    8: { source: 'game', name: 'Liquid Extraction Tech', max: 5, ruId: 8, gateAtTotalInstalls: 100, effect: '+2.5% output of all Generators, per crew member' },
    // REVERTED to 3% 2026-09-02, same story as node 6 above and the more damaging of the two: the
    // GAME's authored RU11ShardBaseBonus = 0.03, i.e. 3%, not the 30% it had just been "corrected"
    // to. A 10x overstatement on a Cells node is not cosmetic -- it made this the most valuable
    // node on Demeter by an order of magnitude and skewed every plan for the ship.
    9: { source: 'game', name: 'On-Site Printing Vehicles', max: 25, ruId: 11, gateAtTotalInstalls: 100, gearKey: 'operationsCompleted', effect: '+3% Cells Gained, per Operation Completed, per crew member' },
    10: { source: 'game', name: 'On-Site GPR Hotspot Scanners', max: 125, ruId: 10, gateAtTotalInstalls: 100, gearKey: 'operationsCompleted', effect: '+0.08% Shards Gained, per Operation Completed, per crew member' },
    11: { source: 'game', name: 'Phylogenetic Analysis', max: 55, ruId: 9, gateAtTotalInstalls: 100, gearKey: 'operationsCompleted', effect: '+0.04% Research Points gained, per Operation Completed, per crew member' },
  },
  6: { // Koios -- ranks up by completing Studies. Unlocks Research Points. Wiki page had no
    // explicit unlock-requirement numbers (different page format from the others), so every
    // gate here read as unconfirmed (0/none) until corrected 2026-09-02 against the game's own
    // FleetManager scene data (tools/reference/research.json shipTrees.Research, keyed by each
    // node's own ruId) -- ALL 10 of this ship's gated slots were simply missing a gate
    // entirely, not just wrong, so the optimizer/effective-path could offer any of them before
    // its real prerequisite was met. `max` values are the wiki's BASE cap (see nodeMaxLevel).
    1: { source: 'game', ruId: 1, name: 'The Venn Hypothesis', max: 250, gearKey: ['studiesThisLR', 'operationsCompleted'], effect: '+0.25% Cells gained, per completed Study & Operation, per crew member' },
    2: { source: 'game', ruId: 2, name: 'Unobtanium Drills', max: 5, gateAtTotalInstalls: 5, gearKey: 'studiesThisLR', effect: '+0.003% Shards gained, per Study completed, per crew member' },
    3: { source: 'game', ruId: 3, name: 'Modification Thesis', max: 5, gateAtTotalInstalls: 5, gearKey: 'totalCompletedResearch', effect: '+2.5% Mod Points gained, per fully completed Research, per crew member' },
    4: { source: 'game', ruId: 4, name: 'The Study of Threesium', max: 5, gateAtTotalInstalls: 10, gearKey: 'researchLevels', effect: '+0.5% MK3 & MK6 outputs, per level in Researches (a maxed Research counts as 3), per crew member' },
    5: { source: 'game', ruId: 5, name: 'The Big Brainium Thesis', max: 5, gateAtTotalInstalls: 10, gearKey: 'studiesThisLR', effect: '+0.001% Research Points gained, per Study completed, per crew member' },
    6: { source: 'game', ruId: 6, name: 'The Connectivity Thesis', max: 10, gateAtTotalInstalls: 30, effect: '+1% Mod Points & Shards gained, per crew member' },
    7: { source: 'game', ruId: 7, name: 'The Overclocking Thesis', max: 10, gateAtTotalInstalls: 30, gearKey: 'studiesThisLR', effect: '+0.1% MK1, MK2, MK3, MK4, MK5, MK6 outputs, per Study completed, per crew member' },
    // Nodes 8-11: `max` corrected 2026-07-31, account-confirmed directly (real caps
    // 300/150/200/750 at 5x). Node 9/11 ruId swapped -- same universal pattern.
    8: { source: 'game', ruId: 8, name: 'Modified Portable Arcade', max: 60, gateAtTotalInstalls: 100, effect: '+3% output of all Generators, per crew member' },
    9: { source: 'game', ruId: 11, name: 'Improved Mk1 Printing Fuel', max: 30, gateAtTotalInstalls: 100, gearKey: 'studiesThisLR', effect: '+1% Cells gained, per Study completed, per crew member' },
    10: { source: 'game', ruId: 10, name: 'Shard Scanning Breakthrough', max: 40, gateAtTotalInstalls: 100, gearKey: 'studiesThisLR', effect: '+0.01% Shards gained, per Study completed, per crew member' },
    11: { source: 'game', ruId: 9, name: 'Robo-Research Assistants', max: 150, gateAtTotalInstalls: 100, gearKey: 'studiesThisLR', effect: '+0.02% Research Points gained, per Study completed, per crew member' },
  },
  7: { // Zeus -- ranks up by completing Missions. Unlocks Academy Points / Gear Sets. Wiki page
    // had no explicit unlock-requirement numbers -- gates below are user-confirmed directly
    // (not wiki-sourced): Z1/2/3 open at start, Z4/5 at 2 total installs, Z6/7 at 50, Z8-11 at
    // 100. `max` values are the wiki's BASE cap (see nodeMaxLevel).
    1: { source: 'game', ruId: 1, name: 'Academy Janitor Bots', max: 250, gearKey: 'missionsCompleted', effect: '+50% Cells gained, per Mission Completed, per crew member' },
    2: { source: 'game', ruId: 2, name: 'Perfect Student Blueprint', max: 1, effect: '+10% Academy Points gained, per crew member' },
    3: { source: 'game', ruId: 3, name: 'Material Scavenger Vehicles', max: 1, effect: '+25% Mission Materials gained, per crew member' },
    // Node 4/7 `max` corrected 2026-07-31, account-confirmed directly (real caps 75/250 at 5x).
    4: { source: 'game', ruId: 4, name: 'Academy Mining Bots', max: 15, gateAtTotalInstalls: 2, gearKey: 'missionsCompleted', effect: '+0.5% Cells & Shards gained, per Mission Completed, per crew member' },
    5: { source: 'game', ruId: 5, name: 'Database Brain-Link Integration', max: 20, gateAtTotalInstalls: 2, gearKey: 'missionsCompleted', effect: '+0.5% Cells & Research Points gained, per Mission Completed, per crew member' },
    6: { source: 'game', ruId: 6, name: 'Academy Auto-Scrappers', max: 15, gateAtTotalInstalls: 50, effect: '+10% Mission Materials & Mod Points gained, per crew member' },
    7: { source: 'game', ruId: 7, name: 'On-Site Auto Construction', max: 50, gateAtTotalInstalls: 50, effect: '+1% Academy Points gained & All Gens output, per crew member' },
    // Nodes 8-11: `max` corrected 2026-07-31, account-confirmed directly (all four corners cap
    // at 250 at 5x = base 50). Node 9/11 ruId swapped -- same universal pattern.
    8: { source: 'game', ruId: 8, name: 'Remote Printing Facilities', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+1% All Gens output, per Mission Completed, per crew member' },
    9: { source: 'game', ruId: 11, name: 'Academy Flight-Kicks', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+5% Cells gained, per Mission Completed, per crew member' },
    10: { source: 'game', ruId: 9, name: 'Orbital Hotspot Scanner', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+1% Shards gained, per Mission Completed, per crew member' },
    11: { source: 'game', ruId: 10, name: 'Cluster Scans', max: 50, gateAtTotalInstalls: 100, gearKey: 'missionsCompleted', effect: '+1% Research Points gained, per Mission Completed, per crew member' },
  },
};

// Fleet Boosts: Loop Mods with a flat % bonus per rank-up/crew, via `pctEffect`, folded into
// computeResourceBonuses below. Transcribed from cifi.fandom.com/wiki/Loop_Modifications.
//
// Crew/Rank-Up/Rank-Point GRANTING items (the "Free Crew"/"Free Rank-Up" inscriptions, and every
// Loop Mod whose only effect was +sp/+crew) are deliberately NOT modeled here -- removed
// 2026-09-02. The game already stores Crew and Rank Points as single account-wide numbers per
// ship (Ship{n}CrewLevel, Ship{n}RankPoints -- see Ship Setup's rank/crew/rank-point fields,
// which already include the effect of every one of those grants), so re-deriving that same total
// by summing a dozen individual inscription/loop-mod levels was redundant complexity: it can
// only ever match what the account already displays, never add information the typed-in number
// doesn't already have. Removing the sources doesn't remove any real capability -- just type the
// real Crew/Rank Points into Ship Setup directly (or import a save, which fills them in exactly
// the same way). Only items with a REAL, separate effect (a %-bonus that merely scales BY crew
// or rank count, not a source OF it) remain below.
const FLEET_BOOST_ITEMS = [
  // Rule of the Cradle kept its pctEffect (a real, separate +8% All Gens/rank-up bonus); its old
  // `sp: 8` grant (the ONLY thing removed here) is gone for the reason above.
  { key: 'lm_rule_cradle', name: 'Ultima Loop Mod: Rule of the Cradle', source: 'Loop Mod', max: 7, ship: 1, pctEffect: { ships: [1], resource: 'allGens', perLevel: 8, per: 'rank' }, note: 'Grants +8% All Gens output per Cradle rank-up (its own separate +8 Rank Points/level grant is not modeled -- see the note above this list).' },
  // Rank Benefits Modules -- % increase to a specific resource per rank-up, multiplicative.
  { key: 'lm_rb_cra', name: 'Cradle Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 1, pctEffect: { ships: [1], resource: 'cells', perLevel: 2.5, per: 'rank' } },
  { key: 'lm_rb_aux', name: 'Auxesia Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 2, pctEffect: { ships: [2], resource: 'mk1', perLevel: 0.7, per: 'rank' }, note: 'Applies to MK1, MK2, MK3 & MK4 outputs collectively.' },
  { key: 'lm_rb_zag', name: 'Zagreus Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 3, pctEffect: { ships: [3], resource: 'modPoints', perLevel: 2, per: 'rank' } },
  { key: 'lm_rb_hep', name: 'Hephaestus Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 4, pctEffect: { ships: [4], resource: 'mk5', perLevel: 3, per: 'rank' } },
  { key: 'lm_rb_dem', name: 'Demeter Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 5, pctEffect: { ships: [5], resource: 'shards', perLevel: 2, per: 'rank' } },
  { key: 'lm_rb_koi', name: 'Koios Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 6, pctEffect: { ships: [6], resource: 'researchPoints', perLevel: 1, per: 'rank' } },
  { key: 'lm_rb_zeus', name: 'Zeus Rank Benefits Module', source: 'Loop Mod', max: 10, ship: 7, pctEffect: { ships: [7], resource: 'missionMaterials', perLevel: 1, per: 'rank' } },
  // Crew Motivation Modules -- % increase to a specific resource per crew member, multiplicative.
  { key: 'lm_cm_cra', name: 'Cradle Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 1, pctEffect: { ships: [1], resource: 'mk1', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_aux', name: 'Auxesia Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 2, pctEffect: { ships: [2], resource: 'mk2', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_zag', name: 'Zagreus Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 3, pctEffect: { ships: [3], resource: 'mk3', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_hep', name: 'Hephaestus Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 4, pctEffect: { ships: [4], resource: 'mk4', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_dem', name: 'Demeter Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 5, pctEffect: { ships: [5], resource: 'mk5', perLevel: 0.5, per: 'crew' } },
  { key: 'lm_cm_koi', name: 'Koios Crew Motivation Module', source: 'Loop Mod', max: 20, ship: 6, pctEffect: { ships: [6], resource: 'researchPoints', perLevel: 2, per: 'crew' } },
  { key: 'lm_cm_zeus', name: 'Zeus Crew Motivation Module', source: 'Loop Mod', max: 10, ship: 7, pctEffect: { ships: [7], resource: 'academyPoints', perLevel: 0.5, per: 'crew' } },
  // Cost Modification Modules -- divide crew/evolution/generator costs. No cost model exists
  // in this tool (it works off install budgets, not currency), so these are listed for
  // tracking only, not wired into any calculation.
  { key: 'lm_cost_cra', name: 'Cradle Cost Modification Module', source: 'Loop Mod', max: 200, ship: 1, note: 'Divides cost of Cradle crew, evolution, and MK1 generators by 10.' },
  { key: 'lm_cost_aux', name: 'Auxesia Cost Modification Module', source: 'Loop Mod', max: 200, ship: 2, note: 'Divides cost of Auxesia crew, evolution, and MK2 generators by 10.' },
  { key: 'lm_cost_zag', name: 'Zagreus Cost Modification Module', source: 'Loop Mod', max: 200, ship: 3, note: 'Divides cost of Zagreus crew, evolution, and MK3 generators by 10.' },
  { key: 'lm_cost_hep', name: 'Hephaestus Cost Modification Module', source: 'Loop Mod', max: 200, ship: 4, note: 'Divides cost of Hephaestus crew, evolution, and MK4 generators by 10.' },
  { key: 'lm_cost_dem', name: 'Demeter Cost Modification Module', source: 'Loop Mod', max: 200, ship: 5, note: 'Divides cost of Demeter crew, evolution, and MK5 generators by 10.' },
  { key: 'lm_cost_koi', name: 'Koios Cost Modification Module', source: 'Loop Mod', max: 200, ship: 6, note: 'Divides cost of Koios crew, evolution, and MK6 generators by 10.' },
  { key: 'lm_cost_zeus', name: 'Zeus Cost Modification Module', source: 'Loop Mod', max: 200, ship: 7, note: 'Divides cost of Zeus crew, evolution, and MK7 generators by 10.' },
  { key: 'lm_cost_fleet', name: 'Fleet Cost Modification Module', source: 'Loop Mod', max: 200, note: 'Divides cost of all ships crew, evolutions, and MK1-7 generators by 100000.' },
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
//
// The SHAPE (not the literal x7/x3 numbers, which live in a runtime config field invisible to
// static disassembly -- same limit as the relic bonus check above) is now independently
// confirmed too (2026-09-02, disassembled: Badges.get_FinalBadge2Bonus and
// get_FinalDarkBadge1Bonus, both `owned ? storedMultiplier : 1.0`, no per-level scaling) --
// matching exactly what computeFleetBadgeMultipliers already does. Both badges checked follow
// the identical pattern, for whatever that consistency is worth as corroboration.
const FLEET_BADGE_ITEMS = [
  { key: 'badge_innovation', name: 'Innovation Badge', source: 'Badge', ships: [1, 2, 3, 4], mult: 7, note: 'Cradle, Auxesia, Zagreus & Hephaestus rank installs gain x7 power.' },
  // Badge12 is the Innovation Badge's counterpart for the three ships Badge2 does not cover, and it
  // was missing entirely until 2026-09-03. Every check is from the game: `RU<Cat><n>Bonus` reads
  // FinalBadge2Bonus on Gen/Tech/Loop/Auto and FinalBadge12Bonus on Shard/Research/Academy (all 11
  // nodes of each), the authored values are Badge2Bonus = 7 and Badge12Bonus1 = 222, and the name
  // comes from the badge inventory, where AcademyMilestone<N> is Badge<N> -- milestone 2 reads
  // "INNOVATION BADGE" (matching the name we already shipped) and milestone 12 "INNOVATION BADGE #2".
  // Uniform across a ship's nodes, so it cannot reorder an allocation and the batch takes per-ship
  // budgets from the user rather than splitting one -- but it understated Demeter/Koios/Zeus totals
  // by 222x for anyone who owns it.
  { key: 'badge_innovation_2', name: 'Innovation Badge #2', source: 'Badge', ships: [5, 6, 7], mult: 222, note: 'Demeter, Koios & Zeus rank installs gain x222 power.' },
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
// Every remaining Fleet Boost item is a Loop Mod with no confirmed save field for its level yet,
// so all of them fall back to the tool's own custom fleetBoosts.levels store (manual entry only).
function getBoostLevel(item) {
  return getFleetBoosts().levels[item.key] || 0;
}
function setBoostLevel(item, v) {
  const clamped = Math.max(0, Math.min(item.max, v));
  getFleetBoosts().levels[item.key] = clamped;
}
// Every Fleet Boost item's pctEffect at its current level for one ship -> { [resource]: multiplier }
// `per: 'rank'` scales by that ship's rank-up count; `per: 'crew'` by its crew count -- both
// typed directly into Ship Setup (or save-imported), no separate grant aggregation on top (see
// FLEET_BOOST_ITEMS' own header comment for why that layer was removed). Each item's own % converts
// to its own (1 + pct/100) multiplier and multiplies into the resource's running total -- see
// computeResourceBonuses for why (matches how node effects now combine too).
function computeFleetPctBonuses(shipId) {
  const input = getShipInput(shipId);
  const crew = input.crew || 0;
  const rank = input.rank || 0;
  const mults = {};
  FLEET_BOOST_ITEMS.forEach((item) => {
    if (!item.pctEffect) return;
    const level = getBoostLevel(item);
    if (!level || !item.pctEffect.ships.includes(shipId)) return;
    const scale = item.pctEffect.per === 'crew' ? crew : rank;
    const pct = item.pctEffect.perLevel * level * scale;
    if (!pct) return;
    const factor = additiveToMultiplier(pct);
    // Same per-tier split as node effects (see effectResources/computeResourceBonuses) -- an
    // "All Gens" Fleet Boost item (e.g. Rule of the Cradle) contributes to each mk1..mk8 total
    // individually rather than one separate "All Gens" bucket.
    const resKeys = item.pctEffect.resource === 'allGens' ? GEN_TIERS.map((n) => `mk${n}`) : [item.pctEffect.resource];
    resKeys.forEach((res) => { mults[res] = (mults[res] || 1) * factor; });
  });
  return mults;
}

// Ship display names + portrait assets (canonical order 1-7; Ship8 is a special/later ship
// not covered by the wiki's ship list -- seen in-game as "The Ouroboros").
// NOTE: in-game ship names/portraits appear to cycle across Ouroboros constructions -- these
// are the wiki's canonical names, used as the default label, not a guarantee of what a given
// account currently shows.
const SHIP_NAMES = { 1: 'Cradle', 2: 'Auxesia', 3: 'Zagreus', 4: 'Hephaestus', 5: 'Demeter', 6: 'Koios', 7: 'Zeus', 8: 'Ouroboros' };

// Ship EVOLUTION: a per-ship production multiplier, and by far the largest single factor in the
// fleet. Authored values, read as serialized data (tools/reference/authored-values.json,
// FleetManager.EvoBonus<Ship><level>) -- these are not percentages, they ARE the multiplier.
//
// The game computes it in SetShip<n>EvoBonus(evoLevel): switch on the level to pick
// EvoBonus<Ship><level>, then `Pow(thatValue, GemPerks.AttractionGU6BonusCalc)`. The result is
// stored as <Ship>EvolutionBonus and multiplied straight into MK1Production/MK2Production,
// between RUAuto1Bonus and RUGen4Bonus.
//
// AttractionGU6BonusCalc is 1 whenever `AttractionGU6Level == 0` -- the game returns a literal 1
// on that branch -- so for any account without that gem upgrade the multiplier is exactly the
// authored value. When it IS owned the exponent becomes
// Pow(Pow(GemPerks.AttractionGU6BonusExponent, AttractionGU6Level), AttractionQualityPower), whose
// two inputs are not in our data, so `shipEvolutionMultiplier` reports rather than guesses.
//
// This does NOT affect install-allocation ranking: it is the same factor whatever you spend
// points on, so it cannot reorder candidates. It matters for any ABSOLUTE number.
const EVO_BONUS_BY_SHIP = {
  1: { 1: 5, 2: 50, 3: 850, 4: 162000, 5: 5.000000136282112e15, 6: 6e30, 7: 7e60 },  // Cradle
  2: { 1: 2, 2: 8, 3: 36, 4: 850000 },                                               // Auxesia
  3: { 1: 4, 2: 22, 3: 4800, 4: 75000000 },                                          // Zagreus
  4: { 1: 125, 2: 150000000, 3: 3.799999906064644e30, 4: 1e100, 5: 1e500 },          // Hephaestus
  5: { 1: 13, 2: 1300, 3: 130000000 },                                               // Demeter
  6: { 1: 25, 2: 900, 3: 15000000, 4: 2.8000000421329054e30 },                       // Koios
  7: { 1: 2, 2: 4, 3: 12, 4: 48, 5: 240, 6: 2440 },                                  // Zeus
};

/**
 * The production multiplier this ship's evolution level grants. 1 when un-evolved.
 * @param {number} shipId
 * @param {number} [evoLevel] defaults to the ship's own stored evo level
 * @returns {number}
 */
function shipEvolutionMultiplier(shipId, evoLevel) {
  const level = Number(evoLevel != null ? evoLevel : getShipInput(shipId).evo) || 0;
  if (level <= 0) return 1;
  const table = EVO_BONUS_BY_SHIP[shipId];
  if (!table) return 1;
  // Levels above the highest authored one hold at the top value rather than silently reverting to
  // 1 -- a missing entry means our table is behind the game, not that the bonus vanished.
  const levels = Object.keys(table).map(Number).sort((a, b) => a - b);
  const use = table[level] != null ? table[level] : table[levels[levels.length - 1]];
  return use;
}

// Two further multipliers sit inside EVERY install node's bonus, alongside the badges and Fleet
// Analysis term we already apply (see the RUGen2Bonus chain in CLAUDE.md):
//
//   GemPerks.FinalPowerGU1Bonus
//   ResearchLaboratory.FinalAllShipsInstallsBonus  ( = FinalRU83InstallsBonus * FinalRU96InstallsBonus )
//
// Both are UNIFORM across a ship's nodes, so they scale every candidate equally and cannot reorder
// the optimizer -- but they do scale the magnitudes.
//
// POWER GU1, now fully known. From GemPerks.PowerGU1BonusCalc:
//
//   if (PowerGU1Level <= 0) return 1;
//   a = Pow(1 + PowerGU1BonusExponentCrew * PowerGU1Level, FleetManager.FinalCradleCrew)
//   b = Pow(1 + PowerGU1BonusExponentRank * PowerGU1Level, FleetManager.FinalCradleRank)
//   return Pow(a * b, PowerQualityPower)
//
// It reads CRADLE's crew and rank specifically, even though the result multiplies every ship's
// install bonuses. The two coefficients are authored (0.0012 and 0.02) and are only readable
// because the type-tree enum fix landed -- GemPerks was unreadable before it. PowerQualityPower is
// 1 unless PowerQualityLevel >= 2, and that branch has an operand Cpp2IL could not resolve, so it
// is reported rather than guessed.
const POWER_GU1_CREW_COEFF = 0.0012;   // GemPerks.PowerGU1BonusExponentCrew
const POWER_GU1_RANK_COEFF = 0.02;     // GemPerks.PowerGU1BonusExponentRank

/** The PowerGU1 level, once it is an input. Not yet in the gem store -- see the note below. */
function powerGU1Level() {
  const gems = (window.store && window.store.gems) || {};
  const power = gems.power || {};
  return Number((power.upgrades && power.upgrades.gu1) || 0) || 0;
}

/**
 * The global multiplier applied to every install node's bonus.
 * Exactly 1 when its sources are unowned, which is the common case and is what the game returns.
 * @returns {number}
 */
function installBonusGlobalMultiplier() {
  const level = powerGU1Level();
  if (level <= 0) return 1;   // the game returns a literal 1 on this branch
  const cradle = getShipInput(1);
  const crew = Number(cradle.crew) || 0;
  const rank = Number(cradle.rank) || 0;
  // PowerQualityPower is 1 below quality level 2; the >= 2 branch is unmodelled and reported.
  return Math.pow(1 + POWER_GU1_CREW_COEFF * level, crew)
    * Math.pow(1 + POWER_GU1_RANK_COEFF * level, rank);
}

/** Install-bonus multipliers we cannot compute for this account. Empty when the model is exact. */
function unmodelledInstallBonusTerms() {
  const gems = (window.store && window.store.gems) || {};
  const research = (window.store && window.store.fleetResearch && window.store.fleetResearch.levels) || {};
  const out = [];
  // PowerGU1's own maths is modelled; what is not is (a) the quality-2+ exponent, whose operand
  // Cpp2IL could not resolve, and (b) the LEVEL itself, which the gem store does not carry yet --
  // it tracks a tree level, node booleans and named upgrades, but not per-GU levels. Until that
  // input exists the level reads 0 and the multiplier is 1, which is right for any account
  // without the upgrade and wrong for one with it. Say so rather than look confident.
  const quality = Number((gems.power && gems.power.qualityLevel) || 0) || 0;
  if (quality >= 2) {
    out.push(`Power quality ${quality} raises the PowerGU1 bonus to an exponent this tool cannot compute`);
  }
  const ru83 = Number(research.ru83 || 0) || 0;
  const ru96 = Number(research.ru96 || 0) || 0;
  if (ru83 > 0 || ru96 > 0) {
    out.push(`RU83/RU96 all-ships installs bonus (levels ${ru83}/${ru96}) is not modelled`);
  }
  return out;
}

/** Evolution factors we cannot compute for this account, for honest reporting. Empty when fine. */
function unmodelledEvolutionTerms() {
  const gems = (window.store && window.store.gems) || {};
  const gu6 = Number(gems.attractionGU6Level || gems.AttractionGU6Level || 0) || 0;
  return gu6 > 0
    ? [`AttractionGU6 (level ${gu6}) raises every evolution bonus to a power this tool cannot compute`]
    : [];
}
const SHIP_PORTRAITS = { 1: 'cradle', 2: 'auxesia', 3: 'zagreus', 4: 'hephaestus', 5: 'demeter', 6: 'koios', 7: 'zeus', 8: 'ouroboros' };
// What each ship actually ranks up by, per cifi.fandom.com's ship pages -- drives the Ship
// Setup page's "progress toward next rank" field label.
const SHIP_RANKUP_METRIC = { 1: 'Generators Purchased', 3: 'Loops Filled', 4: 'Cells Accumulated', 5: 'Operations Completed', 6: 'Studies Completed', 7: 'Missions Completed' };
// Community shorthand prefix for install codes (e.g. "CRA1", "DEM8") -- matches
// cifi.fandom.com's per-ship pages and the Gear Sets table.
const SHIP_CODE_PREFIX = { 1: 'CRA', 2: 'AUX', 3: 'ZAG', 4: 'HEP', 5: 'DEM', 6: 'KOI', 7: 'ZEUS' };
// Real node icon assets (webapp/public/assets/nodes/{CODE}.png, e.g. CRA1.png, DEM8.png).
// Cradle/Auxesia/Zagreus/Hephaestus/Demeter came from cifi.fandom.com's per-ship pages. The wiki
// has no Koios or Zeus pages, so those two were cut from in-game screenshots instead
// (tools/assets/extract-node-icons.py) -- Zeus at the same ~128px as the wiki set, Koios still at
// the older 55x65 and worth redoing the same way. Ouroboros has no SHIP_CODE_PREFIX entry at all,
// so it returns null here and the <img onerror> falls back to a plain tile.
function nodeIconPath(shipId, code) {
  const prefix = SHIP_CODE_PREFIX[shipId];
  return prefix ? `assets/nodes/${prefix}${code}.png` : null;
}

// Which global RU registry category (see shipSchema.js) each ship's install grid reads from.
// CONFIRMED for all 8 ships (2026-09-02) by disassembling each category's BuyRU1<Category>()
// handler directly against libil2cpp.so (capstone; r2/Ghidra were blocked by this machine's
// Application Control policy at the time) and reading which Ship{n}RankPoints struct offset
// each one decrements -- cross-checked against dump.cs's own field-offset comments, e.g.
// BuyRU1Shard decrements MasterManager+0x4AF8, which dump.cs declares as `Ship5RankPoints`. This
// also independently confirms the earlier live-diff results for ships 1 and 5, and settles 2-4/6/7
// which were previously only a thematic guess. Each category has 13 numbered slots in the game's
// own data (tools/reference/research.json), not 11 -- the 11-slot grid seen in the save's
// Ship{n}RU{1-11}AutomationLevelGoal fields is an auto-buy TARGET setting, a different thing (see
// shipSchema.js). Ship 8 (Ouroboros) owns the 8th category, Ouroboros -- not in SHIP_NODE_CATALOG
// above since it has no wiki page (nodes are largely unreleased; see research.json's Ouroboros
// tree for the 5 real, low-cap nodes that do exist).
const SHIP_CATEGORY = {
  1: 'Gen', 2: 'Tech', 3: 'Loop', 4: 'Auto', 5: 'Shard', 6: 'Research', 7: 'Academy', 8: 'Ouroboros',
};

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

// Demeter's "Ahead of the Curve" (ship 5, slot 1). Its payoff lands at the start of the NEXT
// loop reset rather than the active run, so the marginal-value engine cannot score it: there is
// no % in its effect text and no immediate resource gain to weigh against anything else. The
// policy is to max it outright once the budget is comfortably large, or when explicitly prepping
// for a long run, and otherwise skip it entirely so scarce points go to direct multipliers.
//
// Named rather than left as bare `shipId === 5 && slot === '1'` literals scattered across the
// file -- the rule is unusual enough that it needs to be findable when it next comes up.
const AOTC_SHIP_ID = 5;
const AOTC_SLOT = '1';
const AOTC_AUTO_MAX_BUDGET = 15;

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
  // 'allGens' is kept as a marker tag (nodeMarginalLogGain/nodeTiePriority/etc still check
  // for it to detect "this is an all-gens effect"), but the actual per-tier mk1..mk8 tags are
  // ALSO pushed here so every resource-totals consumer (computeResourceBonuses/nodeOwnBonusPct)
  // folds an All-Gens node's contribution into each tier's OWN total individually, instead of
  // bucketing it under one separate "All Gens" pseudo-resource -- each generator tier needs to
  // be factored separately (not lumped together) so the displayed totals show an All-Gens node's
  // real contribution to each tier.
  if (/all generators|all gens\b/i.test(effect)) {
    tags.push('allGens');
    GEN_TIERS.forEach((n) => tags.push(`mk${n}`));
  }
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
// `allLevels` is optional and only matters on Demeter: Ahead Of The Curve grants operations, and
// operations are the counter this ship's other nodes multiply by, so a node's real bonus depends on
// how many AOTC levels are also owned. Callers that have the whole allocation (computeResourceBonuses)
// pass it, so the displayed totals show the same coupling the optimizer prices. Callers that only
// have one node's level omit it and get the uncoupled figure, which is what they were showing before.
function nodeOwnBonusPct(shipId, slot, level, allLevels) {
  const meta = SHIP_NODE_CATALOG[shipId]?.[slot];
  if (!meta || !level) return 0;
  const m = meta.effect.match(/([\d.]+)%/);
  if (!m) return 0;
  const gear = getShipGear();
  const crew = getShipInput(shipId).crew || 0;
  let gearMult = gearMultiplierFor(meta.gearKey, gear);
  if (allLevels && shipId === AOTC_SHIP_ID && meta.gearKey === AOTC_GRANT_COUNTER) {
    gearMult = effectiveOpsFor(shipId, allLevels);
  }
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
    const pct = nodeOwnBonusPct(shipId, slot, lvl, levels);
    if (!pct) return;
    const factor = additiveToMultiplier(pct);
    // 'allGens' is a detection-only marker (see effectResources) -- its equivalent contribution
    // is already fully captured via the individual mk1..mk8 tags pushed alongside it, so it's
    // skipped here to avoid a redundant separate "All Gens" total that would double-count
    // against each tier's own total (and would collapse the per-tier Meltdown melt into one
    // combined figure instead of each tier's own).
    effectResources(meta.effect).forEach((res) => { if (res === 'allGens') return; mults[res] = (mults[res] || 1) * factor; });
  });
  // Fleet Boost items with a pctEffect (Rank Benefits / Crew Motivation Modules, Rule of the
  // Cradle) grant a flat % to one specific resource, independent of install levels -- each
  // item's own factor multiplies into the same per-resource totals as the nodes above.
  mergeResourceTotals(mults, computeFleetPctBonuses(shipId));
  // Ship EVOLUTION multiplies the ship's generator output directly -- it is a plain factor in the
  // game's MK1Production/MK2Production chain (see shipEvolutionMultiplier). It applies to the
  // GENERATOR tiers, not to direct Cells/Shards/RP, which is why it is merged per gen-like tag
  // rather than across everything. Independent of install levels, so it never reorders the
  // optimizer's candidates -- but leaving it out understated these totals by a factor of 162,000
  // on the reference account's Cradle alone.
  const evo = shipEvolutionMultiplier(shipId);
  if (evo !== 1) {
    GEN_TIERS.forEach((n) => { const k = `mk${n}`; if (mults[k]) mults[k] *= evo; });
    TECH_UPGRADE_TAGS.forEach((t) => { if (mults[t]) mults[t] *= evo; });
  }
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
// totalManualGens is shared by Cradle+Hephaestus and operationsCompleted by Demeter+Koios --
// editing either ship's copy of a shared field updates the same store value.
//
// CORRECTED: this comment used to name the save fields as `ManualGensAllTime` and
// `NewSMOperationsAllTime`. Both are wrong -- saveImport actually reads `ManualGensThisLR` and
// `NewSMOperationsThisLoop` (shipSchema.js), i.e. counters that RESET, not all-time totals. The
// distinction is not cosmetic: it is exactly what decides whether a counter grows meaningfully
// within one planning horizon, which is the question GROWTH_GEAR_KEYS below exists to answer.
const SHIP_GEAR_FIELDS = {
  1: [['manualMK2Gens', 'Manually Purchased MK2 Generators'], ['manualMK3Gens', 'Manually Purchased MK3 Generators'], ['totalManualGens', 'Total Manually Purchased Generators']],
  2: [['techUpgrades', 'Tech Upgrades Purchased (combined)'], ['hardwareUpgrades', 'Hardware Upgrades Purchased'], ['softwareUpgrades', 'Software Upgrades Purchased']],
  3: [['loopModsOwned', 'Loop Mods Owned'], ['loopFillsThisRun', 'Loop Fills This Run'], ['loopResetsDone', 'Loop Resets Done']],
  4: [['automationsUnlocked', 'Automations Unlocked'], ['ticksThisLoop', 'Ticks This Loop'], ['totalManualGens', 'Total Manually Purchased Generators']],
  5: [['operationsCompleted', 'Operations Completed']],
  6: [['operationsCompleted', 'Operations Completed'], ['studiesThisLR', 'Studies This Loop Reset'], ['researchLevels', 'Research Levels'], ['totalCompletedResearch', 'Total Completed Research']],
  7: [['missionsCompleted', 'Missions Completed']],
};
// gearKey -> the label the UI already shows for it, so a warning names the field the player has
// to go and edit rather than an internal key. SHIP_GEAR_FIELDS is the single source of those
// labels; falls back to the raw key so a newly-added counter can never render as "undefined".
function gearFieldLabel(key) {
  for (const fields of Object.values(SHIP_GEAR_FIELDS)) {
    const hit = fields.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return key;
}
// Which of THIS ship's resetting "per X" counters are currently 0. Shared by the allocator (which
// returns it as a warning) and by the optimize modal (which shows it before you generate a plan,
// where you can still fix the input). Same logic in one place so the two cannot disagree.
function growthCounterWarnings(shipId) {
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  const gear = getShipGear();
  const zeroed = [...new Set(Object.values(catalog)
    .flatMap((m) => (Array.isArray(m.gearKey) ? m.gearKey : [m.gearKey]))
    .filter((k) => k && GROWTH_GEAR_KEYS.has(k) && !(gear[k] > 0)))];
  if (!zeroed.length) return [];
  return [{
    kind: 'zeroGrowthCounter',
    keys: zeroed,
    message: `${zeroed.map(gearFieldLabel).join(', ')} ${zeroed.length > 1 ? 'are' : 'is'} 0, so `
      + 'every node that scales with it is valued at zero and excluded from this plan. Those '
      + 'counters reset each run -- enter a typical mid-run value for a meaningful allocation.',
  }];
}
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
  Object.keys(window.store.shipGear).forEach((k) => { if (!(k in defaults)) delete window.store.shipGear[k]; });
  Object.keys(defaults.focusWeights).forEach((k) => { if (!(k in window.store.shipGear.focusWeights)) window.store.shipGear.focusWeights[k] = defaults.focusWeights[k]; });
  Object.keys(window.store.shipGear.focusWeights).forEach((k) => { if (!(k in defaults.focusWeights)) delete window.store.shipGear.focusWeights[k]; });
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
// costBase/costScalar: cost(level) = costBase * costScalar^level (Academy Points to reach that
// level from level-1) -- UNCONFIRMED, source: a community fan spreadsheet's "Pre-Calc" tab
// (Google Sheets, provided by the account holder), not the wiki and not this account's own real
// data. Treat at LOWER confidence than a `source: 'wiki'` catalog entry: that sheet's own formula
// cells were broken (#REF! errors) at the time this was harvested, Red's "Gamma Round" base (44)
// is a suspicious outlier next to its neighbors (3/5/6/7), and all 3 Purple pieces show the
// identical base/scalar pair, which may mean Purple really is uniform or may mean the reference
// that varies per-piece got flattened by the same corruption. Cross-check against your own
// account's real Academy Points cost before trusting the Gear Effective Path's exact ordering.
const REAL_GEAR_PIECES = [
  { name: 'Oceanic Specimen', color: 'Purple', setBonus: 'x25 Shards Gained', install1: 'KOI6', install2: 'DEM2', costBase: 10, costScalar: 1.14 },
  { name: 'Venomous Specimen', color: 'Purple', setBonus: 'x999 Cells Gained', install1: 'KOI4', install2: 'HEPH3', costBase: 10, costScalar: 1.14 },
  { name: 'Curious Specimen', color: 'Purple', setBonus: 'x25 Research Points Gained', install1: 'KOI5', install2: 'AUX6', costBase: 10, costScalar: 1.14 },
  { name: 'Terran Fuel Cell', color: 'Orange', setBonus: 'x1.5 Academy Points Gained', install1: 'KOI7', install2: 'AUX5', costBase: 4, costScalar: 1.1 },
  { name: 'Diamond Infused Cell', color: 'Orange', setBonus: 'Gain 3000 Diamonds', install1: 'KOI3', install2: 'AUX4', costBase: 4, costScalar: 1.13 },
  { name: 'Ceti-Powered Energy Cell', color: 'Orange', setBonus: 'x7 Research Points Gained', install1: 'KOI6', install2: 'AUX1', costBase: 4, costScalar: 1.14 },
  { name: 'Ixion Infused Cell', color: 'Orange', setBonus: 'x7 Shards Gained', install1: 'KOI2', install2: 'AUX3', costBase: 4, costScalar: 1.11 },
  { name: 'Cell Based Loop-Tank', color: 'Red', setBonus: 'x75 Cells Gained', install1: 'HEPH1', install2: 'ZAG3', costBase: 5, costScalar: 1.12 },
  { name: 'Field Hard Drive', color: 'Red', setBonus: 'x2 Research Points Gained', install1: 'DEM1', install2: 'ZAG4', costBase: 3, costScalar: 1.1 },
  { name: 'Gravity Bomb', color: 'Red', setBonus: 'x1.5 Academy Points Gained', install1: 'ZAG2', install2: 'ZAG5', costBase: 44, costScalar: 1.11 }, // 44 is the suspicious outlier -- see note above
  { name: 'Gamma Rounds', color: 'Red', setBonus: 'x60 Cells Gained', install1: 'ZAG7', install2: 'ZAG1', costBase: 6, costScalar: 1.13 },
  { name: 'Loop Gun', color: 'Red', setBonus: 'x10 Mod Points Gained', install1: 'DEM6', install2: 'ZAG6', costBase: 7, costScalar: 1.14 },
  { name: 'Cell Battery', color: 'Green', setBonus: 'x500 Cells Gained', install1: 'CRA1', install2: 'HEPH5', costBase: 3, costScalar: 1.1 },
  { name: 'Constructor Suit', color: 'Green', setBonus: 'x2.5 Mod Points Gained', install1: 'ZAG2', install2: 'HEPH6', costBase: 7, costScalar: 1.14 },
  { name: 'Research Supplies', color: 'Green', setBonus: 'x8 Research Points Gained', install1: 'KOI5', install2: 'HEPH1', costBase: 4, costScalar: 1.11 },
  { name: 'Cell Gun', color: 'Green', setBonus: 'x1.5 Academy Points Gained', install1: 'DEM6', install2: 'HEPH7', costBase: 5, costScalar: 1.12 },
  { name: 'Drone Shield', color: 'Green', setBonus: 'x750 Cells Gained', install1: 'HEPH4', install2: 'HEPH2', costBase: 6, costScalar: 1.13 },
  { name: 'Scout Droid', color: 'Blue', setBonus: 'x10 Research Points Gained', install1: 'AUX2', install2: 'DEM3', costBase: 5, costScalar: 1.12 },
  { name: 'Mining Drone', color: 'Blue', setBonus: 'x15 Shards Gained', install1: 'DEM2', install2: 'DEM1', costBase: 3, costScalar: 1.1 },
  { name: 'Crysis Suit', color: 'Blue', setBonus: 'x320 Cells Gained', install1: 'HEPH5', install2: 'DEM4', costBase: 4, costScalar: 1.11 },
  { name: 'Beta-Rounds', color: 'Blue', setBonus: 'x80 Cells Gained', install1: 'HEPH3', install2: 'DEM7', costBase: 6, costScalar: 1.13 },
  { name: 'Shard Gun', color: 'Blue', setBonus: 'x1.5 Academy Points Gained', install1: 'DEM6', install2: 'DEM5', costBase: 7, costScalar: 1.14 },
  // WHITE -- the wiki does not document this set, so unlike every piece above these come from the
  // GAME. Every field is now sourced; nothing here is inferred:
  //  * install1/install2 are the STRONGEST data in this whole table: taken from the game's own
  //    `RU<Category><n>Bonus` dispatch (tools/reference/gear-install-map.json), not transcribed.
  //    This is the field the optimizer is actually sensitive to -- gear is our only per-NODE and
  //    exponential multiplier -- so getting these five pieces in at all is the point of the entry.
  //  * costBase 6 is `WhiteItem<N>.BaseCost` read straight off the authored asset (all five are 6).
  //  * costScalar 1.14 is `CostTier = Tier5`, resolved through the tier->scalar table that all 22
  //    pieces above agree on exactly (0->1.10, 1->1.11, 2->1.12, 3->1.13, 4->1.14). Note this
  //    DISPROVES the tempting "scalar = 1.1 + (base-3)*0.01" shortcut -- the Orange pieces all share
  //    base 4 across tiers 0/3/4/1 -- so the tier is what decides, not the base cost.
  //  * names are the game's own, from the crafting menu's `ItemSelectionLayout/<row>/ReqBox/
  //    DescText` (tools/reference/gear-names.json). The menu's 37 rows are 3 Purple + 4 Orange +
  //    5 Red + 5 Green + 5 Blue -- our exact colour sizes, in our exact order, with 19 of those 22
  //    names matching character for character -- and then 15 gem-gated rows, of which White is the
  //    first five. That block alignment is what pins these five names to these five pieces.
  //    (The same check corrected three wiki typos above: Loop-Tank, Gamma Rounds, Crysis Suit.)
  //  * setBonus resource comes from `Gear.SetGearSetBonuses()`, which multiplies each
  //    `<Color>SetBonus<N>` into a specific resource total, and the magnitude from the authored
  //    asset (tools/reference/gear-set-bonus-map.json carries both). Worth knowing this was NOT
  //    guessable: `CheckWhiteSetBonusTexts()` refreshes the Cells, RP, Shards and AP labels, which
  //    reads like the answer and is wrong -- White touches Mod Points and NOT Research Points. The
  //    text refresher is stale; the aggregator is the math. The same extraction reproduces all 22
  //    wiki-sourced bonuses exactly, which is what licenses trusting it for White.
  //  * White is gated behind Gem Of Power quality 2 (the row's own GameObject name says so), so an
  //    account without it cannot own these at all.
  { name: 'Cell Sprayer', color: 'White', setBonus: 'x1e+50 Cells Gained', install1: 'CRA4', install2: 'HEPH8', costBase: 6, costScalar: 1.14 },
  { name: 'Cell Miner Machina', color: 'White', setBonus: 'x1e+65 Cells Gained', install1: 'CRA8', install2: 'HEPH10', costBase: 6, costScalar: 1.14 },
  { name: 'Epsilon Handcannon', color: 'White', setBonus: 'x2.5 Academy Points Gained', install1: 'ZEUS2', install2: 'CRA11', costBase: 6, costScalar: 1.14 },
  { name: 'Enhanced Mining Suit', color: 'White', setBonus: 'x150 Shards Gained', install1: 'CRA6', install2: 'DEM10', costBase: 6, costScalar: 1.14 },
  { name: 'On-Site Med Kits', color: 'White', setBonus: 'x10 Mod Points Gained', install1: 'CRA10', install2: 'ZAG11', costBase: 6, costScalar: 1.14 },
];
// Old piece name -> current one, for accounts that saved levels under the wiki's spelling. The
// first three were transcription errors the game's own crafting-menu labels corrected; the White
// five were placeholders shipped before those labels were found.
const GEAR_PIECE_RENAMES = {
  'Cell Based Loop Tank': 'Cell Based Loop-Tank',
  'Gamma Round': 'Gamma Rounds',
  'Chrysis Suit': 'Crysis Suit',
  'White Piece 1': 'Cell Sprayer',
  'White Piece 2': 'Cell Miner Machina',
  'White Piece 3': 'Epsilon Handcannon',
  'White Piece 4': 'Enhanced Mining Suit',
  'White Piece 5': 'On-Site Med Kits',
};
function defaultGearSets() {
  return { pieces: REAL_GEAR_PIECES.map((p) => ({ ...p, level: 0, owned: false })) };
}
function getGearSets() {
  if (!window.store) return defaultGearSets();
  if (!window.store.gearSets || !('pieces' in window.store.gearSets)) window.store.gearSets = defaultGearSets();
  // Reconcile the stored list against REAL_GEAR_PIECES, keyed by name: REAL_GEAR_PIECES owns every
  // game-sourced field (color, installs, set bonus, cost curve) and the store owns only the user's
  // own state (level, owned). So a piece we have since ADDED appears, a piece we have since removed
  // or renamed disappears, and a corrected install target or cost reaches an existing account
  // instead of being frozen at whatever was saved.
  //
  // This replaces a narrower costBase/costScalar backfill that sat here. That patch treated one
  // symptom of this same root cause -- the stored list being authoritative -- and adding the White
  // set proved the general case was still broken: the five new pieces never appeared for anyone who
  // had ever opened the Ships page, so `getGearSets().pieces.filter(color === 'White')` was empty
  // while the freshly-seeded defaults looked perfectly correct. Same prune-and-merge shape as
  // getShipGear above; keep the two consistent.
  //
  // Existing piece objects are UPDATED IN PLACE rather than replaced. Rebuilding the array on every
  // call detaches any reference a caller is holding, so a `piece.level = n` written after some
  // unrelated getGearSets() call lands on an orphan and is silently lost. That is not theoretical:
  // it bit the first test written against this function.
  const byName = new Map(window.store.gearSets.pieces.map((p) => [p.name, p]));
  // Pieces are matched by NAME, so correcting a name to the game's own spelling would otherwise
  // orphan that piece's saved level and reset it to 0. These four were renamed once the crafting
  // menu gave us the real strings; keep the map rather than silently losing a user's levels.
  Object.entries(GEAR_PIECE_RENAMES).forEach(([oldName, newName]) => {
    if (byName.has(oldName) && !byName.has(newName)) byName.set(newName, byName.get(oldName));
  });
  window.store.gearSets.pieces = REAL_GEAR_PIECES.map((real) => {
    const saved = byName.get(real.name);
    if (!saved) return { ...real, level: 0, owned: false };
    const level = saved.level || 0;
    const owned = !!saved.owned;
    return Object.assign(saved, real, { level, owned });
  });
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
// CORRECTED 2026-08, account-confirmed: every piece's own Set Bonus (e.g. "x25 Shards Gained")
// only activates once ALL pieces of that piece's COLOR are owned -- not per-piece as an earlier
// version of this tool assumed. Each piece still keeps its own distinct bonus text (Purple's 3
// pieces grant x25 Shards / x999 Cells / x25 Research Points respectively, not one shared
// bonus) -- completing the color simply unlocks all of those pieces' bonuses simultaneously,
// rather than each unlocking individually as it's owned. A flat multiplier on top of the whole
// resource total, independent of install level. Returns { [resource]: multiplier } (multiple
// active pieces hitting the same resource stack multiplicatively). Non-resource bonuses (flat
// Diamond grants) aren't tracked -- no Diamond total exists in this tool.
function computeGearSetBonusMultipliers() {
  const gearSets = getGearSets();
  const byColor = {};
  gearSets.pieces.forEach((p) => { (byColor[p.color] = byColor[p.color] || []).push(p); });
  const mults = {};
  Object.values(byColor).forEach((pieces) => {
    if (!pieces.every((p) => p.owned)) return; // whole color must be complete
    pieces.forEach((p) => {
      // Exponent notation is required, not cosmetic: the White set's Cells bonuses are x1e+50 and
      // x1e+65, and a plain [\d.]+ pattern silently fails to match them, dropping the two largest
      // multipliers in the whole table.
      const m = p.setBonus.match(/^x([\d.]+(?:e[+-]?\d+)?)\s+(.+?)\s+Gained$/i);
      if (!m) return;
      const resources = effectResources(m[2]);
      resources.forEach((res) => { mults[res] = (mults[res] || 1) * parseFloat(m[1]); });
    });
  });
  return mults;
}

// Gear piece leveling cost -- see REAL_GEAR_PIECES' costBase/costScalar note for the (low)
// confidence tier this is at. `level` is the level being bought (1-indexed): cost to go from
// level-1 to level.
function gearPieceCostAtLevel(piece, level) {
  if (!piece.costBase || !piece.costScalar || level < 1) return Infinity;
  return piece.costBase * Math.pow(piece.costScalar, level - 1);
}
// Which resource(s) a gear piece's installs feed, and how much %/level each install is worth
// toward them (install1 = x1.01/level = 1, install2 = x1.02/level = 2) -- summed if BOTH
// installs happen to feed the SAME resource, since one level-up buffs both installs at once for
// one shared cost.
function gearPieceResourceValue(piece, resource) {
  let value = 0;
  const i1 = parseInstallCode(piece.install1);
  const i2 = parseInstallCode(piece.install2);
  if (i1 && SHIP_NODE_CATALOG[i1.ship]?.[i1.code] && effectResources(SHIP_NODE_CATALOG[i1.ship][i1.code].effect).includes(resource)) value += 1;
  if (i2 && SHIP_NODE_CATALOG[i2.ship]?.[i2.code] && effectResources(SHIP_NODE_CATALOG[i2.ship][i2.code].effect).includes(resource)) value += 2;
  return value;
}
// Gear Effective Path: greedy, one level-up at a time, from REAL current piece levels. Only
// pieces you've actually acquired (owned) are eligible -- Gear pieces drop randomly and can't be
// leveled at all until you have them, so an unowned piece is never recommended regardless of how
// good its value would be. Ranked by RAW value only, NOT AP-cost-adjusted -- the Academy Points
// cost data (REAL_GEAR_PIECES' costBase/costScalar) turned out to be wrong (community-sourced,
// never confirmed), so real cost is deliberately left out of the ranking until a real formula is
// found, rather than ranking by a number known to be inaccurate. A piece's %/level value is
// otherwise constant regardless of level (a pure multiplicative factor -- 1.01^(L+1)/1.01^L is
// always 1.01), so with no real cost to weigh against it, `rawValue(p)` alone would just park on
// whichever piece(s) score highest for all 30/50 steps -- to prevent that without inventing a
// specific AP number, `scoreFor` divides by (1 + picks already made TO THIS PIECE WITHIN THIS
// SIMULATION, not the piece's real starting level -- real levels can already be in the hundreds,
// which would make a per-real-level penalty far too weak to ever matter across just 30-50 steps)
// as a deliberately-labeled SPREAD heuristic, not a cost claim: all else equal, prefer whichever
// eligible piece this path hasn't already leaned on, so it rotates across every eligible piece
// instead of parking on one.
function computeGearEffectivePath(rawValueFn, steps) {
  const gearSets = getGearSets();
  const levels = {};
  const picks = {};
  gearSets.pieces.forEach((p) => { levels[p.name] = p.level || 0; picks[p.name] = 0; });
  const eligible = gearSets.pieces.filter((p) => p.owned && rawValueFn(p) > 0);
  const scoreFor = (p) => rawValueFn(p) / (picks[p.name] + 1);
  const path = [];
  let lastPicked = null;
  for (let i = 0; i < steps; i++) {
    if (!eligible.length) break;
    const maxScore = Math.max(...eligible.map(scoreFor));
    const candidates = eligible.filter((p) => scoreFor(p) === maxScore);
    const pick = candidates.find((p) => p.name !== lastPicked) || candidates[0];
    levels[pick.name] += 1;
    picks[pick.name] += 1;
    path.push({ piece: pick, level: levels[pick.name] });
    lastPicked = pick.name;
  }
  return path;
}
// Shared renderer for both the per-resource and fleet-wide weighted Gear Effective Path --
// same list layout as openLoadoutDetail's ship Effective Path (icon(s) + name on the left,
// level readout on the right), including the same click-a-row-to-reveal-a-confirm-checkmark
// interaction: confirming commits every step up to and including that row into the real Gear
// Sets levels (last simulated level per piece wins), then recomputes from the new baseline.
// "Gear pair" = the piece's own 2 target installs (install1/install2), shown as their real
// ship-node icons (the same nodeIconPath assets the ship pages already use -- no separate
// gear-piece art exists).
function renderGearEffectivePathModal(title, path, reopen) {
  document.getElementById('loadoutDetailTitle').textContent = title;
  const body = document.getElementById('loadoutDetailBody');
  body.innerHTML = `
    <p class="text-xs text-gray-500 mb-3">Ranked by raw bonus value (no cost weighting yet -- Academy Points cost data isn't confirmed, see this piece's row). Click a step once you've actually leveled it in-game to confirm your real gear levels up to that point.</p>
    <ol class="space-y-1.5">
      ${path.length ? path.map((step, i) => {
        const i1 = parseInstallCode(step.piece.install1);
        const i2 = parseInstallCode(step.piece.install2);
        const icon1 = i1 ? nodeIconPath(i1.ship, i1.code) : null;
        const icon2 = i2 ? nodeIconPath(i2.ship, i2.code) : null;
        return `<li data-gear-path-item="${i}" class="flex items-center justify-between text-sm bg-gray-700/50 rounded px-3 py-1.5 cursor-pointer hover:bg-gray-700">
          <span class="flex items-center gap-2 text-gray-300">${i + 1}. ${icon1 ? `<img src="${icon1}" class="w-5 h-5" onerror="this.remove()" />` : ''}${icon2 ? `<img src="${icon2}" class="w-5 h-5 -ml-1" onerror="this.remove()" />` : ''}${escapeHtml(step.piece.name)}</span>
          <span class="flex items-center gap-2">
            <span class="text-white font-medium">Lv ${step.level}</span>
            <button data-confirm-gear-up-to="${i}" class="hidden w-6 h-6 flex-shrink-0 rounded-full bg-green-600 hover:bg-green-500 text-white items-center justify-center text-xs" title="I've leveled up to here -- update my real gear levels">✓</button>
          </span>
        </li>`;
      }).join('') : '<li class="text-xs text-gray-500">No gear pieces feed anything weighted here.</li>'}
    </ol>`;
  if (path.length) {
    body.querySelectorAll('[data-gear-path-item]').forEach((li) => {
      li.onclick = () => {
        body.querySelectorAll('[data-confirm-gear-up-to]').forEach((b) => { b.classList.add('hidden'); b.classList.remove('flex'); });
        const btn = li.querySelector('[data-confirm-gear-up-to]');
        btn.classList.remove('hidden');
        btn.classList.add('flex');
      };
    });
    body.querySelectorAll('[data-confirm-gear-up-to]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const upTo = Number(btn.dataset.confirmGearUpTo);
        const gearSets = getGearSets();
        const finalLevels = {};
        path.slice(0, upTo + 1).forEach((step) => { finalLevels[step.piece.name] = step.level; });
        Object.entries(finalLevels).forEach(([name, lvl]) => {
          const piece = gearSets.pieces.find((p) => p.name === name);
          if (piece) piece.level = lvl;
        });
        window.saveStore();
        reopen();
        if (document.getElementById('gearPiecesContainer')) renderGearSetsPage(document.getElementById('pageRoot'));
        if (document.getElementById('fleetCanvas')) renderFleetPage(document.getElementById('pageRoot'));
      };
    });
  }
  document.getElementById('loadoutDetailModal').classList.remove('hidden');
}
function openGearEffectivePath(resource) {
  const path = computeGearEffectivePath((p) => gearPieceResourceValue(p, resource), 30);
  renderGearEffectivePathModal(`Gear Effective Path -- ${RESOURCE_LABELS[resource] || resource}`, path, () => openGearEffectivePath(resource));
}
// Fleet-wide combined path: one list mixing every resource type, weighted by the SAME Focus
// Weights sliders used for Optimize Loadout/This Ship (getShipGear().focusWeights) -- a piece
// feeding a heavily-weighted resource ranks above one feeding a 0-weighted resource, instead of
// treating every resource as equally important.
function openGearEffectivePathWeighted() {
  const weights = getShipGear().focusWeights;
  const path = computeGearEffectivePath(
    (p) => GEAR_EFFECTIVE_PATH_RESOURCES.reduce((sum, res) => sum + gearPieceResourceValue(p, res) * (weights[res] || 0), 0),
    50,
  );
  renderGearEffectivePathModal('Gear Effective Path -- Weighted (Focus Weights)', path, openGearEffectivePathWeighted);
}
window.openGearEffectivePathWeighted = openGearEffectivePathWeighted;
window.openGearEffectivePath = openGearEffectivePath;

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

  const listEl = document.getElementById('shipSetupList');
  for (let n = 1; n <= 8; n++) {
    const rec = ships[n];
    const input = getShipInput(n);
    const portrait = SHIP_PORTRAITS[n];
    const spent = Object.values(input.installs).reduce((a, b) => a + b, 0);
    // Rank/Crew/Rank Points are typed in directly (or save-imported) as the account's real,
    // already-inclusive totals -- no separate grant aggregation on top (see FLEET_BOOST_ITEMS'
    // header comment). Fleet Analysis 1's SP bonus is a distinct, structured mechanic (a
    // Research Center level, not an inscription/loop-mod grant), so it's still added here.
    const researchSp = computeFleetResearchSp();
    const totalSp = input.rankPoints + researchSp;
    const pointsLabel = totalSp !== input.rankPoints ? `${totalSp} <span class="text-gray-500">(${input.rankPoints})</span>` : input.rankPoints;
    const crewLabel = input.crew;
    const rankLabel = input.rank;
    const card = document.createElement('div');
    card.className = `bg-gray-800 rounded-lg border border-gray-700 p-3 ${!rec ? 'opacity-50' : ''}`;
    card.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        ${portrait ? `<img src="assets/ships/${portrait}.png" class="w-10 h-10 object-contain flex-shrink-0" alt="${shipDisplayName(n)}" />` : ''}
        <span class="font-medium text-white text-sm">${shipDisplayName(n)}</span>
      </div>
      <div class="grid grid-cols-2 gap-1 text-xs text-gray-400 mb-2">
        <div>Rank <span class="text-white font-medium">${rankLabel}</span></div>
        <div>Install Points <span class="text-blue-400 font-medium">${pointsLabel}</span></div>
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
      // 'game' means every machine-checkable field of this node is bench-verified against the game
      // itself -- see SHIP_NODE_CATALOG's header for which bench covers which field. Anything else
      // is still wiki-sourced and gets flagged, so a node added later without that verification
      // cannot quietly inherit the same trust as a checked one.
      const unconfirmed = meta.source !== 'game';
      const sourceLine = unconfirmed ? '\n⚠ Unconfirmed (wiki-sourced, not verified against the game)' : '';
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
  White: 'border-slate-200 bg-slate-100/10',
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
const GEAR_EFFECTIVE_PATH_RESOURCES = ['cells', 'shards', 'researchPoints', 'modPoints', 'academyPoints', 'missionMaterials'];
function renderGearSetsPage(root) {
  const gearSets = getGearSets();
  root.innerHTML = `
    <div class="mb-4 rounded-lg overflow-hidden shadow-lg">
      <div class="bg-gradient-to-r from-blue-900 to-gray-800 px-5 py-4 border-b border-gray-600">
        <h1 class="text-xl font-bold">Gear Sets</h1>
        <p class="text-xs text-gray-300 mt-0.5">Crafted/leveled with Academy Points (unlocked via Zeus). Data transcribed from cifi.fandom.com/wiki/Gear_Sets, except the White set, which the wiki does not document and which comes from the game itself -- as do all the piece names and set-bonus resources, which is what corrected three names the wiki had wrong. Each piece's own level buffs its 2 target installs multiplicatively (x1.01/level, x1.02/level), and each piece's own Set Bonus applies once its whole color is owned -- both feed into the Fleet page's resource totals.</p>
      </div>
      <div class="bg-gray-800/70 px-4 py-3 border-t border-gray-700">
        <h3 class="text-xs font-semibold text-gray-300 mb-2">Gear Effective Path -- what to buy next, by resource</h3>
        <div class="flex flex-wrap gap-2" id="gearEffectivePathBtns"></div>
      </div>
    </div>
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4" id="gearPiecesContainer"></div>`;

  const pathBtns = document.getElementById('gearEffectivePathBtns');
  GEAR_EFFECTIVE_PATH_RESOURCES.forEach((res) => {
    const btn = document.createElement('button');
    btn.className = 'px-3 py-1.5 rounded-md bg-gray-700 hover:bg-gray-600 text-white text-xs';
    btn.textContent = RESOURCE_LABELS[res] || res;
    btn.onclick = () => openGearEffectivePath(res);
    pathBtns.appendChild(btn);
  });

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
        <div class="text-xs text-gray-400"><span class="text-gray-500">Set Bonus:</span> ${piece.setBonus
          ? escapeHtml(piece.setBonus)
          // Every shipped piece now has a sourced bonus, so this is a guard rather than a live
          // case: if one is ever added ahead of its data, say so instead of rendering a blank
          // that reads as a broken field.
          : '<span class="text-gray-500 italic">not known &mdash; not applied</span>'}</div>
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
        <div class="flex items-center gap-2 flex-shrink-0">
          <button id="fleetGearPathBtn" class="flex items-center space-x-1 px-3 py-2 rounded-full bg-gray-700 hover:bg-gray-600 text-white font-semibold shadow-lg text-xs sm:text-sm" title="Gear Effective Path weighted by the same Focus Weights used for Optimize Loadout, combining every resource into one list.">${iconSvg('settings', 16)}<span>Gear Path</span></button>
          <button id="newLoadoutBtn" class="flex items-center space-x-1 px-3 py-2 rounded-full bg-gradient-to-r from-purple-600 to-purple-800 hover:from-purple-700 hover:to-purple-900 text-white font-semibold shadow-lg text-xs sm:text-sm">${iconSvg('plus', 16)}<span>Optimize Loadout</span></button>
        </div>
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
  document.getElementById('fleetGearPathBtn').onclick = openGearEffectivePathWeighted;

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

  // Meltdown: account-wide state (applies to every generator tier's output -- confirmed
  // directly against the game's own code, see this file's own Meltdown comment), not per-loadout,
  // so it lives in this persistent toolbar rather than inside the Optimize Loadout modal.
  // Appended last (not part of the static template above) so `ml-auto` pushes it to the row's
  // right edge, after every tab pill/button.
  const meltdownWrap = document.createElement('div');
  meltdownWrap.className = 'flex items-center gap-1.5 ml-auto flex-shrink-0';
  meltdownWrap.title = 'Applies to every generator tier\'s output.';
  meltdownWrap.innerHTML = `
    <label for="fleetMeltdownInput" class="text-xs text-gray-400">Meltdown</label>
    <input id="fleetMeltdownInput" type="number" step="0.001" class="w-20 bg-gray-700 border border-gray-600 rounded-md px-2 py-1 text-white text-xs" />`;
  tabsRow.appendChild(meltdownWrap);
  const gearForMeltdown = getShipGear();
  const meltdownInput = document.getElementById('fleetMeltdownInput');
  meltdownInput.value = gearForMeltdown.meltdown;
  meltdownInput.onchange = (e) => { gearForMeltdown.meltdown = Number(e.target.value) || 0; window.saveStore(); };

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
        ${shipDisplayName(n)}
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
  // a persistent fleet-wide account stat. Meltdown moved OUT of this modal (2026-09-02) to the
  // Fleet Optimizer page's own toolbar, next to the loadout tab selectors -- see renderFleetPage
  // -- since it's account-wide state you check once per session, not something worth reopening
  // this modal to change.
  const gear = getShipGear();
  renderFocusWeightSliders(document.getElementById('newLoadoutFocusWeights'), gear.focusWeights, document.getElementById('newLoadoutWeightPresetBtn'));
  document.getElementById('newLoadoutModal').classList.remove('hidden');
}
document.getElementById('closeNewLoadoutModalBtn').onclick = () => document.getElementById('newLoadoutModal').classList.add('hidden');

// ============================= Real optimizer =============================
// Which user-facing focus-weight slider governs each effectResources() tag. Generator-tier gains
// (allGens, mk1-8, techSoftware/techHardware) all feed the ONE "cells" slider -- from the
// player's point of view there is only "how much do I care about Cells", not a separate
// "Generators" dial: generators only exist to eventually produce Cells, so a player never wants
// to favor one without the other. The actual direct-Cells-vs-generator-tier SPLIT is decided
// entirely by the plumbing, not the player: nodeMarginalLogGain values a generator-stage node
// with the Meltdown exponent the binary actually applies and a direct-Cells node without it (see
// that function's comment), and the greedy allocator below picks whichever single point -- direct
// or generator -- has the best real marginal value right now. Bucket membership here only decides
// whether a slider's weight applies at all (>0) -- it is not a second weight dimension. `other`
// (untagged effects, e.g. flat "+1 completed operation" with no %) gets no weight -- it's never
// picked by the marginal-value pass.
const RESOURCE_TO_WEIGHT_BUCKET = {
  cells: 'cells', allGens: 'cells', shards: 'shards', researchPoints: 'researchPoints',
  modPoints: 'modPoints', academyPoints: 'academyPoints', missionMaterials: 'missionMaterials',
  techSoftware: 'cells', techHardware: 'cells', // intermediate compounding pools feeding Cells -- see effectResources
  ...Object.fromEntries(GEN_TIERS.map((n) => [`mk${n}`, 'cells'])),
};
// Tie-break for the greedy loop below: only ever consulted when two candidate nodes' weighted
// marginal scores are EXACTLY equal (most commonly right after a gate opens several nodes at
// once). Never overrides the real weight/value math -- it only decides ties that math is
// genuinely indifferent between.
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
// Meltdown melts EVERY generator tier's output, not just MK1 -- REVERSED 2026-09-02. This file
// used to claim the opposite ("confirmed account-side to affect ONLY MK1"), which a direct
// disassembly of the game's own libil2cpp.so (x86_64 -- this build is the emulator target, not
// ARM64) disproved: GeneratorManager's get_MK1Production/get_MK2Production/get_MK5Production are
// byte-identical at the relevant site -- load own-tier production into xmm0, load
// `this->OR->FinalMeltdownPower` into xmm1 (OuroborosResetter via GeneratorManager+0x118, the
// field itself at OuroborosResetter+0x378), check a flag, call BigDouble.Pow(xmm0, xmm1). No
// per-tier difference at any of the three checked. SirRed's CIFI Ouroboros Helper Tool
// (decompiled -- Mono, not IL2CPP, so ilspycmd reads it directly) independently agrees: its
// formulas raise every MK-tier-touching node to `meltdownValue^tierCount` across every ship
// checked (Koios, Demeter, Cradle). Direct Cells and non-generator resources (Shards/RP/MP/
// Academy/Materials bonuses that don't touch a tier) remain Meltdown-immune, plain ratio
// (exponent 1) -- only generator-tier output is affected, but that now means ALL of MK1-8, not
// MK1 alone. An "All Gens" node touches all 8 tiers at once, so its value is the product of
// each tier's own marginal ratio, each melted the same way. This uses ONLY real account data
// (current per-tier totals, the stored Meltdown value) -- no invented constants. It does NOT
// change what budget/plan the optimizer outputs (that's still a from-zero simulation per the
// earlier fix) -- it only changes how a candidate node's real relative value
// is judged, which is a different question from what the final plan displays.
function nodeLinearIncrement(shipId, slot) {
  const meta = SHIP_NODE_CATALOG[shipId]?.[slot];
  if (!meta) return 0;
  const m = meta.effect.match(/([\d.]+)%/);
  if (!m) return 0;
  const gear = getShipGear();
  const crew = getShipInput(shipId).crew || 0;
  const gearMult = gearMultiplierFor(meta.gearKey, gear);
  const researchMult = (computeFleetResearchShipMultipliers()[shipId] || 1) * (computeFleetBadgeMultipliers()[shipId] || 1);
  const gearNodeMult = computeGearNodeMultiplier(Number(shipId), Number(slot));
  return parseFloat(m[1]) * crew * gearMult * researchMult * gearNodeMult;
}
// Generator-like intermediate stages: the MK tiers, plus Tech Software/Hardware Upgrade output
// (see effectResources) -- these all compound before feeding a final resource, so they take
// Meltdown's exponent, unlike a direct final-resource bonus. See nodeMarginalLogGain.
function isGenLikeTag(tag) { return /^mk\d+$/.test(tag) || TECH_UPGRADE_TAGS.includes(tag); }
// GROWTH_VALUE_BOOST IS REMOVED (was 1.5, applied to nodes whose "per X" counter climbs during a
// run). It went the same way as RUN_LENGTH_BIAS's default, for the same reason and two more:
//
//   1. **The classification it keyed off was wrong in both directions**, which is fatal for a
//      multiplier of this kind -- it was not merely imprecise, it was pointed at the wrong nodes.
//      `missionsCompleted` was IN the growth set but imports from `MissionsCompletedAllTime`, an
//      all-time total that barely moves within one run (it boosted 7 of Zeus's 11 nodes).
//      `totalManualGens` was OUT of it but imports from `ManualGensThisLR`, which does reset.
//      A constant hung on a misclassification is not a conservative approximation of anything.
//   2. **It cannot fix the failure it looks like it addresses.** The real problem with these
//      counters is that a resetting counter reads 0 at the start of a run, and 1.5 x 0 is still 0
//      -- see the zero-counter warning in optimizeShipInstalls.
//   3. Same "no invented constants" rule that already keeps a compounding multiplier out of the
//      All-Gens case in nodeMarginalLogGain. Undervaluing a growth node is the smaller error.
//
// The underlying effect is REAL and this is a known, deliberate undervaluation: a node paid for
// early does benefit from a higher counter for most of the run than the snapshot shows. Restoring
// a boost needs a defensible number -- derived from run dynamics, or from the counter's own
// growth rate -- not another guess. GROWTH_GEAR_KEYS is kept, with the membership CORRECTED
// against what saveImport actually reads, because the warning below needs to know which counters
// reset. Do not reintroduce a multiplier without also fixing what it multiplies.
//
// Counters that reset within a planning horizon, by the save field each actually imports from
// (shipSchema.js): TicksThisLoop, NewSMOperationsThisLoop, StudiesThisLoop, LoopsFilled,
// ManualGensThisLR. Deliberately NOT here: missionsCompleted (MissionsCompletedAllTime),
// loopResetsDone (LoopResetsPerformedAllTime), and the one-off purchase counters (tech upgrades,
// loop mods owned, automations unlocked), which only move when you deliberately buy something.
const GROWTH_GEAR_KEYS = new Set([
  'ticksThisLoop', 'operationsCompleted', 'studiesThisLR', 'loopFillsThisRun', 'totalManualGens',
]);
function nodeScalesWithGrowth(gearKey) {
  if (!gearKey) return false;
  return Array.isArray(gearKey) ? gearKey.some((k) => GROWTH_GEAR_KEYS.has(k)) : GROWTH_GEAR_KEYS.has(gearKey);
}
// Run Length tactic: skews the optimizer's Cells-vs-Generators preference within the "cells"
// weight bucket (see RESOURCE_TO_WEIGHT_BUCKET -- both direct Cells nodes and all Generator-tier
// nodes feed that one slider, so there's otherwise no way to prefer one over the other). Direct
// Cells nodes pay off immediately; Generator nodes pay off by compounding output over time, so
// they're worth relatively more the longer the run is. Short is an explicit opt-in for players
// about to reset/traverse soon.
//
// LONG IS NEUTRAL, AND THAT IS A CORRECTION. It used to be `{ cells: 0.7, gen: 1.35 }` --
// described in this comment as "a modest, clearly-flagged heuristic". It was neither modest nor
// harmless:
//   * 1.35/0.7 is a 1.93x swing, the largest non-game-derived factor anywhere in the value model,
//     and it INVERTS rankings rather than nudging them. On the Cradle fixture, node 1 (+10% Cells)
//     has a raw log-gain of 0.788 against node 2's 0.470, and the bias flipped that to 0.552 vs
//     0.635 -- so the default allocator systematically underfunded the single best node.
//   * `sirred-algorithm-check.js` measured the cost: 13.6% / 14.5% / 35.7% / 17.5% worse than a
//     plain unbiased greedy at budgets 30 / 75 / 150 / 300. Setting long to neutral makes our
//     allocator reproduce that greedy EXACTLY at every tested budget, which is also the proof
//     that our search was never the problem -- the objective was.
//   * It contradicted the decision twenty lines below it in nodeMarginalLogGain, which refuses to
//     invent a compounding multiplier for All-Gens nodes on "no invented constants" grounds
//     ("undervaluing an All-Gens node is a smaller error than fabricating a factor of 8"). The
//     compounding argument for gens over a long run is the SAME argument; it cannot be
//     disqualifying there and load-bearing here.
//   * The game gives exactly one structural reason to prefer generator nodes over direct-resource
//     ones -- the Meltdown exponent, because gen bonuses sit inside the `Pow(MK1Production, m)`
//     and Cells bonuses sit outside it. nodeMarginalLogGain already applies that, from the binary.
//     Stacking an invented second preference on top double-counts a real effect with a fake number.
// Note also the functional form: this multiplies a LOG gain, so a factor k ranks by ratio^k -- it
// behaves like an exponent, not like a value weight. That is right for Meltdown (which IS an
// exponent) and wrong for "I expect a long run", which is a statement about value.
// `short` stays a deliberate, user-selected deviation from the neutral model rather than a silent
// default, which is the only reason an unmeasurable constant is tolerable here at all.
const RUN_LENGTH_BIAS = {
  short: { cells: 1.35, gen: 0.7 },
  long: { cells: 1, gen: 1 },
};
function runLengthBiasFor(runLength) {
  return RUN_LENGTH_BIAS[runLength] || RUN_LENGTH_BIAS.long;
}
// ===================== The real value model, read out of the game binary =====================
//
// EVERY claim in this block was verified by disassembling libil2cpp.so (x86_64 -- this build is
// the Android emulator ABI, not ARM64) against the RVAs dump.cs carries inline. Method addresses
// and field offsets are quoted so any of it can be re-checked directly. This REPLACES an earlier
// "shared additive pool per generator tier" model that was wrong in a way that cost real value
// (see the allocator comment below and tools/bench/real-save-optimizer-check.js).
//
// GeneratorManager::get_MK1Production (RVA 0x1D7249B) is one flat chain of BigDouble::op_Multiply
// (0x24E7EB3). Every bonus source in the game is an INDEPENDENT MULTIPLICATIVE FACTOR in it:
//
//   MK1Production = Pow(BaseOutput, FinalMeltdownPower)      <- Pow at 0x1D72BD9, ONE per getter
//                 x CellGeneratorsMK1                        <- MasterManager+0x548, the gen count
//                 x TU1Bonus x TU2Bonus x TotalLoopMK1Bonus x DiamondShop.FinalMK1Bonus
//                 x RUGen2Bonus x RUGen4Bonus x RULoop2Bonus x RUAuto1Bonus x RUTech4Bonus x ...
//                 x FinalAllGensBonus x TickMultiplier x (every other bonus, each its own factor)
//
// The decisive detail: RUGen2Bonus (0x1D72743) and RUGen4Bonus (0x1D72E44) are BOTH Cradle
// install nodes that boost MK1 output, and each is multiplied in SEPARATELY. Install nodes are
// never summed into a shared pool anywhere. A single node's own getter
// (FleetManager::get_RUGen2Bonus, RVA 0x2134F20) tail-calls BigDouble::op_Addition (0x24E7CB0)
// onto a literal 1, over a product of its own coefficient (FleetManager+0x57C), its own level
// (+0x4B0C), FinalCradleCrew, the innovation badges and FinalShip1InstallsBonus
// (ResearchLaboratory+0x5AE8) -- i.e. exactly `1 + pct*crew*counter*multipliers*level`, self
// contained, referencing no other node. That is what nodeLinearIncrement already computes.
//
// WHERE MELTDOWN ACTUALLY LANDS. FinalMeltdownPower (OuroborosResetter+0x378, reached via
// GeneratorManager+0x118) is applied by exactly two Pow sites, both gated on the same flag,
// MasterManagerOuro::FirstOuroResetDone (+0x178) -- Meltdown switches on after the first
// Ouroboros reset, and each getter contains one Pow plus a duplicate un-melted branch:
//   1. inside get_MKnProduction: Pow(BaseOutput, m) -- the tier's RAW BASE only, no bonuses.
//   2. inside get_CellProduction (RVA 0x1D72357, Pow at 0x1D723F4): Pow(MK1Production, m) --
//      the ENTIRE MK1 production, every install bonus included.
// Because (A*B)^m == A^m * B^m, site 2 gives every factor inside MK1Production an effective
// exponent of m. get_CellProductionTotalMult is applied OUTSIDE that Pow (0x1D72430), so direct
// "Cells gained" bonuses keep exponent 1. That is why generator nodes are melted and direct
// resource nodes are not -- and it is a property of where the Pow sits, not a special case.
//
// NO PER-TIER COMPOUNDING OF THE EXPONENT. MK2Gains (RVA 0x1D809B6) adds MK2Production into the
// MK1 count with a plain op_Addition and NO Pow of its own. So a higher-tier bonus reaches Cells
// through the MK1 count, which is itself just another factor inside MK1Production, and therefore
// also picks up exponent m exactly ONCE. There is no m^tierCount anywhere in the chain; an
// earlier comment here asserted that shape and it is not what the binary does.
//
// WHAT IS STILL A MODELLED APPROXIMATION, not read from the binary: an "All Gens" node multiplies
// every tier at once, and because each tier feeds the next tier's count, its benefit genuinely
// compounds along the unlocked chain over a run. The exact compounding depends on run length and
// tier dynamics, which no static formula can settle -- treating it as one factor per UNLOCKED
// tier (below) is a deliberate approximation of that chain, and is flagged as such rather than
// presented as proven. RUN_LENGTH_BIAS's `short` tactic remains an opt-in heuristic; its `long`
// default and GROWTH_VALUE_BOOST have both been removed (see their notes).

// Marginal gain from putting ONE more point into `slot`, given the levels this planning run has
// assigned so far, returned as a LOG gain. Log because the objective is a product of factors
// (maximise prod(resource_r ^ weight_r)), whose log is sum(weight_r * log(resource_r)) -- so a
// weighted sum of log-gains is exactly the right thing for the greedy loop to rank on, it makes
// gains on different resources genuinely comparable (a 2x on Shards and a 2x on Cells score the
// same), and it cannot overflow the way a raw product of real-account ratios does. Mutates
// nothing. Diminishing returns are real and need no pool: a node's own factor is 1 + inc*level,
// so each extra point moves it by (1+inc*(L+1))/(1+inc*L), which shrinks on its own as L grows.
// Ahead Of The Curve (Demeter slot 1) does not multiply a resource -- it GRANTS operations, and
// operations are the "per X" counter that 8 of Demeter's 11 nodes multiply by. The game states it:
// LoopModifiers.PerformLoop() adds FleetManager.RUShard1Bonus into the run's operation count and
// stores it as MasterManager.NewSMOpsFromAOTCThisRun, and RUShard1Bonus is
// `RU1ShardBaseBonus(1.0) * FinalDemeterCrew * <gear/badge/research mults> * RU1ShardLevel` --
// linear in level, i.e. crew operations per level before multipliers.
//
// So its value IS computable, and this returns it: the marginal gain of one more AOTC level is the
// improvement it produces across every operations-scaled node at their CURRENT planned levels.
// That falls out with the right shape on its own -- worth nothing while no operations node has
// levels yet, worth more as they fill in -- which is why it replaces the old
// "max it outright above a budget threshold, otherwise skip it" policy. Measured against a
// brute-force optimum on the Demeter fixture, that policy was correct at budgets >= 15 and <= 6 but
// left up to 47.5% on the table across 7-14, because the true optimum ramps 1 -> 5 through that
// band while a binary rule jumps 0 -> 5 at one point.
const AOTC_GRANT_COUNTER = 'operationsCompleted';
// A node's per-level fraction with the operations counter FACTORED OUT, so the counter can be
// varied. Both directions of the AOTC coupling need this: valuing AOTC (how much do other nodes
// improve when operations rise) and valuing those nodes (they must be worth more once AOTC has
// actually raised operations). Mirrors nodeLinearIncrement's multiplier chain exactly, minus the
// counter itself.
function opsScaledPerUnit(shipId, slot) {
  const meta = SHIP_NODE_CATALOG[shipId]?.[slot];
  if (!meta || meta.gearKey !== AOTC_GRANT_COUNTER) return 0;
  const pct = String(meta.effect).match(/([\d.]+)%/);
  if (!pct) return 0;
  const crew = getShipInput(shipId).crew || 0;
  return parseFloat(pct[1]) / 100 * crew
    * (computeFleetResearchShipMultipliers()[shipId] || 1)
    * (computeFleetBadgeMultipliers()[shipId] || 1)
    * computeGearNodeMultiplier(Number(shipId), Number(slot));
}
// Operations actually available to this ship's nodes once AOTC's grant is counted.
function effectiveOpsFor(shipId, levels) {
  const base = getShipGear()[AOTC_GRANT_COUNTER] || 0;
  if (shipId !== AOTC_SHIP_ID) return base;
  const crew = getShipInput(shipId).crew || 0;
  return base + crew * (levels[AOTC_SLOT] || levels[Number(AOTC_SLOT)] || 0);
}
function aotcMarginalLogGain(shipId, slot, levels) {
  const crew = getShipInput(shipId).crew || 0;
  if (crew <= 0) return 0;
  const gear = getShipGear();
  const ops = effectiveOpsFor(shipId, levels); // already-bought AOTC levels count
  const granted = crew; // one operation per crew member per level (RU1ShardBaseBonus = 1.0)
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  let gain = 0;
  Object.keys(catalog).forEach((other) => {
    if (String(other) === String(slot)) return;
    const om = catalog[other];
    if (om.gearKey !== AOTC_GRANT_COUNTER) return;
    const otherLevel = levels[other] || 0;
    if (otherLevel <= 0) return; // nothing to amplify yet
    const perOp = opsScaledPerUnit(shipId, other);
    if (!(perOp > 0)) return;
    gain += Math.log1p(perOp * (ops + granted) * otherLevel)
      - Math.log1p(perOp * ops * otherLevel);
  });
  return gain;
}

function nodeMarginalLogGain(shipId, slot, levels, runLength) {
  const meta = SHIP_NODE_CATALOG[shipId]?.[slot];
  if (!meta) return 0;
  if (shipId === AOTC_SHIP_ID && String(slot) === AOTC_SLOT) {
    return aotcMarginalLogGain(shipId, slot, levels);
  }
  // nodeLinearIncrement is in PERCENT per level; /100 to get the factor's per-level fraction.
  // No growth multiplier: see GROWTH_VALUE_BOOST's removal note. The counter is used exactly as
  // entered, which undervalues nodes whose counter climbs during the run -- a known, deliberate
  // approximation rather than a hidden one.
  let increment = nodeLinearIncrement(shipId, slot) / 100;
  // The other half of the AOTC coupling. nodeLinearIncrement reads the counter as ENTERED, but by
  // the time these points are spent AOTC has raised operations, so valuing these nodes at the
  // unraised counter credits AOTC for a boost and then never collects it. Leaving that
  // inconsistency in place cost up to 24% against a brute-force optimum even once AOTC itself was
  // scored correctly.
  if (shipId === AOTC_SHIP_ID && meta.gearKey === AOTC_GRANT_COUNTER) {
    const perOp = opsScaledPerUnit(shipId, slot);
    if (perOp > 0) increment = perOp * effectiveOpsFor(shipId, levels);
  }
  if (increment <= 0) return 0;
  const level = levels[slot] || 0;
  const logRatio = Math.log1p(increment * (level + 1)) - Math.log1p(increment * level);
  if (logRatio <= 0) return 0;
  const tags = effectResources(meta.effect);
  const isAllGens = tags.includes('allGens');
  const genTiers = tags.filter(isGenLikeTag);
  if (!isAllGens && genTiers.length === 0) {
    // Direct final-resource bonus (Cells/Shards/RP/MP/Academy/Materials): outside the Meltdown
    // Pow, exponent 1.
    return logRatio * runLengthBiasFor(runLength).cells;
  }
  // Generator-stage bonus: exponent m (the Meltdown power) applied ONCE -- see site 2 above.
  //
  // An All-Gens node deliberately gets the SAME single application, not one per tier. Its bonus
  // really does multiply every tier (FinalAllGensBonus is a factor in each get_MKnProduction),
  // and because each tier feeds the next tier's count that genuinely compounds down the chain
  // over a run -- so the true value is somewhere ABOVE this. But how far above depends on run
  // length and on how much each tier is actually contributing, which no static reading of the
  // binary can settle: the propagation is a time integral, not a formula. An earlier version of
  // this function multiplied the log-gain by the number of unlocked tiers (x8 on a real account),
  // which assumes the whole chain saturates instantly from a single point -- on the reference
  // save that alone pushed 164 of 400 Cradle points into one All-Gens node. Per this project's
  // "no invented constants" rule, and the same conservative-default principle that makes a
  // missing gem level mean LOCKED, the unprovable multiplier is left out rather than guessed.
  // Undervaluing an All-Gens node is a smaller error than fabricating a factor of 8.
  const meltdown = getShipGear().meltdown || 0;
  // Meltdown is only live once the first Ouroboros reset is done; before that the binary takes
  // the un-melted branch, i.e. exponent 1. A stored 0 means "not melting yet", not "worth zero".
  const exponent = meltdown > 0 ? meltdown : 1;
  return logRatio * exponent * runLengthBiasFor(runLength).gen;
}
// Real allocator -- pure marginal-value greedy: every single point goes to whichever weighted,
// eligible node currently offers the best real gain, recomputed after every pick so diminishing
// returns are exact (see nodeMarginalLogGain). REPLACES an earlier category-fair-queueing engine
// (weighted round-robin across resource categories, spending toward each category's "target
// share" of the budget) that had a real bug: it gave every resource BUCKET an equal target spend
// share regardless of how many nodes populated it. On Cradle, 9 of 11 nodes all shared the single
// "cells" bucket while 'shards' and 'researchPoints' each had exactly ONE node -- so those two
// lone nodes each claimed a full 1/6 of the budget outright (trivially reaching max), while
// genuinely-better nodes fought each other for the remaining share of the crowded bucket and got
// starved. Verified against SirRed's own greedy CIFI Ouroboros Helper Tool algorithm on this
// account's REAL crew/gear counters (tools/bench/real-save-optimizer-check.js): the old engine
// scored up to 100% worse at higher budgets. This one is the same algorithm SirRed's tool already
// uses -- "always spend the next point on whatever gives the single best real gain right now" --
// so category bucket membership no longer determines a spend SHARE, only which slider weight a
// node's value gets multiplied by.
// Always plans from a clean slate (every node at 0), regardless of what's actually installed
// right now -- `budget` is the total number of points to distribute as if starting over, not a
// target to reach on top of existing installs. Real current installs are a separate concern
// (see "Effective Path" in openLoadoutDetail, which uses this same ideal sequence's tail to
// advise what to buy next from wherever you really are).
function allocateShipInstallsOnce(shipId, budget, weights, prepForLongRun, runLength, pinnedAotc) {
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
  // AOTC (Demeter slot 1) is now SCORED, not policed -- see aotcMarginalLogGain. The old rule
  // ("max it outright once the budget is >= 15 or when prepping for a long run, otherwise skip it
  // entirely") was measured against a brute-force optimum on the Demeter fixture: correct at
  // budgets >= 15 and <= 6, but it left up to 47.5% on the table across 7-14, where the true
  // optimum ramps 1 -> 5 and a binary rule cannot. `prepForLongRun` still forces it to max, because
  // that is a statement about a horizon the within-run objective genuinely cannot see -- not a
  // substitute for scoring the node.
  if (shipId === AOTC_SHIP_ID && (prepForLongRun || pinnedAotc != null)) {
    const want = prepForLongRun ? nodeMaxLevel(shipId, 1) : pinnedAotc;
    const needed = Math.min(want, nodeMaxLevel(shipId, 1), budget - spent);
    if (needed > 0) { levels[1] = needed; spent += needed; for (let i = 0; i < needed; i++) clicks.push('1'); }
  }
  // Which weighted category/categories each node's effect feeds. A node's weight is the SUM of the
  // sliders it touches, which is not a preference but the objective's own arithmetic: maximising
  // prod(resource ^ weight) means maximising sum(weight * log(resource)), so a node whose factor f
  // multiplies BOTH Cells and Shards contributes w_cells*log(f) + w_shards*log(f). Five nodes are
  // like this ("+X% A & B gained": Koios 6, Zeus 4/5/6/7).
  //
  // This comment used to say the weight was the STRONGEST slider touching the node, and the code
  // took a max. That silently undervalued every dual-resource node by treating one of its two
  // contributions as free, and it contradicted the marginal-value derivation quoted at the pick
  // site three lines below.
  const categoryOf = {}; // slot -> [categories]
  slots.forEach((slot) => {
    categoryOf[slot] = [...new Set(effectResources(catalog[slot].effect).map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))];
  });
  // SUM, not max, across the buckets a node feeds. The objective is
  // `maximise prod(resource_r ^ weight_r)`, whose log is `sum(weight_r * log(resource_r))` -- so a
  // node whose effect reads "+X% Cells & Shards gained" multiplies TWO resources and contributes
  // `(w_cells + w_shards) * log(factor)`. Taking the strongest slider instead undervalued exactly
  // those nodes by up to 2x. Five of the 77 nodes are affected (Koios 6, Zeus 4/5/6/7), all of them
  // literal "A & B gained" effects, so this is not a hypothetical.
  // Summing preserves the property the previous max was there for -- a node stays eligible whenever
  // ANY slider touching it is above zero, since a sum of non-negative weights is > 0 iff one is.
  const nodeWeight = (slot) => categoryOf[slot].reduce((sum, c) => sum + (weights[c] || 0), 0);
  // Nothing to suppress any more: the main loop evaluates AOTC on its merits like any other node.
  // It is only pre-filled above when prepForLongRun has already maxed it.
  const aotcSuppressed = shipId === AOTC_SHIP_ID && (prepForLongRun || pinnedAotc != null);
  const nodeEligible = (slot) => !(aotcSuppressed && slot === AOTC_SLOT)
    && (levels[slot] || 0) < nodeMaxLevel(shipId, slot)
    && gateMetFor(slot);
  // requireWeight=true only considers nodes some slider actually weighted (>0); false is the
  // fallback pass, used only once nothing weighted is eligible, to keep total installs climbing
  // toward whatever gate is blocking the real targets.
  const pickBest = (requireWeight) => {
    let bestSlot = null; let bestScore = -Infinity; let bestPriority = Infinity;
    slots.forEach((slot) => {
      if (!nodeEligible(slot)) return;
      const w = nodeWeight(slot);
      if (requireWeight ? w <= 0 : w > 0) return;
      // Log-gain x slider weight IS the objective's own marginal: maximising
      // prod(resource ^ weight) means maximising sum(weight * log(resource)).
      const score = nodeMarginalLogGain(shipId, slot, levels, runLength) * (requireWeight ? w : 1);
      const priority = nodeTiePriority(effectResources(catalog[slot].effect));
      if (score > bestScore || (score === bestScore && priority < bestPriority)) {
        bestScore = score; bestSlot = slot; bestPriority = priority;
      }
    });
    return bestSlot;
  };
  while (spent < budget) {
    const slot = pickBest(true) ?? pickBest(false);
    if (slot == null) break; // truly nothing left to buy
    levels[slot] = (levels[slot] || 0) + 1;
    spent += 1;
    clicks.push(slot);
  }
  // A resetting counter reads 0 at the start of a run, which makes every node that depends on it
  // score exactly 0 and drop out of the plan entirely -- not merely rank lower. Measured on the
  // Demeter fixture at budget 150: with counters at 0 the plan collapses to 3 nodes with 140 of
  // 150 points in ONE, versus a sensible spread across 10 nodes mid-run. That is a wrong answer
  // delivered confidently, and it happens at exactly the moment a player is most likely to plan:
  // just after a reset. Report it instead of hiding it. Callers that ignore `warnings` still get
  // the same plan as before, so this cannot change any existing behaviour.
  return { levels, clicks, warnings: growthCounterWarnings(shipId) };
}

// Total objective value of a finished plan: sum over nodes of weight * log(node factor), evaluated
// at the FINAL levels. Deliberately a function of the end state rather than of the path, which is
// what makes two plans comparable.
function planLogScore(shipId, levels, weights, runLength) {
  const catalog = SHIP_NODE_CATALOG[shipId] || {};
  const meltdown = getShipGear().meltdown || 0;
  const exponent = meltdown > 0 ? meltdown : 1;
  const bias = runLengthBiasFor(runLength);
  let total = 0;
  Object.keys(catalog).forEach((slot) => {
    const level = levels[slot] || 0;
    if (level <= 0) return;
    const meta = catalog[slot];
    let increment = nodeLinearIncrement(shipId, slot) / 100;
    if (shipId === AOTC_SHIP_ID && meta.gearKey === AOTC_GRANT_COUNTER) {
      const perOp = opsScaledPerUnit(shipId, slot);
      if (perOp > 0) increment = perOp * effectiveOpsFor(shipId, levels);
    }
    if (increment <= 0) return;
    const tags = effectResources(meta.effect);
    const isGenStage = tags.includes('allGens') || tags.some(isGenLikeTag);
    const w = [...new Set(tags.map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))]
      .reduce((max, c) => Math.max(max, weights[c] || 0), 0);
    total += Math.log1p(increment * level) * (isGenStage ? exponent * bias.gen : bias.cells) * (w || 1);
  });
  return total;
}

// AOTC is COUPLED to the rest of Demeter: its value depends on how many operations-scaled nodes
// have levels, and their value depends on the operations it grants. A one-point-at-a-time greedy
// cannot see round that loop, and measurably under-commits -- up to 4.5% behind a brute force that
// simply tries every AOTC level. There are only six, so trying all of them is cheap and exact, and
// it is the same move the hunter optimizer makes with dependency-closed support sets: enumerate the
// small structural choice, be greedy only about depth. Other ships take the single-pass path
// unchanged.
function optimizeShipInstalls(shipId, budget, weights, prepForLongRun, runLength) {
  if (shipId !== AOTC_SHIP_ID || prepForLongRun) {
    return allocateShipInstallsOnce(shipId, budget, weights, prepForLongRun, runLength, null);
  }
  const maxAotc = Math.min(nodeMaxLevel(shipId, Number(AOTC_SLOT)), budget);
  let best = null;
  let bestScore = -Infinity;
  for (let pin = 0; pin <= maxAotc; pin++) {
    const plan = allocateShipInstallsOnce(shipId, budget, weights, prepForLongRun, runLength, pin);
    const score = planLogScore(shipId, plan.levels, weights, runLength);
    if (score > bestScore) { bestScore = score; best = plan; }
  }
  return best;
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
  // Surface zeroed resetting counters BEFORE generating, since this modal is where the player can
  // still go and fix the input. Without this the plan silently collapses onto whatever nodes do
  // not depend on that counter (measured: 140 of 150 Demeter points into a single node).
  const warnHost = (() => {
    let el = document.getElementById('optimizeShipWarnings');
    if (!el) {
      el = document.createElement('div');
      el.id = 'optimizeShipWarnings';
      const weights = document.getElementById('optimizeShipFocusWeights');
      weights.parentNode.insertBefore(el, weights);
    }
    return el;
  })();
  const warnings = growthCounterWarnings(shipId);
  warnHost.className = warnings.length ? 'mb-3 rounded border border-amber-500/60 bg-amber-900/20 p-2' : '';
  warnHost.innerHTML = warnings.map((w) => `<p class="text-xs text-amber-200">${escapeHtml(w.message)}</p>`).join('');
  renderFocusWeightSliders(document.getElementById('optimizeShipFocusWeights'), gear.focusWeights, document.getElementById('optimizeShipWeightPresetBtn'));
  document.getElementById('optimizeShipModal').classList.remove('hidden');
}
document.getElementById('closeOptimizeShipModalBtn').onclick = () => document.getElementById('optimizeShipModal').classList.add('hidden');
document.getElementById('optimizeShipGenerateBtn').onclick = () => {
  const shipId = optimizeShipModalShipId;
  const budget = Number(document.getElementById('optimizeShipPoints').value) || 0;
  const gear = getShipGear();
  const optSettings = getOptimizerSettings();
  const prepForLongRun = shipId === AOTC_SHIP_ID && optSettings.prepForLongRun;
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
    const { levels, clicks } = optimizeShipInstalls(shipId, budget, gear.focusWeights, shipId === AOTC_SHIP_ID && optSettings.prepForLongRun, optSettings.runLength);
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
    const prepForLongRun = shipId === AOTC_SHIP_ID && optSettings.prepForLongRun;
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
      <div class="px-3 py-1 rounded-lg bg-gray-900/70 border border-gray-700/30"><span class="font-bold text-lg text-gray-300" data-level>${level}</span><span class="text-xs text-gray-500">/${cap}</span></div>
    </div>
    ${effectBox(lines)}
    ${item.note ? `<div class="flex items-center gap-1.5 text-xs text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-1 mb-2">${iconSvg('info-circle', 13)}<span>${escapeHtml(item.note)}</span></div>` : ''}
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
//
// Both nodes' per-tier values are independently confirmed against the game's own scene data
// (tools/reference/research.json, extracted via AssetRipper -- see extract-research.js), not
// just the wiki: research[68] = {Bonus1:5, Bonus2:20, Bonus3:30, Bonus4:40, Bonus5:50,
// Bonus6:60} matches fleetAnalysis1's six tiers exactly (5/20/30/40/50/60). research[78] =
// {Bonus1:5} -- a single stored value, not six -- consistent with fleetAnalysis2's own tiers
// all being the same "x5" uniformly (each tier just adds one more ship to the x5 list, rather
// than the bonus itself growing per tier the way #68's does).
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
    // shipOrder further corroborated 2026-09-02: ResearchLaboratory declares
    // get_FinalShip{N}InstallsBonus for N=1..6 ONLY (Ship7/Ship8 don't exist at all), matching
    // this tier count and ship range exactly. These are cached auto-property accessors, not live
    // formulas (the real per-tier computation writes to them from elsewhere, not chased further
    // here) -- so this confirms the SHIP SET and COUNT, not the tier-to-ship ORDER within it.
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

// ---------------------------------------------------------------------------------------
// Store-shape ownership
// ---------------------------------------------------------------------------------------
// The Fleet domain owns the SHAPE of its own store fields -- this file is where they are
// defined and where they change. storeSchema.js (the single declaration of the whole store)
// references these factories rather than re-declaring the shapes, so there is exactly one
// definition of each and they cannot drift.
//
// Before this, storeSchema declared gearSets/shipGear/fleetBadges/fleetBoosts/fleetResearch/
// unlockedGens as bare `{}` while the real shapes lived here behind lazy `getX()` accessors, and
// `optimizerSettings.runLength` existed only after an accessor happened to run. A fresh store
// therefore did not describe itself, and validateStore() could not check fields it did not know
// about. defaultLoadoutTabs() was defined in both files outright.
// The Fleet domain's DATA tables, exposed for the same reason as the store shapes: so the
// benchmark can exercise the real ones rather than a Node copy that drifts. Top-level `const`
// declarations are not global properties, so without this the ship optimizer could be called
// from a test but nothing about its inputs could be inspected or asserted.
window.ShipData = {
  SHIP_NODE_CATALOG,
  // Exported so ship-test.js can replay the save import (slot -> ruId -> RU{id}{Category}Level)
  // and check the result against the gates. Without it that test silently skipped every ship.
  SHIP_CATEGORY,
  GEN_TIERS,
  RESOURCE_TO_WEIGHT_BUCKET,
  // Demeter's "Ahead of the Curve" is special-cased in the allocator (its payoff lands next
  // loop, so the marginal-value engine cannot score it). Named here so the rule is greppable
  // rather than appearing as a bare `shipId === 5 && slot === '1'`.
  AOTC: { shipId: AOTC_SHIP_ID, slot: AOTC_SLOT, autoMaxAtBudget: AOTC_AUTO_MAX_BUDGET },
};

window.FleetStoreDefaults = {
  unlockedGens: defaultUnlockedGens,
  shipGear: defaultShipGear,
  gearSets: defaultGearSets,
  fleetBadges: defaultFleetBadges,
  fleetBoosts: defaultFleetBoosts,
  fleetResearch: defaultFleetResearch,
  optimizerSettings: defaultOptimizerSettings,
  loadoutTabs: defaultLoadoutTabs,
};
