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

const savePath = process.argv[2] || (H.latestDecodedSave() || {}).path;
if (!fs.existsSync(savePath)) {
  console.log(`SKIP: ${savePath} missing -- no pulled save in this checkout`);
  process.exit(0);
}
const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG } = sb.ShipData;
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
// WHAT IS BEING COMPARED, and what the yardstick is.
//
// Two ALLOCATORS (ours vs SirRed's plain "maximise the total product" greedy), scored by ONE
// shared objective. That objective is the GAME's own formula, read directly out of libil2cpp.so
// -- see the long comment above nodeMarginalLogGain in shipsPage.js for every RVA and field
// offset. In short, all of it verified rather than assumed:
//   * every install node is an INDEPENDENT MULTIPLICATIVE factor, `1 + coeff*crew*counter*level`
//     (FleetManager::get_RUGen2Bonus tail-calls BigDouble::op_Addition onto a literal 1). Nodes
//     are never summed into a shared pool -- RUGen2Bonus and RUGen4Bonus, both MK1-boosting
//     Cradle nodes, are multiplied into get_MK1Production separately.
//   * Meltdown (OuroborosResetter.FinalMeltdownPower) reaches a node's bonus through exactly one
//     site -- get_CellProduction's Pow(MK1Production, m) -- and since (A*B)^m == A^m * B^m, every
//     generator-stage bonus therefore carries exponent m, applied ONCE.
//   * direct Cells/Shards/RP bonuses live in get_CellProductionTotalMult, applied OUTSIDE that
//     Pow, so they carry exponent 1.
//   * there is NO m^tierCount: MK2Gains adds MK2Production into the MK1 count with a plain
//     op_Addition and no Pow, so a higher-tier bonus still picks up m exactly once.
//
// This yardstick has been WRONG twice in this file's short history, so it is worth recording why
// it is trusted now. First it pinned Meltdown to 1 as a deliberate simplification -- and that
// simplification was then misremembered and written up as "SirRed's tool has no Meltdown concept
// at all", an unverified claim about someone else's tool, corrected only after the project owner
// pointed out that SirRed's UI plainly has a Meltdown input. Then it scored with `m^tierCount`,
// taken on trust from this repo's own older notes. Disassembling the game settled it: the game
// does not do `m^tierCount`. Both wrong versions came from citing a second-hand summary instead
// of the primary source. The numbers here now come from the binary.
//
// SirRed's tool remains a useful ROUGH BASELINE for the ALGORITHM only -- an outdated community
// tool, not ground truth, and parity with it is not a goal. A divergence below is a prompt to go
// inspect the specific plan difference, not a failure signal.
const CRADLE_ID = 1;
const cradleInput = sb.getShipInput(CRADLE_ID);
const CREW = cradleInput.crew || 0;
const MELTDOWN = gear.meltdown || 0;
const CRADLE_COUNTER = {
  1: 1, 2: 1, 3: 1, 4: gear.manualMK2Gens || 0, 5: 1, 6: 1, 7: gear.manualMK3Gens || 0,
  8: gear.totalManualGens || 0, 9: gear.totalManualGens || 0, 10: gear.totalManualGens || 0, 11: gear.totalManualGens || 0,
};
function coeff(slot) { return coefficients[`Cra${String(slot).padStart(2, '0')}`]; }
/** Does this node feed a generator stage (Meltdown exponent m) or a final resource (exponent 1)? */
function isGenStage(slot) {
  const tags = sb.effectResources(CATALOG[CRADLE_ID][slot].effect);
  return tags.includes('allGens') || tags.some((t) => /^mk\d+$/.test(t));
}
function nodeBonus(slot, level) {
  if (level <= 0) return 1;
  const base = 1 + coeff(slot) * level * CRADLE_COUNTER[slot] * CREW;
  // Meltdown only melts once the first Ouroboros reset is done; a stored 0 means the game is on
  // its un-melted branch (exponent 1), not that the bonus is worthless.
  const m = MELTDOWN > 0 ? MELTDOWN : 1;
  return isGenStage(slot) ? base ** m : base;
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
  const verdict = ratio >= 0.999 ? 'ours >= SirRed baseline' : `diverges from SirRed baseline by ${((1 - ratio) * 100).toFixed(2)}% (both plans scored under the GAME's own formula -- see comment above)`;
  if (ratio < 0.999) worseCount++;
  console.log(`budget ${budget}: ours=${oursScore.toExponential(4)} sirred=${sirredScore.toExponential(4)} -> ${verdict}`);
  console.log(`  ours   : ${JSON.stringify(oursPlan)}`);
  console.log(`  sirred : ${JSON.stringify(sirredPlan)}`);
}

console.log(`\n${failures === 0 ? 'all structural sanity checks pass' : failures + ' structural check(s) FAILED'} on real save data`);
console.log(worseCount === 0
  ? 'our allocator matches or beats the SirRed baseline at every tested budget on REAL account data'
  : `our allocator diverged from the SirRed baseline at ${worseCount}/${BUDGETS.length} real-data budget(s) -- `
    + 'both plans are now scored under SirRed\'s own documented Meltdown formula, so this is a real '
    + 'gap worth inspecting, not a scoring-mismatch artifact');
process.exit(failures === 0 ? 0 : 1);
