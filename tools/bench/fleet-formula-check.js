'use strict';
// Does the fleet sim COMPOSE its per-node bonus the way the game does?
//
//   node tools/bench/fleet-formula-check.js [--verbose]
//
// Every INPUT to that formula is already checked individually -- the authored coefficient
// (node-coefficient-check), the counter each node reads (node-counter-check), the badges and their
// ships (badge-check), the caps and gates (ship-node-gate-check), and that no factor is missing
// (node-factor-check). None of that checks the ARITHMETIC. A node can have the right coefficient,
// the right counter and the right multipliers and still be wrong because they are combined wrong:
// a counter applied twice, a badge multiplying the wrong operand, or the percent-to-fraction
// conversion off by 100 all leave every individual field correct.
//
// This rebuilds the game's own formula from the AUTHORED data --
//
//     bonus = 1 + BaseBonus * crew * counter * level * badgeMult * researchMult * gearMult
//
// -- the shape read out of `FleetManager::get_RU<n><Cat>Bonus` (`1 + pct*crew*counter*mults*level`,
// confirmed twice from the binary) -- and compares it against what the shipped
// `nodeOwnBonusPct` actually returns, across every node and several account states.
//
// THE REFERENCE MUST NOT SHARE THE TOOL'S INPUTS, or it tests the tool against itself. So the
// coefficient here comes from `ship-node-coefficients.json` (the authored `RU<n><Cat>BaseBonus`),
// NOT from the catalog's effect text that `nodeOwnBonusPct` parses. Those two are asserted equal
// elsewhere; using the authored side here means a drift in the effect text shows up as a formula
// mismatch rather than cancelling out on both sides.

const H = require('./harness.js');
const COEFFS = require('../reference/ship-node-coefficients.json');

const verbose = process.argv.includes('--verbose');
const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY, GEN_TIERS } = sb.ShipData;

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

// Account states to compare under. The point of more than one is that a single state can hide a
// mistake: with crew 1 a doubled crew term is invisible, and with every multiplier at 1 a
// misplaced badge is too.
const STATES = [
  { label: 'bare (crew 1, nothing owned)', crew: 1, rank: 1, badges: false, research: 0, gear: 0 },
  { label: 'mid (crew 120, badges, FA2)', crew: 120, rank: 30, badges: true, research: 12, gear: 0 },
  { label: 'high (crew 680, badges, FA2, gear)', crew: 680, rank: 106, badges: true, research: 40, gear: 25 },
];

const COUNTER_VALUES = {
  manualMK2Gens: 40, manualMK3Gens: 30, totalManualGens: 55, techUpgrades: 25,
  hardwareUpgrades: 15, softwareUpgrades: 15, loopModsOwned: 35, loopResetsDone: 12,
  automationsUnlocked: 6, researchLevels: 40, totalCompletedResearch: 25, missionsCompleted: 75,
  ticksThisLoop: 60, operationsCompleted: 60, studiesThisLR: 60, loopFillsThisRun: 60,
  meltdown: 1,
};

function seed(state) {
  const store = sb.StoreSchema.freshStore();
  sb.window.store = store;
  Object.keys(CATALOG).map(Number).forEach((id) => {
    store.shipInputs[id] = { ...sb.defaultShipInput(id), rank: state.rank, crew: state.crew };
  });
  GEN_TIERS.forEach((n) => { store.unlockedGens[n] = true; });
  Object.assign(store.shipGear, COUNTER_VALUES);
  store.fleetBadges.owned.badge_innovation = state.badges;
  store.fleetBadges.owned.badge_innovation_2 = state.badges;
  store.fleetBadges.owned.badge_dark_innovation = state.badges;
  store.fleetResearch.levels.fleetAnalysis1 = state.research;
  store.fleetResearch.levels.fleetAnalysis2 = state.research;
  if (state.gear) {
    sb.getGearSets().pieces.forEach((p) => { p.level = state.gear; p.owned = true; });
  }
  return store;
}

let compared = 0;
let skipped = 0;
const mismatches = [];

for (const state of STATES) {
  seed(state);
  // Read the tool's OWN multiplier helpers for the terms that are not per-node, so this bench
  // tests the composition rather than re-deriving badge and research values that badge-check and
  // crew-rank-check already own. The per-node terms -- coefficient, counter, level, gear piece --
  // are supplied independently below, which is where a composition bug would actually live.
  const badgeMults = sb.computeFleetBadgeMultipliers();
  const researchMults = sb.computeFleetResearchShipMultipliers();

  for (const shipIdStr of Object.keys(CATALOG)) {
    const shipId = Number(shipIdStr);
    const category = SHIP_CATEGORY[shipId];
    const authored = COEFFS.baseBonusByCategory[category] || {};
    for (const [slot, meta] of Object.entries(CATALOG[shipId])) {
      const raw = meta.ruId == null ? undefined : authored[String(meta.ruId)];
      // Nodes with no percentage in their effect text are amplifiers (Demeter's Ahead Of The
      // Curve grants operations rather than multiplying a resource); they are covered by
      // node-effect-probe and have no per-node bonus to compose.
      if (raw === undefined || !/([\d.]+)%/.test(meta.effect)) { skipped++; continue; }

      const level = 7;
      const counter = sb.gearMultiplierFor(meta.gearKey, sb.getShipGear());
      const gearNode = sb.computeGearNodeMultiplier(shipId, Number(slot));
      const expectedPct = raw * 100 * state.crew * counter * level
        * (badgeMults[shipId] || 1) * (researchMults[shipId] || 1) * gearNode;

      const actualPct = sb.nodeOwnBonusPct(shipId, slot, level);
      compared++;

      // Relative tolerance, and the size of it is not arbitrary. The two sides read the SAME
      // coefficient from different places: this bench takes the authored `RU<n><Cat>BaseBonus`,
      // which Unity stores as a float32 (0.027% is held as 0.0002699999895412475), while the tool
      // parses the clean decimal out of the node's effect text. Widening a float32 to double
      // leaves ~7 significant digits, so the two agree to about 1e-8 relative and no closer --
      // demanding more would be demanding the effect text carry float32 rounding error.
      //
      // 1e-6 is still orders of magnitude tighter than any composition mistake: applying a counter
      // twice, dropping a badge or misplacing the /100 moves the result by percent to factor-of-100
      // amounts, never by parts per million. Verified by negative control.
      const denom = Math.max(Math.abs(expectedPct), Math.abs(actualPct), 1e-300);
      const rel = Math.abs(expectedPct - actualPct) / denom;
      if (!(rel < 1e-6)) {
        mismatches.push(`[${state.label}] ship ${shipId} slot ${slot} (RU${meta.ruId}${category}): `
          + `formula ${expectedPct}, tool ${actualPct}`);
      } else if (verbose) {
        console.log(`  ok ship ${shipId} slot ${slot}: ${actualPct}`);
      }
    }
  }
}

if (!compared) fail('compared no nodes at all');
if (mismatches.length) {
  [...new Set(mismatches)].slice(0, 12).forEach(fail);
  if (mismatches.length > 12) console.log(`      … and ${mismatches.length - 12} more`);
} else if (compared) {
  pass(`the per-node bonus composes exactly as the game does, across ${compared} node/state `
    + `combinations (${skipped} amplifier node(s) have no percentage to compose)`);
}

// --- the level term must be LINEAR, which the formula asserts but a single level cannot show ----
// `1 + pct*crew*counter*mults*level` is linear in level, so doubling the level must exactly double
// the bonus percentage. A tool that accidentally compounded per level (base^level, which is how
// GEAR works) would pass every single-level comparison above and still be wrong.
seed(STATES[2]);
const nonLinear = [];
for (const shipIdStr of Object.keys(CATALOG)) {
  for (const [slot, meta] of Object.entries(CATALOG[shipIdStr])) {
    if (!/([\d.]+)%/.test(meta.effect)) continue;
    const one = sb.nodeOwnBonusPct(Number(shipIdStr), slot, 1);
    const ten = sb.nodeOwnBonusPct(Number(shipIdStr), slot, 10);
    if (!one) continue;
    const rel = Math.abs(ten - one * 10) / Math.max(Math.abs(ten), 1e-300);
    if (!(rel < 1e-9)) nonLinear.push(`ship ${shipIdStr} slot ${slot}: level 1 -> ${one}, level 10 -> ${ten}`);
  }
}
if (nonLinear.length) nonLinear.slice(0, 6).forEach(fail);
else pass('every node\'s bonus is exactly linear in its level, as the game\'s formula is');

// --- crew multiplies the bonus linearly too -----------------------------------------------------
// Worth its own check because importing the raw save field understated crew on every ship, and the
// symptom was a uniformly low total rather than an error.
const crewA = seed({ ...STATES[1], crew: 100 });
const beforeCrew = sb.nodeOwnBonusPct(1, '1', 5);
void crewA;
seed({ ...STATES[1], crew: 200 });
const afterCrew = sb.nodeOwnBonusPct(1, '1', 5);
if (!(Math.abs(afterCrew - beforeCrew * 2) / Math.max(afterCrew, 1e-300) < 1e-9)) {
  fail(`doubling crew did not double the bonus: ${beforeCrew} -> ${afterCrew}`);
} else {
  pass('doubling crew exactly doubles a node\'s bonus, as the game\'s formula requires');
}

console.log(failures ? `\n${failures} failure(s)` : '\nthe fleet per-node formula matches the game');
process.exit(failures ? 1 : 0);
