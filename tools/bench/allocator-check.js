'use strict';
// Does our install allocator find as good a plan as a plain reference greedy, on EVERY ship?
//
// This replaces Cradle-only coverage. `sirred-algorithm-check.js` and
// `real-save-optimizer-check.js` both test Cradle, which has the fewest growth-counter nodes of any
// ship -- which is exactly why a zero-counter collapse on Demeter went unnoticed for so long.
//
// Two deliberate differences from the SirRed benches:
//
//   * **The objective is built from the GAME's authored coefficients**
//     (tools/reference/ship-node-coefficients.json, `baseBonusByCategory[category][ruId]`), not
//     from SirRed's decompiled tool. SirRed's numbers are a community baseline and are already
//     known wrong in places (the 10x Demeter coefficients, the Demeter gates). Scoring against
//     them would measure agreement with an outdated tool rather than correctness.
//   * **It covers all 7 ships**, with gates and caps from `ship-node-gate-check.js`'s verified data.
//
// The objective is the same shape the game uses per node -- `1 + coeff * level * counter * crew`,
// multiplied across nodes -- with Meltdown pinned to 1 (a true no-op exponent) and every focus
// weight equal. Under those conditions our own weighted-product objective reduces exactly to this
// flat product, which is what makes the comparison fair rather than circular: the reference greedy
// is a different ALGORITHM optimising the SAME function.
//
// What this can and cannot show: it verifies the SEARCH (does our greedy leave value on the table),
// not the value model. A shared mistake in the coefficients would be invisible here -- that is what
// node-coefficient-check.js is for.
//
// LIMITATION, stated rather than papered over: this runs at EVEN focus weights only. With uneven
// weights our objective stops being the flat product, and a reference would have to replicate our
// weighting rule (a node takes the strongest slider touching it) to stay comparable -- at which
// point it is testing our model against itself instead of testing the search. Uneven-weight
// behaviour is a model question, and it is not covered here.
//
// Verified with a negative control: restoring the old RUN_LENGTH_BIAS.long ({cells: 0.7,
// gen: 1.35}) makes this fail on Cradle with exactly the historical 13.59 / 14.50 / 35.70 / 17.53
// percentages -- and on Auxesia too, which the Cradle-only benches could never see.
//
//   node tools/bench/allocator-check.js
//   node tools/bench/allocator-check.js --verbose

const H = require('./harness.js');
const COEFFS = require('../reference/ship-node-coefficients.json').baseBonusByCategory;

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY, GEN_TIERS } = sb.ShipData;
const verbose = process.argv.includes('--verbose');

const CREW = 12;
const BUDGETS = [10, 30, 75, 150, 300];
// Weight scenarios. Uneven weights are testable because the reference implements the OBJECTIVE's
// own weighting -- a node's weight is the sum of the sliders it touches, which falls out of
// maximising prod(resource ^ weight) -- rather than copying a rule from the tool. An earlier
// version of this bench ran even weights only, on the grounds that a reference would have to
// replicate our weighting rule to stay comparable; that was true while the tool took the MAX of a
// node's sliders, and stopped being true once that was corrected to the sum the objective implies.
const WEIGHT_SETS = {
  even:      { cells: 1, shards: 1, researchPoints: 1, modPoints: 1, missionMaterials: 1, academyPoints: 1 },
  cellsOnly: { cells: 5, shards: 0, researchPoints: 0, modPoints: 0, missionMaterials: 0, academyPoints: 0 },
  shardTilt: { cells: 1, shards: 5, researchPoints: 1, modPoints: 0, missionMaterials: 0, academyPoints: 1 },
  research:  { cells: 0, shards: 1, researchPoints: 5, modPoints: 1, missionMaterials: 0, academyPoints: 2 },
  // Chosen to make DUAL-resource nodes pivotal: Koios 6 and Zeus 4/5/6/7 read "+X% A & B gained"
  // and feed two buckets at once. With both sliders up and every other bucket off, a node's weight
  // is 6 if you sum its buckets and 3 if you take the strongest -- so this scenario is the one that
  // can tell those two rules apart. Without it, reverting the tool to `max` passes unnoticed.
  dualPivot: { cells: 0, shards: 3, researchPoints: 0, modPoints: 3, missionMaterials: 0, academyPoints: 0 },
};
let WEIGHTS = WEIGHT_SETS.even;

// The objective is over RESOURCES, not nodes. Five nodes read "+X% A & B gained" and multiply two
// resources at once (Koios 6, Zeus 4/5/6/7), so their factor enters the product twice. Counting
// each node once would understate them and would disagree with the tool for the right reason --
// the reference has to model the objective, not the node list.
const BUCKET = {
  cells: 'cells', allGens: 'cells', shards: 'shards', researchPoints: 'researchPoints',
  modPoints: 'modPoints', academyPoints: 'academyPoints', missionMaterials: 'missionMaterials',
  techSoftware: 'cells', techHardware: 'cells',
};
GEN_TIERS.forEach((n) => { BUCKET[`mk${n}`] = 'cells'; });
function weightOf(shipId, slot) {
  const buckets = [...new Set(sb.effectResources(CATALOG[shipId][slot].effect)
    .map((r) => BUCKET[r]).filter(Boolean))];
  // A node whose effect maps to NO known bucket still counts once -- we simply cannot weight it.
  // A node that maps to buckets the user has set to ZERO genuinely contributes nothing, and must
  // score zero. Collapsing those two cases with `w || 1` silently rewrote the objective: it valued
  // Cells nodes at weight 1 in a scenario with the Cells slider at 0, and then reported the tool as
  // up to 99% "worse" for correctly declining them. The tool was right; the reference was measuring
  // a different function. Exactly the silent-default trap this project bans elsewhere.
  if (!buckets.length) return 1;
  return buckets.reduce((sum, b) => sum + (WEIGHTS[b] || 0), 0);
}

// Every "per X" counter set to a realistic mid-run value, so growth nodes actually participate --
// the whole point of extending past Cradle. Values are arbitrary but fixed, and shared by both
// allocators, so they cannot favour either.
const GEAR = {
  manualMK2Gens: 40, manualMK3Gens: 30, totalManualGens: 120,
  techUpgrades: 25, hardwareUpgrades: 15, softwareUpgrades: 15,
  loopModsOwned: 35, loopFillsThisRun: 8, loopResetsDone: 12,
  automationsUnlocked: 6, ticksThisLoop: 500,
  operationsCompleted: 60, studiesThisLR: 20,
  researchLevels: 40, totalCompletedResearch: 25,
  missionsCompleted: 75, meltdown: 1,
};

function seed() {
  const store = sb.StoreSchema.freshStore();
  sb.window.store = store;
  Object.keys(CATALOG).map(Number).forEach((id) => {
    store.shipInputs[id] = { ...sb.defaultShipInput(id), rank: 20, crew: CREW };
  });
  GEN_TIERS.forEach((n) => { store.unlockedGens[n] = true; });
  Object.assign(store.shipGear, GEAR);
  return store;
}

/** The authored per-level fraction for a node, via its ruId in the ship's RU category.
 *
 * Returns null for a node that is not a multiplicative resource bonus at all. Demeter 1 ("+1
 * completed operation per crew member on new-run start") is the case that matters: it has an
 * authored coefficient like any other node, but the number is a COUNT of operations, not a
 * percentage of a resource. Feeding it into a product objective as `1 + 1.0*level*crew` makes it
 * look like the best node on the ship by a mile, and the first run of this bench duly reported our
 * allocator as 96.87% behind for declining to buy it. Our allocator was right: nodeLinearIncrement
 * parses the leading percentage out of the effect text and finds none. `node-coefficient-check.js`
 * excludes the same node for the same reason ("no % in the effect text").
 */
function coeffOf(shipId, slot) {
  const meta = CATALOG[shipId][slot];
  if (!/%/.test(meta.effect || '')) return null;
  const cat = COEFFS[SHIP_CATEGORY[shipId]];
  const c = cat ? cat[String(meta.ruId)] : undefined;
  return typeof c === 'number' ? c : null;
}

/** The "per X" count this node's bonus multiplies against; 1 when the node has no qualifier. */
function counterOf(shipId, slot) {
  const key = CATALOG[shipId][slot].gearKey;
  if (!key) return 1;
  const n = Array.isArray(key)
    ? key.reduce((sum, k) => sum + (GEAR[k] || 0), 0)
    : (GEAR[key] || 0);
  return n;
}

function makeObjective(shipId) {
  const slots = Object.keys(CATALOG[shipId]).map(Number);
  // Per-level increment, given how many AOTC levels are bought (which raises operations).
  const incFor = (slot, aotcLevel) => {
    const c = coeffOf(shipId, slot);
    if (c === null) return null;
    const meta = CATALOG[shipId][slot];
    const opsBoost = (shipId === AOTC_SHIP && meta.gearKey === 'operationsCompleted')
      ? CREW * aotcLevel : 0;
    return c * (counterOf(shipId, slot) + opsBoost) * CREW;
  };
  return {
    slots,
    incFor,
    // log-space: these products reach 1e30+ on real fixtures and would lose precision as doubles
    logScore(levels) {
      const aotcLevel = shipId === AOTC_SHIP ? (levels[AOTC_SLOT] || 0) : 0;
      let total = 0;
      slots.forEach((s) => {
        const i = incFor(s, aotcLevel);
        if (!i) return;
        total += Math.log1p(i * (levels[s] || 0)) * weightOf(shipId, s);
      });
      return total;
    },
  };
}

// Demeter slot 1 ("Ahead of the Curve") GRANTS OPERATIONS rather than multiplying a resource, and
// operations are the counter 8 of Demeter's 11 nodes scale with. The game states it:
// LoopModifiers.PerformLoop() adds FleetManager.RUShard1Bonus into the run's operations
// (MasterManager.NewSMOpsFromAOTCThisRun), and RUShard1Bonus is linear in the node's level at
// `RU1ShardBaseBonus(1.0) * crew * <mults> * level` -- so one operation per crew member per level.
//
// The reference therefore models it too, and enumerates all six possible levels. It used to instead
// mirror a fixed "max it above budget 15" policy from the tool, which meant the bench could never
// have judged that policy -- and the policy turned out to be leaving up to 47.5% on the table
// between budgets 7 and 14. A reference that copies the thing under test cannot test it.
const AOTC_SHIP = 5;
const AOTC_SLOT = 1;

/** Reference greedy at a FIXED AOTC level: spend each point where it multiplies the product most. */
function referenceGreedyPinned(shipId, budget, obj, aotcLevel) {
  const levels = {};
  obj.slots.forEach((s) => { levels[s] = 0; });
  let spent = 0;
  if (shipId === AOTC_SHIP && aotcLevel > 0) {
    levels[AOTC_SLOT] = Math.min(aotcLevel, budget);
    spent += levels[AOTC_SLOT];
  }
  while (spent < budget) {
    let best = null;
    let bestGain = 0;
    for (const s of obj.slots) {
      if (shipId === AOTC_SHIP && s === AOTC_SLOT) continue; // pinned above
      const inc = obj.incFor(s, levels[AOTC_SLOT] || 0);
      if (!inc) continue;
      const meta = CATALOG[shipId][s];
      const level = levels[s];
      if (level >= sb.nodeMaxLevel(shipId, s)) continue;
      // Same gate semantics the game uses and our allocator enforces: installs on this ship,
      // excluding the node's own levels (a node cannot bootstrap its own prerequisite).
      if (meta.gateAtTotalInstalls && (spent - level) < meta.gateAtTotalInstalls) continue;
      // Weight the marginal, not just the final score. Maximising prod(resource ^ weight) means
      // maximising sum(weight * log(resource)), so the per-point gain a greedy ranks on has to
      // carry the weight too. Scoring with weights while PICKING without them made this reference
      // optimise the unweighted product -- a baseline too weak to detect a real weighting
      // regression in the tool, which is exactly what it failed to do.
      const gain = (Math.log1p(inc * (level + 1)) - Math.log1p(inc * level)) * weightOf(shipId, s);
      if (gain > bestGain) { bestGain = gain; best = s; }
    }
    if (best === null) break; // everything capped or gated
    levels[best] += 1;
    spent += 1;
  }
  return levels;
}

let worse = 0;
let compared = 0;
const rows = [];

for (const [wName, wSet] of Object.entries(WEIGHT_SETS)) {
for (const shipId of Object.keys(CATALOG).map(Number).sort((a, b) => a - b)) {
  WEIGHTS = wSet;
  const obj = makeObjective(shipId);
  const missing = obj.slots.filter((s) => obj.incFor(s, 0) === null);
  if (missing.length === obj.slots.length) {
    rows.push(`SKIP ship ${shipId}: no authored coefficients`);
    continue;
  }
  for (const budget of BUDGETS) {
    seed();
    const ours = sb.optimizeShipInstalls(shipId, budget, WEIGHTS, false, 'long').levels;
    // Enumerate AOTC levels for Demeter; every other ship has a single pin of 0.
    const pins = shipId === AOTC_SHIP
      ? Array.from({ length: Math.min(sb.nodeMaxLevel(shipId, AOTC_SLOT), budget) + 1 }, (_, i) => i)
      : [0];
    let ref = null;
    let refBest = -Infinity;
    for (const pin of pins) {
      const cand = referenceGreedyPinned(shipId, budget, obj, pin);
      const sc = obj.logScore(cand);
      if (sc > refBest) { refBest = sc; ref = cand; }
    }
    const oursLog = obj.logScore(ours);
    const refLog = obj.logScore(ref);
    compared++;
    // Compare in log space: a 1e-9 relative slack on the log is far tighter than it looks, since
    // the scores themselves span many orders of magnitude.
    const behind = refLog - oursLog;
    const bad = behind > Math.max(1e-9, Math.abs(refLog) * 1e-9);
    if (bad) {
      worse++;
      const pct = (Math.expm1(-behind) * 100).toFixed(2);
      rows.push(`WORSE [${wName}] ship ${shipId} budget ${budget}: ours ${pct}% of reference`);
      rows.push(`        ours: ${JSON.stringify(ours)}`);
      rows.push(`        ref : ${JSON.stringify(ref)}`);
    } else if (verbose) {
      rows.push(`ok    [${wName}] ship ${shipId} budget ${budget}: log ${oursLog.toFixed(6)} vs ${refLog.toFixed(6)}`);
    }
  }
}

}
rows.forEach((r) => console.log(r));
console.log(`\ncompared ${compared} (ship, budget) combination(s) across `
  + `${Object.keys(CATALOG).length} ships, objective from the GAME's authored coefficients`);
if (worse) {
  console.log(`${worse} case(s) where our allocator found a worse plan than a plain reference greedy`);
  process.exit(1);
}
console.log('our allocator matches or beats a reference greedy on every ship and budget');
