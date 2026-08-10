'use strict';
// Invariant tests for the ship install optimizer (shipsPage.js optimizeShipInstalls).
//
// This code had no automated coverage of any kind. It is a ~170-line greedy allocator with
// category fair-queueing, per-node fair-queueing, unlock gates, a meltdown-adjusted value model
// and a hardcoded special case -- exactly the shape of thing that silently drifts.
//
// The tests assert properties the implementation CLAIMS, none of which need a known-correct
// answer to check:
//   * determinism            same inputs -> byte-identical plan
//   * budget                 never overspends; clicks and levels agree
//   * caps                   no node above its max level
//   * gates                  no node bought before its total-installs gate
//   * locked tiers           no investment in single-tier nodes for locked generators
//   * no consecutive repeats the "never buy 20 of the same thing in a row" claim
//   * prefix growth          a smaller budget's click order is a prefix of a larger one's,
//                            which is what "a sane partial-budget snapshot at every step" means
//   * weight respect         a zero-weighted category is only funded as a last resort
//
// Runs the SHIPPED shipsPage.js under Node via the same sandbox the optimizer benchmark uses.
//
//   node tools/bench/ship-test.js

const H = require('./harness.js');

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, RESOURCE_TO_WEIGHT_BUCKET, AOTC } = sb.ShipData;
const SHIP_IDS = Object.keys(CATALOG).map(Number).sort((a, b) => a - b);

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

// A spread of weightings that exercises different code paths: even, single-category focus,
// and one with explicit zeros (the "truly excluded" path).
const WEIGHT_SETS = {
  even: { cells: 1, shards: 1, researchPoints: 1, modPoints: 1, missionMaterials: 1, academyPoints: 1 },
  cellsOnly: { cells: 1, shards: 0, researchPoints: 0, modPoints: 0, missionMaterials: 0, academyPoints: 0 },
  shardsHeavy: { cells: 1, shards: 5, researchPoints: 1, modPoints: 0, missionMaterials: 0, academyPoints: 0 },
};
const BUDGETS = [1, 5, 15, 40, 120];

const plan = (shipId, budget, weights, prep = false, runLength = 'long') =>
  sb.optimizeShipInstalls(shipId, budget, weights, prep, runLength);

/** Every (ship, budget, weights) combination the tests sweep. */
function* cases() {
  for (const shipId of SHIP_IDS) {
    for (const [wName, weights] of Object.entries(WEIGHT_SETS)) {
      for (const budget of BUDGETS) yield { shipId, budget, weights, wName };
    }
  }
}

check('plans are deterministic (identical output for identical input)', () => {
  for (const { shipId, budget, weights, wName } of cases()) {
    const a = plan(shipId, budget, weights);
    const b = plan(shipId, budget, weights);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return `ship ${shipId} budget ${budget} weights ${wName} differed between two identical runs`;
    }
  }
  return null;
});

check('never overspends the budget', () => {
  for (const { shipId, budget, weights, wName } of cases()) {
    const { levels, clicks } = plan(shipId, budget, weights);
    const spent = Object.values(levels).reduce((s, n) => s + n, 0);
    if (spent > budget) return `ship ${shipId} weights ${wName}: spent ${spent} of ${budget}`;
    if (clicks.length !== spent) return `ship ${shipId} budget ${budget} weights ${wName}: ${clicks.length} clicks vs ${spent} points in levels`;
  }
  return null;
});

check('clicks and levels describe the same plan', () => {
  for (const { shipId, budget, weights, wName } of cases()) {
    const { levels, clicks } = plan(shipId, budget, weights);
    const fromClicks = {};
    clicks.forEach((slot) => { fromClicks[slot] = (fromClicks[slot] || 0) + 1; });
    for (const [slot, n] of Object.entries(levels)) {
      if (n === 0) continue;
      if ((fromClicks[slot] || 0) !== n) {
        return `ship ${shipId} budget ${budget} weights ${wName}: slot ${slot} has level ${n} but ${fromClicks[slot] || 0} clicks`;
      }
    }
  }
  return null;
});

check('no node exceeds its max level', () => {
  for (const { shipId, budget, weights, wName } of cases()) {
    const { levels } = plan(shipId, budget, weights);
    for (const [slot, n] of Object.entries(levels)) {
      const max = sb.nodeMaxLevel(shipId, slot);
      if (n > max) return `ship ${shipId} budget ${budget} weights ${wName}: slot ${slot} at ${n} exceeds max ${max}`;
    }
  }
  return null;
});

check('no node is bought before its total-installs gate', () => {
  for (const { shipId, budget, weights, wName } of cases()) {
    const { clicks } = plan(shipId, budget, weights);
    const running = {};
    let total = 0;
    for (const slot of clicks) {
      const gate = CATALOG[shipId][slot].gateAtTotalInstalls;
      // The gate compares installs in OTHER nodes, so a node's own points don't unlock it.
      if (gate && (total - (running[slot] || 0)) < gate) {
        return `ship ${shipId} budget ${budget} weights ${wName}: slot ${slot} (gate ${gate}) bought at ${total - (running[slot] || 0)} other installs`;
      }
      running[slot] = (running[slot] || 0) + 1;
      total += 1;
    }
  }
  return null;
});

check('no investment in single-tier nodes for locked generators', () => {
  const unlocked = sb.getUnlockedGens();
  for (const { shipId, budget, weights, wName } of cases()) {
    const { levels } = plan(shipId, budget, weights);
    for (const [slot, n] of Object.entries(levels)) {
      if (!n) continue;
      const tags = sb.effectResources(CATALOG[shipId][slot].effect);
      if (tags.includes('allGens')) continue;
      const single = tags.find((t) => /^mk\d+$/.test(t));
      if (!single) continue;
      const tier = Number(single.slice(2));
      if (tier > 1 && unlocked[tier] === false) {
        return `ship ${shipId} budget ${budget} weights ${wName}: slot ${slot} invests in locked tier mk${tier}`;
      }
    }
  }
  return null;
});

/**
 * Was a node other than `slot` both eligible AND a legitimate target at this point?
 *
 * "Legitimate" means it feeds a category the user actually weighted. A zero-weighted node does
 * NOT count as an alternative: spreading picks out in time must never override an explicit
 * "don't invest here", which is the exact bug this suite found (Cradle handed 8 of 40 points to
 * an excluded category). A test that counted excluded nodes here would argue for reintroducing
 * it.
 */
function alternativeExisted(shipId, slot, levels, totalInstalls, unlocked, weights) {
  return Object.keys(CATALOG[shipId]).some((other) => {
    if (other === slot) return false;
    if (shipId === AOTC.shipId && other === AOTC.slot) return false; // policy-driven, not weight-driven
    const cats = [...new Set(sb.effectResources(CATALOG[shipId][other].effect)
      .map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))];
    if (cats.length && !cats.some((c) => (weights[c] || 0) > 0)) return false;
    if ((levels[other] || 0) >= sb.nodeMaxLevel(shipId, other)) return false;
    const gate = CATALOG[shipId][other].gateAtTotalInstalls;
    if (gate && (totalInstalls - (levels[other] || 0)) < gate) return false;
    const tags = sb.effectResources(CATALOG[shipId][other].effect);
    if (!tags.includes('allGens')) {
      const single = tags.find((t) => /^mk\d+$/.test(t));
      if (single && Number(single.slice(2)) > 1 && unlocked[Number(single.slice(2))] === false) return false;
    }
    return true;
  });
}

check('never repeats a node when an alternative was actually eligible', () => {
  // The implementation documents this ("never buy 20 of the same thing in a row"), but a repeat
  // is legitimate when nothing else can be bought yet. An earlier version of this test counted
  // distinct nodes across the WHOLE plan, which wrongly flagged ship 1's opening run: its other
  // nodes gate at 5 total installs, so the first five picks have no alternative at all. Replay
  // the sequence and judge eligibility at the moment of each repeat.
  const unlocked = sb.getUnlockedGens();
  for (const { shipId, budget, weights, wName } of cases()) {
    const { clicks } = plan(shipId, budget, weights);
    const levels = {};
    let total = 0;
    for (let i = 0; i < clicks.length; i++) {
      const slot = clicks[i];
      // AOTC is maxed in one deliberate burst by its policy, before the interleaving loop runs
      // at all -- "max it outright" is the rule, so its consecutive clicks are not a violation.
      const isAotcBurst = shipId === AOTC.shipId && slot === AOTC.slot;
      if (i > 0 && slot === clicks[i - 1] && !isAotcBurst
        && alternativeExisted(shipId, slot, levels, total, unlocked, weights)) {
        return `ship ${shipId} budget ${budget} weights ${wName}: repeated slot ${slot} at click ${i} while another node was eligible`;
      }
      levels[slot] = (levels[slot] || 0) + 1;
      total += 1;
    }
  }
  return null;
});

check('a smaller budget is a prefix of a larger one (stable partial plans)', () => {
  for (const shipId of SHIP_IDS) {
    for (const [wName, weights] of Object.entries(WEIGHT_SETS)) {
      for (let i = 1; i < BUDGETS.length; i++) {
        // Demeter is exempt across its AOTC threshold, and legitimately so: below the threshold
        // AOTC is skipped entirely, at or above it is maxed FIRST, so the two plans necessarily
        // start differently. That is the policy working, not instability -- every other ship,
        // and Demeter away from the boundary, must still be prefix-stable.
        if (shipId === AOTC.shipId
          && BUDGETS[i - 1] < AOTC.autoMaxAtBudget && BUDGETS[i] >= AOTC.autoMaxAtBudget) continue;
        const small = plan(shipId, BUDGETS[i - 1], weights).clicks;
        const large = plan(shipId, BUDGETS[i], weights).clicks;
        if (small.length > large.length) {
          return `ship ${shipId} weights ${wName}: budget ${BUDGETS[i - 1]} produced more clicks than ${BUDGETS[i]}`;
        }
        for (let k = 0; k < small.length; k++) {
          if (small[k] !== large[k]) {
            return `ship ${shipId} weights ${wName}: budget ${BUDGETS[i - 1]} diverges from ${BUDGETS[i]} at click ${k}`
              + ` (${small[k]} vs ${large[k]}) -- a bigger budget reorders the earlier picks`;
          }
        }
      }
    }
  }
  return null;
});

check('a zero-weighted category is only funded as a last resort', () => {
  for (const shipId of SHIP_IDS) {
    const weights = WEIGHT_SETS.cellsOnly;
    const { levels } = plan(shipId, 40, weights);
    for (const [slot, n] of Object.entries(levels)) {
      if (!n) continue;
      const cats = [...new Set(sb.effectResources(CATALOG[shipId][slot].effect)
        .map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))];
      if (!cats.length) continue;
      const wanted = cats.some((c) => (weights[c] || 0) > 0);
      if (wanted) continue;
      // AOTC is a deliberate exception: at or above its budget threshold the policy maxes it
      // outright, weights notwithstanding, because its value is a next-loop head start rather
      // than anything the weighted categories describe.
      if (shipId === AOTC.shipId && slot === AOTC.slot) continue;
      // Allowed only when a weighted category had nothing eligible -- i.e. every cells-feeding
      // node is maxed. Verify that claim rather than accepting the spend.
      const cellsNodesLeft = Object.keys(CATALOG[shipId]).some((s) => {
        const c = [...new Set(sb.effectResources(CATALOG[shipId][s].effect).map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))];
        return c.includes('cells') && (levels[s] || 0) < sb.nodeMaxLevel(shipId, s);
      });
      if (cellsNodesLeft) {
        return `ship ${shipId}: slot ${slot} (categories ${cats.join('/')}, all weight 0) funded to ${n} while weighted cells nodes still had room`;
      }
    }
  }
  return null;
});

check("Demeter's AOTC rule matches its documented policy", () => {
  const { shipId, slot, autoMaxAtBudget } = AOTC;
  const weights = WEIGHT_SETS.even;
  const below = plan(shipId, autoMaxAtBudget - 1, weights, false);
  if ((below.levels[slot] || 0) !== 0) {
    return `below the ${autoMaxAtBudget}-point threshold AOTC should be skipped entirely, got level ${below.levels[slot]}`;
  }
  const at = plan(shipId, autoMaxAtBudget, weights, false);
  if ((at.levels[slot] || 0) !== sb.nodeMaxLevel(shipId, slot)) {
    return `at the ${autoMaxAtBudget}-point threshold AOTC should be maxed, got ${at.levels[slot] || 0} of ${sb.nodeMaxLevel(shipId, slot)}`;
  }
  const prepped = plan(shipId, 5, weights, true);
  if ((prepped.levels[slot] || 0) === 0) {
    return 'prepForLongRun should max AOTC even on a small budget, got 0';
  }
  return null;
});

console.log(`\n${failures ? `${failures} FAILED` : 'all ship optimizer invariants hold'}`);
process.exit(failures ? 1 : 0);
