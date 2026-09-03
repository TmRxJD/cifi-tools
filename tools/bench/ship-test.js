'use strict';
// Invariant tests for the ship install optimizer (shipsPage.js optimizeShipInstalls).
//
// This code had no automated coverage of any kind. It is a pure marginal-value greedy allocator
// (2026-09-02: replaced an earlier category-fair-queueing design after real-save testing found it
// could lose up to 100% of achievable value -- see real-save-optimizer-check.js and the comment
// above optimizeShipInstalls) with unlock gates, a meltdown-adjusted value model and a hardcoded
// special case -- exactly the shape of thing that silently drifts.
//
// The tests assert properties the implementation CLAIMS, none of which need a known-correct
// answer to check:
//   * determinism            same inputs -> byte-identical plan
//   * budget                 never overspends; clicks and levels agree
//   * caps                   no node above its max level
//   * gates                  no node bought before its total-installs gate
//   * locked tiers           no investment in single-tier nodes for locked generators
//   * greedy optimality      every click is the single best-scoring eligible node at that moment
//   * prefix growth          a smaller budget's click order is a prefix of a larger one's,
//                            which is what "a sane partial-budget snapshot at every step" means
//   * weight respect         a zero-weighted category is only funded as a last resort
//
// Runs the SHIPPED shipsPage.js under Node via the same sandbox the optimizer benchmark uses.
//
//   node tools/bench/ship-test.js

const H = require('./harness.js');

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, RESOURCE_TO_WEIGHT_BUCKET, AOTC, GEN_TIERS } = sb.ShipData;
const SHIP_IDS = Object.keys(CATALOG).map(Number).sort((a, b) => a - b);

/**
 * Seed a REALISTIC account before testing. This is not cosmetic.
 *
 * nodeLinearIncrement() is `percent x crew x multipliers`, so on a default store -- crew 0 --
 * EVERY node's increment and value is exactly 0. An earlier version of this suite ran that way
 * and reported all invariants passing, but with every value tied at zero the allocator's ranking
 * (bestNodeIn compares nodeSpent/value) degenerates into plain count round-robin resolved by tie
 * priority. The structural invariants were real; the value model was never exercised at all.
 *
 * Seeding crew and unlocking generator tiers puts real numbers through the value path, which is
 * the part nobody has ever verified.
 */
function seedAccount({ crew = 12, rank = 20, unlockTiers = 8, meltdown = 0 } = {}) {
  const store = sb.StoreSchema.freshStore();
  sb.window.store = store;
  SHIP_IDS.forEach((id) => {
    store.shipInputs[id] = { ...sb.defaultShipInput(id), rank, crew };
  });
  GEN_TIERS.forEach((n) => { store.unlockedGens[n] = n <= unlockTiers; });

  // Crew alone is not enough. Most nodes ALSO scale on a gear counter ("per Loop Modification
  // owned", "per Mission Completed", ...) via gearMultiplierFor, which returns 0 when that
  // counter is 0. Zagreus in particular is entirely gated on loopModsOwned, so seeding crew but
  // not gear left every one of its nodes valued 0 -- correct behaviour, useless fixture.
  Object.assign(store.shipGear, {
    manualMK2Gens: 40, manualMK3Gens: 30, totalManualGens: 120,
    techUpgrades: 25, hardwareUpgrades: 15, softwareUpgrades: 15,
    loopModsOwned: 35, loopFillsThisRun: 8, loopResetsDone: 12,
    automationsUnlocked: 6, ticksThisLoop: 500,
    operationsCompleted: 60, studiesThisLR: 20,
    researchLevels: 40, totalCompletedResearch: 25,
    missionsCompleted: 75, meltdown,
  });
  return store;
}
seedAccount();

/** True when at least one node on this ship has a non-zero value -- i.e. the model is live. */
function valueModelIsLive(shipId) {
  return Object.keys(CATALOG[shipId]).some((slot) => sb.nodeMarginalLogGain(shipId, slot, {}, 'long') > 0);
}

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

check('the value model is actually live under test (guards against testing all-zeros)', () => {
  const dead = SHIP_IDS.filter((id) => !valueModelIsLive(id));
  if (dead.length) {
    return `ships ${dead.join(',')} have every node valued 0 even with crew seeded -- the ranking `
      + 'path is not being exercised, so any "pass" below says nothing about it';
  }
  return null;
});

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

check('spends the whole budget unless the ship physically cannot absorb it', () => {
  // "Never overspends" is not enough -- leaving points unspent hands back free value. The only
  // legitimate reason to stop early is that every node is maxed or still gated.
  for (const { shipId, budget, weights, wName } of cases()) {
    const { levels } = plan(shipId, budget, weights);
    const spent = Object.values(levels).reduce((s, n) => s + n, 0);
    if (spent >= budget) continue;
    const capacity = Object.keys(CATALOG[shipId])
      .reduce((s, slot) => s + sb.nodeMaxLevel(shipId, slot), 0);
    // AOTC below its threshold is deliberately excluded by the allocator itself (its payoff
    // lands next loop, not this one, so the normal marginal-value engine can't score it) --
    // "room left" has to honor that same exclusion, or a budget too small to reach any other
    // open node reads as a bug instead of the documented policy it actually is.
    const aotcSuppressed = shipId === AOTC.shipId && budget < AOTC.autoMaxAtBudget;
    const roomLeft = Object.keys(CATALOG[shipId])
      .some((slot) => !(aotcSuppressed && slot === AOTC.slot)
        && (levels[slot] || 0) < sb.nodeMaxLevel(shipId, slot)
        && !(CATALOG[shipId][slot].gateAtTotalInstalls > spent - (levels[slot] || 0)));
    if (roomLeft) {
      return `ship ${shipId} budget ${budget} weights ${wName}: stopped at ${spent} with capacity `
        + `${capacity} and an ungated node still open`;
    }
  }
  return null;
});

// What the importer writes must be internally consistent with the gates. A node the account
// OWNS points in cannot also be gated shut -- the game would not have sold them.
//
// This is worth pinning because a stale or mis-mapped fleet import shows up exactly here and
// nowhere else: the totals still look plausible, but installs land in nodes that could not have
// been bought yet, and the fleet card then draws real, owned nodes as "Locked". Reported on a
// Zeus grid showing points in all four 100-install corner nodes at 79 total installs.
check('a save import never lands installs in a node its own gate would forbid', () => {
  const fs = require('fs');
  const path = require('path');
  const savePath = path.join(__dirname, '../gamefiles/save/decoded-20260809.json');
  if (!fs.existsSync(savePath)) return null;   // no pulled save in this checkout
  const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const rus = sb.mapCifiSaveToResearchUnits
    ? sb.mapCifiSaveToResearchUnits(save)
    : sb.mapSaveToResearchUnits(save);
  const problems = [];
  for (const shipId of SHIP_IDS) {
    const category = sb.ShipData.SHIP_CATEGORY && sb.ShipData.SHIP_CATEGORY[shipId];
    if (!category) continue;
    const catalog = CATALOG[shipId];
    const levels = {};
    for (const slot of Object.keys(catalog)) {
      const ruId = catalog[slot].ruId;
      const v = ruId != null && rus[ruId] && rus[ruId].categoryLevels
        ? rus[ruId].categoryLevels[category] : undefined;
      levels[slot] = v == null ? 0 : v;
    }
    const total = Object.values(levels).reduce((a, b) => a + b, 0);
    for (const slot of Object.keys(catalog)) {
      const gate = catalog[slot].gateAtTotalInstalls;
      const lvl = levels[slot];
      if (lvl > 0 && gate && (total - lvl) < gate) {
        problems.push(`ship ${shipId} slot ${slot} (${catalog[slot].name}): owns ${lvl} but its gate `
          + `needs ${gate} installs elsewhere and only ${total - lvl} exist`);
      }
    }
  }
  return problems.length ? problems.join('\n        ') : null;
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
 * Every eligible (weighted, ungated, unmaxed, unlocked-tier) node's weighted marginal score at
 * the current state -- an independent reassembly from the same exported building blocks the
 * allocator itself uses (nodeMarginalLogGain, nodeMaxLevel, RESOURCE_TO_WEIGHT_BUCKET), used to
 * check that the allocator's own pick really was the best one available, not just A plausible one.
 */
function bestEligibleScore(shipId, levels, totalInstalls, unlocked, weights, runLength, excludeSlot) {
  let best = -Infinity;
  for (const slot of Object.keys(CATALOG[shipId])) {
    if (slot === excludeSlot) continue;
    if (shipId === AOTC.shipId && slot === AOTC.slot) continue; // policy-driven, not scored
    if ((levels[slot] || 0) >= sb.nodeMaxLevel(shipId, slot)) continue;
    const gate = CATALOG[shipId][slot].gateAtTotalInstalls;
    if (gate && (totalInstalls - (levels[slot] || 0)) < gate) continue;
    const tags = sb.effectResources(CATALOG[shipId][slot].effect);
    if (!tags.includes('allGens')) {
      const single = tags.find((t) => /^mk\d+$/.test(t));
      if (single && Number(single.slice(2)) > 1 && unlocked[Number(single.slice(2))] === false) continue;
    }
    const cats = [...new Set(tags.map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))];
    const w = cats.reduce((m, c) => Math.max(m, weights[c] || 0), 0);
    if (w <= 0) continue; // only the weighted pass is checked here -- see note below
    best = Math.max(best, sb.nodeMarginalLogGain(shipId, slot, levels, runLength) * w);
  }
  return best;
}

check('greedy always spends on the single best-scoring eligible node at each step, and only '
  + 'falls back to a zero-weighted node when nothing weighted was eligible at that moment', () => {
  // Replays the plan's own click sequence, recomputing each node's marginal value exactly as
  // optimizeShipInstalls does. Two things checked per click: (1) if the picked node is itself
  // weighted, no OTHER weighted-eligible node ever outscored it; (2) if the picked node is
  // UNWEIGHTED (the last-resort fallback pass), no weighted node was eligible at all at that
  // exact moment -- checked here per-step rather than against the plan's FINAL state, because a
  // final-state "some weighted node still has room" check produces false positives: several ships
  // gate their weighted nodes behind total-installs thresholds only a currently-unweighted node
  // can clear, so a small budget can legitimately run out partway through funding the weighted
  // nodes afterward -- room left at the END does not mean the earlier fallback spend was wrong.
  // Demeter's AOTC burst is a policy special-case, not scored by the marginal-value engine at
  // all, so it is skipped entirely.
  const unlocked = sb.getUnlockedGens();
  for (const { shipId, budget, weights, wName } of cases()) {
    const { clicks } = plan(shipId, budget, weights);
    const levels = {};
    let total = 0;
    for (let i = 0; i < clicks.length; i++) {
      const slot = clicks[i];
      const isAotc = shipId === AOTC.shipId && slot === AOTC.slot;
      if (!isAotc) {
        const tags = sb.effectResources(CATALOG[shipId][slot].effect);
        const cats = [...new Set(tags.map((r) => RESOURCE_TO_WEIGHT_BUCKET[r]).filter(Boolean))];
        const w = cats.reduce((m, c) => Math.max(m, weights[c] || 0), 0);
        const rivalBest = bestEligibleScore(shipId, levels, total, unlocked, weights, 'long', slot);
        if (w > 0) {
          const ownScore = sb.nodeMarginalLogGain(shipId, slot, levels, 'long') * w;
          if (rivalBest > ownScore + 1e-9) {
            return `ship ${shipId} budget ${budget} weights ${wName}: click ${i} picked slot ${slot} `
              + `(score ${ownScore.toFixed(6)}) while another eligible node scored ${rivalBest.toFixed(6)}`;
          }
        } else if (rivalBest > -Infinity) {
          return `ship ${shipId} budget ${budget} weights ${wName}: click ${i} fell back to `
            + `zero-weighted slot ${slot} while a weighted node was still eligible (score ${rivalBest.toFixed(6)})`;
        }
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

// A pure marginal-value greedy allocator makes no claim that spend tracks the weight RATIO, nor
// that an unweighted category's TOTAL spend stays below a weighted one's (that coarser claim held
// under the old category-fair-queueing design, but breaks on a ship like Auxesia whose only
// ungated node at all sits in a bucket the player weighted 0 -- the fallback pass then has to
// dump many points there just to clear gates on everything else, legitimately outspending a
// heavily-gated weighted category). The precise property -- no eligible, weighted, higher-scoring
// node was ever skipped in favor of an unweighted one -- is already checked exactly, per click,
// by "greedy always spends on the single best-scoring eligible node at each step" above and by
// "a zero-weighted category is only funded as a last resort".

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
