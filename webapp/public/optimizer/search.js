// The optimizer. One deterministic pipeline, no randomness, no fallbacks, no legacy paths.
//
// Given the same build and account state it returns the same answer every time. That is not
// an aspiration -- there is no Math.random in this file, every list is sorted by an explicit
// total order, and the underlying WASM evaluator is exactly reproducible (a fresh instance
// per call yields bit-identical output; verified directly).
//
// -----------------------------------------------------------------------------------------
// WHAT "EVALUATE EVERY COMBINATION" HONESTLY MEANS HERE
// -----------------------------------------------------------------------------------------
// The full allocation space cannot be enumerated: two attributes per hunter are uncapped, so
// at level 80 there are astronomically many legal attribute allocations. Anything claiming to
// try them all would be lying. What IS enumerated exhaustively is the STRUCTURAL choice --
// which nodes get funded at all:
//
//   Stage 1  Every dependency-closed, budget-affordable support set (Borge 361, Ozzy 289,
//            Knox 145 -- measured, not estimated). No heuristic decides which regions of the
//            tree are worth looking at, because every region is looked at.
//   Stage 2  For the strongest supports, the depth question is solved by coarse-to-fine
//            coordinate exchange run to a fixpoint: on exit, NO single transfer of 8, 4, 2 or
//            1 points between any pair of nodes improves the score. That is a checkable
//            guarantee, unlike "we sampled some random neighbours."
//   Stage 3  Finalists are re-scored at full fidelity -- the same measurement that decides
//            the winner, so the search cannot optimize one function and be judged by another.
//
// The old engine's failures all came from Stage 1 being a guess: greedy construction cannot
// fund a gate node whose payoff only appears once its child is funded, so it never reached
// whole regions of the tree, and the gap was patched with a bespoke "chain-unlock" move, then
// random restarts, then a legality repair pass. Enumerating supports removes the cause rather
// than compensating for it.
(function (global) {
  'use strict';

  const Space = (typeof module !== 'undefined' && module.exports)
    ? require('./space.js')
    : global.AllocSpace;
  const Objective = (typeof module !== 'undefined' && module.exports)
    ? require('./objective.js')
    : global.OptimizerObjective;

  /**
   * Force pinned attributes to their maximum and keep them there.
   *
   * Used by the `bossTimeless` mode: Timeless Mastery does not help kill a boss at all -- kill
   * rate is identical at Timeless 0 and 5 (measured) -- it multiplies what the kill pays out.
   * A boss objective therefore has no reason to fund it, and would spend those points on offence
   * instead. Pinning reserves them up front so the search optimizes everything else AROUND a
   * maxed Timeless, which is exactly the "wait until the kill is worth the most" strategy.
   *
   * Applied to every allocation the search produces, so a pin cannot be quietly traded away by
   * a later transfer.
   */
  function applyPins(defs, deps, minVal, budget, alloc, pinnedIds) {
    if (!pinnedIds.length) return alloc;
    const out = { ...alloc };
    for (const id of pinnedIds) {
      const def = defs.find((d) => d.id === id);
      if (!def) throw new Error(`Cannot pin unknown attribute "${id}"`);
      // Open whatever this node depends on first, or it cannot legally hold points at all.
      let guard = 0;
      while ((out[id] || 0) < def.maxLevel && guard++ < 500) {
        if (Space.isEligible(def, defs, deps, minVal, out)) {
          out[id] = (out[id] || 0) + 1;
          continue;
        }
        // Blocked: fund one point into whatever is missing, if the budget allows.
        const opened = defs.find((d) => (out[d.id] || 0) === 0 && Space.isEligible(d, defs, deps, minVal, out));
        if (!opened) break;
        out[opened.id] = 1;
      }
    }
    // Paying for the pin can push the allocation over budget; trim elsewhere, never the pin.
    let guard = 0;
    while (Space.costOf(defs, out) > budget && guard++ < 5000) {
      let victim = null;
      for (const d of defs) {
        if (pinnedIds.includes(d.id)) continue;
        if ((out[d.id] || 0) <= 0) continue;
        if (!victim || out[d.id] > out[victim.id]) victim = d;
      }
      if (!victim) break;
      out[victim.id] -= 1;
      Space.clearInvalidDescendants(defs, deps, minVal, out);
    }
    return out;
  }

  /** Are every pinned attribute still at maximum? */
  function pinsHeld(defs, alloc, pinnedIds) {
    return pinnedIds.every((id) => {
      const def = defs.find((d) => d.id === id);
      return def ? (alloc[id] || 0) >= def.maxLevel : true;
    });
  }

  // Coarse fidelity for ranking, full fidelity for deciding. Measured on 40 allocations: the
  // 100-iteration score sits ~0.9% off the 1000-iteration score and inverts ~1.2% of pairwise
  // rankings -- fine for narrowing thousands of candidates, NOT fine for picking the winner.
  // Stage 3 therefore re-scores at FINAL_ITERATIONS, which is also exactly what the build card
  // displays. Optimizing one number and reporting another is what produced the old "the search
  // said it was better but nothing changed" dialog.
  const SCREEN_ITERATIONS = 100;
  const FINAL_ITERATIONS = 1000;

  // Stage 2 runs in two tiers. Every enumerated support is screened in Stage 1; SURVEY_SUPPORTS
  // of them get a cheap coarse optimization, and only REFINE_SUPPORTS of those get the full
  // fixpoint treatment. A single WASM evaluation costs ~11ms on a mid-level build and rises
  // with level (it scales with how far the build progresses), so eval count is the binding
  // constraint on wall clock -- spending the full budget on supports that the coarse tier
  // already shows are uncompetitive buys nothing.
  // HOW MANY SUPPORTS GET TUNED, as a user-facing choice.
  //
  // Screening scores each support at a canonical fill, and that estimate is a POOR predictor of
  // what the support is worth once tuned. Measured on a real level-62 Ozzy: the best support in
  // the whole space screens 147th of 234, so at the default width it is never surveyed and no
  // later stage can recover it. Handed that support at the very same flat fill, refinement reaches
  // 39,139,365 -- 8.4% above the player's own build -- so refinement is sound and the loss is
  // entirely the screening cut.
  //
  // Five cheaper fills were measured as screening proxies (flat, max-concentration, capped-at-cap,
  // capped-at-cap with the remainder split, and a coarse measured greedy) and ALL of them rank it
  // below the cut. The reason is structural: its value needs exo deep enough to clear cat's
  // 150-cost tier threshold AND cat funded to 18, and no single-shot fill produces that pair --
  // each one strands cat, which is then zeroed, taking the value with it.
  //
  // So the honest lever is coverage, and its cost is roughly linear in the number surveyed. Rather
  // than pick one point on that trade for everybody, it is exposed: `complete` surveys EVERY
  // realizable support, which is the only setting that can promise a support was never discarded
  // on an estimate. The table lives here, beside the search, and the UI renders from it -- so a
  // level cannot exist in the dropdown without the optimizer implementing it.
  // Effort now buys ARCHIVE COVERAGE and refinement width, not survey width -- there is no survey
  // to widen. `archiveEvals` is how many variations the behaviour archive gets to spend; more
  // evaluations mean more cells reached and more depth inside each, which is the only lever that
  // was ever actually monotone in quality.
  const EFFORT_LEVELS = {
    fast: {
      label: 'Fast', archiveEvals: 1200, refineSupports: 3,
      help: 'A shorter archive pass, then refines the 3 strongest elites. Quickest.',
    },
    complete: {
      label: 'Complete', archiveEvals: 4800, refineSupports: 8,
      help: 'A full archive pass, then refines the 8 strongest elites. Finds builds Fast '
        + 'misses, at several times the cost.',
    },
  };
  const DEFAULT_EFFORT = 'fast';
  const DEFAULT_ARCHIVE_EVALS = EFFORT_LEVELS.fast.archiveEvals;

  // The survey stage reports progress as a fraction of this, since a rung schedule has no single
  // natural denominator.
  const SURVEY_REPORT_SCALE = 100;
  const SURVEY_SUPPORTS = EFFORT_LEVELS.fast.refineSupports;
  const REFINE_SUPPORTS = 3;

  // Transfer sizes, largest first. Large steps cross the flat regions that trap single-point
  // hill climbing; the size-1 pass at the end is what makes the fixpoint claim above true.
  // The survey tier uses a subset -- enough to rank supports fairly, not enough to converge.
  const STEP_SIZES = [8, 4, 2, 1];

  // The winner's final polish, run at FINAL_ITERATIONS. Small steps only: the coarse descent has
  // already happened at screening fidelity, and this pass exists to correct the last few points
  // where the screen and the judge disagree.
  // AMOUNTS ARE WIDENED ONLY WHILE WIDENING PAYS.
  //
  // The polish needs big transfers on some builds and not others, and the cost of offering them is
  // brutal: scanning the whole neighbourhood at FINAL_ITERATIONS for every amount 1..16 took a
  // level-60 Borge from 28.8s to over five minutes -- for a polish gain of 0.32% it already got
  // from amounts 1..4. A level-62 Ozzy genuinely needs 9-unit moves (exo 65 -> 74, worth 1.9%).
  //
  // So the range is not fixed. It starts narrow and doubles ONLY when the move just accepted used
  // the widest amount currently on offer -- evidence that something wider might pay. A build that
  // never wants a big transfer never scans for one.
  const POLISH_TIERS = [4, 8, 16];


  // A boss at full health was never engaged, so "how close did it come" says nothing.
  const BOSS_UNENGAGED_HP = 100;
  // How many boss-capable supports join the loot leaders in the tuning pool.
  const BOSS_CANDIDATES = 3;

  // How many candidate moves are scored before a block settles for the best one found so far.
  // Sized to keep the worker pool (MAX_POOL_SIZE is 6) busy while bounding what one accepted move
  // can cost. A scheduling constant: it changes how fast the fixpoint is reached, not which one.
  const MOVE_CHUNK = 24;

  // The polish runs at FINAL_ITERATIONS, where every evaluation costs about 10x a screening one,
  // so it is the one stage whose cost must be BOUNDED rather than left to run to a fixpoint. It is
  // a correction, not a search: the descent has already happened. Unbounded it was the largest
  // single cost on a high-level hunter -- a level-62 Ozzy run grew past three minutes, most of it
  // here -- for a measured gain of 0.32%.
  // Each round is now ONE screening pass plus POLISH_VERIFY accurate evaluations, so a round is
  // cheap and the cap can be generous. It could not before: the old polish scanned the whole
  // neighbourhood at FINAL_ITERATIONS, where 4 rounds per step level already cost minutes.
  //
  // Four was measured far too tight once the cost changed. On a level-62 Ozzy the wide polish had
  // been making 16.67% of corrections across many rounds; capped at 4 it managed 0.92% and the run
  // came back 66% below the player's own build.
  const POLISH_MAX_ROUNDS = 40;

  const SURVEY_STEP_SIZES = [4, 1];

  // Bound on improving moves per block pass. Each round applies at most one move, so this only
  // binds on pathological inputs; it is reported rather than silently swallowed.
  const MAX_ROUNDS_PER_BLOCK = 400;


  // Talent supports are enumerated as a bitmask over the talent list. 16 bits is 65,535 subsets,
  // far past anything the game has (8-9 talents, i.e. 255-511); beyond it the enumeration is
  // refused rather than attempted.
  const MAX_TALENT_ENUM_BITS = 16;

  // How many enumerated talent supports get a full joint refinement at each point one is used.
  // The winning support ranks FIRST against the attributes it belongs with in every case measured
  // (the level-31 Knox's by a factor of six over the runner-up), so this is a safety margin rather
  // than a search width -- and each one costs a full fixpoint, which is the expensive unit here.
  const REFINE_TALENT_SUPPORTS = 2;

  class Cancelled extends Error {}

  // ---------------------------------------------------------------------------------------
  // Block optimization: fix one allocation, optimize the other to a coordinate-exchange
  // fixpoint. Deterministic throughout -- candidate moves are generated in declaration order
  // and ties are broken toward the earlier candidate, never by chance.
  // ---------------------------------------------------------------------------------------
  // Spend idle budget by MEASURED marginal value: one point at a time into whichever eligible
  // node most improves the score. Deterministic -- candidates are built in declaration order and
  // ties break toward the earlier one -- and it introduces no weights or constants of its own.
  //
  // This replaces Space.spendRemaining for the incumbent, which filled in DECLARATION ORDER,
  // round-robin. That is the same flat shape this file already learned not to trust as a talent
  // seed, and on an under-spent build it is worse than merely uninformed: it DESTROYS the shape
  // of the build being repaired. Measured on a real level-38 Borge whose 12 stripped talent
  // points were spread across six talents by the flat fill, the repaired build came back 12.06%
  // below the untouched import; filling by marginal value instead reproduces the import EXACTLY.
  //
  // It costs (idle points x eligible nodes) evaluations, so it costs nothing on a build that is
  // already fully spent -- the loop does not run. The price is paid only in the case it fixes.
  // `memberIds`, when given, confines the fill to one support -- widening the support is Stage 1's
  // job, and letting the fill do it silently would make the support sets meaningless.
  /** @param {string[] | null} [memberIds] */
  async function greedyTopUp(ctx, defs, deps, minVal, budget, alloc, buildPair, memberIds = null) {
    const current = { ...alloc };
    for (;;) {
      if (ctx.shouldCancel()) throw new Cancelled();
      const idle = budget - Space.costOf(defs, current);
      if (idle <= Space.MAX_IDLE_POINTS) break;
      const cands = [];
      for (const d of defs) {
        if (memberIds && !memberIds.includes(d.id)) continue;
        if ((d.cost || 1) > idle) continue;
        if (!Space.isEligible(d, defs, deps, minVal, current)) continue;
        const next = { ...current };
        next[d.id] = (next[d.id] || 0) + 1;
        cands.push({ id: d.id, alloc: next });
      }
      // Nothing eligible fits the remaining budget: the leftover is UNSPENDABLE, not unspent,
      // which is exactly the condition the Stage 3 assertion allows.
      if (!cands.length) break;
      const scores = await ctx.score(cands.map((c) => buildPair(c.alloc)), SCREEN_ITERATIONS);
      let best = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
      current[cands[best].id] = (current[cands[best].id] || 0) + 1;
    }
    return current;
  }

  // A SECOND SCREENING SHAPE: PAY THE GATE, THEN BUY THE GATED NODE.
  //
  // canonicalFill spreads the budget evenly across a support's members. For a support whose value
  // sits behind a TIER THRESHOLD that is a shape nobody would ever play, and the support is judged
  // on it.
  //
  // MEASURED on a real level-62 Ozzy. Its best support screens 147th of 234 at a flat fill
  // (3,105,388 against a leader of 7,351,118) so it never reaches refinement -- yet handed that
  // same support, refinement reaches 39,139,365, which is 8.4% ABOVE the player's own build. The
  // player's allocation is cat 18 / exo 79 / lotl 18, and the 79 is not greed: `cat` requires 150
  // cost units spent in strictly-lower-threshold nodes before it is legal at all, and exo is the
  // cheap uncapped node that pays it. A flat fill gives cat 9 and exo 53 -- it neither pays the
  // gate nor buys what the gate protects.
  //
  // Five shapes were measured and all fail: flat, max-concentration, capped-at-cap, capped-at-cap
  // with the remainder split, and a coarse measured greedy. Every one of them starves the 150 and
  // loses `cat` to clearInvalidDescendants, taking the value with it.
  //
  // So this builds the shape deliberately: fund the gated members toward their caps, then fund the
  // lower tiers until each gate is actually paid, then put whatever is left into the uncapped
  // nodes. Uncapped nodes are exactly the "adjustable filler" that makes a threshold reachable --
  // and are often the best buy in their own right, which is why the remainder goes there too.
  //
  // Costs ONE extra evaluation per support (~234 on this account, about 3s) against a screening
  // stage that already decides everything downstream.
  function gatePayingFill(defs, deps, minVal, budget, ids) {
    const members = defs.filter((d) => ids.includes(d.id));
    if (!members.length) return null;
    const thresholdOf = (d) => minVal[d.id] || 0;
    const costOf = (d) => d.cost || 1;
    const capOf = (d) => (Number.isFinite(d.maxLevel) ? d.maxLevel : Infinity);
    const alloc = {};
    for (const d of members) alloc[d.id] = 0;
    const spent = () => Space.costOf(defs, alloc);
    const room = (d) => spent() + costOf(d) <= budget;

    // 1. Gated members toward their caps, deepest gate first -- these are what the budget is for.
    const tiers = [...new Set(members.map(thresholdOf))].sort((a, b) => b - a);
    for (const t of tiers) {
      if (t <= 0) continue;
      for (const d of members) {
        if (thresholdOf(d) !== t) continue;
        const cap = Number.isFinite(capOf(d)) ? capOf(d) : 1;   // an uncapped gated node: just open it
        while (alloc[d.id] < cap && room(d)) alloc[d.id] += 1;
      }
    }

    // 2. Pay each gate: spend in strictly-lower-threshold members until it clears the threshold.
    //    Uncapped members first -- they are the filler that can absorb an arbitrary amount.
    for (const t of tiers) {
      if (t <= 0) continue;
      const lower = members.filter((d) => thresholdOf(d) < t)
        .sort((a, b) => (Number.isFinite(capOf(a)) ? 1 : 0) - (Number.isFinite(capOf(b)) ? 1 : 0));
      const lowerSpend = () => lower.reduce((sum, d) => sum + alloc[d.id] * costOf(d), 0);
      let progressed = true;
      while (lowerSpend() < t && progressed) {
        progressed = false;
        for (const d of lower) {
          if (alloc[d.id] >= capOf(d) || !room(d)) continue;
          alloc[d.id] += 1;
          progressed = true;
          if (lowerSpend() >= t) break;
        }
      }
    }

    // 3. Whatever is left goes to the uncapped nodes, round-robin.
    const uncapped = members.filter((d) => !Number.isFinite(capOf(d)));
    if (uncapped.length) {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const d of uncapped) {
          if (!room(d)) continue;
          alloc[d.id] += 1;
          progressed = true;
        }
      }
    }
    // 4. Anything still idle goes to whoever can take it, so the shape is not judged under-spent.
    Space.fillLeftover(defs, deps, minVal, budget, alloc);
    Space.clearInvalidDescendants(defs, deps, minVal, alloc);
    if (budget - spent() > Space.MAX_IDLE_POINTS) return null;
    if (!Space.isLegal(defs, deps, minVal, alloc, budget)) return null;
    return alloc;
  }

  // SHORTLIST CHEAPLY, DECIDE EXPENSIVELY.
  //
  // The polish is the only stage that measures at FINAL_ITERATIONS, and that is what makes it able
  // to correct a fine ridge -- on a real level-62 Ozzy it moved the winner 16.67%. But scanning the
  // whole neighbourhood at that fidelity, across every step size, is ruinous: a level-60 Borge went
  // from 94s to over five minutes when the amount range widened to 1..16.
  //
  // An evaluation at 1000 iterations costs about ten at 100, so the budget is far better spent as
  // a FEW accurate decisions than as many accurate scans. Every candidate move is scored once at
  // screening fidelity to rank them, and only the best POLISH_VERIFY of them are re-scored at full
  // fidelity, where the choice is actually made.
  //
  // The shortlist being biased is exactly why it is a SHORTLIST and not a decision: a 100-iteration
  // score has been measured ranking a 0.32% ridge backwards by 1.7%, so it is trusted only to say
  // "these are the moves worth paying to look at properly", and the verdict always comes from the
  // full-fidelity score.
  // VERIFY EVERY CANDIDATE MOVE AT FULL FIDELITY. Quality over speed, deliberately.
  //
  // A cheap shortlist was tried: rank the neighbourhood at SCREEN_ITERATIONS and re-score only the
  // best few at FINAL_ITERATIONS. It looked lossless and was not. The check that "proved" it was
  // run while cross-seed was removed and the build was stuck 66% low, so it compared convergence
  // from a broken starting point and said nothing about the real one. With cross-seed active a
  // top-12 shortlist returns 38,238,568 where a full scan returns 39,881,450 -- 1.64M given away.
  //
  // The reason is the shortlist's own ranking: a 100-iteration score has been measured ordering a
  // 0.32% ridge BACKWARDS by 1.7%, and the moves that matter here ARE fine-ridge redistributions
  // (exo/lotl/timeless). A noisy ranking buries exactly the candidates worth verifying, so the
  // shortlist discards the answer before the accurate scorer ever sees it.
  //
  // The polish only ever touches ONE build -- the winner -- which is what makes scanning it in
  // full affordable at all.
  const POLISH_VERIFY = Infinity;

  async function polishWinner(ctx, cfg, talentAlloc, attrAlloc, startScore, pinnedAttrs, report) {
    const { TALENTS, ATTRIBUTES, TALENT_BUDGET, ATTRIBUTE_BUDGET } = cfg;
    const deps = cfg.ATTRIBUTE_DEPENDENCIES;
    const minVal = cfg.ATTRIBUTE_MIN_VALUE;
    let curT = { ...talentAlloc };
    let curA = { ...attrAlloc };
    let curScore = startScore;

    let tier = 0;                       // index into POLISH_TIERS: how wide the amounts go
    for (let round = 0; round < POLISH_MAX_ROUNDS; round++) {
      if (ctx.shouldCancel()) throw new Cancelled();
      report(round / POLISH_MAX_ROUNDS);
      const maxAmount = POLISH_TIERS[tier];
      const amounts = Array.from({ length: maxAmount }, (_, i) => maxAmount - i);

      // Build the whole neighbourhood: every pair, every amount in POLISH_STEP_SIZES, both blocks.
      const moves = [];
      const seen = new Set();
      const push = (talents, attrs) => {
        const sig = `${Space.signature(TALENTS, talents)}|${Space.signature(ATTRIBUTES, attrs)}`;
        if (seen.has(sig)) return;
        seen.add(sig);
        moves.push({ talentAlloc: talents, attrAlloc: attrs });
      };
      for (const step of amounts) {
        for (const from of ATTRIBUTES) {
          if (pinnedAttrs.includes(from.id) || (curA[from.id] || 0) < step) continue;
          for (const to of ATTRIBUTES) {
            const nx = Space.transfer(ATTRIBUTES, deps, minVal, ATTRIBUTE_BUDGET, curA, from.id, to.id, step);
            if (nx && pinsHeld(ATTRIBUTES, nx, pinnedAttrs)) push(curT, nx);
          }
        }
        for (const from of TALENTS) {
          if ((curT[from.id] || 0) < step) continue;
          for (const to of TALENTS) {
            const nx = Space.transfer(TALENTS, {}, {}, TALENT_BUDGET, curT, from.id, to.id, step);
            if (nx) push(nx, curA);
          }
        }
      }
      if (!moves.length) break;

      // Rank cheaply...
      const verifyWidth = cfg.polishVerify || POLISH_VERIFY;
      const cheap = await ctx.score(moves, SCREEN_ITERATIONS);
      const order = moves.map((m, i) => ({ m, s: cheap[i] }))
        .sort((a, b) => b.s - a.s)
        .slice(0, verifyWidth);
      // ...decide expensively.
      const exact = await ctx.score(order.map((o) => o.m), FINAL_ITERATIONS);
      let bestIdx = -1;
      for (let i = 0; i < exact.length; i++) {
        if (exact[i] > curScore && (bestIdx === -1 || exact[i] > exact[bestIdx])) bestIdx = i;
      }
      if (bestIdx === -1) {
        // Nothing improved at this width. Widen once and try again; if the widest tier is already
        // in play, the polish is genuinely converged.
        if (tier < POLISH_TIERS.length - 1) { tier += 1; continue; }
        break;
      }
      curT = order[bestIdx].m.talentAlloc;
      curA = order[bestIdx].m.attrAlloc;
      curScore = exact[bestIdx];
    }
    return { talentAlloc: curT, attrAlloc: curA, score: curScore };
  }

  // ============================ THE ARCHIVE (quality-diversity) ============================
  //
  // WHY THE SEARCH IS BUILT THIS WAY, because the previous architecture failed for ONE reason in
  // four disguises.
  //
  // It was staged filtering: enumerate, screen at a canonical fill, tune a few, refine fewer -- and
  // every stage cut candidates PERMANENTLY on a cheap, biased proxy. Measured consequences:
  //   * a level-62 Ozzy's best support screens 147th of 234 and is never tuned
  //   * a 0.32% ridge is ranked BACKWARDS by 1.7% at SCREEN_ITERATIONS
  //   * boss capability is invisible to screening -- on all three hunters, ZERO screened fills
  //     engage a boss at all, because capability is something refinement CREATES
  //   * borge@54 comes back 88% short, at a level that was never in the test set
  // Those are one architecture failing four ways, not four bugs. Each patch fitted to one of them
  // (a depth multi-start, a boss cross-seed, annealing) broke another hunter.
  //
  // A quality-diversity archive (MAP-Elites) inverts the rule that caused it: keep the BEST
  // SOLUTION PER BEHAVIOUR CELL rather than the top N by score, so a build that scores badly now
  // but behaves differently survives as a stepping stone instead of being cut. That is exactly the
  // boss-capable build this search kept losing -- poor loot today, decisive once refined.
  //
  // The descriptors are FREE. Every evaluation already returns bossKillRate and maxStage alongside
  // the objective; the old scorer computed and discarded them, which is precisely why a second
  // boss-objective search had to be bolted on to recover the same information.
  //
  // DETERMINISM IS PRESERVED. The ban is on Math.random, not on sampling: this uses a seeded PRNG
  // with a fixed seed and a fixed traversal order, so identical input gives identical output.
  // Reproducibility is the invariant; unpredictability was never the point.

  const ARCHIVE_SEED = 0x9e3779b9;
  // Behaviour space. Kill rate says whether a build can pass a boss at all; the stage band says how
  // far it gets. Bands rather than raw values because cells are niches, not points.
  //
  // RESOLUTION IS WHAT MAKES AN ARCHIVE AN ARCHIVE. The first version used 7 kill bands and
  // 25-stage bands and filled FIVE cells from 1200 variations -- so nearly every child competed
  // against the same handful of elites and the diversity pressure that justifies the whole method
  // was not actually being applied. Coarse cells are not a conservative choice; they are a
  // degenerate one.
  const KILL_BANDS = [0, 1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99];
  const ARCHIVE_STAGE_BAND = 5;
  // THE THIRD AXIS IS CONCENTRATION, and it is the one this repo's own notes predict matters most:
  // "concentration is what crosses a threshold, and a narrow support concentrates for free". A
  // build that dumps its budget into one attribute and one that spreads it evenly can reach the
  // same stage with the same kill rate while being completely different builds -- and crossing
  // between them is exactly the move coordinate exchange cannot make. Without this axis they share
  // a cell and one of them is discarded.
  const CONCENTRATION_BANDS = 6;
  const ARCHIVE_BATCH = 48;            // large enough to keep the worker pool saturated
  const ARCHIVE_CROSSOVER = 0.25;
  // POINT TRANSFERS CANNOT NAVIGATE A THRESHOLD TREE, AND THAT -- NOT BOSS CAPABILITY -- IS WHY
  // THE ARCHIVE STAYED EMPTY FOR TWO OF THREE HUNTERS.
  //
  // Measured, same account, same 4800 variations, at Complete effort:
  //     borge@60   571 cells   14 kill bands   best kill 99     0.00%
  //     ozzy@62     50 cells    1 kill band    best kill  0   -66.27%
  //     knox@26     28 cells    1 kill band    best kill  0    -1.39%
  // An archive that fills 571 cells is exploring; one that fills 50 is not. Borge reaches the
  // boss region by ordinary variation with no help at all, so the boss region is not intrinsically
  // unreachable -- the MOVE SET is what differs.
  //
  // Ozzy is the hunter with real tier thresholds (0/90/150/180). `Space.transfer` legalises its
  // result by ZEROING stranded descendants, so a random transfer out of a threshold build usually
  // either fails outright or demolishes the structure that made the build worth anything -- and
  // the child comes back indistinguishable from its parent. Thousands of variations then explore
  // almost nothing.
  //
  // So a share of children are generated STRUCTURALLY: pick one of the already-enumerated
  // dependency-closed supports and fill it, rather than nudging points inside the support the
  // parent happens to have. The enumeration is exact and already paid for, `gatePayingFill` knows
  // how to pay a tier threshold, and this is pure exploration -- it is not directed at the boss or
  // at any objective, so it cannot collapse the search into a basin.
  const STRUCTURAL_SHARE = 0.35;
  // What fraction of the attribute point-moves are DAG-native depth moves rather than flat
  // transfers. Sweepable through the effort object, same as the structural share.
  const DEPTH_SHARE = 0.6;
  // A BOSS-DIRECTED EMITTER WAS TRIED HERE AND MEASURED USELESS. Recorded so it is not retried.
  //
  // The idea was to draw a third of parents from the elites nearest a kill, on the theory that the
  // archive was failing to REACH the boss region. On a real level-62 Ozzy account it made coverage
  // WORSE -- 2 kill bands became 1 -- and the note read "best kill rate reached 0" across all 4800
  // variations, against an account build sitting at kill 67.2.
  //
  // The reason is worth keeping: when every elite has kill 0 and full boss HP, "nearest a kill" is
  // not an ordering at all, so there was nothing to steer by. Biasing parent selection cannot
  // create a gradient that the population does not already contain.
  //
  // The real defect was variation, not selection -- see STRUCTURAL_SHARE below.
  const ARCHIVE_MAX_MOVES = 6;

  function seededRng(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Which archive cell a result belongs to, from the metadata every score already carries. */
  /** How concentrated an allocation is: the share of spend sitting in its single largest node. */
  function concentrationBand(defs, alloc) {
    let total = 0;
    let top = 0;
    for (const d of defs) {
      const v = (alloc[d.id] || 0) * (d.cost || 1);
      total += v;
      if (v > top) top = v;
    }
    if (total <= 0) return 0;
    const share = top / total;
    return Math.min(CONCENTRATION_BANDS - 1, Math.floor(share * CONCENTRATION_BANDS));
  }

  function cellOf(meta, defs, attrAlloc) {
    // A missing descriptor is a PLUMBING FAULT, not a niche. Returning a placeholder cell for it
    // makes every candidate a neighbour of every other and turns the archive into a hill climb
    // that still returns a plausible-looking build -- the exact failure this replaced. Throw.
    if (!meta || !Number.isFinite(meta.kill) || !Number.isFinite(meta.maxStage)) {
      throw new Error('cellOf: scorer returned no boss metadata; the archive cannot form cells');
    }
    let killBand = 0;
    for (let i = 0; i < KILL_BANDS.length; i++) if (meta.kill >= KILL_BANDS[i]) killBand = i;
    return killBand + ':' + Math.floor(meta.maxStage / ARCHIVE_STAGE_BAND)
      + ':' + concentrationBand(defs, attrAlloc);
  }

  /** One legal transfer within a block, drawn from the same move set the refiner uses. */
  //
  // REJECTIONS AND REPAIRS ARE DIFFERENT EVENTS AND MUST BE COUNTED SEPARATELY.
  //
  // Space.transfer returns null for a move it cannot make, and silently ZEROES stranded
  // descendants for one it can. A rejection only wastes a variation. A repair produces a
  // structurally demolished child that looks perfectly legal and then BREEDS. Counting them
  // together would report a healthy move set while it was quietly destroying structure -- which is
  // the failure mode this whole change exists to remove, so the measurement must be able to see
  // the difference.
  function randomTransfer(defs, deps, minVal, budget, alloc, rng, pinnedIds, stats) {
    const held = defs.filter((d) => (alloc[d.id] || 0) > 0 && pinnedIds.indexOf(d.id) === -1);
    if (!held.length) return null;
    for (let tries = 0; tries < 8; tries++) {
      const from = held[Math.floor(rng() * held.length)];
      const to = defs[Math.floor(rng() * defs.length)];
      const amount = 1 + Math.floor(rng() * Math.min(12, alloc[from.id] || 1));
      const next = Space.transfer(defs, deps, minVal, budget, alloc, from.id, to.id, amount);
      if (!next) { if (stats) stats.rejected++; continue; }
      if (stats) {
        stats.accepted++;
        // A node that held points before and holds none after, other than the one we moved OUT of
        // by request, was stranded and cleared -- structure destroyed as a side effect.
        let cleared = 0;
        for (const d of defs) {
          if (d.id === from.id) continue;
          if ((alloc[d.id] || 0) > 0 && (next[d.id] || 0) === 0) cleared++;
        }
        if (cleared) { stats.repaired++; stats.nodesCleared += cleared; }
      }
      return next;
    }
    return null;
  }

  //
  // THE DEPTH OPERATORS, and the measurement that specified them.
  //
  // Sweeping the structural share on a real level-62 Ozzy account, 2400 variations each:
  //     share 0.00   52 cells   2 kill bands   best kill 1
  //     share 0.35   86 cells   2 kill bands   best kill 2
  //     share 0.70   87 cells   2 kill bands   best kill 2
  //     share 1.00   87 cells   1 kill band    best kill 0
  // Support resampling SATURATES at ~35%: it draws from a fixed pool of enumerated supports at two
  // fill patterns, so once those are sampled there is nothing left for it to say. And at 100% the
  // BOSS BAND IS LOST, because going fully structural means no point transfers, and those were the
  // only source of DEPTH variation. The boss-engaging build needs depth a canonical fill does not
  // have.
  //
  // So "replace the flat nudges with DAG-native moves" is right, but it cannot be done by removing
  // the nudges -- the replacement has to exist first, and removing them early is a regression.
  // These are the replacement. Both change DEPTH while holding the SUPPORT fixed or growing it by
  // one legally-openable node, and neither can strand anything: the donor is required to keep at
  // least one point, so no funded node is ever emptied, so no descendant is ever orphaned and
  // clearInvalidDescendants has nothing to clear.
  //
  // Threshold gates are the one thing this still has to CHECK rather than guarantee, because a
  // tier gate counts points in strictly-lower-threshold nodes and a legal depth shift can drop one
  // below its gate. That is a rejection, not a repair -- the cheap failure, not the destructive one.
  function depthMove(defs, deps, minVal, budget, alloc, rng, pinnedIds, stats) {
    const costOf = (d) => d.cost || 1;
    const capOf = (d) => (Number.isFinite(d.maxLevel) ? d.maxLevel : Infinity);
    // Donors must keep a point, which is what makes stranding impossible by construction.
    const donors = defs.filter((d) => (alloc[d.id] || 0) > 1 && pinnedIds.indexOf(d.id) === -1);
    if (!donors.length) return null;
    const funded = (id) => (alloc[id] || 0) > 0;
    // Targets: already-funded nodes (pure depth shift), or one unfunded node whose parents are all
    // funded (deepen the path by opening exactly one legal step -- never a stranded orphan).
    const targets = defs.filter((d) => {
      if ((alloc[d.id] || 0) >= capOf(d)) return false;
      if (funded(d.id)) return true;
      const parents = deps[d.id] || [];
      return parents.every(funded);
    });
    if (!targets.length) return null;

    for (let tries = 0; tries < 8; tries++) {
      const from = donors[Math.floor(rng() * donors.length)];
      const to = targets[Math.floor(rng() * targets.length)];
      if (from.id === to.id) continue;
      const maxOut = (alloc[from.id] || 0) - 1;                       // never empty the donor
      const maxIn = capOf(to) - (alloc[to.id] || 0);
      if (maxOut < 1 || maxIn < 1) continue;
      const take = 1 + Math.floor(rng() * Math.min(maxOut, 12));
      // Convert the donated spend into levels of the target, which may cost differently.
      const give = Math.max(1, Math.min(maxIn, Math.floor((take * costOf(from)) / costOf(to))));
      const next = { ...alloc };
      next[from.id] = (next[from.id] || 0) - take;
      next[to.id] = (next[to.id] || 0) + give;
      if (Space.costOf(defs, next) > budget) continue;
      // Legality is CHECKED, never repaired: an illegal proposal is discarded whole, so no
      // candidate can enter the archive with structure silently deleted out of it.
      if (!Space.isLegal(defs, deps, minVal, next, budget)) { if (stats) stats.depthRejected++; continue; }
      if (!pinsHeld(defs, next, pinnedIds)) continue;
      if (stats) { stats.depthAccepted++; if (!funded(to.id)) stats.depthOpened++; }
      return next;
    }
    return null;
  }

  /**
   * Illuminate the behaviour space and return the elites, best score first.
   *
   * Seeded from the enumerated supports rather than from random points: the enumeration is exact
   * and already paid for, so the archive starts with real structural coverage instead of noise.
   */
  async function illuminate(ctx, spaces, seeds, supports, pinnedAttrs, evalBudget, structuralShare, depthShare, report) {
    const stats = { rejected: 0, accepted: 0, repaired: 0, nodesCleared: 0, structural: 0,
      depthAccepted: 0, depthRejected: 0, depthOpened: 0 };
    const { TALENTS, ATTRIBUTES, talentBudget, attrBudget, deps, minVal } = spaces;
    const rng = seededRng(ARCHIVE_SEED);
    const archive = new Map();

    const consider = (pair, score, meta) => {
      if (!Number.isFinite(score)) return;
      const cell = cellOf(meta, ATTRIBUTES, pair.attrAlloc);
      const held = archive.get(cell);
      if (!held || score > held.score) {
        archive.set(cell, {
          talentAlloc: pair.talentAlloc,
          attrAlloc: pair.attrAlloc,
          score,
          kill: meta.kill,
          hp: Number.isFinite(meta.hp) ? meta.hp : 100,
        });
      }
    };
    // SEEDS MUST BE COMPLETE PAIRS. Screening varies attributes against a fixed talent seed, so a
    // screened row carries `attrAlloc` and no `talentAlloc` -- and `{ ...undefined }` is `{}`, so an
    // incomplete seed does not throw, it silently becomes a build with NO TALENTS that then breeds
    // through the whole archive. Assert the shape instead of trusting the caller.
    for (const s of seeds) {
      if (!s.talentAlloc || !s.attrAlloc) {
        throw new Error('illuminate: seed is not a complete {talentAlloc, attrAlloc} pair');
      }
      consider(s, s.score, s.boss);
    }

    let spent = 0;
    while (spent < evalBudget) {
      if (ctx.shouldCancel()) throw new Cancelled();
      report(spent / evalBudget);
      const elites = [...archive.values()];
      if (!elites.length) break;

      const batch = [];
      for (let i = 0; i < ARCHIVE_BATCH; i++) {
        const parent = elites[Math.floor(rng() * elites.length)];
        let t = { ...parent.talentAlloc };
        let a = { ...parent.attrAlloc };
        // Structural resample: adopt a whole different support, filled two ways (gate-paying when
        // the support has a threshold to pay, canonical otherwise). This is the move that a
        // sequence of point transfers cannot make.
        if (supports.length && rng() < structuralShare) {
          const pick = supports[Math.floor(rng() * supports.length)];
          const ids = pick.support ? pick.support.ids : pick.ids;
          const filled = (rng() < 0.5)
            ? gatePayingFill(ATTRIBUTES, deps, minVal, attrBudget, ids)
            : Space.canonicalFill(ATTRIBUTES, deps, minVal, attrBudget, ids, true);
          if (filled && Space.isLegal(ATTRIBUTES, deps, minVal, filled, attrBudget)
            && pinsHeld(ATTRIBUTES, filled, pinnedAttrs)) {
            a = filled;
            stats.structural++;
          }
        }
        // Crossing a boss-capable elite with a farming one is how ONE search reaches builds that
        // neither parent's basin contains -- which is what the cross-seed pass was doing by hand.
        if (elites.length > 1 && rng() < ARCHIVE_CROSSOVER) {
          const other = elites[Math.floor(rng() * elites.length)];
          if (rng() < 0.5) t = { ...other.talentAlloc }; else a = { ...other.attrAlloc };
          if (Space.costOf(TALENTS, t) > talentBudget
            || !Space.isLegal(ATTRIBUTES, deps, minVal, a, attrBudget)) {
            t = { ...parent.talentAlloc }; a = { ...parent.attrAlloc };
          }
        }
        // Multi-move perturbation: one transfer cannot leave a basin, several can.
        const steps = 1 + Math.floor(rng() * ARCHIVE_MAX_MOVES);
        for (let m = 0; m < steps; m++) {
          if (rng() < 0.5) {
            const nx = randomTransfer(TALENTS, {}, {}, talentBudget, t, rng, [], null);
            if (nx) t = nx;
          } else if (rng() < depthShare) {
            // DAG-native depth: hold the support, change how deep it goes.
            const nx = depthMove(ATTRIBUTES, deps, minVal, attrBudget, a, rng, pinnedAttrs, stats);
            if (nx) a = nx;
          } else {
            const nx = randomTransfer(ATTRIBUTES, deps, minVal, attrBudget, a, rng, pinnedAttrs, stats);
            if (nx && pinsHeld(ATTRIBUTES, nx, pinnedAttrs)) a = nx;
          }
        }
        batch.push({ talentAlloc: t, attrAlloc: a });
      }

      const scores = await ctx.score(batch, SCREEN_ITERATIONS);
      const meta = scores.boss || [];
      for (let i = 0; i < batch.length; i++) consider(batch[i], scores[i], meta[i]);
      spent += batch.length;
    }

    const bands = new Set([...archive.keys()].map((k) => k.split(':')[0]));
    const bestKill = [...archive.values()].reduce((m, e) => Math.max(m, e.kill || 0), 0);
    ctx.note(`archive: ${archive.size} cells across ${bands.size} kill bands from ${spent} `
      + `variations (best kill rate reached ${bestKill})`);
    const attempted = stats.rejected + stats.accepted;
    const pct = (n) => (attempted ? ((n / attempted) * 100).toFixed(1) : '0.0');
    ctx.note(`moves: ${attempted} attribute transfers -- ${pct(stats.rejected)}% rejected, `
      + `${pct(stats.repaired)}% accepted-but-stranded (${stats.nodesCleared} nodes cleared); `
      + `${stats.structural} structural resamples at share ${structuralShare}`);
    ctx.note(`depth moves: ${stats.depthAccepted} accepted (${stats.depthOpened} opened a new node), `
      + `${stats.depthRejected} rejected -- NONE stranded, by construction; share ${depthShare}`);
    return [...archive.entries()]
      .map(([cell, e]) => ({ ...e, cell }))
      .sort((x, y) => y.score - x.score);
  }

  // Every talent support, the same way attribute supports are enumerated.
  //
  // Talents have no dependency edges and no tier thresholds, so every non-empty subset is a legal
  // support and canonicalFill alone decides whether it is realizable within the budget and caps.
  // With 8-9 talents that is at most 511 subsets -- FEWER than the 361 dependency-closed attribute
  // supports this file already enumerates exhaustively, so the asymmetry of enumerating one block
  // and hill-climbing the other was never justified by cost.
  //
  // It matters because the talent block is where coordinate exchange actually fails. Measured on a
  // real level-31 Knox: with the right attributes held fixed, hill climbing from a flat talent fill
  // reaches 6,473 where the answer is 64,031 -- it strips Power Of Gaia early (worthless at 3) and
  // no pairwise 8/4/2/1 transfer can rebuild it alongside Finisher. Enumerating the supports finds
  // {revival, ghost, pog, finish} ranked FIRST and refines it to the import exactly.
  function enumerateTalentSupports(defs, budget) {
    const n = defs.length;
    // 2^n subsets. Guarded rather than assumed: a future hunter with many more talents should
    // make this fail visibly instead of quietly hanging the optimizer.
    if (n > MAX_TALENT_ENUM_BITS) return null;
    const out = [];
    for (let mask = 1; mask < (1 << n); mask++) {
      const ids = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) ids.push(defs[i].id);
      const fill = Space.canonicalFill(defs, {}, {}, budget, ids);
      if (fill) out.push({ mask, ids, fill });
    }
    return out;
  }

  // Screen every talent support against one attribute allocation and return the strongest few.
  // Used from two places -- the refined supports and the incumbent -- so there is exactly one
  // definition of "which talent structures are worth refining against these attributes".
  async function bestTalentSupportsFor(ctx, attrAlloc, TALENTS, talentBudget, batch, shouldCancel) {
    const supports = enumerateTalentSupports(TALENTS, talentBudget);
    if (!supports || !supports.length) return [];
    const screened = [];
    for (let i = 0; i < supports.length; i += batch) {
      if (shouldCancel()) throw new Cancelled();
      const chunk = supports.slice(i, i + batch);
      const scores = await ctx.score(chunk.map((c) => ({ talentAlloc: c.fill, attrAlloc })), SCREEN_ITERATIONS);
      chunk.forEach((c, j) => screened.push({ ...c, score: scores[j] }));
    }
    // Deterministic total order, same rule as the attribute screen: score, then mask.
    screened.sort((a, b) => (b.score - a.score) || (a.mask - b.mask));
    return screened.slice(0, REFINE_TALENT_SUPPORTS);
  }

  async function optimizeBlock(ctx, defs, deps, minVal, budget, alloc, buildPair, baseScore, stepSizes, pinnedIds = [], onFrac = null, iterations = SCREEN_ITERATIONS, maxRounds = MAX_ROUNDS_PER_BLOCK) {
    let current = { ...alloc };
    let currentScore = baseScore;
    let rounds = 0;

    // CONTINUOUS PROGRESS. A block runs an unbounded number of rounds, so there is no exact
    // denominator to report against -- the step index gives the coarse position and the round
    // count eases within it, saturating so the fraction only ever moves forward.
    //
    // Without this the bar reported once per SUPPORT, and survey plus refine are 94% of the
    // runtime: it sat still for tens of seconds and then jumped, which from the outside is
    // indistinguishable from the optimizer having hung.
    const ROUND_EASE = 25;
    let stepIdx = 0;
    const tick = () => {
      if (!onFrac) return;
      onFrac(Math.min((stepIdx + Math.min(rounds / ROUND_EASE, 1)) / stepSizes.length, 1));
    };

    for (const step of stepSizes) {
      let improved = true;
      while (improved) {
        if (ctx.shouldCancel()) throw new Cancelled();
        // Only the EMERGENCY cap is worth reporting. A rung deliberately caps a block at one or
        // two rounds, and reporting that as "hit MAX_ROUNDS_PER_BLOCK" made a normal run look
        // pathological -- 12 such notes per run, which read as refinement churning without
        // converging. Raising the real cap from 400 to 3000 changed nothing (byte-identical
        // score and evaluation count), which is what proved the notes were spurious.
        if (++rounds > maxRounds) {
          if (maxRounds === MAX_ROUNDS_PER_BLOCK) ctx.note(`block hit MAX_ROUNDS_PER_BLOCK at step ${step}`);
          break;
        }
        improved = false;

        const moves = [];
        const seen = new Set();
        for (const from of defs) {
          if ((current[from.id] || 0) < step) continue;
          // Never move points OUT of a pinned node -- that is what the pin means.
          if (pinnedIds.includes(from.id)) continue;
          for (const to of defs) {
            const next = Space.transfer(defs, deps, minVal, budget, current, from.id, to.id, step);
            if (!next) continue;
            // A transfer cascades: removing a point can strand a dependency and clear a pinned
            // node indirectly. Re-check rather than assume the `from` guard above is sufficient.
            if (!pinsHeld(defs, next, pinnedIds)) continue;
            const sig = Space.signature(defs, next);
            if (seen.has(sig)) continue;
            seen.add(sig);
            moves.push(next);
          }
        }
        if (!moves.length) break;

        // FIRST IMPROVEMENT, scanned in chunks -- not steepest descent.
        //
        // Scoring the whole neighbourhood costs ~66 evaluations here and buys exactly ONE
        // point-move, and a block runs many rounds. Early rounds have plenty of improving moves,
        // so a chunk almost always holds one.
        //
        // The fixpoint guarantee is untouched: as the block converges, improvements get rarer and
        // the loop scans further, until the final round scans every move and finds none. Only the
        // path to the fixpoint is cheaper. Deterministic -- chunks are taken in generation order
        // and ties inside a chunk break toward the earlier candidate.
        let bestMove = null;
        let bestScore = currentScore;
        for (let start = 0; start < moves.length; start += MOVE_CHUNK) {
          if (ctx.shouldCancel()) throw new Cancelled();
          const chunk = moves.slice(start, start + MOVE_CHUNK);
          const scores = await ctx.score(chunk.map(buildPair), iterations);
          for (let i = 0; i < scores.length; i++) {
            if (scores[i] > bestScore) { bestScore = scores[i]; bestMove = chunk[i]; }
          }
          if (bestMove) break;
        }
        if (bestMove) {
          current = bestMove;
          currentScore = bestScore;
          improved = true;
        }
        tick();
      }
      stepIdx++;
      rounds = 0;
      tick();
    }
    return { alloc: current, score: currentScore };
  }

  // Alternate attribute and talent blocks until neither improves. Both blocks see the other's
  // current state, so this converges on a joint fixpoint rather than optimizing each in
  // isolation against a stale partner.
  async function optimizeJointly(ctx, cfg, talentAlloc, attrAlloc, startScore, stepSizes, maxSweeps, pinnedAttrs = [], onFrac = null, iterations = SCREEN_ITERATIONS, maxRounds = MAX_ROUNDS_PER_BLOCK) {
    const { TALENTS, ATTRIBUTES, TALENT_BUDGET, ATTRIBUTE_BUDGET } = cfg;
    const noDeps = {};
    const noMin = {};
    let talents = { ...talentAlloc };
    let attrs = { ...attrAlloc };
    let score = startScore;

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      const before = score;
      // Each sweep runs two blocks, so a sweep owns 1/maxSweeps of the bar and each block half of
      // that. A sweep that exits early simply leaves the remainder unused -- the fraction is
      // monotone, which is what the bar needs; it is not a prediction of how many sweeps will run.
      const blockFrac = (half, f) => {
        if (!onFrac) return;
        onFrac(Math.min((sweep + (half + f) / 2) / maxSweeps, 1));
      };

      const attrResult = await optimizeBlock(
        ctx, ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, ATTRIBUTE_BUDGET,
        attrs, (a) => ({ talentAlloc: talents, attrAlloc: a }), score, stepSizes, pinnedAttrs,
        (f) => blockFrac(0, f), iterations, maxRounds,
      );
      attrs = attrResult.alloc;
      score = attrResult.score;

      const talentResult = await optimizeBlock(
        ctx, TALENTS, noDeps, noMin, TALENT_BUDGET,
        talents, (t) => ({ talentAlloc: t, attrAlloc: attrs }), score, stepSizes, [],
        (f) => blockFrac(1, f), iterations, maxRounds,
      );
      talents = talentResult.alloc;
      score = talentResult.score;

      if (score <= before) break;
    }
    return { talentAlloc: talents, attrAlloc: attrs, score };
  }

  // ---------------------------------------------------------------------------------------
  // Entry point.
  //
  // `scorer(pairs, iterations) -> Promise<number[]>` is the only I/O this file does. The
  // browser supplies a Web Worker pool; the Node benchmark supplies a direct WASM call. The
  // search itself is identical in both, so what the benchmark proves is what ships.
  // ---------------------------------------------------------------------------------------
  /** @param {OptimizerConfig} cfg @param {OptimizeOptions} [options] */
  async function optimize(cfg, { mode = 'loot', effort = DEFAULT_EFFORT, scorer, onProgress = () => {}, shouldCancel = () => false } = /** @type {any} */ ({})) {
    if (typeof scorer !== 'function') throw new Error('optimize() requires a scorer function');

    // Mode is validated HERE as well as in the worker, so an unknown mode fails before a search
    // runs rather than silently scoring as loot. Pins come from the mode definition, never from
    // a caller-supplied list -- there is one place that decides what a mode means.
    Objective.modeOrThrow(mode);
    const pinnedAttrs = Objective.pinnedAttrsFor(mode);

    // Validate the config up front rather than defaulting missing pieces away. A missing
    // dependency table would silently make every gated attribute look freely available and
    // produce builds the game would reject -- exactly the class of bug the old engine ended up
    // patching with a legality-repair pass. Fail loudly instead.
    for (const field of ['hunter', 'TALENTS', 'ATTRIBUTES', 'ATTRIBUTE_DEPENDENCIES', 'ATTRIBUTE_MIN_VALUE']) {
      if (cfg[field] === undefined || cfg[field] === null) throw new Error(`optimize(): cfg.${field} is required`);
    }
    for (const field of ['TALENT_BUDGET', 'ATTRIBUTE_BUDGET']) {
      if (!Number.isFinite(cfg[field]) || cfg[field] < 0) {
        throw new Error(`optimize(): cfg.${field} must be a non-negative number, got ${cfg[field]}`);
      }
    }

    const notes = [];
    let evals = 0;
    let cacheHits = 0;

    const { TALENTS, ATTRIBUTES, TALENT_BUDGET, ATTRIBUTE_BUDGET } = cfg;

    // Exact memoization, keyed by the allocation pair and fidelity.
    //
    // This is sound ONLY because the evaluator is deterministic: a fresh WASM instance per
    // call returns bit-identical output for identical arguments (verified directly). The old
    // engine assumed the opposite and averaged repeated samples of the same allocation, which
    // both cost 3x and ruled out caching entirely. Coordinate exchange regenerates the same
    // neighbours constantly and separate supports converge onto overlapping allocations, so
    // this removes a large fraction of the real work rather than a rounding error.
    const cache = new Map();
    const ctx = {
      shouldCancel,
      note: (m) => notes.push(m),
      // BOSS METADATA RIDES ON THE RESULT ARRAY, AND THE MEMO MUST CARRY IT TOO.
      //
      // The scorer returns `scores` with a parallel `scores.boss` -- kill rate, boss HP and
      // maxStage, which the evaluator produces anyway. This function rebuilds the array (it has
      // to, because of the memo), so `.boss` has to be rebuilt with it or it is silently dropped.
      //
      // IT WAS DROPPED, and the failure was invisible in exactly the way this repo keeps
      // recording: nothing threw, `(scores.boss || [])[j]` quietly yielded undefined, and the
      // archive's descriptor became `Math.floor(undefined / 25)` = NaN for every candidate. All
      // 4800 variations landed in ONE cell, so the quality-diversity search silently degraded into
      // the single-elite hill climb it was written to replace -- and still reported a plausible
      // build. The note "archive: 1 behaviour cells" is what exposed it; print the count.
      //
      // The memo therefore caches {score, boss} rather than a bare number, so a cache HIT carries
      // the same descriptor a miss would. Caching only the score would leave the descriptor
      // dependent on whether a candidate happened to be re-scored, which is not deterministic in
      // any useful sense.
      async score(pairs, iterations) {
        if (!pairs.length) { const e = []; e.boss = []; return e; }
        const out = new Array(pairs.length);
        const boss = new Array(pairs.length);
        const missIdx = [];
        const missPairs = [];
        const missKeys = [];
        for (let i = 0; i < pairs.length; i++) {
          const key = `${iterations}|${Space.signature(TALENTS, pairs[i].talentAlloc)}|${Space.signature(ATTRIBUTES, pairs[i].attrAlloc)}`;
          if (cache.has(key)) {
            const hit = cache.get(key);
            out[i] = hit.score; boss[i] = hit.boss; cacheHits++; continue;
          }
          missIdx.push(i);
          missPairs.push(pairs[i]);
          missKeys.push(key);
        }
        if (missPairs.length) {
          evals += missPairs.length;
          const scores = await scorer(missPairs, iterations);
          const meta = scores.boss || [];
          for (let j = 0; j < missIdx.length; j++) {
            cache.set(missKeys[j], { score: scores[j], boss: meta[j] });
            out[missIdx[j]] = scores[j];
            boss[missIdx[j]] = meta[j];
          }
        }
        out.boss = boss;
        return out;
      },
    };

    const deps = cfg.ATTRIBUTE_DEPENDENCIES;
    const minVal = cfg.ATTRIBUTE_MIN_VALUE;
    const noDeps = {};
    const noMin = {};

    // A budget can exceed what the available nodes are able to absorb -- most concretely for
    // talents, where the budget is the character level but the caps are fixed (Borge's visible
    // talents total 72 levels, so any level past that has nowhere left to put points, and more
    // so when an advanced talent is hidden because the build has none in it).
    //
    // This has to be handled explicitly rather than ignored: every allocation is required to
    // leave at most one point idle (see Space.MAX_IDLE_POINTS), so an unspendable budget would
    // reject EVERY candidate move and that block would silently never optimize at all. Clamp to
    // real capacity and record it, so the constraint is visible instead of looking like the
    // search simply found nothing.
    const capacityOf = (defs) => defs.reduce((sum, d) => sum + (d.maxLevel === Infinity ? Infinity : d.maxLevel * (d.cost || 1)), 0);
    const talentCapacity = capacityOf(TALENTS);
    const attrCapacity = capacityOf(ATTRIBUTES);
    const talentBudget = Math.min(TALENT_BUDGET, talentCapacity);
    const attrBudget = Math.min(ATTRIBUTE_BUDGET, attrCapacity);
    if (talentBudget < TALENT_BUDGET) {
      ctx.note(`talent budget clamped ${TALENT_BUDGET} -> ${talentBudget} (available talents cap out there)`);
    }
    if (attrBudget < ATTRIBUTE_BUDGET) {
      ctx.note(`attribute budget clamped ${ATTRIBUTE_BUDGET} -> ${attrBudget} (available attributes cap out there)`);
    }
    // From here on the clamped budgets are the ones the search uses, so pass them down rather
    // than letting any block read the raw cfg values again.
    const budgets = { ...cfg, TALENT_BUDGET: talentBudget, ATTRIBUTE_BUDGET: attrBudget };

    // The best score found SO FAR travels with every progress event. It is the one number that
    // tells the user something they cannot infer -- that the search is finding better builds rather
    // than merely still running -- and it costs nothing, since it is already computed.
    let bestSoFarScore = null;
    const noteBest = (v) => { if (typeof v === 'number' && Number.isFinite(v) && (bestSoFarScore === null || v > bestSoFarScore)) bestSoFarScore = v; };
    const report = (phase, done, total) => onProgress({ phase, done, total, evals, best: bestSoFarScore });

    try {
      // --- Stage 0: a talent allocation to screen attribute supports against. -------------
      // Supports must be compared against SOME talent build, and the choice is NOT cosmetic. An
      // earlier version used a canonical round-robin fill and called it "neutral", reasoning that
      // Stage 2 re-optimizes talents anyway so the seed "only affects screening order, never the
      // final answer". Screening order is exactly what decides which supports reach refinement, so
      // that reasoning was wrong, and measurably so.
      //
      // The failure it caused, on a real level-11 Ozzy build: the round-robin seed spreads 11
      // points over 8 talents, giving Call Me Lucky Loot 1 when the right answer is 10. Loot is
      // dominated by that talent, so under the flat seed every support scores low and the RANKING
      // INVERTS -- support {lotl,exo,timeless} screened at 45.0 against the true best's 38.5, while
      // with tuned talents those same two are worth 57.4 and 68.9. The good support was ranked out
      // of the refinement cut by a talent build nothing like the one it would be used with, and the
      // optimizer returned a build 16.7% worse than one it was allowed to make.
      //
      // So the seed is TUNED once, against a neutral attribute fill, before any support is scored.
      // It is one extra block optimization -- cheap next to screening every support -- and it makes
      // every later comparison a comparison between supports rather than between artefacts of the
      // seed. It introduces no randomness and no new heuristic: it is the same coordinate exchange
      // the rest of the search uses, run once up front.
      const flatTalents = Space.canonicalFill(TALENTS, noDeps, noMin, talentBudget, TALENTS.map((t) => t.id));
      if (!flatTalents) throw new Error('Could not build a legal starting talent allocation within budget');
      let seedTalents = flatTalents;

      // --- Stage 1: exhaustive support enumeration and screening. -------------------------
      const supports = Space.enumerateSupports(ATTRIBUTES, deps, attrBudget);
      report('enumerate', supports.length, supports.length);

      const screened = [];
      const BATCH = 64;
      const realizable = [];
      for (const s of supports) {
        let fill = Space.canonicalFill(ATTRIBUTES, deps, minVal, attrBudget, s.ids);
        // A pinned attribute must be funded in EVERY candidate, including the screening fills,
        // or the survey ranks supports by a shape the refinement stage will never keep.
        if (fill && pinnedAttrs.length) {
          fill = applyPins(ATTRIBUTES, deps, minVal, attrBudget, fill, pinnedAttrs);
          if (!pinsHeld(ATTRIBUTES, fill, pinnedAttrs)) fill = null; // support cannot host the pin
        }
        // A support can be dependency-legal and affordable yet still unrealizable: a tier
        // threshold it needs may be unreachable with this budget. Those are dropped here, and
        // the count is reported rather than hidden.
        if (fill) realizable.push({ support: s, attrAlloc: fill });
        // The same support, shaped to pay its tier gates (see gatePayingFill). Scored separately;
        // the support keeps whichever shape screens better.
        let gated = gatePayingFill(ATTRIBUTES, deps, minVal, attrBudget, s.ids);
        if (gated && pinnedAttrs.length) {
          gated = applyPins(ATTRIBUTES, deps, minVal, attrBudget, gated, pinnedAttrs);
          if (!pinsHeld(ATTRIBUTES, gated, pinnedAttrs)) gated = null;
        }
        if (gated && !Space.sameAlloc(ATTRIBUTES, gated, fill || {})) {
          realizable.push({ support: s, attrAlloc: gated });
        }
      }
      // Stage 2b needs the support MEMBERS behind a surveyed candidate, not just its fill, so it
      // can re-fill the same support a different way. Only the mask survives the survey.
      const allSupports = new Map(supports.map((s) => [s.mask, s]));
      ctx.note(`${supports.length} supports enumerated, ${realizable.length} realizable within budget`);

      for (let i = 0; i < realizable.length; i += BATCH) {
        if (shouldCancel()) throw new Cancelled();
        const chunk = realizable.slice(i, i + BATCH);
        const scores = await ctx.score(chunk.map((c) => ({ talentAlloc: seedTalents, attrAlloc: c.attrAlloc })), SCREEN_ITERATIONS);
        // Boss progress comes back with the score at no extra cost -- see the worker.
        chunk.forEach((c, j) => screened.push({ ...c, score: scores[j], boss: (scores.boss || [])[j] }));
        report('screen', Math.min(i + BATCH, realizable.length), realizable.length);
      }

      // Deterministic total order: score descending, then support mask ascending so equal
      // scores never depend on iteration or floating-point tie order.
      screened.sort((a, b) => (b.score - a.score) || (a.support.mask - b.support.mask));

      // One entry per SUPPORT -- its better shape. Without this a support could occupy two of the
      // few slots that go on to refinement, crowding out a genuinely different combination.
      const bestPerSupport = [];
      const seenMask = new Set();
      for (const c of screened) {
        if (seenMask.has(c.support.mask)) continue;
        seenMask.add(c.support.mask);
        bestPerSupport.push(c);
      }
      screened.length = 0;
      screened.push(...bestPerSupport);

      // BOSS CAPABILITY CANNOT BE SEEN AT SCREENING, so it is not looked for here.
      //
      // Screening scores canonical fills, and those never engage a boss at all: on all three
      // hunters, ZERO of the screened shapes had bossHpPercent below 100. Boss capability is
      // something refinement CREATES, not a property screening can detect -- which is why
      // selecting "boss-capable supports" from screening kept exactly none, on every hunter.


      // --- Stage 2a: THE COARSE SURVEY TIER IS GONE. -------------------------------------
      //
      // It used to tune a wide set of supports with a cheap pass, to RE-RANK them before the
      // expensive refinement picked winners. It was measured contributing NOTHING, four times:
      //
      //   Ozzy lvl62   survey 24 -> 11,809,928 in 166.8s   (15,163 evals)
      //                survey  8 -> 11,809,928 in  85.8s   ( 7,351 evals)
      //                survey  0 -> 11,809,928 in  66.1s   ( 3,885 evals)
      //   Borge lvl60  survey  0 -> 142,839,497 in 56.7s -- EXACTLY the best allocation known for
      //                that account, the one the full pipeline reproduces.
      //
      // Same answers, 2.5x the time. Refinement converges to the same place from any of the top
      // few screened candidates, so the survey's ranking work was discarded -- it was the single
      // largest cost in the search and it moved no number. What remains is one cheap tuning round
      // to give refinement a sane starting point, then refinement itself.
      //
      // The coverage lever is now REFINEMENT width, which is the stage that demonstrably decides
      // the answer.
      // `effort` is a key from EFFORT_LEVELS, or a spec object of the same shape. The object form
      // exists so a bench can ABLATE a stage without editing constants and rebuilding. The UI only
      // ever passes a key, so there is still exactly one table of shipped levels.
      const effortSpec = (effort && typeof effort === 'object') ? effort : EFFORT_LEVELS[effort];
      if (!effortSpec) throw new Error(`optimize(): unknown effort level "${effort}"`);

      // --- Stage 2a: ILLUMINATE THE BEHAVIOUR SPACE. --------------------------------------
      //
      // This replaces the rung/survey schedule, which ranked every candidate by score at
      // SCREEN_ITERATIONS and cut the rest permanently. See the archive header for why that
      // architecture failed on ozzy@62, borge@54 and every boss-limited build: a cheap biased
      // proxy was being used to make an irreversible decision.
      //
      // The archive makes no irreversible cut. Every behaviour cell keeps its own best build, so a
      // shape that is behind on loot today but different in KIND -- most importantly, one that has
      // started to engage a boss -- stays available as a parent instead of being ranked away.
      const maskOf = (alloc) => ATTRIBUTES.reduce(
        (m, d, k) => ((alloc[d.id] || 0) > 0 ? (m | (1 << k)) : m), 0,
      );
      const spaces = { TALENTS, ATTRIBUTES, talentBudget, attrBudget, deps, minVal };
      const elites = await illuminate(
        ctx, spaces,
        // Screening only varies attributes, so pair each row back up with the talent seed it was
        // actually measured against before it becomes an archive elite.
        screened.map((c) => ({
          talentAlloc: seedTalents, attrAlloc: c.attrAlloc, score: c.score, boss: c.boss,
        })),
        realizable,
        pinnedAttrs,
        effortSpec.archiveEvals || DEFAULT_ARCHIVE_EVALS,
        // Sweepable through the effort-object form, so the DAG-native fraction can be measured
        // without editing constants -- the same convention the ablation hooks already use.
        Number.isFinite(effortSpec.structuralShare) ? effortSpec.structuralShare : STRUCTURAL_SHARE,
        Number.isFinite(effortSpec.depthShare) ? effortSpec.depthShare : DEPTH_SHARE,
        (f) => report('survey', f * SURVEY_REPORT_SCALE, SURVEY_REPORT_SCALE),
      );
      const surveyed = elites.map((e) => ({ ...e, mask: maskOf(e.attrAlloc) }));

      // --- Stage 2b: full fixpoint refinement of the survivors. ---------------------------
      const finalists = [];
      // REFINEMENT WIDTH IS PART OF THE EFFORT CHOICE, not a fixed 3.
      //
      // Widening the SURVEY alone was measured insufficient: at Complete effort every support is
      // surveyed, including the one that matters, and a level-62 Ozzy still came back 4.03% below
      // the player's own build. Survey is a single-sweep probe, so a support whose value only
      // appears under real refinement surveys poorly and misses a top-3 cut -- and refinement is
      // demonstrably what finds it (handed that support at its flat fill, refinement reaches
      // 39,139,365, 8.4% above the player's build).
      const refineWidth = Math.min(effortSpec.refineSupports, surveyed.length);
      // SELECTING FROM THE ARCHIVE BY SCORE ALONE THROWS THE ARCHIVE AWAY, and it cost 66% on a
      // real level-62 Ozzy account.
      //
      // The archive filled 58 behaviour cells, so the boss-capable build WAS found -- and then the
      // refinement cut took the top 8 by score at SCREEN_ITERATIONS, where a build that has begun
      // to engage a boss but not yet kill it scores near the bottom. Its value only appears AFTER
      // refinement (that is the whole reason the archive keeps it), so ranking it before
      // refinement reintroduces the exact irreversible-cut failure the archive replaced, one stage
      // later. The result was kill 0 and 11.88M against the account's own 35.15M.
      //
      // So the cut is stratified by kill band: the best elite in each distinct band is taken first,
      // strongest band first, and only then are the remaining slots filled by score. Every
      // qualitatively different way of engaging a boss gets one refinement slot before any band
      // gets a second.
      const bandOf = (e) => String(e.cell).split(':')[0];
      const byBand = new Map();
      for (const e of surveyed) {
        const b = bandOf(e);
        if (!byBand.has(b) || byBand.get(b).score < e.score) byBand.set(b, e);
      }
      const stratified = [...byBand.values()].sort((a, b) => (Number(bandOf(b)) - Number(bandOf(a))) || (b.score - a.score));
      const toRefine = [];
      const takenSig = new Set();
      const take = (e) => {
        const sig = `${Space.signature(TALENTS, e.talentAlloc)}|${Space.signature(ATTRIBUTES, e.attrAlloc)}`;
        if (takenSig.has(sig) || toRefine.length >= refineWidth) return;
        takenSig.add(sig);
        toRefine.push(e);
      };
      for (const e of stratified) take(e);
      for (const e of surveyed) take(e);
      ctx.note(`refining ${toRefine.length} elites across ${new Set(toRefine.map(bandOf)).size} kill bands`);

      for (let i = 0; i < toRefine.length; i++) {
        if (shouldCancel()) throw new Cancelled();
        report('refine', i, toRefine.length + 1);
        const c = toRefine[i];
        finalists.push(await optimizeJointly(ctx, budgets, c.talentAlloc, c.attrAlloc, c.score, STEP_SIZES, 6,
          pinnedAttrs, (f) => report('refine', i + f, toRefine.length + 1), SCREEN_ITERATIONS,
          effortSpec.refineMaxRounds || MAX_ROUNDS_PER_BLOCK));
        noteBest(finalists[finalists.length - 1].score);

        // ENUMERATE THE TALENT SUPPORTS. This is what a threshold talent needs.
        //
        // Coordinate exchange cannot BUILD a talent that is worthless until it is deep. Power Of
        // Gaia is the standing example -- worthless at 3, decisive at 10 -- so a hill climb strips
        // it early and no sequence of 8/4/2/1 transfers rebuilds it alongside Finisher. Talents
        // have no dependencies and no thresholds, so every subset is a legal support and there are
        // at most 511 of them: FEWER than the attribute supports already enumerated exhaustively.
        //
        // MEASURED on knox#22 (level 31): the search settles on ll 10 / ghost 9 / finish 9 / calyp 3
        // and scores 6,924, while the real build runs pog 10 / finish 13 / ghost 6 / revival 2 and
        // scores 64,031. It is a JOINT peak -- neither half rescues the other:
        //     import talents + search attrs -> 3,741
        //     search talents + import attrs -> 6,455
        // so the talent structure has to be enumerated, not climbed to.
        //
        // Screened against a MEASURED attribute fill rather than a flat one, because the coupling
        // is one-way: a talent support that only wins at real attribute depth is invisible against
        // a canonical fill.
        //
        // THIS WAS DELETED ONCE, on an ablation that measured it inert on borge#16 and a level-60
        // Borge -- neither of which has a threshold talent to rebuild. knox#22 is the build it was
        // written for and it was not in the ablation. A stage is only dead if the cases it exists
        // for say so.
        const support = allSupports.get(c.mask);
        if (support) {
          const opened = Space.canonicalFill(ATTRIBUTES, deps, minVal, attrBudget, support.ids, true);
          if (opened) {
            let measuredAttrs = await greedyTopUp(
              ctx, ATTRIBUTES, deps, minVal, attrBudget, opened,
              (a) => ({ talentAlloc: seedTalents, attrAlloc: a }), support.ids,
            );
            if (pinnedAttrs.length) {
              measuredAttrs = applyPins(ATTRIBUTES, deps, minVal, attrBudget, measuredAttrs, pinnedAttrs);
            }
            if (Space.isLegal(ATTRIBUTES, deps, minVal, measuredAttrs, attrBudget)) {
              const best = await bestTalentSupportsFor(ctx, measuredAttrs, TALENTS, talentBudget, BATCH, shouldCancel);
              for (const t of best) {
                if (shouldCancel()) throw new Cancelled();
                finalists.push(await optimizeJointly(
                  ctx, budgets, t.fill, measuredAttrs, t.score, STEP_SIZES, 6, pinnedAttrs,
                ));
              }
            }
          }
        }
      }

      // Survey results that did not make the refinement cut still compete: they are complete,
      // legal allocations, just less thoroughly tuned, and keeping them costs nothing at Stage 3.
      finalists.push(...surveyed.filter((e) => toRefine.indexOf(e) === -1));

      // --- Stage 3: full-fidelity decision. -----------------------------------------------
      report('final', 0, 1);
      const unique = [];
      const seen = new Set();
      for (const f of finalists) {
        const sig = `${Space.signature(TALENTS, f.talentAlloc)}|${Space.signature(ATTRIBUTES, f.attrAlloc)}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        unique.push(f);
      }
      const finalScores = await ctx.score(unique.map((f) => ({ talentAlloc: f.talentAlloc, attrAlloc: f.attrAlloc })), FINAL_ITERATIONS);
      const ranked = unique
        .map((f, i) => ({ talentAlloc: f.talentAlloc, attrAlloc: f.attrAlloc, score: finalScores[i] }))
        .sort((a, b) => b.score - a.score);

      // POLISH THE WINNER AT THE FIDELITY IT IS JUDGED AT.
      //
      // Stage 3 ranks at FINAL_ITERATIONS, but survey and refine hill-climb at SCREEN_ITERATIONS,
      // and the two do not always agree about which of two builds is better. Where they disagree,
      // the search optimizes one metric and is then judged by another -- so it can converge on a
      // build that is genuinely worse and never know.
      //
      // MEASURED on a real level-60 Borge, on two allocations differing only in how a single
      // uncapped attribute is funded (the evaluator is deterministic, so these are exact, not
      // samples):
      //     iterations   ares22/htb1     ares16/htb4     screen prefers
      //        100       141,219,577     143,620,249     htb  -- INVERTED by 1.7%
      //        200       141,894,986     143,816,017     htb  -- INVERTED
      //        400       142,620,391     142,041,394     ares -- correct
      //       1000       142,839,497     142,383,349     ares -- correct
      // The true difference is 0.32% in favour of ares; the screen reports 1.7% in favour of htb.
      // The bias is systematic rather than scatter, which is why the search landed on htb on every
      // run instead of occasionally. This is the documented ~0.9% mean deviation and ~1.2% rank
      // inversion rate of a 100-iteration score, biting on a ridge finer than its resolution.
      //
      // Only the WINNER is polished, and only with small steps: this corrects the last few points,
      // it does not redo the descent. It is additive -- the polished build is compared against the
      // champion on the same FINAL_ITERATIONS measurement and only replaces it if it truly wins.
      if (ranked.length && !effortSpec.skipPolish) {
        const champion = ranked[0];
        const polished = await polishWinner(
          ctx, budgets, champion.talentAlloc, champion.attrAlloc, champion.score, pinnedAttrs,
          (f) => report('final', f, 1),
        );
        if (polished.score > champion.score) {
          ranked.unshift({
            talentAlloc: polished.talentAlloc, attrAlloc: polished.attrAlloc, score: polished.score,
          });
          ctx.note(`final polish improved the winner by ${(((polished.score / champion.score) - 1) * 100).toFixed(2)}%`);
        }
      }

      // Nothing illegal can reach here -- every allocation was produced by Space.transfer or
      // Space.canonicalFill, both of which refuse to return an illegal state. Assert it rather
      // than repair it: a violation means a real bug in this file, not a condition to paper
      // over at the last moment the way the old repairLegality pass did.
      for (const r of ranked) {
        if (!Space.isLegal(ATTRIBUTES, deps, minVal, r.attrAlloc, attrBudget)) {
          throw new Error(`Optimizer produced an illegal attribute allocation: ${JSON.stringify(r.attrAlloc)}`);
        }
        if (!Space.isLegal(TALENTS, noDeps, noMin, r.talentAlloc, talentBudget)) {
          throw new Error(`Optimizer produced an illegal talent allocation: ${JSON.stringify(r.talentAlloc)}`);
        }
      }

      // Unspent points must be UNSPENDABLE, not merely unspent.
      //
      // "The winner spends its whole budget" is the wrong assertion: a build can legitimately
      // finish with points left when every remaining node is maxed or still gated behind a
      // threshold it cannot reach, and throwing there would break Optimize on a valid build.
      // The defensible rule is that no eligible node could have taken another point -- if one
      // could, value was left on the table and that IS a defect. Measured on the reported case:
      // the 12 unspent talent points were worth 13.26%, and a single point into Lucky Loot alone
      // was worth 2.24%.
      //
      // This is a backstop, not the real guarantee. The real one is local optimality -- that no
      // single move improves the winner at full fidelity -- which cannot be checked here without
      // spending another few hundred evaluations per run, so it lives in
      // tools/bench/local-optimality.js instead.
      const winner = ranked[0];
      const spendable = (defs, deps, minVal, budget, alloc) => {
        const idle = budget - Space.costOf(defs, alloc);
        if (idle <= 0) return null;
        const node = defs.find((d) => (d.cost || 1) <= idle && Space.isEligible(d, defs, deps, minVal, alloc));
        return node ? { idle, node: node.id } : null;
      };
      const talentLeft = spendable(TALENTS, noDeps, noMin, talentBudget, winner.talentAlloc);
      if (talentLeft) {
        throw new Error(`Optimizer left ${talentLeft.idle} talent point(s) unspent while "${talentLeft.node}" could still take one: ${JSON.stringify(winner.talentAlloc)}`);
      }
      const attrLeft = spendable(ATTRIBUTES, deps, minVal, attrBudget, winner.attrAlloc);
      if (attrLeft) {
        throw new Error(`Optimizer left ${attrLeft.idle} attribute point(s) unspent while "${attrLeft.node}" could still take one: ${JSON.stringify(winner.attrAlloc)}`);
      }

      report('done', 1, 1);
      return {
        best: ranked[0],
        ranked,
        evals,
        cacheHits,
        notes,
        cancelled: false,
        supportsEnumerated: supports.length,
        supportsRealizable: realizable.length,
      };
    } catch (err) {
      if (err instanceof Cancelled) return { best: null, ranked: [], evals, cacheHits, notes, cancelled: true };
      throw err;
    }
  }

  const Optimizer = {
    optimize, SCREEN_ITERATIONS, FINAL_ITERATIONS,
    SURVEY_SUPPORTS, REFINE_SUPPORTS, STEP_SIZES, SURVEY_STEP_SIZES,
    EFFORT_LEVELS, DEFAULT_EFFORT,
    // Exposed so a bench can measure ONE support's tuning in isolation. The search's own stages
    // all call this same function -- there is no second implementation to drift from it.
    optimizeJointly,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Optimizer;
  else global.HunterOptimizer = Optimizer;
})(typeof window !== 'undefined' ? window : globalThis);
