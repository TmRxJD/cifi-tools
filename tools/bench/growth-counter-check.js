'use strict';
// The "per X" progression counters: is each one classified correctly, and does the allocator say
// so when one of them is zero?
//
// These counters scale a node's bonus (`+0.001% Cells, per Tick Completed, per crew member`), and
// they fall into two kinds that behave completely differently within one planning horizon:
//
//   * RESETTING -- TicksThisLoop, NewSMOperationsThisLoop, StudiesThisLoop, LoopsFilled,
//     ManualGensThisLR. These read 0 at the start of a run and climb as you play.
//   * ALL-TIME -- MissionsCompletedAllTime, LoopResetsPerformedAllTime. These barely move within
//     one run.
//
// Getting that split wrong is not a rounding error. A resetting counter at 0 makes every node
// depending on it score EXACTLY zero, so those nodes do not rank lower -- they vanish from the
// plan. Measured on Demeter at budget 150: with counters zeroed the plan collapses to 3 nodes with
// 140 of 150 points in ONE, against a sensible spread over 10 nodes mid-run. That is a confidently
// wrong answer produced at exactly the moment a player is most likely to plan: just after a reset.
//
// This bench exists because the two allocator benches (sirred-algorithm-check,
// real-save-optimizer-check) both test CRADLE ONLY, and Cradle's growth nodes were -- wrongly --
// not even classified as growth. So nothing covered this at all.
//
//   node tools/bench/growth-counter-check.js

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, GEN_TIERS } = sb.ShipData;

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

// --- 1. classification vs what saveImport ACTUALLY reads --------------------------------------
// Parsed from shipSchema.js rather than restated here, so that changing an importer mapping
// without revisiting the classification fails this bench instead of silently drifting.
const schemaSrc = fs.readFileSync(path.join(__dirname, '../../webapp/public/shipSchema.js'), 'utf8');
const importRe = /save\.([A-Za-z0-9_]+) !== undefined\) gear\.([A-Za-z0-9_]+) =/g;
const importedFrom = {};
for (let m = importRe.exec(schemaSrc); m; m = importRe.exec(schemaSrc)) importedFrom[m[2]] = m[1];

// Read GROWTH_GEAR_KEYS out of the shipped source rather than a sandbox export: it is a
// module-private const, and parsing the file means this checks what actually ships.
const pageSrcEarly = fs.readFileSync(path.join(__dirname, '../../webapp/public/shipsPage.js'), 'utf8');
const growthDecl = pageSrcEarly.match(/const GROWTH_GEAR_KEYS = new Set\(\[([\s\S]*?)\]\)/);
const growthKeys = new Set(growthDecl
  ? [...growthDecl[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  : []);
if (!growthKeys.size) {
  fail('could not parse GROWTH_GEAR_KEYS from shipsPage.js');
} else {
  Object.entries(importedFrom).forEach(([key, field]) => {
    const isAllTime = /AllTime$/.test(field);
    const classified = growthKeys.has(key);
    if (isAllTime && classified) {
      fail(`${key} imports from ${field} (all-time) but is classified as a growth counter`);
    } else if (!isAllTime && !classified && /ThisLoop$|ThisLR$|^LoopsFilled$/.test(field)) {
      fail(`${key} imports from ${field} (resets) but is NOT classified as a growth counter`);
    }
  });
  if (!failures) pass('every counter\'s growth classification matches the save field it imports from');
}

// --- 2. no invented growth multiplier ---------------------------------------------------------
// The value model must use the counter as entered. A multiplier here cannot fix the zero case
// (1.5 x 0 is still 0) and was previously hung on the misclassification checked above.
const pageSrc = pageSrcEarly;
if (/nodeScalesWithGrowth\([^)]*\)\s*\?\s*[A-Z_]+\s*:/.test(pageSrc)) {
  fail('a growth multiplier is being applied in the value model again -- see GROWTH_VALUE_BOOST\'s '
    + 'removal note before reintroducing one');
} else {
  pass('the value model applies no invented growth multiplier');
}

// --- 3. the zero-counter case is REPORTED, on every ship that has growth nodes -----------------
function seed(counterValue) {
  const store = sb.StoreSchema.freshStore();
  sb.window.store = store;
  Object.keys(CATALOG).map(Number).forEach((id) => {
    store.shipInputs[id] = { ...sb.defaultShipInput(id), rank: 20, crew: 12 };
  });
  GEN_TIERS.forEach((n) => { store.unlockedGens[n] = true; });
  Object.assign(store.shipGear, {
    manualMK2Gens: 40, manualMK3Gens: 30, techUpgrades: 25, hardwareUpgrades: 15,
    softwareUpgrades: 15, loopModsOwned: 35, loopResetsDone: 12, automationsUnlocked: 6,
    researchLevels: 40, totalCompletedResearch: 25, missionsCompleted: 75, meltdown: 1,
    // the resetting ones -- the whole point of the test
    ticksThisLoop: counterValue, operationsCompleted: counterValue, studiesThisLR: counterValue,
    loopFillsThisRun: counterValue, totalManualGens: counterValue,
  });
  return store;
}
const WEIGHTS = { cells: 1, shards: 1, researchPoints: 1, modPoints: 1, missionMaterials: 1, academyPoints: 1 };
const shipsWithGrowth = Object.keys(CATALOG).map(Number).filter((id) =>
  Object.values(CATALOG[id]).some((m) => {
    const k = m.gearKey;
    return k && (Array.isArray(k) ? k.some((x) => growthKeys.has(x)) : growthKeys.has(k));
  }));

seed(0);
const unwarned = shipsWithGrowth.filter((id) =>
  !(sb.optimizeShipInstalls(id, 150, WEIGHTS, false, 'long').warnings || []).length);
if (unwarned.length) {
  fail(`ship(s) ${unwarned.join(', ')} depend on a resetting counter but produced no warning at 0`);
} else {
  pass(`all ${shipsWithGrowth.length} ship(s) with growth nodes warn when their counter is 0`);
}

seed(60);
const spurious = shipsWithGrowth.filter((id) =>
  (sb.optimizeShipInstalls(id, 150, WEIGHTS, false, 'long').warnings || []).length);
if (spurious.length) {
  fail(`ship(s) ${spurious.join(', ')} warned even though every counter is set`);
} else {
  pass('no ship warns once its counters are set');
}

// --- 4. a growth-heavy ship allocates sensibly mid-run ----------------------------------------
// Demeter is the extreme case: 8 of its 11 nodes ride a resetting counter. Cradle-only benches
// cannot see this. The check is deliberately structural (does the plan use the ship's breadth)
// rather than a score threshold, since there is no independent optimum to compare against.
const DEMETER = 5;
seed(60);
const plan = sb.optimizeShipInstalls(DEMETER, 150, WEIGHTS, false, 'long').levels;
const used = Object.values(plan).filter((v) => v > 0).length;
const biggest = Math.max(...Object.values(plan));
if (used < 5 || biggest > 100) {
  fail(`Demeter mid-run plan looks degenerate: ${used} node(s) used, largest ${biggest}/150`);
} else {
  pass(`Demeter mid-run plan spreads across ${used} nodes, largest ${biggest}/150`);
}

console.log(failures ? `\n${failures} failure(s)` : '\ngrowth-counter handling is correct');
process.exit(failures ? 1 : 0);
