// The allocation space: the ONE definition of what a legal talent/attribute allocation is,
// and the only place that knows how to enumerate or move through that space.
//
// Every consumer goes through this module -- the build editor's +/- button gating (app.js),
// the search engine (search.js), and the Node benchmark harness (tools/bench). There is no
// second copy of the legality rules anywhere. If a build is illegal, it is because it never
// passed through here, not because some generator forgot to re-check.
//
// LEGALITY IS A STATE PREDICATE, NOT A PATH PREDICATE. A node at level > 0 is legal iff:
//   1. its level is within maxLevel,
//   2. every dependency parent is itself at level > 0,
//   3. if it carries a minValue threshold, the points spent in strictly-lower-threshold
//      nodes meet that threshold.
// Nothing depends on the ORDER points were spent in. That is what makes exhaustive support
// enumeration below valid: a support set can be checked for legality directly, without
// simulating a purchase order that could reach it.
//
// This mirrors cifi-tools.com's own gating function z(e) exactly.
(function (global) {
  'use strict';

  // An allocation that leaves points idle is dominated: respeccing to spend them is almost
  // always better than sitting on them, so allocations with idle budget are not worth an
  // evaluation. Enforced at the two places an allocation can be born -- canonicalFill and
  // transfer -- so no wasteful candidate ever reaches the evaluator.
  //
  // ONE POINT OF SLACK IS ALLOWED, AND ONLY FOR RESTRICTED NODE SETS. The original note here said
  // odd costs "can make it genuinely unspendable (e.g. only cost-2 and cost-3 nodes remain
  // eligible with 1 point left)". That is true ONLY while the available nodes are restricted to a
  // SUPPORT -- a support of cost-3 attributes really cannot absorb a last point.
  //
  // It is FALSE for the unrestricted set, and measurement settles it: on all three hunters EVERY
  // talent costs 1, and each hunter has an uncapped, dependency-free, cost-1 attribute
  // (borge ares, ozzy lotl, knox kraken). With the whole node set available a point is ALWAYS
  // spendable, so a returned build that leaves one idle is not "unspendable", it is underspent.
  //
  // That distinction was missing, and the tolerance leaked into places it does not belong:
  // greedyTopUp stopped one point short of a full budget, so builds at the SHIPPED effort were
  // returned underspent (measured: ozzy@11 and ozzy@12 both gained their last talent and attribute
  // point once it was removed). The Stage 3 assertion on the WINNER is therefore strict -- no
  // restriction applies there -- while construction inside a support keeps this slack.
  const MAX_IDLE_POINTS = 1;

  function costOf(defs, alloc) {
    let sum = 0;
    for (const d of defs) sum += (alloc[d.id] || 0) * (d.cost || 1);
    return sum;
  }

  // Points spent in nodes whose threshold is strictly lower than `threshold` -- the quantity
  // the real site's tier gates measure.
  function pointsBelowThreshold(defs, minVal, alloc, threshold) {
    let sum = 0;
    for (const r of defs) {
      if ((minVal[r.id] || 0) < threshold) sum += (alloc[r.id] || 0) * (r.cost || 1);
    }
    return sum;
  }

  // Can this node take one MORE point in the given allocation?
  function isEligible(def, defs, deps, minVal, alloc) {
    if ((alloc[def.id] || 0) >= def.maxLevel) return false;
    const parents = deps[def.id];
    if (parents && parents.length && !parents.every((p) => (alloc[p] || 0) > 0)) return false;
    const threshold = minVal[def.id] || 0;
    if (threshold > 0 && pointsBelowThreshold(defs, minVal, alloc, threshold) < threshold) return false;
    return true;
  }

  // Is this node's CURRENT level legal (as opposed to "may it be raised")? Differs from
  // isEligible in that it ignores maxLevel headroom -- a node sitting at max is legal, it
  // just can't grow.
  function isHeld(def, defs, deps, minVal, alloc) {
    if ((alloc[def.id] || 0) <= 0) return true;
    if ((alloc[def.id] || 0) > def.maxLevel) return false;
    const parents = deps[def.id];
    if (parents && parents.length && !parents.every((p) => (alloc[p] || 0) > 0)) return false;
    const threshold = minVal[def.id] || 0;
    if (threshold > 0 && pointsBelowThreshold(defs, minVal, alloc, threshold) < threshold) return false;
    return true;
  }

  function isLegal(defs, deps, minVal, alloc, budget) {
    if (costOf(defs, alloc) > budget) return false;
    return defs.every((d) => isHeld(d, defs, deps, minVal, alloc));
  }

  // Repeatedly zero out any node whose gate no longer holds, until stable. Removing a point
  // can strand a dependent OR drop a tier-threshold sum below what a higher tier needed, and
  // that in turn can strand more -- hence the fixpoint loop rather than a single sweep.
  function clearInvalidDescendants(defs, deps, minVal, alloc) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of defs) {
        if ((alloc[d.id] || 0) > 0 && !isHeld(d, defs, deps, minVal, alloc)) {
          alloc[d.id] = 0;
          changed = true;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Support-set enumeration
  // ---------------------------------------------------------------------------------------
  // A "support set" is which nodes are funded at all (level > 0), ignoring how deep. This is
  // the structural half of the decision, and it is the half every previous version of the
  // optimizer got wrong: greedy construction can't fund a gate node whose payoff only exists
  // once its child is also funded, so whole regions of the tree were unreachable and had to
  // be papered over with a bespoke "chain-unlock" move. Here the entire set of legal support
  // sets is enumerated up front, so an unlock chain is not a special case -- it is simply one
  // of the enumerated supports, judged on score like every other.
  //
  // Tractable by direct measurement: Borge 361, Ozzy 289, Knox 145 dependency-closed subsets.
  // Exhaustive means exhaustive.
  function enumerateSupports(defs, deps, budget) {
    const n = defs.length;
    if (n > 30) throw new Error(`enumerateSupports: ${n} nodes exceeds the exhaustive bitmask limit`);
    const indexOf = new Map(defs.map((d, i) => [d.id, i]));
    for (const [id, parents] of Object.entries(deps)) {
      if (!indexOf.has(id)) continue;
      for (const p of parents) {
        if (!indexOf.has(p)) throw new Error(`Dependency "${p}" of "${id}" is not in the node list`);
      }
    }

    const out = [];
    for (let mask = 0; mask < (1 << n); mask++) {
      let ok = true;
      let minCost = 0;
      for (let i = 0; i < n && ok; i++) {
        if (!(mask & (1 << i))) continue;
        minCost += defs[i].cost || 1;
        const parents = deps[defs[i].id];
        if (parents) {
          for (const p of parents) {
            if (!(mask & (1 << indexOf.get(p)))) { ok = false; break; }
          }
        }
      }
      // One point in every member is the cheapest way to realize a support set; if even that
      // exceeds the budget the set is unreachable at this level.
      if (ok && minCost <= budget) out.push({ mask, minCost, ids: defs.filter((_, i) => mask & (1 << i)).map((d) => d.id) });
    }
    // Deterministic order: cheapest first, then by mask. No tie is ever broken by chance.
    out.sort((a, b) => (a.minCost - b.minCost) || (a.mask - b.mask));
    return out;
  }

  // Deterministically spend `budget` across exactly the nodes in `support`, respecting caps,
  // dependency order and tier thresholds. This is the canonical starting allocation a support
  // set gets screened at -- NOT the final answer for that support, which comes from the
  // coordinate exchange in search.js.
  //
  // Strategy: seed one point in every member (in dependency order, so gates open before the
  // nodes they gate), then distribute what's left in round-robin passes over the members that
  // can still take a point. Round-robin rather than "dump it all in the first node" because
  // the screen should reflect what a support set can do when actually used, not a degenerate
  // corner of it. Fully deterministic: no randomness, ties broken by declaration order.
  function canonicalFill(defs, deps, minVal, budget, supportIds, openOnly = false) {
    const inSupport = new Set(supportIds);
    const members = defs.filter((d) => inSupport.has(d.id));
    const alloc = {};
    defs.forEach((d) => { alloc[d.id] = 0; });

    let spent = 0;
    // Seed pass: keep sweeping until no member can be opened. Dependency and threshold gates
    // mean a member may only become eligible after an earlier one is funded, so a single pass
    // in declaration order is not enough.
    //
    // A THRESHOLD gate cannot be opened by seeding alone, and assuming otherwise silently threw
    // away whole regions of the search space. Seeding gives every member ONE point, so a support
    // of ten attributes reaches a spend of ten -- while Borge's `weak` needs 75 points banked in
    // strictly-lower-threshold nodes before it may be touched at all. `weak` therefore never
    // opened, the support was declared "not realizable within budget", and the optimizer never
    // saw it. A real level-38 import proves such allocations exist: it funds that exact support
    // legally, and the optimizer scored 1.96% below it while never having considered its shape.
    //
    // So when a member is blocked ONLY by its threshold, pour points into the members already open
    // until the threshold is met, then open it. If the budget runs out first the support really is
    // unrealizable -- which is what this was trying to detect, and now actually does.
    //
    // ROUND-ROBIN, NOT FIRST-ELIGIBLE, and the difference is not cosmetic.
    //
    // This used to take `growable.find(...)` -- the first eligible member -- on every iteration,
    // justified as "cheapest first, so the fewest points are committed". That rationale is wrong:
    // `pointsBelowThreshold` counts points in the SAME cost-weighted units as the budget, so
    // reaching a threshold of 150 costs exactly 150 whatever the distribution. Concentrating buys
    // nothing, and it wrecks the fill.
    //
    // Measured on a real level-55 Ozzy, whose `scarab` needs 150 banked points: the old code
    // produced `lotl:135 exo:2 scorp:2 timeless:2 ibu:2 exterm:2 medusa:1 dance:1 scarab:1` --
    // 135 of 165 points in ONE attribute, because `lotl` is cost 1, uncapped, and first in
    // declaration order, so it never became ineligible. That fill screened the import's own
    // support at rank 63 of 234, far outside the top-8 survey cut, so the shape the player
    // actually used was never refined and the optimizer finished 4.20% below it.
    //
    // Which is exactly the degenerate corner canonicalFill's own header comment says it exists to
    // avoid ("Round-robin rather than 'dump it all in the first node' because the screen should
    // reflect what a support set can do when actually used"). The threshold path simply did not
    // honour it. Cycling is still fully deterministic: same order, same starting point, same
    // result every time.
    const openThreshold = (blocked) => {
      const need = minVal[blocked.id] || 0;
      if (need <= 0) return false;
      const growable = members
        .filter((m) => (alloc[m.id] || 0) > 0 && (minVal[m.id] || 0) < need)
        .sort((a, b) => (a.cost || 1) - (b.cost || 1));
      if (!growable.length) return false;
      let guard = 0;
      let cursor = 0;
      while (pointsBelowThreshold(defs, minVal, alloc, need) < need && guard++ < 100000) {
        let next = null;
        // Scan the whole ring each time, so a member that has hit its cap is skipped rather than
        // ending the fill. Realizability is therefore unchanged: this fails only when NO member is
        // eligible, which is the same condition the old first-eligible scan failed on.
        for (let i = 0; i < growable.length; i++) {
          const cand = growable[(cursor + i) % growable.length];
          if (isEligible(cand, defs, deps, minVal, alloc) && spent + (cand.cost || 1) <= budget) {
            next = cand;
            cursor = (cursor + i + 1) % growable.length;
            break;
          }
        }
        if (!next) return false;   // cannot reach the threshold within budget
        alloc[next.id] += 1;
        spent += next.cost || 1;
      }
      return isEligible(blocked, defs, deps, minVal, alloc)
        && spent + (blocked.cost || 1) <= budget;
    };

    let opened = true;
    while (opened) {
      opened = false;
      for (const d of members) {
        if ((alloc[d.id] || 0) > 0) continue;
        const cost = d.cost || 1;
        if (spent + cost > budget) continue;
        if (!isEligible(d, defs, deps, minVal, alloc)) {
          // Only a threshold is worth working around here; a missing dependency parent is opened
          // by the sweep itself, and a maxLevel block means the member is already funded.
          if (!openThreshold(d)) continue;
        }
        alloc[d.id] = 1;
        spent += cost;
        opened = true;
      }
    }
    // Any member we could not open means this support set is not actually realizable within
    // budget -- now a real conclusion rather than an artefact of seeding one point at a time.
    if (members.some((d) => (alloc[d.id] || 0) === 0)) return null;

    // OPEN-ONLY: hand back the support with one point in each member and the rest unspent, so a
    // caller can choose its own distribution. `canonicalFill` distributes round-robin, which is
    // right for RANKING supports against each other but wrong as a starting point for refinement:
    // a support whose value is concentrated (one attribute taken deep) is represented by the one
    // shape it would never actually use. Measured on a real level-26 Borge with talents held at
    // the import's, the round-robin fill of the right support scores 18.24% below the import while
    // filling the same support by measured marginal value scores 0.51% below it.
    if (openOnly) return alloc;

    // Distribution pass: round-robin one point at a time.
    let progressed = true;
    while (progressed && spent < budget) {
      progressed = false;
      for (const d of members) {
        const cost = d.cost || 1;
        if (spent + cost > budget) continue;
        if (!isEligible(d, defs, deps, minVal, alloc)) continue;
        alloc[d.id] += 1;
        spent += cost;
        progressed = true;
        if (spent >= budget) break;
      }
    }
    // Reject fills that cannot use the budget: a support whose caps leave points permanently
    // idle is strictly worse than one that spends them. (Not applied to an open-only result,
    // which is unspent BY CONSTRUCTION and returns above.)
    if (budget - spent > MAX_IDLE_POINTS) return null;
    return alloc;
  }

  // Spend any budget that is sitting idle, deterministically, without changing the support
  // set. Used after a transfer frees an odd amount that the donor's cost can't absorb.
  function fillLeftover(defs, deps, minVal, budget, alloc) {
    let spent = costOf(defs, alloc);
    let progressed = true;
    while (progressed && spent < budget) {
      progressed = false;
      for (const d of defs) {
        if ((alloc[d.id] || 0) === 0) continue; // never widen the support here
        const cost = d.cost || 1;
        if (spent + cost > budget) continue;
        if (!isEligible(d, defs, deps, minVal, alloc)) continue;
        alloc[d.id] += 1;
        spent += cost;
        progressed = true;
      }
    }
    return alloc;
  }

  // Spend every point of idle budget, OPENING new nodes when necessary.
  //
  // fillLeftover deliberately refuses to widen the support (it skips nodes at 0), which is right
  // inside a transfer -- that move is about redistributing within a chosen shape. It is wrong for
  // an allocation that simply has points left over: if the only remaining capacity sits in nodes
  // currently at 0, fillLeftover cannot touch it and the points stay unspent forever.
  //
  // That is how an under-spent build could survive all the way to the final answer: the user's
  // own build enters the finalist pool as-is, and an incumbent sitting at 46 of 58 talent points
  // has nowhere for the other 12 to go unless new nodes may be opened. Deterministic: nodes are
  // considered in declaration order, one point at a time, so the same input always fills the
  // same way.
  //
  // THIS IS NO LONGER THE OPTIMIZER'S TOP-UP, AND SHOULD NOT BE WIRED BACK IN AS ONE. Declaration
  // order is flat, and a flat refill does not merely fail to improve an under-spent build -- it
  // destroys the shape of the build it is repairing, spreading recovered points across talents
  // the build never invested in. Measured on a real level-38 Borge, repairing 12 stripped talent
  // points this way finished 12.06% below the untouched import, where search.js's greedyTopUp
  // (which picks each point by measured marginal value) reproduces the import exactly. This
  // function survives as the unscored primitive the benches compare against; the scored one is
  // the one the search uses.
  function spendRemaining(defs, deps, minVal, budget, alloc) {
    let spent = costOf(defs, alloc);
    let progressed = true;
    while (progressed && budget - spent > MAX_IDLE_POINTS) {
      progressed = false;
      for (const d of defs) {
        const cost = d.cost || 1;
        if (spent + cost > budget) continue;
        if (!isEligible(d, defs, deps, minVal, alloc)) continue;
        alloc[d.id] = (alloc[d.id] || 0) + 1;
        spent += cost;
        progressed = true;
        if (budget - spent <= MAX_IDLE_POINTS) break;
      }
    }
    return alloc;
  }

  // Reduce an allocation until it fits `budget`, then repair anything the reduction stranded.
  //
  // This is what a level-down does: the game refunds points that no longer fit. Removing from
  // whichever node currently holds the most is the canonical rule -- it is the one the build
  // editor already used, and having it here means talents and attributes are trimmed by the
  // same code instead of two hand-rolled loops that can drift apart.
  //
  // Mutates `alloc` in place, matching how the editor holds a live allocation object.
  function trimToBudget(defs, deps, minVal, budget, alloc) {
    let guard = 0;
    while (costOf(defs, alloc) > budget && guard++ < 10000) {
      let topId = null;
      let topLevel = 0;
      for (const d of defs) {
        if ((alloc[d.id] || 0) > topLevel) { topLevel = alloc[d.id]; topId = d.id; }
      }
      if (!topId) break;
      alloc[topId] -= 1;
    }
    clearInvalidDescendants(defs, deps, minVal, alloc);
    return alloc;
  }

  // Every legal "move `amount` points from `from` to `to`" result, as a fresh allocation.
  // Returns null when the move is illegal or a no-op. Cascade-clears before granting, so a
  // transfer can never produce a stranded dependent -- the failure mode that forced the old
  // code to carry a separate repairLegality pass.
  function transfer(defs, deps, minVal, budget, alloc, fromId, toId, amount) {
    if (fromId === toId) return null;
    const from = defs.find((d) => d.id === fromId);
    const to = defs.find((d) => d.id === toId);
    if (!from || !to) return null;
    if ((alloc[fromId] || 0) < amount) return null;

    const next = { ...alloc };
    next[fromId] -= amount;
    if ((next[toId] || 0) >= to.maxLevel) return null;

    // LEGALITY IS A STATE PREDICATE, NOT A PATH PREDICATE -- so it is checked on the FINISHED
    // move, never halfway through it.
    //
    // clearInvalidDescendants used to run HERE, between the withdrawal and the grant. A tier
    // threshold counts points spent in strictly-lower-threshold nodes, so a transfer BETWEEN two
    // tier-0 nodes is threshold-neutral by construction -- yet mid-move the total is short by the
    // withdrawn amount, so a dependent node read as unsupported and was ZEROED. The grant that
    // restores the total landed immediately afterwards, too late to save it, and fillLeftover then
    // scattered the freed points in declaration order.
    //
    // MEASURED on a real level-60 Borge sitting at exactly the 150-point threshold that mino
    // requires: `htb -> ares x1`, a move between two tier-0 nodes that cannot change the tier-0
    // total, came back with mino 15 -> 0, ares 3 -> 35 and a score of -20.92%. Every escape from
    // that allocation looked like a cliff for the same reason, and the allocation was not actually
    // a local optimum at all -- the move generator was fabricating the walls around it.
    //
    // The withdrawal and the grant are two halves of ONE move. Nothing is stranded until both have
    // happened, which is what the state-predicate rule means.

    let room = budget - costOf(defs, next);
    const toCost = to.cost || 1;
    if (toCost > room) return null;
    // Grant as many points to `to` as the freed budget allows, up to its cap.
    let granted = 0;
    while (room >= toCost && (next[toId] || 0) < to.maxLevel && isEligible(to, defs, deps, minVal, next)) {
      next[toId] = (next[toId] || 0) + 1;
      room -= toCost;
      granted++;
    }
    if (granted === 0) return null;
    // Now the move is complete: anything still stranded is genuinely stranded.
    clearInvalidDescendants(defs, deps, minVal, next);
    fillLeftover(defs, deps, minVal, budget, next);
    if (!isLegal(defs, deps, minVal, next, budget)) return null;
    // Same rule as canonicalFill: a transfer that strands budget is not worth evaluating.
    if (budget - costOf(defs, next) > MAX_IDLE_POINTS) return null;
    if (sameAlloc(defs, alloc, next)) return null;
    return next;
  }

  function sameAlloc(defs, a, b) {
    return defs.every((d) => (a[d.id] || 0) === (b[d.id] || 0));
  }

  function signature(defs, alloc) {
    return defs.map((d) => alloc[d.id] || 0).join(',');
  }

  const Space = {
    MAX_IDLE_POINTS,
    costOf, pointsBelowThreshold, isEligible, isHeld, isLegal, clearInvalidDescendants,
    enumerateSupports, canonicalFill, fillLeftover, spendRemaining, trimToBudget, transfer, sameAlloc, signature,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Space;
  else global.AllocSpace = Space;
})(typeof window !== 'undefined' ? window : globalThis);
