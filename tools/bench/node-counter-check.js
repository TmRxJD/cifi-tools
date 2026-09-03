'use strict';
// Every install node's "per X" COUNTER, checked against the game.
//
// A node's bonus is `1 + coeff * counter * crew * level * <uniform mults>`. Coefficients, gates and
// caps are already verified elsewhere (node-coefficient-check, ship-node-gate-check); the counter
// was the remaining piece of a node's MATH that came from the wiki, and it is the one that scales a
// node's value directly -- on the bench fixture `loopModsOwned` reads 35 where a flat node reads 1,
// so a wrong counter misvalues a node by that whole factor.
//
// Regenerate the reference with:
//   CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-counters.py
//
//   node tools/bench/node-counter-check.js
//   node tools/bench/node-counter-check.js --verbose

const H = require('./harness.js');
const REF = require('../reference/ship-node-counters.json');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY } = sb.ShipData;
const verbose = process.argv.includes('--verbose');

// The game's MasterManager/RL field -> the gearKey our catalog and importer use for it.
const FIELD_TO_GEARKEY = {
  TotalOperationsThisRun: 'operationsCompleted',
  TotalStudiesThisLoop: 'studiesThisLR',
  TotalMissionsThisLoop: 'missionsCompleted',
  TotalResearchLevels: 'researchLevels',
  FullyCompletedResearches: 'totalCompletedResearch',
  ManualGensThisLoop: 'totalManualGens',
  CellGeneratorsMK2Manual: 'manualMK2Gens',
  CellGeneratorsMK3Manual: 'manualMK3Gens',
  TicksThisLoop: 'ticksThisLoop',
  AutomationsAcquired: 'automationsUnlocked',
  CurrentLoopsDone: 'loopFillsThisRun',
  LoopModLevelsCount: 'loopModsOwned',
  FinalLoopResetsPerformedThisConstruction: 'loopResetsDone',
  TotalHardwareLevels: 'hardwareUpgrades',
  TotalSoftwareLevels: 'softwareUpgrades',
};

let checked = 0;
let bad = 0;
const rows = [];
const unmapped = new Set();

for (const [shipIdRaw, nodes] of Object.entries(CATALOG)) {
  const shipId = Number(shipIdRaw);
  const category = SHIP_CATEGORY[shipId];
  const cat = REF.counters[category];
  if (!cat) { rows.push(`SKIP ship ${shipId}: no authored category ${category}`); continue; }

  for (const [slot, meta] of Object.entries(nodes)) {
    const raw = cat[String(meta.ruId)];
    if (!raw) { rows.push(`SKIP ${category}${slot}: game has no RU${meta.ruId}${category}`); continue; }
    raw.forEach((n) => { if (!(n in FIELD_TO_GEARKEY)) unmapped.add(`${category}${meta.ruId}:${n}`); });

    let expected = [...new Set(raw.map((n) => FIELD_TO_GEARKEY[n]).filter(Boolean))].sort();
    // Auxesia's tech nodes read hardware and software levels separately; our catalog models the
    // pair as the single combined `techUpgrades` counter the UI asks the player for.
    if (expected.join(',') === 'hardwareUpgrades,softwareUpgrades') expected = ['techUpgrades'];

    const key = meta.gearKey;
    const ours = (key ? (Array.isArray(key) ? key.slice() : [key]) : []).sort();
    checked++;
    const ok = JSON.stringify(ours) === JSON.stringify(expected);
    if (!ok) {
      bad++;
      rows.push(`DIFF ship ${shipId} slot ${slot} (RU${meta.ruId}${category}) "${String(meta.name).slice(0, 30)}"`
        + `\n      ours=${JSON.stringify(ours)} game=${JSON.stringify(expected)} raw=${JSON.stringify(raw)}`);
    } else if (verbose) {
      rows.push(`ok   ship ${shipId} slot ${slot}: ${ours.length ? ours.join('+') : '(flat)'}`);
    }
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nchecked ${checked} node counter(s) against the game`);
if (unmapped.size) {
  console.log(`${unmapped.size} game counter field(s) with no gearKey mapping: ${[...unmapped].join(', ')}`);
  process.exit(1);
}
if (bad) {
  console.log(`${bad} mismatch(es) -- a wrong counter scales that node's value by the ratio of the `
    + 'two counters, which is exactly the kind of error the optimizer acts on confidently');
  process.exit(1);
}
console.log('every node counter matches the game');
