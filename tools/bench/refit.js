'use strict';
// HOW A DONOR BUILD IS RE-FITTED TO A DIFFERENT BUDGET. One canonical implementation.
//
// THE MECHANIC THIS EXISTS FOR, stated by the project owner and since confirmed by measurement:
// nodes are filled to reach the UNLOCK THRESHOLD of a better node, and the allocation has to be
// reassessed at each of those stages. Borge's atlas/weak/battle need 75 cost-weighted points spent
// in strictly-lower-threshold nodes before they are legal at all; mino/hermes need 150; athena 180.
// Ozzy has 90/150/180. Knox has none.
//
// WHY THE NAIVE VERSION FAILED, measured on borge@73:
//   `refitNaive` clamps to caps then absorbs the whole budget difference in the donor's SINGLE
//   LARGEST node. For a threshold-gated build that is destructive: it strips the sub-threshold
//   nodes that were paying the gates, so a donor whose shape depends on 150 points sitting below
//   `mino` ends up funding `mino` with nothing underneath it. borge@74's refit came out ILLEGAL
//   that way, and the legal survivors kept the boss kill but lost half the loot (2.96B against the
//   import's 5.01B). The barrier probe then measured the consequence: reaching the import from the
//   best legal refit needs 82 coordinated point-moves through a valley 67% deep -- which no
//   pairwise or chunked local search can cross. The defect was never the search; it was here.
//
// `refitTiered` walks the thresholds ASCENDING and pays each gate before funding the nodes it
// unlocks, distributing in the donor's own proportions rather than dumping into one node.
//
// Determinism: no PRNG, fixed iteration order, integer arithmetic. Same donor and budget give the
// same allocation every time.

function capOf(d) {
  return d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel;
}
// TALENT DEFINITIONS HAVE NO `cost` FIELD AT ALL -- they are {id, label, maxLevel}, and every
// talent costs 1. Attributes DO carry `cost`. `d.cost || 1` gives the right answer for both, but it
// is the exact shape of the bug that read `d.max` on an object whose field is `maxLevel`: a missing
// field silently becoming a default. There the default was "uncapped", which produced dead=31
// against a cap of 10 and a reported +103.60%. An explicit presence check states the intent and
// cannot be confused with a typo.
function costOf(d) { return Object.prototype.hasOwnProperty.call(d, 'cost') ? d.cost : 1; }
function spend(defs, alloc) {
  let s = 0;
  for (const d of defs) s += (alloc[d.id] || 0) * costOf(d);
  return s;
}
/** Cost-weighted points sitting in nodes whose threshold is strictly below `threshold`. */
function pointsBelow(defs, minVal, alloc, threshold) {
  let s = 0;
  for (const d of defs) {
    if ((minVal[d.id] || 0) < threshold) s += (alloc[d.id] || 0) * costOf(d);
  }
  return s;
}

/**
 * The original strategy, kept so the two can be compared rather than swapped on faith.
 * Clamp to caps, then absorb the budget difference in the donor's largest node.
 */
function refitNaive(defs, budget, donor) {
  const alloc = {};
  for (const d of defs) alloc[d.id] = Math.min(donor[d.id] || 0, capOf(d));
  let dump = null;
  for (const d of defs) {
    const v = (alloc[d.id] || 0) * costOf(d);
    if (!dump || v > (alloc[dump.id] || 0) * costOf(dump)) dump = d;
  }
  if (!dump) return null;
  let g = 100000;
  while (spend(defs, alloc) > budget && (alloc[dump.id] || 0) > 0 && g-- > 0) alloc[dump.id] -= 1;
  while (spend(defs, alloc) + costOf(dump) <= budget && g-- > 0) {
    if ((alloc[dump.id] || 0) + 1 > capOf(dump)) break;
    alloc[dump.id] += 1;
  }
  if (spend(defs, alloc) > budget) return null;
  return alloc;
}

/**
 * THRESHOLD-AWARE REFIT.
 *
 *   1. Clamp the donor to caps and scale it proportionally toward the target budget, so the shape
 *      is preserved instead of one node absorbing the whole difference.
 *   2. Walk the tier thresholds ASCENDING. Before any node of tier T keeps its funding, top the
 *      sub-T nodes up -- in the donor's own proportions -- until T cost-weighted points sit below
 *      it. If the budget cannot pay that gate, the tier is ABANDONED (its nodes go to zero) rather
 *      than left funded and illegal. That is the "reassess at each stage" step: an unlock you
 *      cannot afford is not a discount, it is a different build.
 *   3. Spend whatever is left, largest donor share first, respecting caps and never breaking a gate
 *      that is already paid.
 *
 * Returns null if no legal allocation can be produced.
 */
function refitTiered(defs, minVal, budget, donor) {
  const alloc = {};
  for (const d of defs) alloc[d.id] = Math.min(Math.max(0, donor[d.id] || 0), capOf(d));

  const donorSpend = spend(defs, alloc);
  if (donorSpend <= 0) return null;

  // 1. PRESERVE THE DONOR'S STRUCTURE. Do NOT rebuild it by scaling and refilling.
  //
  // A proportional floor-scale followed by a greedy refill ordered by donor share DESTROYED the
  // decisive node: `athena` costs 15 with a donor value of 1, so it sat at the back of the refill
  // queue and the 219-point budget was exhausted on cheap high-count nodes before reaching it.
  // athena=1 is worth kill 7.4 / 2.96B against kill 0.0 / 0.99B -- one point, 3x the loot and the
  // entire boss kill. Its 180 gate was fully paid (219 points below it); the node simply never got
  // funded.
  //
  // So: start from the donor's actual values, and only TRIM to fit, taking points from the node
  // with the largest cost-weighted spend -- and never dropping a node the donor funded to zero.
  // That keeps low-count expensive nodes, which is where the thresholds and the kills live.
  let guardTrim = 100000;
  while (spend(defs, alloc) > budget && guardTrim-- > 0) {
    let victim = null;
    for (const d of defs) {
      if ((alloc[d.id] || 0) <= 1) continue; // never zero a node the donor chose to fund
      const w = (alloc[d.id] || 0) * costOf(d);
      if (!victim || w > (alloc[victim.id] || 0) * costOf(victim)) victim = d;
    }
    if (!victim) break;
    alloc[victim.id] -= 1;
  }
  // Still over budget with every funded node at 1: drop the most expensive ones, dearest first,
  // preferring nodes whose gate is unpayable anyway.
  let guardDrop = 1000;
  while (spend(defs, alloc) > budget && guardDrop-- > 0) {
    let victim = null;
    for (const d of defs) {
      if ((alloc[d.id] || 0) <= 0) continue;
      if (!victim || costOf(d) > costOf(victim)) victim = d;
    }
    if (!victim) break;
    alloc[victim.id] = 0;
  }

  const tiers = [...new Set(defs.map((d) => minVal[d.id] || 0))].filter((t) => t > 0).sort((a, b) => a - b);

  // 2. Pay each gate, ascending, or abandon the tier.
  for (const T of tiers) {
    const gated = defs.filter((d) => (minVal[d.id] || 0) === T && (alloc[d.id] || 0) > 0);
    if (!gated.length) continue;

    let below = pointsBelow(defs, minVal, alloc, T);
    if (below >= T) continue;

    // Fund sub-T nodes in the donor's proportions, largest donor share first. Deterministic order:
    // donor value descending, then id, so ties never depend on object key order.
    const feeders = defs.filter((d) => (minVal[d.id] || 0) < T && capOf(d) > (alloc[d.id] || 0))
      .sort((x, y) => ((donor[y.id] || 0) - (donor[x.id] || 0)) || (x.id < y.id ? -1 : 1));

    let guard = 100000;
    while (below < T && guard-- > 0) {
      // Free budget by trimming the gated nodes we are trying to unlock -- their points are worth
      // nothing while the gate is unpaid.
      let progressed = false;
      for (const f of feeders) {
        if (below >= T) break;
        if ((alloc[f.id] || 0) >= capOf(f)) continue;
        if (spend(defs, alloc) + costOf(f) > budget) {
          const donorNode = gated.find((g) => (alloc[g.id] || 0) > 0);
          if (!donorNode) break;
          alloc[donorNode.id] -= 1;
        }
        if (spend(defs, alloc) + costOf(f) > budget) continue;
        alloc[f.id] += 1;
        below += costOf(f);
        progressed = true;
      }
      if (!progressed) break;
    }

    // DO NOT ABANDON THE TIER HERE. This runs on the floor-SCALED allocation, which is still under
    // budget -- step 3 has not spent the remainder yet. Judging a gate unpayable against a budget
    // that has not finished being spent zeroed `athena` on borge@75's refit, and athena at 1 is the
    // difference between kill 7.4 / 2.96B and kill 0.0 / 0.99B. The tiered allocation actually had
    // MORE points below the 180 gate than the naive one; the gate was affordable and was abandoned
    // anyway. Anything still unpaid after the budget is fully spent is cleared by the final sweep.
  }

  // 3. Spend the remainder, largest donor share first, never breaking a paid gate.
  const order = [...defs].sort((x, y) => ((donor[y.id] || 0) - (donor[x.id] || 0)) || (x.id < y.id ? -1 : 1));
  let guard2 = 100000;
  let added = true;
  while (added && guard2-- > 0) {
    added = false;
    for (const d of order) {
      if ((alloc[d.id] || 0) >= capOf(d)) continue;
      if (spend(defs, alloc) + costOf(d) > budget) continue;
      const T = minVal[d.id] || 0;
      if (T > 0 && pointsBelow(defs, minVal, alloc, T) < T) continue; // its own gate is unpaid
      alloc[d.id] += 1;
      added = true;
    }
  }

  if (spend(defs, alloc) > budget) return null;
  for (const d of defs) if ((alloc[d.id] || 0) > capOf(d)) return null;
  // Final gate sweep: anything still funded under a genuinely unpaid gate is zeroed.
  let changed = true;
  let guard3 = 1000;
  let freed = false;
  while (changed && guard3-- > 0) {
    changed = false;
    for (const d of defs) {
      const T = minVal[d.id] || 0;
      if (T > 0 && (alloc[d.id] || 0) > 0 && pointsBelow(defs, minVal, alloc, T) < T) {
        alloc[d.id] = 0;
        changed = true;
        freed = true;
      }
    }
  }

  // Zeroing a tier hands its points back, and leaving them unspent would report the build as
  // under-spent -- which the optimizer treats as a defect, correctly: the best build never leaves a
  // point on the table. Re-spend into nodes whose own gates are paid.
  if (freed) {
    let guard4 = 100000;
    let added2 = true;
    while (added2 && guard4-- > 0) {
      added2 = false;
      for (const d of order) {
        if ((alloc[d.id] || 0) >= capOf(d)) continue;
        if (spend(defs, alloc) + costOf(d) > budget) continue;
        const T = minVal[d.id] || 0;
        if (T > 0 && pointsBelow(defs, minVal, alloc, T) < T) continue;
        alloc[d.id] += 1;
        added2 = true;
      }
    }
  }
  return alloc;
}

/**
 * A STARTING POINT BUILT FROM THE RULES, WITH NO CORPUS.
 *
 * The corpus was measured ESSENTIAL only because its donors already pay the tier gates: with a flat
 * canonical fill the search never reaches the kills-boss regime (borge@73 -42.90%, knox@30 -84.13%,
 * kill 0.0 in both). That is a property of the FILL, not of the corpus -- `canonicalFill` spreads
 * points evenly and so never accumulates the 75/150/180 cost-weighted points that unlock the gated
 * nodes where the boss damage lives.
 *
 * This builds the same shape the donors have, from the rules alone: pay each gate in ascending
 * order out of the cheapest available sub-threshold nodes, fund the gated nodes it unlocks, and
 * spend whatever is left. `deep` biases toward concentration (fund the unlocked tier hard) versus
 * breadth, which is the axis the boss cliff turns on.
 *
 * Deterministic: fixed node order, integer arithmetic, no PRNG.
 */
function gatePayingFill(defs, minVal, budget, opts) {
  const deep = !!(opts && opts.deep);
  // DEPENDENCY EDGES, NOT JUST TIER GATES. The first version handled thresholds and forgot
  // dependencies entirely, so `deep` -- which funds the EXPENSIVE nodes first, and the expensive
  // nodes are usually the children -- produced illegal builds on 24 of 24 fixtures (`spartan`
  // under `ylith 0`, `exo` under `lotl 0`, `pl` under `spa 0`). Breadth survived only by accident,
  // because it fills cheapest-first and parents happen to be cheap.
  // It would have silently poisoned the experiment it was written for: ablation-check rejects
  // illegal candidates, so the gated-deep arm would have reported NO CANDIDATE and been read as
  // "a rules-built start cannot reach the boss regime".
  const deps = (opts && opts.deps) || {};
  const alloc = {};
  for (const d of defs) alloc[d.id] = 0;

  const byId = {};
  for (const d of defs) byId[d.id] = d;
  /** Fund every ancestor of `id` to at least 1, cheapest path first. Returns false if unaffordable. */
  const fundAncestors = (id, seen) => {
    const guardSeen = seen || new Set();
    if (guardSeen.has(id)) return true;
    guardSeen.add(id);
    for (const parent of (deps[id] || [])) {
      const p = byId[parent];
      if (!p) continue;
      if (!fundAncestors(parent, guardSeen)) return false;
      if ((alloc[parent] || 0) > 0) continue;
      if (spend(defs, alloc) + costOf(p) > budget) return false;
      if ((alloc[parent] || 0) + 1 > capOf(p)) return false;
      alloc[parent] += 1;
    }
    return true;
  };

  const tiers = [...new Set(defs.map((d) => minVal[d.id] || 0))].sort((a, b) => a - b);
  const byCostThenId = (x, y) => (costOf(x) - costOf(y)) || (x.id < y.id ? -1 : 1);

  for (const T of tiers) {
    if (T > 0) {
      // Pay this gate from the cheapest sub-T nodes available.
      const feeders = defs.filter((d) => (minVal[d.id] || 0) < T).sort(byCostThenId);
      let guard = 100000;
      while (pointsBelow(defs, minVal, alloc, T) < T && guard-- > 0) {
        let moved = false;
        for (const f of feeders) {
          if ((alloc[f.id] || 0) >= capOf(f)) continue;
          if (spend(defs, alloc) + costOf(f) > budget) continue;
          alloc[f.id] += 1;
          moved = true;
          if (pointsBelow(defs, minVal, alloc, T) >= T) break;
        }
        if (!moved) break;
      }
      if (pointsBelow(defs, minVal, alloc, T) < T) break; // cannot afford this tier or any above it
    }
    // Fund the nodes this tier unlocks. Deep: dearest first (the gated nodes are the expensive,
    // decisive ones -- athena is cost 15 and one point of it is worth an entire boss kill).
    const here = defs.filter((d) => (minVal[d.id] || 0) === T)
      .sort(deep ? (x, y) => (costOf(y) - costOf(x)) || (x.id < y.id ? -1 : 1) : byCostThenId);
    for (const d of here) {
      // Parents before children, or the node is illegal however well its tier gate is paid.
      if (!fundAncestors(d.id)) continue;
      let guard2 = 100000;
      while ((alloc[d.id] || 0) < capOf(d) && spend(defs, alloc) + costOf(d) <= budget && guard2-- > 0) {
        alloc[d.id] += 1;
        if (!deep) break; // breadth: one point each, round-robin style
      }
    }
  }

  // CONCENTRATE THE REMAINDER, DO NOT SPREAD IT -- and this is the whole ballgame.
  //
  // Measured: a gate-paying fill that SPREADS its remainder fails completely. One fill scored
  // -46.32% on borge@73 and -84.47% on knox@30; exhaustively enumerating all 360 supports and
  // filling each the same way scored -45.20% and -84.17%. Every one legal, every one correctly
  // gated, every one kill 0.0. So structure was never the missing ingredient.
  //
  // What the corpus donors have that a spread fill does not is DEPTH. knox@30's winning build is
  // `kraken 38` of a 90-point budget -- 42% in a single uncapped cost-1 node -- with the cheap
  // high-value nodes at their caps and the gates paid with the minimum. This file's own notes say
  // it: "concentration is what crosses a threshold".
  //
  // So: cap what is cheap, pay gates minimally, and dump EVERYTHING left into the single best
  // uncapped node rather than sprinkling it across the support.
  if (opts && opts.concentrate) {
    let dump = null;
    for (const d of defs) {
      if (capOf(d) !== Infinity) continue;
      const T = minVal[d.id] || 0;
      if (T > 0 && pointsBelow(defs, minVal, alloc, T) < T) continue;
      if (!fundAncestors(d.id)) continue;
      // Cheapest uncapped node absorbs the most points per unit of budget.
      if (!dump || costOf(d) < costOf(dump)) dump = d;
    }
    if (dump) {
      let guardC = 1000000;
      while (spend(defs, alloc) + costOf(dump) <= budget && guardC-- > 0) alloc[dump.id] += 1;
    }
  }

  // Spend anything left over, cheapest first, never breaking a paid gate.
  let guard3 = 100000;
  let added = true;
  while (added && guard3-- > 0) {
    added = false;
    for (const d of [...defs].sort(byCostThenId)) {
      if ((alloc[d.id] || 0) >= capOf(d)) continue;
      if (spend(defs, alloc) + costOf(d) > budget) continue;
      const T = minVal[d.id] || 0;
      if (T > 0 && pointsBelow(defs, minVal, alloc, T) < T) continue;
      if ((alloc[d.id] || 0) === 0 && !fundAncestors(d.id)) continue;
      if (spend(defs, alloc) + costOf(d) > budget) continue; // ancestors may have consumed the room
      alloc[d.id] += 1;
      added = true;
    }
  }
  // Clear anything left funded under an unpaid gate OR an unfunded parent, to a fixpoint: removing
  // one can strand another.
  let changed = true;
  let guard4 = 1000;
  while (changed && guard4-- > 0) {
    changed = false;
    for (const d of defs) {
      if ((alloc[d.id] || 0) <= 0) continue;
      const T = minVal[d.id] || 0;
      if (T > 0 && pointsBelow(defs, minVal, alloc, T) < T) { alloc[d.id] = 0; changed = true; continue; }
      for (const parent of (deps[d.id] || [])) {
        if ((alloc[parent] || 0) <= 0) { alloc[d.id] = 0; changed = true; break; }
      }
    }
  }
  return alloc;
}

/**
 * TALENTS. No thresholds and no dependencies -- but that does NOT make the naive form correct,
 * and this used the naive form with a comment saying it did.
 *
 * EVERY talent is capped (Borge: revival 2, loth 5, ua 5, impeccable 10, omen 10, ll 12, pog 15,
 * tfow 15, ultima 50 -- no uncapped talent in any hunter). `refitNaive` fills exactly ONE node and
 * `break`s when that node hits its cap, so it never moves on to a second talent. A far-away donor
 * therefore comes out massively UNDER-SPENT:
 *     borge@73 <- borge@18 donor : 18 of 73 talent points spent  (55 unspent)
 *     knox@30  <- knox@16b donor : 16 of 30                      (14 unspent)
 * Near neighbours hide it -- borge@74 and knox@31 spend fully only because their talent totals are
 * already close. `legalT` checks caps and `spend <= budget`, and under-spend passes both, so these
 * entered the candidate pool silently. It is very likely part of why the band=5 test collapsed:
 * with near donors excluded, EVERY surviving candidate is under-spent by 14-55 talent points.
 *
 * `refitTiered` with an empty threshold map is the right shape: preserve the donor, trim to fit,
 * then spend the remainder ACROSS ALL nodes in donor-share order, respecting caps.
 */
function refitTalents(defs, budget, donor) { return refitTiered(defs, {}, budget, donor); }

module.exports = { refitNaive, refitTiered, refitTalents, gatePayingFill, capOf, spend, pointsBelow };
