'use strict';
// Validates the ship install optimizer against a REAL pulled save (not the synthetic
// seedAccount() fixture ship-test.js and sirred-algorithm-check.js use) -- the user's own
// complaint was specifically that manually-found builds beat the tool's recommendations, so
// this checks with real crew/gear/rank numbers, not idealized ones.
//
//   node tools/bench/real-save-optimizer-check.js [path/to/decoded-save.json]

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const savePath = process.argv[2] || path.join(__dirname, '../gamefiles/save/decoded-20260809.json');
if (!fs.existsSync(savePath)) {
  console.log(`SKIP: ${savePath} missing -- no pulled save in this checkout`);
  process.exit(0);
}
const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, GEN_TIERS } = sb.ShipData;
const coefficients = require('../reference/sirred-install-coefficients.json');

sb.window.store = sb.StoreSchema.freshStore();
sb.window.saveStore = sb.saveStore = () => {}; // no-op under Node -- nothing persists this run
sb.window.applyImportedShipData(save, {
  shipRanks: true, unlockedGens: true, shipGear: true, fleetResearch: true, gearSets: true, fleetBadges: true,
});
sb.autofillShipInputFromSave();

const gear = sb.getShipGear();
console.log('Real gear counters from save:', JSON.stringify(gear));
console.log('Unlocked gens:', JSON.stringify(sb.getUnlockedGens()));

let failures = 0;
function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.stack.split('\n').slice(0, 2).join(' | ')}`);
    failures++;
  }
}

const EVEN_WEIGHTS = { cells: 1, shards: 1, researchPoints: 1, modPoints: 1, missionMaterials: 1, academyPoints: 1 };
const BUDGETS = [50, 150, 400];

// --- Structural sanity across every ship, with REAL crew/rank/gear/unlocked-gens state ---
for (let shipId = 1; shipId <= 7; shipId++) {
  if (!CATALOG[shipId]) continue;
  const input = sb.getShipInput(shipId);
  console.log(`\nShip ${shipId} (${sb.shipDisplayName(shipId)}): rank=${input.rank} crew=${input.crew} rankPoints=${input.rankPoints}`);
  for (const budget of BUDGETS) {
    check(`ship ${shipId} budget ${budget}: never overspends`, () => {
      const { levels, clicks } = sb.optimizeShipInstalls(shipId, budget, EVEN_WEIGHTS, false, 'long');
      const spent = Object.values(levels).reduce((a, b) => a + b, 0);
      if (spent > budget) return `spent ${spent} of ${budget}`;
      if (clicks.length !== spent) return `${clicks.length} clicks vs ${spent} points in levels`;
      return null;
    });
    check(`ship ${shipId} budget ${budget}: respects every node's real (5x) cap and gate`, () => {
      const { levels } = sb.optimizeShipInstalls(shipId, budget, EVEN_WEIGHTS, false, 'long');
      const spentSoFarAt = (() => {
        // Recompute cumulative totalInstalls at the point each slot's points were bought is not
        // tracked by levels alone -- approximate with the final total, which is a valid (looser)
        // gate check: if the FINAL total didn't clear a gate, the level bought there couldn't be legal.
        return Object.values(levels).reduce((a, b) => a + b, 0);
      })();
      for (const [slot, lvl] of Object.entries(levels)) {
        const cap = sb.nodeMaxLevel(shipId, slot);
        if (lvl > cap) return `slot ${slot} has ${lvl}, cap is ${cap}`;
        const gate = CATALOG[shipId][slot].gateAtTotalInstalls || 0;
        if (lvl > 0 && spentSoFarAt < gate) return `slot ${slot} got ${lvl} point(s) but total spend ${spentSoFarAt} never reaches its gate ${gate}`;
      }
      return null;
    });
  }
}

// --- Real-data comparison against SirRed's own greedy algorithm, Cradle only (the one ship
// whose formulas were fully decompiled and validated this session) -- same method as
// sirred-algorithm-check.js, but with THIS account's real crew/gear counters instead of a
// synthetic fixture.
//
// SirRed's tool is a useful ROUGH BASELINE, not a source of truth -- it is an outdated community
// tool, and per the project owner it should be treated that way, not as ground truth to chase
// exact parity with.
//
// nodeBonus/totalBonus below have NO melt term -- they use the plain `1 + coeff*level*counter*
// crew` shape everywhere, i.e. this SCRIPT's own model is equivalent to always assuming
// Meltdown=1 (Math.pow(x, 1) = x, a no-op). That was a deliberate simplifying choice for this
// comparison (matching sirred-algorithm-check.js's synthetic-fixture version), NOT a verified
// fact about SirRed's own tool -- SirRed's actual UI has a Meltdown input, so its real algorithm
// almost certainly does account for it somehow. This project does not currently have SirRed's
// decompiled source on disk to check its real formula (that RE work was done in an earlier
// session and not preserved), so do not repeat the "SirRed has no Meltdown concept" claim as
// fact anywhere -- it was an incorrect inference from this script's own simplification, caught
// and corrected 2026-09-02.
//
// Our own allocator DOES read this account's real Meltdown value (0.373 on the reference save)
// and applies it per generator tier (see poolAdjustedNodeValue). Given that, and that this
// script's SirRed side ignores Meltdown entirely, the two sides are almost certainly scoring
// different objectives whenever an account's real Meltdown differs from 1 -- but that is a
// hypothesis this script does not actually verify, not a settled explanation. A gap here is a
// prompt to go inspect the specific plan difference (gate/counter/tier causes are all real and
// inspectable via the ship-by-ship printouts above), not proof of a bug, and not proof of
// anything about Meltdown specifically without re-deriving SirRed's real formula.
const CRADLE_ID = 1;
const cradleInput = sb.getShipInput(CRADLE_ID);
const CREW = cradleInput.crew || 0;
const CRADLE_COUNTER = {
  1: 1, 2: 1, 3: 1, 4: gear.manualMK2Gens || 0, 5: 1, 6: 1, 7: gear.manualMK3Gens || 0,
  8: gear.totalManualGens || 0, 9: gear.totalManualGens || 0, 10: gear.totalManualGens || 0, 11: gear.totalManualGens || 0,
};
function coeff(slot) { return coefficients[`Cra${String(slot).padStart(2, '0')}`]; }
function nodeBonus(slot, level) {
  if (level <= 0) return 1;
  return 1 + coeff(slot) * level * CRADLE_COUNTER[slot] * CREW;
}
function totalBonus(levels) {
  let total = 1;
  for (let slot = 1; slot <= 11; slot++) total *= nodeBonus(slot, levels[slot] || 0);
  return total;
}
function simulateSirred(budget) {
  const levels = {};
  for (let slot = 1; slot <= 11; slot++) levels[slot] = 0;
  const maxLevel = (slot) => sb.nodeMaxLevel(CRADLE_ID, slot);
  const gateOf = (slot) => CATALOG[CRADLE_ID][slot].gateAtTotalInstalls || 0;
  let totalInstalls = 0;
  while (totalInstalls < budget) {
    let bestSlot = null; let bestBonus = -1;
    for (let slot = 1; slot <= 11; slot++) {
      if (totalInstalls < gateOf(slot)) continue;
      if (levels[slot] >= maxLevel(slot)) continue;
      const trial = { ...levels, [slot]: levels[slot] + 1 };
      const bonus = totalBonus(trial);
      if (bonus > bestBonus) { bestBonus = bonus; bestSlot = slot; }
    }
    if (bestSlot === null) break;
    levels[bestSlot] += 1;
    totalInstalls += 1;
  }
  return levels;
}

console.log(`\n=== Cradle real-data comparison (crew=${CREW}, counters=${JSON.stringify(CRADLE_COUNTER)}) ===`);
let worseCount = 0;
for (const budget of BUDGETS) {
  const oursPlan = sb.optimizeShipInstalls(CRADLE_ID, budget, EVEN_WEIGHTS, false, 'long').levels;
  const sirredPlan = simulateSirred(budget);
  const oursScore = totalBonus(oursPlan);
  const sirredScore = totalBonus(sirredPlan);
  const ratio = sirredScore > 0 ? oursScore / sirredScore : 1;
  const verdict = ratio >= 0.999 ? 'ours >= SirRed baseline' : `diverges from SirRed baseline by ${((1 - ratio) * 100).toFixed(2)}% (not necessarily a bug -- see comment above)`;
  if (ratio < 0.999) worseCount++;
  console.log(`budget ${budget}: ours=${oursScore.toExponential(4)} sirred=${sirredScore.toExponential(4)} -> ${verdict}`);
  console.log(`  ours   : ${JSON.stringify(oursPlan)}`);
  console.log(`  sirred : ${JSON.stringify(sirredPlan)}`);
}

console.log(`\n${failures === 0 ? 'all structural sanity checks pass' : failures + ' structural check(s) FAILED'} on real save data`);
console.log(worseCount === 0
  ? 'our allocator matches or beats the SirRed baseline at every tested budget on REAL account data'
  : `our allocator diverged from the SirRed baseline at ${worseCount}/${BUDGETS.length} real-data budget(s) -- `
    + 'this script\'s SirRed-side model ignores Meltdown (unverified whether SirRed\'s real tool does '
    + 'too -- see the comment above), so a gap is a prompt for manual inspection, not a fail signal');
process.exit(failures === 0 ? 0 : 1);
