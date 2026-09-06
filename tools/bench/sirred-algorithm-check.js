'use strict';
// Does our own greedy allocator (value/cost ratio + category fairness) ever leave real value on
// the table compared to SirRed's own algorithm (pure "maximize total product" greedy, no fairness
// at all)? Caps/gates/coefficients are already cross-checked exact (sirred-ship-check.js); this
// checks the ALGORITHM instead -- given the identical inputs, which one finds the better plan.
//
// Meltdown is deliberately pinned to 1 (a true no-op exponent, x^1 = x) so this comparison is not
// entangled with the still-unresolved Meltdown-scope disagreement (see shipsPage.js's own
// comment on that) -- every node's bonus reduces to the same plain `1 + coeff*level*counter*crew`
// shape on both sides.
//
// Ship: Cradle, using the same realistic seedAccount() fixture ship-test.js itself uses, and the
// real coefficients already extracted into tools/reference/sirred-install-coefficients.json.
//
//   node tools/bench/sirred-algorithm-check.js

const H = require('./harness.js');
const coefficients = require('../reference/sirred-install-coefficients.json');

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, GEN_TIERS } = sb.ShipData;

const SHIP_ID = 1; // Cradle
const PREFIX = 'Cra';
const CREW = 12;
const COUNTERS = { manualMK2Gens: 40, manualMK3Gens: 30, totalManualGens: 120 };

function seedAccount() {
  const store = sb.StoreSchema.freshStore();
  sb.window.store = store;
  Object.keys(CATALOG).map(Number).forEach((id) => {
    store.shipInputs[id] = { ...sb.defaultShipInput(id), rank: 20, crew: CREW };
  });
  GEN_TIERS.forEach((n) => { store.unlockedGens[n] = true; }); // all 10 tiers unlocked
  Object.assign(store.shipGear, {
    manualMK2Gens: COUNTERS.manualMK2Gens, manualMK3Gens: COUNTERS.manualMK3Gens,
    totalManualGens: COUNTERS.totalManualGens,
    techUpgrades: 25, hardwareUpgrades: 15, softwareUpgrades: 15,
    loopModsOwned: 35, loopFillsThisRun: 8, loopResetsDone: 12,
    automationsUnlocked: 6, ticksThisLoop: 500,
    operationsCompleted: 60, studiesThisLR: 20,
    researchLevels: 40, totalCompletedResearch: 25,
    missionsCompleted: 75, meltdown: 1,
  });
  return store;
}

// Which real DataController counter each Cradle node's coefficient multiplies against, read
// directly off CradleOptimizer.cs (decompiled 2026-09-02). Node 1 has no counter at all (crew
// only); nodes 4/7 use the manual MK2/MK3 gen counts; the "corner" nodes 8-11 use totalManualGens.
const CRADLE_COUNTER = {
  1: 1, 2: 1, 3: 1, 4: COUNTERS.manualMK2Gens, 5: 1, 6: 1, 7: COUNTERS.manualMK3Gens,
  8: COUNTERS.totalManualGens, 9: COUNTERS.totalManualGens, 10: COUNTERS.totalManualGens, 11: COUNTERS.totalManualGens,
};

function coeff(slot) { return coefficients[`${PREFIX}${String(slot).padStart(2, '0')}`]; }
function nodeBonus(slot, level) {
  if (level <= 0) return 1;
  return 1 + coeff(slot) * level * CRADLE_COUNTER[slot] * CREW; // meltdown pinned to 1, no exponent needed
}
function totalBonus(levels) {
  let total = 1;
  for (let slot = 1; slot <= 11; slot++) total *= nodeBonus(slot, levels[slot] || 0);
  return total;
}

/** SirRed's own CalcBestBonus loop, translated directly from InstallOptimizer.cs/CradleOptimizer.cs. */
function simulateSirred(budget) {
  const levels = {};
  for (let slot = 1; slot <= 11; slot++) levels[slot] = 0;
  const maxLevel = (slot) => sb.nodeMaxLevel(SHIP_ID, slot);
  const gateOf = (slot) => CATALOG[SHIP_ID][slot].gateAtTotalInstalls || 0;
  let totalInstalls = 0;
  while (totalInstalls < budget) {
    let bestSlot = null; let bestBonus = -1;
    for (let slot = 1; slot <= 11; slot++) {
      if (totalInstalls < gateOf(slot)) continue; // SirRed: totalInstalls >= unlockThreshold
      if (levels[slot] >= maxLevel(slot)) continue; // installEntities cap
      const trial = { ...levels, [slot]: levels[slot] + 1 };
      const bonus = totalBonus(trial);
      if (bonus > bestBonus) { bestBonus = bonus; bestSlot = slot; }
    }
    if (bestSlot === null) break; // every node capped or gated -- SirRed's loop would spin forever; we just stop
    levels[bestSlot] += 1;
    totalInstalls += 1;
  }
  return levels;
}

// Cradle's own Ins1..Ins11 (decompiled) end in `,focusWeights.x)` UNIFORMLY -- every node scales
// by the same weight axis, so SirRed's own tool does not actually distinguish "cellsOnly" from
// "even" for THIS ship (unlike Koios/Zeus, which spread x/y/z/w across different nodes). Only one
// weight scenario is meaningful here as a result; it is the closest match to our "even" weights.
const WEIGHT_SETS = {
  even: { cells: 1, shards: 1, researchPoints: 1, modPoints: 1, missionMaterials: 1, academyPoints: 1 },
};
const BUDGETS = [10, 30, 75, 150, 300];

console.log(`Cradle, crew ${CREW}, all gens unlocked, meltdown pinned to 1 (true no-op)\n`);
let worseCount = 0;
let total = 0;
for (const [wName, weights] of Object.entries(WEIGHT_SETS)) {
  console.log(`=== weights: ${wName} ===`);
  for (const budget of BUDGETS) {
    total++;
    seedAccount();
    const oursPlan = sb.optimizeShipInstalls(SHIP_ID, budget, weights, false, 'long').levels;
    const sirredPlan = simulateSirred(budget);
    const oursScore = totalBonus(oursPlan);
    const sirredScore = totalBonus(sirredPlan);
    const ratio = oursScore / sirredScore;
    const verdict = ratio >= 0.999 ? 'ours >= SirRed' : `ours WORSE by ${((1 - ratio) * 100).toFixed(2)}%`;
    if (ratio < 0.999) worseCount++;
    console.log(`budget ${budget}: ours=${oursScore.toExponential(4)} sirred=${sirredScore.toExponential(4)} -> ${verdict}`);
    console.log(`  ours   : ${JSON.stringify(oursPlan)}`);
    console.log(`  sirred : ${JSON.stringify(sirredPlan)}`);
  }
}

console.log(worseCount === 0
  ? '\nour allocator never scores worse than SirRed\'s own greedy algorithm at any tested budget'
  : `\nour allocator scored worse than SirRed's greedy algorithm at ${worseCount}/${total} (budget, weight) combination(s)`);
// EXIT NON-ZERO ON A REAL DIVERGENCE. This printed the finding and exited 0, so a regression was
// invisible to any suite runner -- catchable only by a human reading the output.
//
// NOT the same as sirred-ship-check, which is deliberately a report because the GAME arbitrates
// caps and gates and failing against SirRed there would mean failing for being right. Here
// SirRed's greedy is a reference ALGORITHM and being beaten by it is a defect in ours:
// neutralising RUN_LENGTH_BIAS made the two agree EXACTLY, so any divergence is a regression.
process.exit(worseCount === 0 ? 0 : 1);
