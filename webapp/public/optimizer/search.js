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
  //
  // EVERY ARCHIVE DECISION IS MADE AT THIS FIDELITY, AND IT IS A SAMPLE, NOT A VALUE.
  //
  // Measured here: a 100-iteration score carries ~0.9% mean deviation from a 1000-iteration score
  // and ~1.2% pairwise rank inversions, and a 0.32% ridge has been measured ordering BACKWARDS by
  // 1.7% at this fidelity. MAP-Elites replaces a cell's occupant only with a HIGHER-SCORING one, so
  // under noise a cell accumulates whichever build got a LUCKY estimate rather than the best build
  // -- the winner's curse. The QD literature names this failure directly: "lucky solutions might be
  // kept in place of truly good-performing ones" (Uncertain Quality-Diversity, arXiv 2302.00463).
  //
  // Overridable per run ONLY so that hypothesis can be tested end to end -- if outcomes are driven
  // by lucky estimates, raising this must change them. Shipped value unchanged.
  const DEFAULT_SCREEN_ITERATIONS = 100;
  let SCREEN_ITERATIONS = DEFAULT_SCREEN_ITERATIONS;
  // Same concurrency guard as FINAL_ITERATIONS, for the same reason: two runs in one process
  // disagreeing about screening fidelity would silently corrupt each other's archives.
  let screenIterationsOwner = 0;
  function setScreenIterations(n) {
    if (!Number.isFinite(n) || n <= 0) throw new Error(`screenIterations must be a positive number, got ${n}`);
    if (screenIterationsOwner > 0 && n !== SCREEN_ITERATIONS) {
      throw new Error(`optimize(): another run in this process is using screenIterations `
        + `${SCREEN_ITERATIONS}; two concurrent runs cannot disagree about screening fidelity`);
    }
    SCREEN_ITERATIONS = n;
    screenIterationsOwner++;
  }
  function releaseScreenIterations() {
    screenIterationsOwner = Math.max(0, screenIterationsOwner - 1);
    if (screenIterationsOwner === 0) SCREEN_ITERATIONS = DEFAULT_SCREEN_ITERATIONS;
  }
  //
  // THE FIDELITY EVERY DECISION IS MADE AT, AND THE SINGLE LARGEST COST IN A RUN.
  //
  // Evaluation cost is PURE MARGINAL in iterations -- measured, fixed per-call overhead is 1.2ms at
  // level 12 and ~0 at level 60 despite a fresh WASM instance per call -- and roughly 87% of wall
  // clock is spent at this fidelity in refinement and polish. So this constant scales the whole
  // run linearly, and it is the only dial that does.
  //
  // Measured precision against a 16,000-iteration reference, on each fixture's own import:
  //      250 iters   mean |error| 0.19%   worst 0.39%    1x cost
  //      500 iters   mean |error| 0.18%   worst 0.50%    2x cost
  //     1000 iters   mean |error| 0.12%   worst 0.35%    4x cost   <- shipped
  //     2000 iters   mean |error| 0.07%   worst 0.13%    8x cost
  //
  // It is TEMPTING to read that as "250 is nearly as good for a quarter of the price". Do not ship
  // that on the table alone: polish DECIDES moves at this fidelity, and a cheap ranking has already
  // been measured mis-ordering a 0.32% ridge by 1.7% and costing 1.64M on ozzy@62. The error table
  // bounds what a COMPARISON can claim; it says nothing about how often a noisier ranking picks the
  // wrong move. That is an end-to-end question.
  //
  // Overridable per run ONLY so it can be A/B'd end to end. Shipped value unchanged.
  const DEFAULT_FINAL_ITERATIONS = 1000;
  let FINAL_ITERATIONS = DEFAULT_FINAL_ITERATIONS;
  // Concurrent optimize() calls in one process share this module, so two runs asking for different
  // fidelities would silently corrupt each other's decisions. Refuse rather than interleave.
  let finalIterationsOwner = 0;
  function setFinalIterations(n) {
    if (!Number.isFinite(n) || n <= 0) throw new Error(`finalIterations must be a positive number, got ${n}`);
    if (finalIterationsOwner > 0 && n !== FINAL_ITERATIONS) {
      throw new Error(`optimize(): another run in this process is using finalIterations `
        + `${FINAL_ITERATIONS}; two concurrent runs cannot disagree about decision fidelity`);
    }
    FINAL_ITERATIONS = n;
    finalIterationsOwner++;
  }
  function releaseFinalIterations() {
    finalIterationsOwner = Math.max(0, finalIterationsOwner - 1);
    if (finalIterationsOwner === 0) FINAL_ITERATIONS = DEFAULT_FINAL_ITERATIONS;
  }

  // A single WASM evaluation costs ~11ms on a mid-level build and rises with level (it scales with
  // how far the build progresses), so EVALUATION COUNT is the binding constraint on wall clock.
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
      // 9600, NOT 4800, AND THE REASON IS BOSS REACHABILITY RATHER THAN GENERAL THOROUGHNESS.
      // On the level-62 Ozzy seed that fails, archive-only:
      //     4800 evals   93 cells  1 kill band   best kill  0   47s   -> final -66.27%
      //     9600 evals  103 cells  3 kill bands  best kill  5   89s
      //    19200 evals  107 cells  4 kill bands  best kill 10  170s
      // At 4800 the archive never touches a boss cell and 0 of 98 finalists kill anything, so
      // refinement has nothing to develop -- it is reliable but needs a foothold (it takes kill 3
      // to kill 53). Doubling the budget produces one, and cells barely move, so this buys DEPTH
      // per lineage rather than coverage.
      label: 'Complete', archiveEvals: 9600, refineSupports: 8,
      help: 'A full archive pass, then refines the 8 strongest elites. Finds builds Fast '
        + 'misses, at several times the cost.',
    },
    // EXHAUSTIVE IS REMOVED, ON EVIDENCE FROM REAL USE RATHER THAN A PREFERENCE.
    //
    // It was `{ archiveEvals: 19200, refineSupports: 16, crossBlock: true }` -- double Complete's
    // archive and refinement with the cross-block pass forced on. The archive rungs that justified
    // it are real (ozzy@62: 9600 -> 103 cells / best kill 5 / 89s, 19200 -> 107 cells / kill 10 /
    // 170s), but cells barely moved and the DEPTH it bought never turned into a better answer.
    //
    // Reported by the project owner after testing with real accounts: it "truly is what it says and
    // takes an eternity and has yet to produce results better than what complete finds". That
    // matches every measurement here -- borge@73 and knox@30 returned byte-identical builds to
    // top-1 donors, and the ablation found refinement width buys nothing once the corpus climb has
    // converged. An option that costs several times more and has never won is not a choice, it is
    // a trap: it makes the tool look slow and teaches users to distrust the fast paths.
    //
    // A level nobody should pick should not be in the dropdown. The UI renders straight from this
    // table, so deleting the entry removes the option -- there is no second list to update. If a
    // future mechanism genuinely needs a bigger budget, add it back WITH the build it wins on.
  };
  //
  // THE SHIPPED DEFAULT, DECLARED EXACTLY ONCE -- and it used to be declared twice, with two
  // different values, which invalidated the entire bench suite without anyone noticing.
  //
  // `storeSchema.js` said 'complete' (what a user actually gets) while this said 'fast', and NINE
  // of thirteen optimize() call sites pass no effort at all and inherit whatever this says. So the
  // acceptance gate, search-quality-check, underspend-test, budget-monotonicity-check,
  // real-account-optimizer-check and smoke were all validating a configuration nobody runs.
  //
  // It was not a subtle difference. On knox@22 -- a build the gate reported as a QUALITY FAILURE at
  // -0.44% -- the shipped configuration scores +0.02%. The failure was an artefact of the gate
  // testing Fast.
  //
  // storeSchema now DERIVES its default from this constant rather than restating it, and
  // schema-test asserts they agree, so the two cannot drift apart again. A bench that wants the
  // cheap configuration must now ask for it BY NAME, where the choice is visible in the diff.
  const DEFAULT_EFFORT = 'complete';
  // EVERY KEY THE EFFORT SPEC MAY CARRY. Adding a flag to the search means adding it here, and
  // that is deliberate friction: it is the step that makes a typo throw instead of quietly
  // disabling the thing being measured.
  const EFFORT_SPEC_KEYS = new Set([
    'label', 'help',                                   // shipped-level metadata
    'archiveEvals', 'refineSupports',                  // the two budget dials
    // Adding a flag to the search means adding it here, and that friction is the point: an
    // unlisted key throws instead of silently disabling the thing being measured.
    'structuralShare',                                 // variation mix
    'selection', 'seeds', 'seed',                      // parent choice + determinism
    'breakpointSpending',                              // move flags
    // The cross-block pass in polishWinner. Declared so its COST can be A/B'd and so it can be
    // switched off if it ever breaches a runtime ceiling -- narrowing CROSS_BLOCK_WIDTH instead
    // would silently stop it working (the halves it pairs are individually downhill, so a narrow
    // slice excludes exactly what it looks for).
    'crossBlock',
    'feasibleInfeasible',                              // FI-MAP-Elites: two archives
    'archiveOnly',                                     // ablation: stop after illumination
    'finalIterations',                                 // decision fidelity; A/B only
    'screenIterations',                                // ARCHIVE fidelity; A/B only
    'ocbaPolish',                                      // OCBA allocation in the final polish
    'betAndRun',                                       // k independent archives, refine the best
    'bossDamageBands',                                 // split kill-0 cells by boss damage
    'skipPolish',                                      // ablation
  ]);

  // How many community builds are re-fitted in as extra finalists. Nearest levels first, since
  // the method interpolates: a donor 40 levels away carries a shape for a different budget.
  // Each costs ONE full-fidelity evaluation at Stage 3, so this is cheap next to the archive.
  const CORPUS_DONORS = 12;

  const DEFAULT_ARCHIVE_EVALS = EFFORT_LEVELS.fast.archiveEvals;

  // Illumination reports progress as a fraction of this: it has no natural denominator of its own,
  // since the archive's size is not known until it is built.
  const SURVEY_REPORT_SCALE = 100;

  // Transfer sizes, largest first. Large steps cross the flat regions that trap single-point
  // hill climbing; the size-1 pass at the end is what makes the fixpoint claim above true.
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
  // How many halves from EACH block the cross-block pass pairs. 32 was the smallest width that
  // found the ozzy@11 coupling under a STRATIFIED slice; top-K needed 100+ and a narrow top-K never
  // found it at all, because the halves involved are individually downhill. Cost is O(width^2)
  // full-fidelity evaluations, paid only where the block-wise polish has already converged.
  const CROSS_BLOCK_WIDTH = 32;
  // How far the nearest usable corpus donor may be before the cross-block pass is worth its cost.
  // 2 because refit demonstrably bridges one or two levels on its own -- generating a seed one level
  // up scored +0.00% over simply refitting the level below -- while five levels away collapses
  // (band=5 measured -41% on borge@73, -84% on knox@30).
  const CROSS_BLOCK_DONOR_DISTANCE = 2;
  // How many recombined donor pairs are admitted as finalists. 4 because the gain comes from the
  // BEST pairing, not from volume -- ozzy@70's winner was a single pair worth +42 points -- while
  // every admitted finalist costs a full-fidelity evaluation at Stage 3.
  const CORPUS_RECOMBINE = 4;



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
      // SPEND EVERYTHING SPENDABLE. This stopped at Space.MAX_IDLE_POINTS (1), inheriting a
      // tolerance that measurement shows is never needed: every talent costs 1 on all three
      // hunters, and each hunter has an uncapped, dependency-free, cost-1 attribute, so a point is
      // always spendable. The real and sufficient termination is the `!cands.length` break below --
      // "nothing eligible fits" -- which is a fact about the allocation rather than a constant.
      if (idle <= 0) break;
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

  // The band, in relative score, inside which a candidate is treated as "the decision is still
  // open" and gets a full-fidelity evaluation. Set from MEASURED error rather than taste: a
  // SCREEN_ITERATIONS score has been observed ordering a 0.32% ridge backwards by 1.7%, so the band
  // is several times that. Widening it costs evaluations; narrowing it risks the ridge failure the
  // rejected shortlist produced.
  const OCBA_UNCERTAIN_BAND = 0.05;
  // Floor on how many get verified, so a degenerate neighbourhood cannot collapse the decision.
  const OCBA_MIN_VERIFY = 8;

  async function polishWinner(ctx, cfg, talentAlloc, attrAlloc, startScore, pinnedAttrs, report, ocba, stats, crossBlock) {
    const { TALENTS, ATTRIBUTES, TALENT_BUDGET, ATTRIBUTE_BUDGET } = cfg;
    const deps = cfg.ATTRIBUTE_DEPENDENCIES;
    const minVal = cfg.ATTRIBUTE_MIN_VALUE;
    let curT = { ...talentAlloc };
    let curA = { ...attrAlloc };
    let curScore = startScore;

    let tier = 0;                       // index into POLISH_TIERS: how wide the amounts go
    for (let round = 0; round < POLISH_MAX_ROUNDS; round++) {
      if (ctx.shouldCancel()) throw new Cancelled();
      // The polish is a sequence of full-fidelity neighbourhood sweeps and is the second-largest
      // consumer after the archive. Checking only before the cross-block pass left it unbounded:
      // with the archive capped, borge@12 at exhaustive still ran 115s against a 20s cap. Each
      // round starts from a complete legal build, so stopping between rounds is safe.
      if (round > 0 && ctx.pastDeadline()) break;
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

      //
      // OCBA: SPEND FULL FIDELITY WHERE THE DECISION IS UNCERTAIN, NOT EVERYWHERE.
      //
      // With verifyWidth Infinity -- the shipped value -- the cheap pass above sorts the moves and
      // then EVERY move is scored at FINAL_ITERATIONS regardless, so the sort changes nothing and
      // the whole cheap pass is dead work. What remains is textbook EQUAL ALLOCATION: the same
      // budget to a move that is plainly terrible and to one sitting on a 0.32% ridge.
      //
      // Optimal Computing Budget Allocation (Chen) is the ranking-and-selection answer: give design
      // i replications proportional to (spread_i / gap_i)^2, so effort concentrates where the gap
      // is small relative to the noise. Reported to reach the same selection quality at a tenth of
      // the computational effort.
      //
      // THIS IS NOT THE TOP-K SHORTLIST THAT WAS MEASURED AND REJECTED HERE. That ranked at
      // SCREEN_ITERATIONS and DISCARDED everything below the cut -- and a 100-iteration score has
      // been measured ordering a 0.32% ridge BACKWARDS by 1.7%, which cost 1.64M on ozzy@62. The
      // literature names the difference exactly: top-K screening "lacks the principled reallocation
      // mechanism". Nothing is discarded here. A move outside the band keeps its cheap estimate and
      // can still win if it is genuinely ahead; it simply does not get re-sampled while it sits far
      // behind. The band is what makes that safe, so it is set from MEASURED error, not taste:
      // a 100-iteration score has been seen wrong by 1.7%, so the default band is several times
      // that rather than a tight cut.
      const band = OCBA_UNCERTAIN_BAND;
      let toVerify = order;
      if (ocba && order.length) {
        const leader = order[0].s;
        const floorScore = leader - Math.abs(leader) * band;
        const near = order.filter((o) => o.s >= floorScore);
        // Always verify at least a few, so a degenerate neighbourhood (every move scoring alike, or
        // a leader of 0) cannot collapse the decision onto a single cheap estimate.
        toVerify = near.length >= OCBA_MIN_VERIFY ? near : order.slice(0, OCBA_MIN_VERIFY);
        if (stats) { stats.ocbaConsidered += order.length; stats.ocbaVerified += toVerify.length; }
      }
      // ...decide expensively.
      const exact = await ctx.score(toVerify.map((o) => o.m), FINAL_ITERATIONS);
      let bestIdx = -1;
      for (let i = 0; i < exact.length; i++) {
        if (exact[i] > curScore && (bestIdx === -1 || exact[i] > exact[bestIdx])) bestIdx = i;
      }
      if (bestIdx === -1) {
        // Nothing improved at this width. Widen once and try again; if the widest tier is already
        // in play, the polish is genuinely converged.
        if (tier < POLISH_TIERS.length - 1) { tier += 1; continue; }
        // ---- CROSS-BLOCK PASS: change TALENTS AND ATTRIBUTES SIMULTANEOUSLY -------------------
        //
        // EVERY move above changes ONE block. The talent sweep holds attributes fixed and the
        // attribute sweep holds talents fixed, so a transition needing BOTH is unreachable by
        // construction -- at any width, from any start, with any budget.
        //
        // That is not theoretical. Measured on ozzy@11 with fixed allocations and no search
        // involved: the import's attributes score -7.77% against our talents, its talents -0.92%
        // against our attributes, and the two TOGETHER +2.07%. Both halves downhill, the pair
        // uphill. A block-wise climber cannot cross that, which is why the build sat at -2.02%
        // fully spent, legal and converged, only 8 point-differences from a better build.
        //
        // WIDENING WITHIN A BLOCK DOES NOT FIX IT -- measured, do not retry. Allowing K sources and
        // M-level raises returned a BYTE-IDENTICAL build on borge@42, knox@38 and ozzy@11 at 4.6x
        // to 9.7x the evaluations. The missing degree of freedom is ACROSS blocks, not within one.
        //
        // RANKING THE HALVES BY THEIR OWN SCORE IS ANTI-CORRELATED WITH FINDING THE PAIR. The
        // halves needed here are individually downhill, so a top-K slice excludes precisely what
        // this pass exists to find: top-K at K=8/16/32 returned +0.02% while a wide STRATIFIED
        // slice returned +2.18 points. Half the slice is the best moves, half is spread across the
        // whole distribution so the downhill tail is represented. Do not "optimise" this by
        // narrowing K.
        if (crossBlock === false) break;   // explicitly disabled for a cost A/B
        if (stats) stats.crossBlockRan = true;
        const jointMoves = await crossBlockMoves(ctx, cfg, curT, curA, curScore);
        if (!jointMoves.length) break;
        const jointExact = await ctx.score(jointMoves, FINAL_ITERATIONS);
        let jb = -1;
        for (let i = 0; i < jointExact.length; i++) {
          if (jointExact[i] > curScore && (jb === -1 || jointExact[i] > jointExact[jb])) jb = i;
        }
        if (jb === -1) break;               // converged jointly too
        curT = jointMoves[jb].talentAlloc;
        curA = jointMoves[jb].attrAlloc;
        curScore = jointExact[jb];
        if (stats) stats.crossBlockGains = (stats.crossBlockGains || 0) + 1;
        tier = 0;                           // structure changed: re-sweep from the narrowest width
        continue;
      }
      curT = toVerify[bestIdx].m.talentAlloc;
      curA = toVerify[bestIdx].m.attrAlloc;
      curScore = exact[bestIdx];
    }
    return { talentAlloc: curT, attrAlloc: curA, score: curScore };
  }

  /**
   * Candidate moves that change BOTH blocks at once, for the coupling the block-wise polish cannot
   * cross. Returns allocations; the caller decides, so this can never accept a regression.
   *
   * Cost is bounded by CROSS_BLOCK_WIDTH^2 and it runs ONLY where the polish has converged, so a
   * build that is not stuck pays nothing for it.
   */
  async function crossBlockMoves(ctx, cfg, curT, curA, curScore) {
    const { TALENTS, ATTRIBUTES, TALENT_BUDGET, ATTRIBUTE_BUDGET } = cfg;
    const deps = cfg.ATTRIBUTE_DEPENDENCIES;
    const minVal = cfg.ATTRIBUTE_MIN_VALUE;
    const capOf = (d) => (d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel);

    // One block's worth of single-source moves, including ONE SOURCE -> TWO DESTINATIONS. The split
    // form matters: ozzy@11's attribute half is `exo -3` spread across `lotl +1` and `exterm +1`,
    // and every other move in this file sends freed points to a single destination, so without it
    // the pair has nothing to pair WITH.
    const halfMoves = (defs, alloc, budget, isAttr) => {
      const out = [];
      for (const from of defs) {
        for (const chunk of [1, 2]) {
          if ((alloc[from.id] || 0) < chunk) continue;
          for (const to of defs) {
            if (to.id === from.id) continue;
            const next = { ...alloc };
            next[from.id] -= chunk;
            const room = Math.floor((budget - Space.costOf(defs, next)) / (to.cost || 1));
            const add = Math.min(room, capOf(to) - (next[to.id] || 0));
            if (add < 1) continue;
            next[to.id] = (next[to.id] || 0) + add;
            if (Space.costOf(defs, next) > budget) continue;
            if (!isAttr || Space.isLegal(defs, deps, minVal, next, budget)) out.push(next);
            if (add >= 2) {
              for (const to2 of defs) {
                if (to2.id === to.id || to2.id === from.id) continue;
                const split = { ...next };
                split[to.id] -= 1;
                const room2 = Math.floor((budget - Space.costOf(defs, split)) / (to2.cost || 1));
                const add2 = Math.min(room2, capOf(to2) - (split[to2.id] || 0));
                if (add2 < 1) continue;
                split[to2.id] = (split[to2.id] || 0) + add2;
                if (Space.costOf(defs, split) > budget) continue;
                if (!isAttr || Space.isLegal(defs, deps, minVal, split, budget)) out.push(split);
              }
            }
          }
        }
      }
      return out;
    };

    const aMoves = halfMoves(ATTRIBUTES, curA, ATTRIBUTE_BUDGET, true);
    const tMoves = halfMoves(TALENTS, curT, TALENT_BUDGET, false);
    if (!aMoves.length || !tMoves.length) return [];

    // Rank each block's halves at SCREEN fidelity -- this is ranking only, and every surviving PAIR
    // is re-scored at FINAL_ITERATIONS by the caller. That is the opposite of donor screening,
    // where a cheap mis-rank permanently removed a candidate.
    const aScores = await ctx.score(aMoves.map((a) => ({ talentAlloc: curT, attrAlloc: a })), SCREEN_ITERATIONS);
    const tScores = await ctx.score(tMoves.map((t) => ({ talentAlloc: t, attrAlloc: curA })), SCREEN_ITERATIONS);
    const stratify = (ranked, k) => {
      if (ranked.length <= k) return ranked;
      const head = ranked.slice(0, Math.ceil(k / 2));
      const rest = ranked.slice(head.length);
      const want = k - head.length;
      const step = rest.length / want;
      for (let i = 0; i < want; i++) head.push(rest[Math.floor(i * step)]);
      return head;
    };
    const topA = stratify(aMoves.map((a, i) => ({ v: a, s: aScores[i] })).sort((x, y) => y.s - x.s), CROSS_BLOCK_WIDTH);
    const topT = stratify(tMoves.map((t, i) => ({ v: t, s: tScores[i] })).sort((x, y) => y.s - x.s), CROSS_BLOCK_WIDTH);

    const out = [];
    for (const A of topA) {
      for (const T of topT) out.push({ talentAlloc: T.v, attrAlloc: A.v });
    }
    return out;
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

  //
  // THE SEED IS FIXED FOR REPRODUCIBILITY, AND MUST BE SWEEPABLE FOR MEASUREMENT. Those are
  // different requirements and conflating them cost a day of false conclusions.
  //
  // The search is deterministic: one seed, one traversal order, one answer. But it is only ONE
  // SAMPLE of a stochastic process, and the spread across seeds was measured at roughly SEVEN
  // PERCENTAGE POINTS on a level-62 Ozzy -- the identical configuration returned +15.34% and
  // +8.24% on two different streams. Every single-run A/B comparison narrower than that is noise,
  // and several were read as signal before this was noticed. The tell was there and was explained
  // away: cell counts that went 82 -> 94 -> 83 as a share increased monotonically are not
  // measuring the share.
  //
  // So a bench must be able to average over seeds. Anything comparing two configurations on ONE
  // seed each is not a comparison.
  const ARCHIVE_SEED = 0x9e3779b9;
  //
  // ONE STREAM BY DEFAULT, MEASURED. Merging several streams into the archive was tried as a fix
  // for the ~7-point seed variance and it does not work AT CONSTANT BUDGET -- splitting 2400
  // variations three ways gave each stream 800, and none explored deep enough:
  //     single 9e37   82 cells  2 bands  best kill 1   9.614M
  //     single 1234   80 cells  2 bands  best kill 1   8.919M
  //     single a5a5   82 cells  3 bands  best kill 7   9.562M
  //     MERGED x3     75 cells  2 bands  best kill 1   9.226M
  // The merge is worse than two of the three singles and has the FEWEST cells. Note what it cost:
  // seed a5a5 alone reached 3 kill bands and kill rate 7 -- the best boss reach measured -- and
  // truncating it at 800 variations threw that away.
  //
  // So PER-STREAM DEPTH beats stream diversity, and the variance is not free to remove: it would
  // take 3x the archive budget, not the same budget redistributed. Left as a known, measured
  // defect rather than papered over with a change that does not fix it. `seeds` stays available
  // for benches, which is what it is genuinely for.
  const ARCHIVE_SEEDS = [ARCHIVE_SEED];
  // Distinct streams for bet-and-run. Fixed and ordered, so a k=3 run is reproducible and a k=2 run
  // is a prefix of it rather than a different experiment.
  const BET_AND_RUN_SEEDS = [ARCHIVE_SEED, 0x1234, 0xa5a5a5a5, 0x2545f491, 0x9e3779b1];
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
  // BOSS DAMAGE IS A DESCRIPTOR AXIS BELOW A KILL, AND ITS ABSENCE THREW AWAY EVERY STEPPING
  // STONE TOWARD ONE.
  //
  // Kill rate is a step function: it reads 0 for a build that never scratched the boss and 0 for
  // one that left 5% of its HP. So the entire approach to a cliff occupies a SINGLE band, and the
  // archive keeps whichever member has the most loot/min -- which is the build that farms fastest
  // and hits the boss weakest. The candidate one step from the kill is discarded, every generation.
  //
  // Measured on borge@73, archive-only, 9600 variations. Kill-0 elites at the deepest stage band
  // (300-305) span 63.1%-93.8% boss HP remaining -- a 30.6-point spread of boss damage sharing one
  // kill band -- and NOTHING exists between 63% and a kill. The returned build leaves 67.44%; the
  // community reference leaves 3.43% and clears it 31.7% of the time, for 39.44% more loot.
  //
  // CONDITIONED ON STAGE, WHICH IS WHAT MAKES IT VALID. objective.js records the measurement
  // showing bossHpPercent is NOT a gradient on its own: it reads 0 both for a build that never
  // reached the wall and one already past it. The same measurement found it discriminating once
  // depth is held fixed ("where stage ties at a wall the HP reading is precisely what
  // discriminates, 74.0 vs 47.0"). The archive key already carries a stage band, so this axis is
  // only ever compared within one wall -- exactly the conditioning that measurement licenses.
  // The probe above confirms it directly: bands 205-300 all read HP 0 (never engaged) and are
  // separated from band 300+ by stage, not by this axis.
  //
  // FEASIBLE-INFEASIBLE ARCHIVES (FI-MAP-Elites -- Khalifa et al.'s Constrained MAP-Elites, which
  // is MAP-Elites combined with the FI-2Pop GA of Kimbrough et al.).
  //
  // WHY THIS AND NOT THE THREE THINGS ALREADY TRIED. The measured fact on borge@73 is precise: the
  // archive held 488 finalists of which 348 KILL a boss, and the search still returned a
  // non-killer. The killers exist -- they kill SHALLOWER bosses and farm less. What does not exist
  // anywhere is a build that is DEEP AND KILLING AT ONCE. That is a conjunction, and each half is
  // easy alone while everything between is worse than both halves.
  //
  // Every previous attempt kept the boss-progressing builds inside a loot-driven population:
  //   - an extra descriptor axis (bossDamageBands) only split cells; -39.44% -> -39.48%
  //   - a per-cell Pareto front (MOME) retained them but still bred them under loot pressure and
  //     under curiosity selection, where they were a small minority; -39.44% -> -39.44%, identical
  //     build, from an archive whose coverage moved 477 -> 329.
  //
  // FI-2Pop's insight is the one thing none of those did: the infeasible population "is not
  // evaluated by the objective function", so it "is free to explore boundary regions, where the
  // optimum is likely to be found". A deep non-killing build here is bred PURELY to remove boss HP,
  // with no loot pressure to drag it back toward farming -- and selection ALTERNATES between the
  // archives, so it gets about half the variation budget instead of a sliver.
  //
  // Offspring route themselves: a child that kills is scored on the objective and lands in the
  // feasible archive; one that does not is scored on violation and lands in the infeasible one.
  // Crossing the constraint IS the migration, which is exactly the event the search has been
  // failing to produce.
  //
  // FEASIBLE means the build kills the boss it reaches. VIOLATION is how much boss HP it left --
  // but only for a run that ended AT a wall. bossHpPercent reads 0 both for a build that never
  // reached one and for one already past it (objective.js records the measurement), so a build
  // that died between bosses is credited NO progress rather than perfect progress. Getting this
  // wrong once already made an unreachable regime score feasible.
  // Fraction of the variation budget spent UNSPLIT before deciding whether to engage FI.
  //
  // MEASURED across THREE seeds, FI off, 9600 variations -- first variation at which anything kills:
  //     knox@31   336 (3.5%)   1392 (14.5%)   528 (5.5%)   -- ALWAYS arrives
  //     knox@30   NEVER        NEVER          NEVER        -- never arrives, on any seed
  // So the separation is not a knife edge: 14.5% against "not within the whole budget".
  //
  // 0.30 is ~2x the worst observed arrival, with ~7x headroom on the other side. It is a chosen
  // constant and it is chosen from a measured DISTRIBUTION, which is the part that matters.
  //
  // AN EARLIER VALUE OF 0.10 WAS DERIVED FROM A SINGLE SEED (336) AND COST 18%. On seed 1234
  // knox@31 arrives at 14.5%, so the warmup ended first, FI engaged on a build that did not need
  // it, and the result was -18.22% -- WORSE than the -2.84% the gate existed to remove. One seed is
  // one sample applies to the measurement a threshold is read from, not only to the A/B arms.
  const FI_WARMUP_FRACTION = 0.30;
  const FEASIBLE_KILL_RATE = 0;
  function isFeasibleBuild(meta) {
    return (meta.kill || 0) > FEASIBLE_KILL_RATE;
  }
  function bossViolationOf(meta) {
    const stage = Number.isFinite(meta.maxStage) ? meta.maxStage : 0;
    const atWall = Math.abs(stage / BOSS_STAGE_INTERVAL - Math.round(stage / BOSS_STAGE_INTERVAL)) < 1e-6
      && stage >= BOSS_STAGE_INTERVAL;
    if (!atWall) return 100;
    const hp = Number.isFinite(meta.hp) ? meta.hp : 100;
    return Math.max(0, Math.min(100, hp));
  }

  // Width of a boss-damage band, and the cap on how many. Only applies below a kill, where
  // KILL_BANDS provides no gradient at all.
  const BOSS_DAMAGE_BAND = 10;
  const BOSS_DAMAGE_BANDS_MAX = 9;
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
  //
  // FRONTIER PUSHING ON STAGE BOUNDARIES -- descriptor-space navigation, not a boss objective.
  //
  // The whole Ozzy failure reduces to one binary event: does illumination land a single build in a
  // kill > 0 cell. Archive-only at 4800 variations, the correlation is perfect --
  //     seed a5a5   93 cells   1 kill band   best kill 0   -> final -66.27%
  //     seed 1234   95 cells   3 kill bands  best kill 7   -> final  +4.77%
  // and the foothold needed is tiny, because an archive whose best kills at 7 refines into a build
  // killing at 58. Refinement is reliable; it was being fed by luck.
  //
  // Bosses stand every 100 stages, so an elite at maxStage 99 is ONE variation away from engaging
  // one while an elite at maxStage 20 is nowhere near. That distance is computed purely from the
  // maxStage DESCRIPTOR -- nothing here reads a kill rate, boss HP, or any boss-derived score, so
  // it cannot collapse the search into the deceptive basin the way optimising boss performance
  // directly would. It preferentially develops the elites ADJACENT TO AN UNOCCUPIED CELL, which is
  // ordinary MAP-Elites frontier pushing.
  //
  // It is also why this is one fix rather than two. On Knox there is no separate boss basin to
  // find at all: Omen is the only attribute that touches boss performance (reduced effect against
  // bosses), so a Knox boss build IS a push build with overflow into Omen. Knox's archive is
  // correspondingly flat -- 1 kill band and best kill 0 on every seed, 2.5% spread. For Ozzy,
  // pushing the stage frontier is how a boss cell gets reached; for Knox, reaching a boss cell
  // just IS pushing stage depth. Same lever.
  // Bosses stand every N stages. DECLARED ONCE, in objective.js, which already owns boss-stage
  // arithmetic (bossTargetFor, isBossLimited, describeRun). This file restated it as a literal 100
  // when the frontier emitter was added -- the exact duplication that let the shipped optimize
  // effort say 'fast' here and 'complete' in storeSchema. Two copies of one fact is how the copies
  // get to disagree, and nothing notices until a measurement is already wrong.
  const BOSS_STAGE_INTERVAL = Objective.BOSS_INTERVAL;
  //
  // OFF, ON MEASUREMENT -- and it falsified the claim that motivated it.
  //
  // The theory was that the run's whole outcome turns on whether illumination lands ONE build in a
  // kill > 0 cell, so preferentially developing elites near a stage boundary would make that
  // reliable. It does move the archive: seed a5a5, which had never reached a boss cell under any
  // configuration, went to 2 kill bands / best kill 1, and champion scores rose across all three
  // seeds (10.47M / 10.56M / 9.61M against ~9.4M).
  //
  // End-to-end it is a REGRESSION. Full pipeline, level-62 Ozzy:
  //     seed 9e37   curiosity +15.34%   -> curiosity + frontier  -66.27%
  //     seed a5a5   curiosity -66.27%   -> curiosity + frontier  -66.27%
  // It broke a seed that worked, and did not rescue the one that did not.
  //
  // WHICH ALSO CORRECTS THE DIAGNOSIS. a5a5's archive DID reach a boss cell (kill 1) and the run
  // still returned the same local optimum, while the seed that succeeds reaches kill 7. So
  // touching a boss cell is NECESSARY BUT NOT SUFFICIENT -- there is a foothold THRESHOLD somewhere
  // between kill 1 and kill 7, and "any kill > 0 cell means success" was generalised from two data
  // points. Chasing more boss-adjacent cells is not the same as chasing a DEEPER one.
  //
  // Kept at 0 rather than deleted: the mechanism works on its own terms (it reaches cells nothing
  // else reached) and may matter once the threshold question is understood.
  const DEFAULT_SELECTION = 'curiosity';
  const CURIOSITY_REWARD = 1;
  const CURIOSITY_PENALTY = 0.5;
  const CURIOSITY_INITIAL = 2;
  const STRUCTURAL_SHARE = 0.35;
  // What fraction of the attribute point-moves are DAG-native depth moves rather than flat
  // transfers. Sweepable through the effort object, same as the structural share.
  //
  // DEFAULT ZERO, ON MEASUREMENT. Four seeds per arm on a level-62 Ozzy, archive-only so the
  // comparison is not swamped by refinement:
  //     ds 0.0   81.8 cells   archive best 9.384M   (flat transfers only)
  //     ds 0.3   87.8 cells                9.271M
  //     ds 0.6   92.5 cells                9.170M
  //     ds 1.0   84.7 cells                9.015M   (DAG depth moves only)
  // Coverage rises with the share and that survives averaging. Champion quality does not -- it
  // declines, and the fully DAG-native arm is the worst of the four. The differences sit inside
  // the 0.7-1.65M seed spread, so this is "no measured benefit", NOT "measurably worse".
  //
  // The hypothesis this refutes is a specific one worth recording: that flat transfers become
  // actively harmful once the structure is right, so they should be REPLACED. The ds 1.0 arm is
  // that replacement, and it did not win. The operator is kept because it is proven non-stranding
  // (81.7% acceptance against 28%, zero repairs by construction) and may matter under a different
  // refinement or fidelity regime -- but it ships off until something measures it winning.
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

  function cellOf(meta, defs, attrAlloc, bossDamageBands) {
    // A missing descriptor is a PLUMBING FAULT, not a niche. Returning a placeholder cell for it
    // makes every candidate a neighbour of every other and turns the archive into a hill climb
    // that still returns a plausible-looking build -- the exact failure this replaced. Throw.
    if (!meta || !Number.isFinite(meta.kill) || !Number.isFinite(meta.maxStage)) {
      throw new Error('cellOf: scorer returned no boss metadata; the archive cannot form cells');
    }
    let killBand = 0;
    for (let i = 0; i < KILL_BANDS.length; i++) if (meta.kill >= KILL_BANDS[i]) killBand = i;
    //
    // BOSS DAMAGE AS A DESCRIPTOR AXIS, RESTORED -- AND THE REASON IT WAS DELETED WAS A TESTING
    // ERROR, NOT A RESULT.
    //
    // It was measured ONCE, on borge@73, where it did nothing (-39.44% -> -39.48%, cells 477 -> 455)
    // and was deleted as measured-dead. borge@73's archive fills 477 CELLS: its descriptor already
    // discriminates, so an extra axis can only fragment what is working.
    //
    // knox@30 is the opposite build and the one this axis is actually for. Its archive fills SIX
    // cells, because every build lands in kill band 0 at stage ~100, leaving concentration as the
    // only varying term. 9,600 variations feed a 6-slot hill climber. There, splitting kill-0 by
    // how much boss HP a build removed is the difference between a descriptor that discriminates
    // and one that does not -- and it was never tested there.
    //
    // The conditioning is what makes it legitimate, and objective.js already measured it:
    // bossHpPercent is meaningless alone (0 both for never-reached and already-past) but IS
    // discriminating once depth is held fixed, which the stage band in this key does.
    let damageBand = 0;
    if (bossDamageBands && killBand === 0) {
      if (!Number.isFinite(meta.hp)) {
        throw new Error('cellOf: boss damage banding is on but the scorer returned no bossHpPercent');
      }
      damageBand = Math.max(0, Math.min(BOSS_DAMAGE_BANDS_MAX,
        Math.floor((100 - meta.hp) / BOSS_DAMAGE_BAND)));
    }
    return killBand + ':' + damageBand + ':' + Math.floor(meta.maxStage / ARCHIVE_STAGE_BAND)
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
  //
  // UNCAPPED NODES ARE BREAK-POINT GATES, NOT CONTINUOUS SINKS.
  //
  // A capped node stops accepting points; an uncapped one never does. So a move generator that
  // proposes targets uniformly keeps feeding the uncapped node, because it is always legal, always
  // available, and always looks like progress. Measured: a transfer INTO an uncapped node is
  // accepted 98-100% of the time against 21-59% for a capped one, a 60.3-point gap on every build
  // and every hunter.
  //
  // The reason the optimizer WANTS to feed them is real, not a bug: capped nodes sit behind spend
  // thresholds, and an uncapped cost-1 node is the cheapest way to buy that prereq spend. Ozzy's
  // structure, derived from its own config rather than assumed:
  //
  //     lotl (uncapped, cost 1)  level 1 unlocks exo, ibu
  //     exo  (uncapped, cost 1)  level 1 unlocks scorp, timeless
  //     tier thresholds 90 / 150 / 180 points of tier-0 spend
  //        90 unlocks deal, medusa, dance   150 unlocks scarab, cat   180 unlocks sisters
  //
  // Between those points the marginal value of another point is whatever the evaluator says, and
  // nothing structural changes -- so overshooting buys nothing while starving the nodes the spend
  // was meant to unlock. The failing ozzy@54 build holds 54.3% of its budget in lotl against the
  // reference's 39.5%, with five capped nodes left at 0 that the reference funds.
  //
  // THE BREAKPOINTS ARE COMPUTED, NEVER TABULATED. They fall out of the dependency edges and the
  // minValue tiers already in the config, so they stay correct for any hunter and any future
  // balance change. A hard-coded list would be a second source of truth for something the game
  // already states.
  function nextBreakpointFor(defs, minVal, alloc, node) {
    const cost = node.cost || 1;
    const current = alloc[node.id] || 0;
    // Level 1 is a breakpoint whenever anything depends on this node: it is the difference between
    // a subtree being reachable and not.
    if (current === 0) return 1;
    // Otherwise the next structural event is a spend threshold this node's tier can contribute to.
    const myTier = minVal[node.id] || 0;
    const spendBelow = defs.reduce((sum, d) => (
      (minVal[d.id] || 0) <= myTier ? sum + (alloc[d.id] || 0) * (d.cost || 1) : sum
    ), 0);
    const higher = [...new Set(defs.map((d) => minVal[d.id] || 0))]
      .filter((t) => t > myTier)
      .sort((a, b) => a - b);
    for (const t of higher) {
      if (spendBelow < t) return current + Math.ceil((t - spendBelow) / cost);
    }
    // Past the last threshold nothing structural remains, so there is no breakpoint to stop at and
    // the objective alone decides -- which is the case where the node genuinely is the best buy.
    return null;
  }

  function randomTransfer(defs, deps, minVal, budget, alloc, rng, pinnedIds, stats, breakpointSpending) {
    const held = defs.filter((d) => (alloc[d.id] || 0) > 0 && pinnedIds.indexOf(d.id) === -1);
    if (!held.length) return null;
    for (let tries = 0; tries < 8; tries++) {
      const from = held[Math.floor(rng() * held.length)];
      const to = defs[Math.floor(rng() * defs.length)];
      let amount = 1 + Math.floor(rng() * Math.min(12, alloc[from.id] || 1));
      // THE UNCAPPED-SINK INTERVENTION, off by default, measured before it may ship.
      //
      // MEASURED BIAS: over 20,000 proposed transfers per build across all 12 gate fixtures, a
      // transfer INTO an uncapped node is accepted 98-100% of the time and into a capped node
      // 21-59% -- a mean gap of 60.3 points. An uncapped node can never reject for want of
      // headroom, so it is a sink the generator cannot help filling.
      //
      // MEASURED CONSEQUENCE: the two builds the shipped configuration loses on both over-fund the
      // uncapped root by ~15 points of budget against the reference (ozzy@54 39.5% -> 54.3%,
      // borge@73 19.6% -> 35.2%), while the ten it wins on average -5.4 points.
      //
      // THE INTERVENTION is not a weighting constant -- it removes the CAUSE of the asymmetry.
      // Most capped rejections are "the amount exceeds this target's remaining headroom", which is
      // information already in the defs, so clamping the proposed amount to what the target can
      // actually receive makes a capped target answer the same question an uncapped one does:
      // "is this move good?", not "did the dice pick a number that happens to fit?".
      // Break-point spending: never overshoot the next structural event in an uncapped node.
      if (breakpointSpending && !Number.isFinite(to.maxLevel)) {
        const bp = nextBreakpointFor(defs, minVal, alloc, to);
        if (bp !== null) {
          const room = bp - (alloc[to.id] || 0);
          if (room <= 0) { if (stats) { stats.rejected++; stats.breakpointBlocked++; } continue; }
          if (amount > room) { amount = room; if (stats) stats.breakpointClamped++; }
        }
      }
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

  /**
   * Illuminate the behaviour space and return the elites, best score first.
   *
   * Seeded from the enumerated supports rather than from random points: the enumeration is exact
   * and already paid for, so the archive starts with real structural coverage instead of noise.
   */
  async function illuminate(ctx, spaces, seeds, supports, pinnedAttrs, evalBudget, structuralShare, seedList, selection, breakpointSpending, feasibleInfeasible, bossDamageBands, report) {
    const stats = { rejected: 0, accepted: 0, repaired: 0, nodesCleared: 0, structural: 0,
      breakpointClamped: 0, breakpointBlocked: 0 };
    const { TALENTS, ATTRIBUTES, talentBudget, attrBudget, deps, minVal } = spaces;
    //
    // ONE ARCHIVE, SEVERAL STREAMS -- because a single stream is one sample and the spread between
    // samples was measured at ~7 percentage points on a real account. That is a user-visible
    // defect: the same account, optimized twice with identical settings, returned builds 7% apart.
    //
    // Merging is what makes this more than a retry. Each stream writes into the SAME archive, so a
    // cell keeps the best build found by ANY of them, and a stream that stumbles into the
    // boss-engaging cell hands that stepping stone to every later stream as a parent. Running the
    // whole search three times and taking the maximum would not do that -- the streams would never
    // see each other's discoveries.
    //
    // It is affordable for the reason the archive-only bench established: illumination is ~10s of
    // a ~130s run, so three streams cost about 20 extra seconds against a refinement stage that
    // dominates either way.
    const archive = new Map();

    //
    // ONE ELITE PER CELL IS WHY THE STEPPING STONE IS THROWN AWAY, AND THE FIX IS A PER-CELL PARETO
    // FRONT (MOME -- Pierrot, Richard, Beguir & Cully 2022, arXiv:2202.03057).
    //
    // The failure has a name in the literature: DETACHMENT, "algorithms forgetting how to reach
    // previously visited states" -- one of the two modes Go-Explore was built to fix (Ecoffet et
    // al., "First return, then explore", Nature 2021). Ours happens INSIDE a cell: a build that
    // removed 37% of the boss and one that never scratched it share a cell, the archive keeps
    // whichever has more loot/min today, and the lineage that was making progress is forgotten.
    //
    // MOME keeps a Pareto front per cell instead: a new solution enters "if it belongs to the
    // Pareto Front within the cell and replaces any solutions that it dominates". Note what this
    // does NOT do -- it does not add cells. That distinction is the whole point, because adding a
    // descriptor axis was measured here and FAILED: bossDamageBands moved cells 477 -> 455 and
    // loot -39.44% -> -39.48%, because the same variation budget spread over more niches gives
    // each lineage less depth. More per cell, not more cells.
    //
    // A "SUPERSET, SO IT CANNOT REGRESS" ARGUMENT WAS WRITTEN HERE AND IS FALSE. MEASURED WITHIN
    // MINUTES OF WRITING IT. The reasoning was: the maximum-loot point is always on the Pareto
    // front, so the 'loot' role retains exactly what the single-elite archive retained, therefore
    // the archive can only grow. The retention RULE is indeed a superset. The RUN is not --
    // borge@35, 900 variations, same seed:
    //     paretoDepth 1   cells 201   entries 201
    //     paretoDepth 2   cells 194   entries 228   <- 34 extra members, 7 FEWER cells
    // Extra elites change what parent selection sees, so the trajectory diverges from the first
    // divergent draw onward and the two runs explore different regions. A retention superset is
    // only a population superset when the trajectory is identical, and adding to the population is
    // exactly what makes it not be.
    // So this carries the SAME depth-dilution risk as the descriptor axis, just milder (3.5%
    // coverage lost against 4.6%). It has to be judged end to end on returned loot, like every
    // other change here -- there is no structural free lunch.
    //
    // K = 2 needs no tuning parameter: with two objectives the front's two EXTREMES are the
    // max-loot and max-damage members, and for K = 2 the extremes ARE the front. The damage role
    // is kept only in kill-0 cells, because below a kill is the only place bossHpPercent is a
    // gradient at all -- objective.js records the measurement showing it reads 0 both for a build
    // that never reached the wall and one already past it. Above a kill, KILL_BANDS is already a
    // fine-grained gradient and a second member would duplicate the first.
    //
    // Within a cell this implements Deb's feasibility rules (Deb 2000): every member of a cell is
    // on the same side of the constraint (cells are keyed on kill band), so rule 2 never fires;
    // rule 1 (both feasible -> better objective) is the loot role, and rule 3 (both infeasible ->
    // smaller constraint violation) is the damage role, with bossHpPercent as the violation. It is
    // parameter-free, which is why it is usable here at all.
    //
    // THE LOOT OBJECTIVE IS UNTOUCHED. This changes what the archive RETAINS, not what anything is
    // scored on: refinement still ranks by the caller's objective and Stage 3 still decides on pure
    // loot. A build is never preferred for hurting a boss; it is merely not forgotten for it.
    const put = (key, pair, score, meta, better, feasible) => {
      const held = archive.get(key);
      const entry = {
        feasible: feasible !== false,
        violation: bossViolationOf(meta),
        talentAlloc: pair.talentAlloc,
        attrAlloc: pair.attrAlloc,
        score,
        kill: meta.kill,
        hp: Number.isFinite(meta.hp) ? meta.hp : 100,
        maxStage: meta.maxStage,
        // A brand-new elite starts curious, so an unexplored niche is developed before it has
        // had to prove anything -- which is the only way a boss cell that is reached once gets
        // the follow-up effort to become a real build.
        curiosity: CURIOSITY_INITIAL,
      };
      if (!held || better(entry, held)) { archive.set(key, entry); return true; }
      return false;
    };
    // Deterministic total orders. A tie broken by chance would make the archive depend on
    // evaluation order, and this search's whole contract is that one seed gives one answer.
    const betterLoot = (a, b) => a.score > b.score;
    // Infeasible survival: closest to killing wins. Ties break on the objective so the rule is
    // a total order and the archive cannot depend on evaluation order.
    const betterViolation = (a, b) => (a.violation !== b.violation ? a.violation < b.violation : a.score > b.score);

    //
    // FI ENGAGES ONLY WHERE ITS PREMISE HOLDS: A HARD-TO-REACH FEASIBLE REGION.
    //
    // FI-2Pop exists for problems where feasible solutions are RARE, and its whole value is walking
    // the infeasible population to the constraint boundary. Where feasible solutions are already
    // abundant there is no boundary to find, and the mechanism can only perturb a search that was
    // already succeeding.
    //
    // MEASURED, and three separate rule variants failed to remove it -- fixed 50/50 alternation,
    // pfeas-weighted selection, and dual retention:
    //     knox@31  baseline +1.51% / +1.17% / +1.51%   (stable: 0.34 points across seeds)
    //     knox@31  FI on    -2.84% / +1.17% / +1.51%   (one seed -4.29%, two exactly neutral)
    // The regression is not the ~7-point variance measured on the bimodal ozzy build; knox@31's own
    // baseline barely moves. FI was adding trajectory variance to a build that had none.
    //
    // The discriminator is in the archive itself, not in the hunter or the level:
    //     knox@30  nothing kills   6 cells, reaches-cannot-kill  -> FI creates the killers, +82 pts
    //     knox@31  killers already dominate  143 of 156 cells    -> FI can only perturb
    // So the split is enabled only while NO seed build kills anything. Once the search can already
    // reach the feasible region on its own, the premise is gone and so is the split.
    // THE PREMISE IS TESTED AT RUNTIME, NOT AGAINST THE SEEDS. `seedHasKiller` alone could never
    // fire on knox@31 -- its flat canonical fills do not kill, while its ILLUMINATED population
    // kills abundantly -- so the build the gate was written for was the one build it never saw.
    //
    // MEASURED, `firstFeasibleAtVariation` with the split OFF, 9600 variations, seed 9e3779b9:
    //     knox@30    NEVER   (and three independent full runs agree: no killer, ever)
    //     knox@31      336   3.5% of budget
    //     borge@42      48   0.5%
    //     borge@32       0   already in the seeds
    //     knox@35b       0   already in the seeds
    // knox@30 is the ONLY build that cannot reach the feasible region on its own, which is exactly
    // the condition FI-2Pop exists for. So: illuminate UNSPLIT for a warmup slice, and engage the
    // split only if nothing has killed anything by then.
    //
    // WHY NOT THE CONSTANT-FREE RULE ("stop splitting once any killer appears"). With the split ON,
    // knox@30's first killer arrives at variation 96 -- the split MANUFACTURED it. That rule would
    // disengage immediately and throw away the win it exists to protect. The decision has to be made
    // from UNSPLIT evidence, which is what costs one checkpoint constant.
    //
    // THIS IS A TRADE, NOT A FREE WIN, and pretending otherwise would be the kind of tidy story this
    // file keeps having to correct. borge@42 reaches feasibility at 48 and would therefore decline
    // the split -- yet FI HELPED it (-1.08% -> -0.68% on 2 of 3 seeds, violation 28-31 -> 9-10). We
    // give up that +0.41% to avoid knox@31's -4.29%. Net positive, deliberately chosen.
    // Read from the module constant, NOT from effortSpec -- illuminate takes positional parameters
    // and has no effortSpec in scope, so referencing one here throws at runtime.
    const warmupEvals = Math.max(1, Math.round(evalBudget * FI_WARMUP_FRACTION));
    const seedHasKiller = seeds.some((sd) => sd.boss && isFeasibleBuild(sd.boss));
    // `let`, because the warmup checkpoint may turn it on part way through.
    let splitArchives = false;
    let fiDecision = feasibleInfeasible ? 'pending-warmup' : 'not-requested';
    if (feasibleInfeasible && seedHasKiller) {
      fiDecision = 'declined-seed-killer';
      ctx.note('FI requested but NOT engaged: a seed build already kills a boss, so the feasible '
        + 'region is not hard to reach and the split would only perturb the search');
    }

    // WHEN does the population first reach the feasible region? MEASUREMENT ONLY.
    //
    // The FI premise is "killers are hard to find". `seedHasKiller` tests that against screened
    // seeds, which are FLAT canonical fills -- so it never fires on knox@31, whose flat fills do
    // not kill but whose illuminated population kills abundantly. Recording the variation index of
    // the first feasible build is what makes the premise testable at a runtime checkpoint instead.
    //
    // Pure counter write, taking NO rng draw. A draw taken for a check that could never pass once
    // shifted the whole stream and moved a result 7 points, which was written down as a real effect.
    // Declared HERE, above `consider`, not beside the illumination loop: seeding calls
    // `consider` before the loop runs, and reading a let in its temporal dead zone THROWS.
    let spent = 0;
    let firstFeasibleAtVariation = null;

    const consider = (pair, score, meta) => {
      if (!Number.isFinite(score)) return;
      if (firstFeasibleAtVariation === null && isFeasibleBuild(meta)) firstFeasibleAtVariation = spent;
      const cell = cellOf(meta, ATTRIBUTES, pair.attrAlloc, bossDamageBands);
      // The '|F'/'|I' or '|loot' suffix is a constant on every key, so it does not change the
      // relative order under the key tie-break that parent selection uses.
      if (splitArchives) {
        // Two archives, same cells. The suffix keeps them in one Map so every downstream reader
        // (curiosity, diag, the elite list) works unchanged; `feasible` is what selection splits on.
        const feasible = isFeasibleBuild(meta);
        if (feasible) return put(cell + '|F', pair, score, meta, betterLoot, true);

        //
        // DUAL RETENTION IN INFEASIBLE CELLS -- MEASURED, BECAUSE REPLACING COST A BUILD THAT WAS
        // WINNING.
        //
        // FI-2Pop keeps its infeasible population on constraint violation ALONE, and in its setting
        // that is free: an infeasible solution violates a hard constraint and is unusable, so
        // discarding its objective quality discards nothing.
        //
        // THAT ASSUMPTION DOES NOT HOLD HERE. "Infeasible" means "does not kill the boss it
        // reaches", and 8 of 10 sampled imports do not kill theirs -- a non-killing build is
        // frequently the RIGHT ANSWER. An infeasible cell that kept only its lowest-violation
        // member was therefore throwing away a perfectly good farming build.
        //
        // Measured on knox@31, three seeds, violation-only retention:
        //     9e3779b9  +1.51% -> -2.72%      1234  +1.17% -> +1.51%      a5a5a5a5  +1.51% -> +1.51%
        // Its baseline varies only 0.34 points across seeds, so the -4.17% is a REAL regression and
        // not the ~7-point variance measured on the bimodal ozzy build. FI was adding variance to a
        // build that had none.
        //
        // WEIGHTING SELECTION COULD NOT HAVE FIXED IT, which is why pfeas did not: the loss happens
        // in RETENTION. By the time killers appear and the infeasible share collapses, the
        // loot-best builds in those cells are already gone.
        //
        // So an infeasible cell keeps BOTH extremes -- the build closest to killing, which is what
        // walks the boundary, and the highest-scoring one, which is what a non-killing build is
        // actually for. Both remain available as parents, and nothing that was retained before is
        // lost.
        const improvedViolation = put(cell + '|I', pair, score, meta, betterViolation, false);
        const improvedLoot = put(cell + '|IL', pair, score, meta, betterLoot, false);
        return improvedViolation || improvedLoot;
      }
      return put(cell + '|loot', pair, score, meta, betterLoot, true);
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

    // WHEN DID THE ARCHIVE LAST LEARN ANYTHING?
    //
    // Instrumentation before optimisation, deliberately. The archive is visibly over-provisioned on
    // some builds -- knox@30 fills SIX cells from 9,600 variations -- so stopping early looks like
    // free money. It is not obviously safe: the Ozzy boss cell that decides that build's entire
    // outcome is found LATE, which is exactly why archiveEvals had to go 4800 -> 9600. A patience
    // value guessed from intuition would silently re-break that.
    //
    // So record the variation index of the last archive change and report it. Once the distribution
    // is known across builds, a patience threshold can be set from data rather than from hope.
    let lastImprovementAt = 0;
    let parentCursor = 0;
    let supportCursor = 0;
    let crossStride = 1;
    const streams = Array.isArray(seedList) ? seedList : [seedList];
    const perStream = Math.max(ARCHIVE_BATCH, Math.floor(evalBudget / streams.length));
    for (const streamSeed of streams) {
    const rng = seededRng(streamSeed);
    const until = Math.min(evalBudget, spent + perStream);
    while (spent < until) {
      if (ctx.shouldCancel()) throw new Cancelled();
      // TIME CAP IN THE ARCHIVE STAGE TOO. The first version checked only the refinement loop and
      // the polish, which left the ARCHIVE unbounded -- and the archive is exactly what the
      // Exhaustive tier doubles (19200 evaluations). Measured: borge@12 at exhaustive ran 20,125
      // evaluations under a 45s cap, because nothing in this loop looked at the clock. A cap that
      // misses the most expensive stage of the most expensive tier is not a cap.
      //
      // Breaking here is safe: the archive already holds complete legal builds, and the stages
      // after this one operate on whatever it contains.
      // The outer `truncated` flag is set by the refinement/polish checks that follow, so
      // breaking here needs no flag of its own -- one would be set and never read.
      if (ctx.pastDeadline()) break;
      report(spent / evalBudget);
      const elites = [...archive.values()];
      if (!elites.length) break;

      // CURIOSITY SELECTION: deterministic, and DEPTH-CONCENTRATING.
      //
      // Two attempts at reducing the seed sensitivity failed for the SAME reason, and the reason is
      // what this implements. Merging several seeds into one archive (each shallower) and sweeping
      // parents round-robin (every cell equally) both traded depth for breadth, and both LOST THE
      // BOSS REACH: round-robin on ozzy@62 dropped mean champion 6.4% and took best kill from 7 to
      // 0 across three of four seeds. Deep development of ONE lineage is what crosses into a boss
      // cell; spreading effort evenly guarantees no lineage gets there.
      //
      // The diagnosis that followed is sharper than "7% variance". Borge's archive varies 17.8%
      // between seeds and its FINAL answer is 0.00% every time -- refinement recovers from any
      // archive it is handed. Ozzy's outcome is not a spread at all, it is BIMODAL: a seed whose
      // archive touches a boss cell finishes near 40.5M, one whose archive does not finishes near
      // 11.9M. The quantity that actually varies is a discrete event -- did any lineage get deep
      // enough -- not a continuous score.
      //
      // Curiosity selection (Cully & Demiris) is the standard answer to exactly this trade-off:
      // pick the parent whose descendants have most recently been IMPROVING the archive. A lineage
      // that keeps landing in new or better cells keeps being developed, so effort concentrates
      // where it is paying; one that stops contributing decays and yields its turn. Selection is a
      // deterministic function of archive state -- no draw -- so it cannot depend on the stream,
      // while depth still concentrates.
      // DETERMINISTIC SELECTION, RANDOM PERTURBATION -- and the split is the whole point.
      //
      // Illumination made three kinds of random decision: WHICH elite to develop, WHICH support to
      // resample, and HOW to perturb. Only the third is exploration. The first two are COVERAGE
      // decisions, and sampling a coverage decision is strictly worse than sweeping it: uniform
      // draws revisit some cells many times and miss others entirely, purely by luck of the
      // stream. That is where the seed sensitivity came from -- measured at 7.8% spread in the
      // archive's own champion (9.614M / 8.919M / 9.562M) BEFORE refinement runs at all, so it
      // could not have originated downstream.
      //
      // Round-robin fixes it at zero cost. Every cell gets developed equally often and every
      // enumerated support gets tried, in a fixed order, so the answer stops depending on whether
      // a particular stream happened to draw the right parent. Randomness is kept where it is
      // actually doing work: which nodes move and by how much.
      //
      // Elites are ordered by CELL KEY, not by score. Ordering by score would make the sweep chase
      // the current leader and reintroduce exactly the fitness bias the archive exists to avoid.
      // Highest curiosity first; cell key breaks ties, so the order is total and reproducible.
      // `selection` exists so the strategies can be A/B'd on the FULL pipeline without editing the
      // file between arms -- which matters because the archive's own champion score turned out to
      // be an unreliable proxy for the final answer (Borge's archive varies 17.8% between seeds
      // while its final build is identical every time).
      // Split once per batch, so the alternating pick below is O(1). `feasible` is set by
      // consider(); entries from the non-FI paths are all flagged feasible, which makes
      // infeasibleOrdered empty and the alternation inert -- the flag cannot change behaviour when
      // it is off, including in the random stream.
      const ordered = selection === 'random'
        ? [...archive.values()]
        : [...archive.entries()]
          .sort((x, y) => ((y[1].curiosity || 0) - (x[1].curiosity || 0))
            || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
          .map(([, e]) => e);
      const feasibleOrdered = splitArchives ? ordered.filter((e) => e.feasible !== false) : ordered;
      const infeasibleOrdered = splitArchives ? ordered.filter((e) => e.feasible === false) : [];

      // Distance to the NEXT boss, from the stage descriptor alone. An elite that already kills is
      // not on the frontier -- its cell is occupied and curiosity will develop it on merit.
      const distanceToBoss = (e) => {
        const ms = e.maxStage;
        if (!Number.isFinite(ms)) return Infinity;
        return BOSS_STAGE_INTERVAL - (ms % BOSS_STAGE_INTERVAL);
      };
      const frontier = ordered
        .filter((e) => !(e.kill > 0) && Number.isFinite(distanceToBoss(e)))
        .sort((x, y) => (distanceToBoss(x) - distanceToBoss(y)) || (y.score - x.score));

      const batch = [];
      const parents = [];
      for (let i = 0; i < ARCHIVE_BATCH; i++) {
        // Draw from the most curious head of the list, cycling so one lineage cannot monopolise a
        // whole batch. Depth without starving everything else.
        const head = Math.max(1, Math.min(ordered.length, Math.ceil(ordered.length / 4)));
        let parent;
        //
        // ALTERNATING SELECTION IS HALF THE MECHANISM, NOT A DETAIL.
        //
        // FI-2Pop alternates between the feasible and infeasible archives when both are non-empty,
        // which gives the infeasible population about half the variation budget. Without this the
        // boss-progressing builds are simply a minority inside one curiosity-ordered list and get
        // a sliver of the effort -- which is exactly what MOME did here, and it returned a
        // bit-identical build. Retaining a stepping stone is worthless if nothing develops it.
        if (splitArchives && infeasibleOrdered.length && feasibleOrdered.length) {
          //
          // SHARE BY FEASIBILITY RATE, NOT A FIXED 50/50 -- MEASURED, BECAUSE FIXED ALTERNATION
          // REGRESSED A BUILD THAT WAS ALREADY WINNING.
          //
          //   knox@30  FI off -84.13% -> FI ON -1.68%   cells   6 -> 96   WIN
          //   knox@31  FI off  +1.51% -> FI ON -0.87%   cells 157 -> 154  LOSS
          //
          // knox@31 already kills its boss from a healthy 157-cell archive. Handing half the
          // variation budget to an infeasible archive of 13 cells spends it where the constraint
          // is not binding. FI-2Pop's premise is a HARD-TO-REACH feasible region; when feasible
          // solutions are abundant the premise does not hold and the alternation is pure cost.
          //
          // The constrained-EA literature allocates between the populations by FEASIBILITY RATE
          // rather than statically, and that is self-regulating here: early in a run nothing kills
          // a boss, so pfeas is ~0 and almost every parent comes from the infeasible archive --
          // the knox@30 case, where the boundary walk is the whole point. As killers appear pfeas
          // rises and the share collapses on its own -- the knox@31 case. No build-specific tuning
          // and nothing keyed off a hunter name.
          const pfeas = feasibleOrdered.length / (feasibleOrdered.length + infeasibleOrdered.length);
          const useInfeasible = rng() >= pfeas;
          const pool = useInfeasible ? infeasibleOrdered : feasibleOrdered;
          const ph = Math.max(1, Math.min(pool.length, Math.ceil(pool.length / 4)));
          parent = pool[(parentCursor++) % ph];
        } else if (selection === 'random') {
          parent = ordered[Math.floor(rng() * ordered.length)];
        } else {
          parent = ordered[(parentCursor++) % head];
        }
        parents.push(parent);
        let t = { ...parent.talentAlloc };
        let a = { ...parent.attrAlloc };
        // Structural resample: adopt a whole different support, filled two ways (gate-paying when
        // the support has a threshold to pay, canonical otherwise). This is the move that a
        // sequence of point transfers cannot make.
        if (supports.length && rng() < structuralShare) {
          // Sweep the supports in order rather than sampling them, so every enumerated structure
          // is tried once before any is tried twice. The enumeration is exhaustive and already
          // paid for; drawing from it at random throws that property away.
          const which = supportCursor++;
          const pick = supports[which % supports.length];
          const ids = pick.support ? pick.support.ids : pick.ids;
          // Alternate the two fills deterministically so each support is seen both ways.
          const filled = (which % 2 === 0)
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
        if (ordered.length > 1 && rng() < ARCHIVE_CROSSOVER) {
          // Partner is a fixed stride away in the same cell order, so crossover pairs are spread
          // across the archive instead of clustering wherever the stream happened to land.
          const other = ordered[(parentCursor + crossStride++) % ordered.length];
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
          // Guard the SHARE before drawing, so a disabled operator consumes no entropy. A draw
          // taken for a check that can never pass still shifts every later draw, which is exactly
          // how the "identical configuration" that returned +15.34% and +8.24% differed at all.
          // A flag that is off must be inert, including in the random stream.
          } else {
            const nx = randomTransfer(ATTRIBUTES, deps, minVal, attrBudget, a, rng, pinnedAttrs, stats, breakpointSpending);
            if (nx && pinsHeld(ATTRIBUTES, nx, pinnedAttrs)) a = nx;
          }
        }
        batch.push({ talentAlloc: t, attrAlloc: a });
      }

      const scores = await ctx.score(batch, SCREEN_ITERATIONS);
      const meta = scores.boss || [];
      for (let i = 0; i < batch.length; i++) {
        const improved = consider(batch[i], scores[i], meta[i]);
        if (improved) lastImprovementAt = spent;
        // Reward the PARENT, which is what makes this a lineage signal rather than a cell score.
        const par = parents[i];
        if (par) {
          par.curiosity = (par.curiosity === undefined ? CURIOSITY_INITIAL : par.curiosity)
            + (improved ? CURIOSITY_REWARD : -CURIOSITY_PENALTY);
        }
      }
      spent += batch.length;

      // THE WARMUP CHECKPOINT. Decided once, from unsplit evidence, and never revisited.
      if (fiDecision === 'pending-warmup' && spent >= warmupEvals) {
        if (firstFeasibleAtVariation === null) {
          // Nothing has killed anything unaided, so the feasible region really is hard to reach.
          // Every entry in the archive is therefore INFEASIBLE by construction -- that is exactly
          // the condition being tested -- so re-keying '|loot' to '|I' is exact, not approximate,
          // and no entry is lost or misfiled.
          const migrated = [...archive.entries()];
          archive.clear();
          for (const [key, entry] of migrated) {
            const bare = key.endsWith('|loot') ? key.slice(0, -5) : key;
            entry.feasible = false;
            archive.set(bare + '|I', entry);
          }
          splitArchives = true;
          fiDecision = 'engaged-warmup-empty';
          ctx.note(`FI ENGAGED after ${spent} unsplit variations: nothing reached the feasible `
            + `region, so the split is what has to find it (${migrated.length} entries re-keyed)`);
        } else {
          fiDecision = 'declined-warmup-found-killer';
          ctx.note(`FI requested but NOT engaged: the population reached the feasible region on its `
            + `own at variation ${firstFeasibleAtVariation}, so the split would only perturb it`);
        }
      }
    }
    }

    const bands = new Set([...archive.keys()].map((k) => k.split(':')[0]));
    const bestKill = [...archive.values()].reduce((m, e) => Math.max(m, e.kill || 0), 0);
    // HOW FAR DID ILLUMINATION ACTUALLY GET? Loot is a CLIFF at every boss boundary (bosses stand
    // every 100 stages and clearing one changes that stage's rewards), so a build 0.6 stages short
    // of 300 scores ~40% below one that crosses it -- measured on borge@73, whose reference
    // averages stage 300.50 against our 299.90 for a 39.44% loot gap. Whether the archive ever
    // REACHED the far side of a boundary is therefore the whole question for such a build, and
    // there was no field that answered it.
    const bestStage = [...archive.values()].reduce((m, e) => Math.max(m, e.maxStage || 0), 0);
    const bossBoundariesCrossed = Math.floor(bestStage / Objective.BOSS_INTERVAL);
    // CELLS AND ENTRIES ARE DIFFERENT NUMBERS ONCE paretoDepth > 1, AND REPORTING ONE AS THE OTHER
    // WOULD BE THE EXACT KIND OF MISLEADING DIAGNOSTIC THAT STARTED TWO WRONG INVESTIGATIONS HERE.
    // `cells` stays comparable across paretoDepth settings -- it is the descriptor coverage, which
    // MOME deliberately does not change -- while `entries` is what the archive actually holds.
    const cellCount = new Set([...archive.keys()].map((k) => k.slice(0, k.lastIndexOf('|')))).size;
    ctx.note(`archive: ${cellCount} cells (${archive.size} entries) across ${bands.size} kill bands from ${spent} `
      + `variations (best kill rate reached ${bestKill}, furthest stage ${bestStage.toFixed(1)}, `
      + `${bossBoundariesCrossed} boss boundary/ies crossed)`);
    const attempted = stats.rejected + stats.accepted;
    const pct = (n) => (attempted ? ((n / attempted) * 100).toFixed(1) : '0.0');
    ctx.note(`moves: ${attempted} attribute transfers -- ${pct(stats.rejected)}% rejected, `
      + `${pct(stats.repaired)}% accepted-but-stranded (${stats.nodesCleared} nodes cleared); `
      + `${stats.structural} structural resamples at share ${structuralShare}`
      + `; breakpoint ${breakpointSpending ? 'ON' : 'off'}`
      + `; feasibleInfeasible ${feasibleInfeasible ? 'ON' : 'off'}`
      + (breakpointSpending ? ` (${stats.breakpointClamped} clamped, ${stats.breakpointBlocked} blocked)` : ''));
    ctx.note(`illuminated from ${streams.length} stream(s)`);
    // STRUCTURED, NOT STRINGIFIED. The notes are for a human reading one run; a bench comparing
    // twenty configurations needs numbers it can sort. Every diagnosis in this file's history was
    // delayed by a measurement that could not see the field in question, so the record carries
    // every counter the archive keeps -- not the ones that seem interesting today.
    ctx.diag.archive = {
      cells: cellCount,
      entries: archive.size,
      // FI-MAP-Elites accounting. `feasibleCells` is the population that kills something;
      // `bestViolation` is how close the infeasible archive got to the constraint boundary --
      // 100 means nothing ever engaged a boss, 0 means something killed one. This is the number
      // that says whether the infeasible archive is actually WALKING to the boundary, which is the
      // entire claim of the mechanism. Without it a null result cannot be told from a no-op.
      feasibleCells: [...archive.values()].filter((e) => e.feasible !== false).length,
      infeasibleCells: [...archive.values()].filter((e) => e.feasible === false).length,
      // Variations since the archive last changed. `idleSince` is the headroom an early stop
      // would have had; a build whose last improvement lands near the budget is one an early
      // stop would have damaged.
      lastImprovementAt,
      idleVariations: spent - lastImprovementAt,
      bestViolation: [...archive.values()].reduce(
        (m, e) => (Number.isFinite(e.violation) ? Math.min(m, e.violation) : m), 100,
      ),
      killBands: bands.size,
      bestKillReached: bestKill,
      bestMaxStageReached: bestStage,
      bossBoundariesCrossed,
      // NAMED FOR ITS FIDELITY, DELIBERATELY. This is a SCREEN_ITERATIONS score, and it was
      // compared against a FINAL_ITERATIONS import score in an earlier analysis -- 779,420 against
      // 1,004,599 -- producing the confident and wrong conclusion that "the archive never finds
      // anything close". The two differ by ~10x in cost and are not comparable. A field called
      // `bestScore` invites exactly that; a field that names its own fidelity does not.
      bestScoreAtScreenIterations: [...archive.values()].reduce((m, e) => Math.max(m, e.score || 0), 0),
      variations: spent,
      streams: streams.length,
      structuralShare,
      selection,
      breakpointSpending,
      feasibleInfeasible: splitArchives,
      screenIterations: SCREEN_ITERATIONS,
      fiDecision,
      firstFeasibleAtVariation,
      feasibleInfeasibleRequested: feasibleInfeasible,
      bossDamageBands,
      breakpointClamped: stats.breakpointClamped,
      breakpointBlocked: stats.breakpointBlocked,
      moves: {
        attempted: stats.rejected + stats.accepted,
        rejected: stats.rejected,
        accepted: stats.accepted,
        strandedRepairs: stats.repaired,
        nodesCleared: stats.nodesCleared,
        structuralResamples: stats.structural,
      },
    };
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
  // Every option this function accepts. An option NOT on this list is rejected rather than ignored
  // -- see the check below for why that matters.
  const OPTIMIZE_OPTIONS = ['mode', 'effort', 'scorer', 'onProgress', 'shouldCancel', 'maxSeconds'];

  // A WALL-CLOCK CAP, NOT A WALL-CLOCK BUDGET, AND THE DIFFERENCE IS THE WHOLE DESIGN.
  //
  // A budget DECIDES how much searching happens, so it always binds, the amount of work varies with
  // machine load, and identical inputs stop giving identical answers. This project measured exactly
  // that: borge@42 returned +78.80% and then +62.72% at an IDENTICAL configuration, because a
  // deadline is not deterministic even when the algorithm is. That is why every budget in this file
  // is an evaluation count.
  //
  // A CAP is a safety valve. Sized generously it never fires, the search converges normally and
  // determinism is untouched; it engages only in the pathological case where the alternative is a
  // user waiting indefinitely. When it DOES fire the run is no longer reproducible, so it must say
  // so -- `diag.truncated` and a note -- or a truncated answer is indistinguishable from a converged
  // one, which is how the original wall-clock bug hid.
  //
  // Checked at STAGE BOUNDARIES only. Aborting mid-stage could return a partial allocation; skipping
  // a whole stage cannot, because every stage's input is already a legal fully-spent build. And the
  // floor is the corpus fallback: the finalist pool already holds the refit community builds, so a
  // truncated run costs the search's improvements, never correctness.
  //
  // NEVER LOWER THIS TO MAKE SOMETHING FASTER. The moment it binds routinely it is a budget again
  // and every A/B measured under it is noise.
  const DEFAULT_MAX_SECONDS = 600;
  // How many finalists still get a full-fidelity score once the deadline has passed. Enough that
  // the champion is chosen by measurement rather than by screening order -- screening is measured
  // inverting a 0.32% ridge by 1.7%, so picking the winner on a screen score is how the search
  // lands on a build that is genuinely worse. Corpus donors are kept on top of this count.
  const FINALISTS_WHEN_LATE = 8;

  async function optimize(cfg, opts = /** @type {any} */ ({})) {
    let fidelityClaimed = false;
    let screenClaimed = false;
    // AN IGNORED OPTION IS INDISTINGUISHABLE FROM A WORKING ONE, AND THAT IS HOW DEAD PARAMETERS
    // SURVIVE FOR MONTHS.
    //
    // The cross-seed pass took a `scorerFor` factory. It was deleted; EIGHT benches went on passing
    // `scorerFor: H.scorerFactory(cfg)` and this function silently swallowed it, so the call sites
    // still read as though cross-seeding were wired up. Nothing failed, nothing warned, and the
    // only way to discover it was to read the signature.
    //
    // It is the same shape as the shipped-effort split: two things that must agree, with nothing
    // asserting they do. Rejecting unknown keys makes the class impossible instead of unlikely.
    for (const k of Object.keys(opts)) {
      if (!OPTIMIZE_OPTIONS.includes(k)) {
        throw new Error(`optimize(): unknown option "${k}". Accepted: ${OPTIMIZE_OPTIONS.join(', ')}. `
          + 'An option that is silently ignored is indistinguishable from one that works, which is '
          + 'how `scorerFor` outlived the cross-seed pass it belonged to.');
      }
    }
    const {
      mode = 'loot', effort = DEFAULT_EFFORT, scorer,
      onProgress = () => {}, shouldCancel = () => false,
    } = opts;
    if (typeof scorer !== 'function') throw new Error('optimize() requires a scorer function');

    // Mode is validated HERE as well as in the worker, so an unknown mode fails before a search
    // runs rather than silently scoring as loot. Pins come from the mode definition, never from
    // a caller-supplied list -- there is one place that decides what a mode means.
    Objective.modeOrThrow(mode);
    // NOTE: pins are resolved AFTER the config is validated and ATTRIBUTES is bound, because a pin
    // is now resolved against this hunter's own attribute list (ids differ per hunter -- Timeless
    // Mastery is `timeless` on Borge/Ozzy and `time` on Knox). Resolving it here, above the
    // declaration, threw `Cannot access 'ATTRIBUTES' before initialization` for EVERY build.

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

    // Pins come from the mode definition, never from a caller-supplied list -- there is one place
    // that decides what a mode means -- and they resolve against THIS hunter's own ids, because
    // the ids differ: Timeless Mastery is `timeless` on Borge/Ozzy and `time` on Knox. Resolved
    // HERE rather than beside modeOrThrow above, since that is before ATTRIBUTES is bound and
    // doing it there threw `Cannot access 'ATTRIBUTES' before initialization` for every build.
    const pinnedAttrs = Objective.pinnedAttrsFor(mode, ATTRIBUTES);

    // Exact memoization, keyed by the allocation pair and fidelity.
    //
    // This is sound ONLY because the evaluator is deterministic: a fresh WASM instance per
    // call returns bit-identical output for identical arguments (verified directly). The old
    // engine assumed the opposite and averaged repeated samples of the same allocation, which
    // both cost 3x and ruled out caching entirely. Coordinate exchange regenerates the same
    // neighbours constantly and separate supports converge onto overlapping allocations, so
    // this removes a large fraction of the real work rather than a rounding error.
    const cache = new Map();
    const diag = { stages: {}, timings: {} };
    const startedAt = Date.now();
    const maxSeconds = Number.isFinite(opts.maxSeconds) ? opts.maxSeconds : DEFAULT_MAX_SECONDS;
    // maxSeconds <= 0 disables the cap entirely, for benches that must never be truncated.
    const deadlineAt = maxSeconds > 0 ? startedAt + maxSeconds * 1000 : Infinity;
    let truncated = false;
    const ctx = {
      shouldCancel,
      pastDeadline: () => Date.now() > deadlineAt,
      diag,
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
      diag.stages.enumerate = { supports: supports.length, realizable: realizable.length };

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
      // AN UNRECOGNISED EFFORT KEY IS A SILENT NO-OP, AND A SILENT NO-OP IN AN A/B MEASURES A LIE.
      //
      // Every flag here is read as `effortSpec.<name>`, so a misspelling reads `undefined`, the
      // feature stays off, and the arm meant to have it ON returns the control's number -- which
      // is then recorded as "measured, no effect". That is not hypothetical: `bossDamageBands` was
      // added to illuminate's signature and to cellOf and was never passed at the call site,
      // because the surrounding lines used `!== false` where the patch expected `=== true`. It
      // read as fully wired at three of four sites.
      //
      // The top-level options object is already whitelisted for exactly this reason
      // (OPTIMIZE_OPTIONS); the effort spec is the other half and had no such check.
      if (Number.isFinite(effortSpec.finalIterations)) {
        setFinalIterations(effortSpec.finalIterations);
        fidelityClaimed = true;
      }
      if (Number.isFinite(effortSpec.screenIterations)) {
        setScreenIterations(effortSpec.screenIterations);
        screenClaimed = true;
      }
      if (effort && typeof effort === 'object') {
        const unknown = Object.keys(effortSpec).filter((k) => !EFFORT_SPEC_KEYS.has(k));
        if (unknown.length) {
          throw new Error(`optimize(): unknown effort option(s) ${unknown.join(', ')}; `
            + `known keys are ${[...EFFORT_SPEC_KEYS].sort().join(', ')}`);
        }
      }

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
      //
      // BET-AND-RUN: k INDEPENDENT ARCHIVES, THEN REFINE ONLY THE MOST PROMISING.
      //
      // The failure this targets is BIMODAL rather than gradual: on ozzy@62 one seed returns
      // +15.34% and another -66.27%, with nothing in between. That is a heavy-tailed outcome
      // distribution, and restart portfolios are the standard answer to heavy tails. Bet-and-run
      // (Fischetti & Monaci) runs k short streams and continues only the most promising.
      //
      // IT IS CHEAP HERE BECAUSE OF WHERE THE TIME GOES. Illumination is ~10% of wall clock and
      // refinement ~87%, so k archives plus ONE refinement costs about 1.2x at k=3 -- against 3x
      // for best-of-three full runs.
      //
      // IT IS NOT THE MULTI-SEED MERGE ALREADY MEASURED AND LOST. That split ONE budget across
      // three streams, leaving each too shallow; the recorded conclusion was "per-stream depth
      // beats stream diversity". Here each stream gets the FULL archiveEvals and the choice is made
      // BETWEEN completed archives, so that objection does not transfer.
      //
      // THE DECISION MAKER IS BOSS REACH, NOT ARCHIVE SCORE. The literature warns that a naive
      // decision maker just takes best-so-far, and archive score is known to be a bad proxy here:
      // Borge's archive score varies 17.8% between seeds while its final build is identical every
      // time. What separates a winning Ozzy stream from a losing one is whether any lineage got
      // deep enough to engage a boss, so streams are ranked on kill reach first, then on how little
      // boss HP the closest build left, and only then on score.
      const betAndRun = Number.isFinite(effortSpec.betAndRun) ? Math.max(1, effortSpec.betAndRun) : 1;
      const streamSeeds = effortSpec.seeds
        || (Number.isFinite(effortSpec.seed) ? [effortSpec.seed] : ARCHIVE_SEEDS);
      const runArchive = async (seedsForRun) => illuminate(
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
        seedsForRun,
        effortSpec.selection || DEFAULT_SELECTION,
        // ON BY DEFAULT. Measured on the canonical fixture configs, helped one build badly and
        // regressed none:
        //     ozzy@54   -17.86% -> -0.60%   (both seeds, identical resulting build)
        //     ozzy@31     0.00% ->  0.00%
        //     borge@59    0.00% ->  0.00%
        //     borge@73  -39.44% -> -39.44%  (untouched; its cause is WRONG_REGIME, not overshoot)
        // Confirmed at the shipped effort (9600/8) as well as at 2400/4, with the same answer, so
        // it is not a budget artefact. Opt OUT with effort.breakpointSpending === false.
        effortSpec.breakpointSpending !== false,
        // FI-MAP-Elites. OFF until measured end to end, like every other move here.
        effortSpec.feasibleInfeasible === true,
        effortSpec.bossDamageBands === true,
        (f) => report('survey', f * SURVEY_REPORT_SCALE, SURVEY_REPORT_SCALE),
      );

      let elites;
      if (betAndRun > 1) {
        const candidates = [];
        for (let k = 0; k < betAndRun; k++) {
          if (shouldCancel()) throw new Cancelled();
          const seedForStream = [BET_AND_RUN_SEEDS[k % BET_AND_RUN_SEEDS.length]];
          const got = await runArchive(seedForStream);
          candidates.push({ elites: got, archive: { ...ctx.diag.archive }, seed: seedForStream[0] });
        }
        // Rank: deepest boss engagement first, then closest to a kill, then champion score.
        candidates.sort((a, b) => (b.archive.bestKillReached || 0) - (a.archive.bestKillReached || 0)
          || (a.archive.bestViolation ?? 100) - (b.archive.bestViolation ?? 100)
          || (b.archive.bestScoreAtScreenIterations || 0) - (a.archive.bestScoreAtScreenIterations || 0));
        const winner = candidates[0];
        elites = winner.elites;
        ctx.diag.archive = winner.archive;
        ctx.diag.betAndRun = {
          streams: candidates.length,
          chosenSeed: winner.seed,
          perStream: candidates.map((c) => ({
            seed: c.seed,
            cells: c.archive.cells,
            bestKillReached: c.archive.bestKillReached,
            bestViolation: c.archive.bestViolation,
          })),
        };
        ctx.note(`bet-and-run: ${candidates.length} archives, chose seed `
          + `${winner.seed.toString(16)} (kill ${winner.archive.bestKillReached}, `
          + `violation ${Math.round(winner.archive.bestViolation ?? 100)}) from `
          + candidates.map((c) => `${c.seed.toString(16)}:kill${c.archive.bestKillReached}`).join(' '));
      } else {
        elites = await runArchive(streamSeeds);
      }
      const surveyed = elites.map((e) => ({ ...e, mask: maskOf(e.attrAlloc) }));
      // Stage champions, kept so the ledger can re-score them all at ONE fidelity at the end.
      // Without this, "where did the value go" can only be answered by comparing numbers measured
      // at different fidelities, which is not an answer.
      const stageChampions = [];
      if (surveyed[0]) {
        stageChampions.push({
          stage: 'archive', talentAlloc: surveyed[0].talentAlloc, attrAlloc: surveyed[0].attrAlloc,
        });
      }

      // ARCHIVE-ONLY: return before refinement, for measuring the MOVE SET rather than the whole
      // pipeline. Refinement and the final polish are roughly 90% of a run's wall clock and are
      // identical across move-set configurations, so paying for them to compare two variation
      // operators measures mostly the part that did not change -- and it is what made a
      // configuration sweep cost hours instead of minutes.
      //
      // The archive's own best score is at SCREEN_ITERATIONS, so it ranks configurations; it does
      // NOT predict the final build. Full fidelity stays where it belongs: on the ONE configuration
      // that wins, measured once.
      if (effortSpec.archiveOnly) {
        return { best: surveyed[0], archiveOnly: true, evals, notes, diag };
      }

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
        // STAGE BOUNDARY. Every finalist already refined is a complete, legal, fully-spent build,
        // so stopping BETWEEN elites is safe in a way stopping inside one would not be.
        if (i > 0 && ctx.pastDeadline()) {
          truncated = true;
          ctx.note(`time cap reached: refined ${i} of ${toRefine.length} elites`);
          break;
        }
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

      // --- Stage 2c: REAL COMMUNITY BUILDS, re-fitted to this budget, as extra finalists. -----
      //
      // WHY THIS IS HERE, and why it is not a shortcut. Four rule-based constructions were measured
      // against borge@73 and knox@30, all legal and correctly gated, and every one returned a build
      // that KILLS NOTHING:
      //     gate-paying fill      -46.32% / -84.47%      enumeration of all 360 supports  -45.20% / -84.17%
      //     enumeration + depth   -46.36% / -88.17%      median of the whole corpus       -44.21% / -84.23%
      // Re-fitting an ACTUAL community build to the same budget reaches +2.37% and +1.33%, killing
      // the boss. Even the corpus MEDIAN fails, so the knowledge is build-specific: it is not a
      // rule, not a per-node prior, and not recoverable from cost/cap/threshold metadata. Real
      // builds encode which nodes are worth capping (knox winners hold `dead` at 10 and `sear` at
      // 5) and nothing in the game's own data says so.
      //
      // STRICTLY ADDITIVE. Donors are appended as ordinary finalists and Stage 3 takes the maximum,
      // so a donor that does not beat the search simply loses. This can raise the answer and cannot
      // lower it -- which is the only reason it is safe to ship a heuristic this blunt.
      //
      // IT INTERPOLATES, IT DOES NOT OPTIMISE. Excluding donors within 5 levels collapses borge@73
      // to -41.09% and knox@30 to -84.13%, i.e. back to the search's own answer. So this helps
      // where the corpus has coverage (borge 12-84, ozzy 11-75, knox 12-40) and is inert outside
      // it. That is a real limitation, not a rough edge to be smoothed over later.
      // ADAPTIVE COST: SPEND WHERE THE BUILD ACTUALLY NEEDS IT.
      //
      // Starts at Infinity so a build with NO corpus (module missing, or a hunter/mode with no
      // rows) is treated as uncovered -- the expensive path -- rather than silently cheap. An
      // optimistic default here would withhold the one mechanism that helps exactly the builds
      // that have nothing to fall back on.
      let corpusNearest = Infinity;
      const admittedPairs = [];   // donors that refit legally, for recombination below
      const corpus = (typeof global !== 'undefined' && global.OptimizerCorpus)
        || (typeof globalThis !== 'undefined' && globalThis.OptimizerCorpus);
      const refit = (typeof global !== 'undefined' && global.OptimizerRefit)
        || (typeof globalThis !== 'undefined' && globalThis.OptimizerRefit);
      if (corpus && refit) {
        const donors = corpus.donorsFor(cfg.hunter, mode, cfg.level || 0).slice(0, CORPUS_DONORS);
        let admitted = 0;
        for (const d of donors) {
          // `parseBuildCode` is ASYNC and takes ONLY the code -- it reads the hunter out of the
          // code's own header byte. Calling it synchronously (or passing a hunter) yields a Promise
          // whose `.attributes` is undefined, every donor is skipped, and the whole feature does
          // nothing while looking perfectly wired. That is the exact failure mode this file records
          // for `optimizeByRegime` and for a flag that reached three of four call sites.
          // THE DEADLINE HAS TO BE CHECKED HERE TOO, OR THE CAP IS ADVISORY. Measured: ozzy@54 at
          // `fast` ran 960s against the 600s default, because the archive, refinement and polish
          // loops each check it and this stage did not -- decoding, refitting and screening up to
          // 12 donors is not free at level 50+. A cap that names a number and then overruns it by
          // 60% is worse than no cap, because the number is quoted to users as a bound.
          //
          // Donors already admitted are KEPT: they are ordinary finalists and Stage 3 still takes
          // the maximum, so stopping early means fewer candidates, never a worse answer than not
          // having run this stage at all.
          if (ctx.pastDeadline()) { ctx.note('corpus: stopped admitting donors at the time cap'); break; }
          let decoded = null;
          try {
            decoded = global.parseBuildCode ? await global.parseBuildCode(d.code) : null;
          } catch (e) { decoded = null; }
          if (!decoded || !decoded.attributes || !decoded.talents) continue;
          // The code carries its own hunter; a corpus row for the wrong one would refit into a
          // node set it shares no ids with.
          if (decoded.hunter && decoded.hunter !== cfg.hunter) continue;
          const a = refit.refitTiered(ATTRIBUTES, minVal, attrBudget, decoded.attributes);
          const t = refit.refitTalents(TALENTS, talentBudget, decoded.talents);
          if (!a || !t) continue;
          // Legality is not assumed. The naive refit used to produce ILLEGAL builds by stripping
          // the sub-threshold points paying a gated build's unlock gates; the tiered form fixes
          // that, and this asserts it rather than trusting it.
          if (!Space.isLegal(ATTRIBUTES, deps, minVal, a, attrBudget)) continue;
          if (Space.costOf(TALENTS, t) > talentBudget) continue;
          finalists.push({ talentAlloc: t, attrAlloc: a, score: -Infinity, fromCorpus: d.level });
          admittedPairs.push({ t, a, level: d.level });
          admitted++;
        }
        if (admitted) ctx.note(`corpus: ${admitted} community build(s) re-fitted to this budget as extra finalists`);
        // ---- DONOR RECOMBINATION: talents from one donor, attributes from another --------------
        //
        // A cross-block move for free. The measured barrier on the converged shortfalls is a
        // talent/attribute COUPLING that no single-block move can cross; recombination simply
        // STARTS from a build whose two blocks came from different donors, instead of searching for
        // a way across.
        //
        // MEASURED, and this is the largest single gain of the whole effort: ozzy@70 went from
        // -44.02% to -1.98%. That build has 59 donors below it and only 5 above, and its own climb
        // gained just 1.78 points -- its bottleneck is the DONOR STAGE, which is exactly what this
        // addresses. On builds whose donor is already good it does nothing, and it was never
        // measured making anything worse.
        //
        // On both builds where the winning pair mixed level directions it took TALENTS FROM BELOW
        // and ATTRIBUTES FROM ABOVE. Plausible mechanism: talent budget is ~level and saturates its
        // caps early, while attributes are ~3x level and keep growing, so a lower donor's talents
        // fit a smaller budget cleanly while a higher donor's attributes carry depth structure.
        //
        // SCREENED, NOT ADMITTED WHOLESALE. 12 donors cross into 132 combinations; entering all of
        // them as finalists would multiply the most expensive stage. They are ranked at
        // SCREEN_ITERATIONS and only the best few are admitted -- and unlike donor screening, a
        // mis-rank here removes a SPECULATIVE extra candidate rather than a real donor.
        // Recombination screens up to 132 combinations at SCREEN_ITERATIONS, which is the single
        // largest uncapped block in this stage. It is a SPECULATIVE extra candidate, so it is the
        // right thing to drop first when time has run out.
        if (admittedPairs.length > 1 && !ctx.pastDeadline()) {
          const combos = []; const cmeta = [];
          for (const ti of admittedPairs) {
            for (const aj of admittedPairs) {
              if (ti.level === aj.level) continue;
              if (!Space.isLegal(ATTRIBUTES, deps, minVal, aj.a, attrBudget)) continue;
              combos.push({ talentAlloc: ti.t, attrAlloc: aj.a });
              cmeta.push(`${ti.level}t+${aj.level}a`);
            }
          }
          if (combos.length) {
            const cs = await ctx.score(combos, SCREEN_ITERATIONS);
            const order = combos.map((_, i) => i).sort((x, y) => cs[y] - cs[x]).slice(0, CORPUS_RECOMBINE);
            for (const i of order) {
              finalists.push({
                talentAlloc: combos[i].talentAlloc, attrAlloc: combos[i].attrAlloc,
                score: -Infinity, fromCorpus: cmeta[i],
              });
            }
            diag.corpusRecombined = { offered: combos.length, admitted: order.length };
            ctx.note(`corpus: ${order.length} recombined donor pair(s) admitted (talents and `
              + 'attributes from different builds)');
          }
        }

        // HOW FAR AWAY IS THE NEAREST USABLE DONOR? This is what decides whether the expensive
        // cross-block pass is worth running, so it is recorded rather than recomputed later.
        for (const d of donors) {
          const dist = Math.abs((d.level || 0) - (cfg.level || 0));
          if (dist < corpusNearest) corpusNearest = dist;
        }
        if (!admitted) corpusNearest = Infinity;   // offered but none legal is the same as none
        diag.corpus = { offered: donors.length, admitted, nearestLevelDistance: corpusNearest };
      }

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
      // OUT OF TIME: SCORE FEWER FINALISTS, NEVER ZERO.
      //
      // Stage 3 evaluates every finalist at FINAL_ITERATIONS -- ten times a screening evaluation
      // each -- and it ran uncapped, which is the second half of why a 5s cap produced a 64s run
      // (skipping polish took that to 28s; this is the rest). It cannot be skipped: scoring the
      // finalists is HOW the champion is chosen, and a cap that skipped it would return an unranked
      // guess rather than a slightly less refined build.
      //
      // So it is trimmed instead, and the ones kept are chosen by the screening score already paid
      // for -- plus every corpus donor unconditionally, because donors are the safety net that
      // guarantees the answer is never worse than a known good build, and dropping them to save
      // time would trade the one property a rushed run most needs to keep.
      let toScore = unique;
      if (ctx.pastDeadline() && unique.length > FINALISTS_WHEN_LATE) {
        const donors = unique.filter((f) => f.fromCorpus !== undefined);
        const rest = unique.filter((f) => f.fromCorpus === undefined)
          .sort((a, b) => (b.score || -Infinity) - (a.score || -Infinity));
        toScore = donors.concat(rest).slice(0, Math.max(FINALISTS_WHEN_LATE, donors.length));
        ctx.note(`time cap: scoring ${toScore.length} of ${unique.length} finalists at full `
          + `fidelity (every corpus donor kept)`);
      }
      const finalScores = await ctx.score(toScore.map((f) => ({ talentAlloc: f.talentAlloc, attrAlloc: f.attrAlloc })), FINAL_ITERATIONS);
      // Did refinement CREATE boss capability from the archive's foothold, or fail to? The archive
      // reaching kill 1 vs kill 7 decides the whole run, so the question is whether a weak foothold
      // refines up or dies. Reported, not acted on.
      {
        const fb = finalScores.boss || [];
        const best = fb.reduce((m, b) => Math.max(m, (b && b.kill) || 0), 0);
        const withKill = fb.filter((b) => b && b.kill > 0).length;
        ctx.note(`finalists: ${unique.length}, ${withKill} kill a boss, best kill rate ${best}`);
        diag.finalists = {
          count: unique.length, killing: withKill, bestKillRate: best, refined: toRefine.length,
          refinedKillBands: new Set(toRefine.map((e) => String(e.cell).split(':')[0])).size,
        };
      }
      if (finalists.length) {
        const bestRefined = finalists.reduce((m, f) => (f.score > m.score ? f : m), finalists[0]);
        stageChampions.push({
          stage: 'refined', talentAlloc: bestRefined.talentAlloc, attrAlloc: bestRefined.attrAlloc,
        });
      }
      // `toScore`, NOT `unique`. finalScores is parallel to what was actually SCORED, and when the
      // time cap trims the finalist list those two stop being the same array -- mapping over
      // `unique` here would pair each build with another build's score, silently crowning the
      // wrong champion (and handing `undefined` to the sort for the trimmed tail). Exactly the
      // index-misalignment this project has been bitten by before, in new code, an hour after
      // writing the trim.
      const ranked = toScore
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
      // POLISH IS SKIPPED WHOLESALE ONCE THE DEADLINE HAS PASSED, and this is what makes the cap
      // mean anything at all.
      //
      // MEASURED: `maxSeconds: 5` produced a 64-SECOND run. The archive honoured the cap (240 of
      // 1200 variations) and stopped; everything after it ran to completion regardless, and this
      // repo's own ablation puts ~87% of wall clock in full-fidelity refinement and polish. So the
      // cap was bounding the cheap tenth and letting the expensive nine tenths run -- which is why
      // it read as a no-op, and why raising or lowering the number changed nothing.
      //
      // Polish is the right thing to drop: it is explicitly ADDITIVE (it corrects the last few
      // points on an already-chosen champion and only replaces it if it truly wins), so skipping it
      // returns the same champion slightly less refined, never an invalid or worse build. Stage 3
      // still runs, because scoring the finalists is how the champion is chosen at all -- a cap
      // that skipped THAT would return an unranked guess.
      const outOfTime = ctx.pastDeadline();
      if (outOfTime) {
        ctx.note(`stopped at the ${maxSeconds}s time cap before polish -- returning the best build `
          + 'found, which is chosen at full fidelity but not finally polished');
      }
      if (ranked.length && !effortSpec.skipPolish && !outOfTime) {
        const champion = ranked[0];
        const polishStats = { ocbaConsidered: 0, ocbaVerified: 0 };
        const polished = await polishWinner(
          ctx, budgets, champion.talentAlloc, champion.attrAlloc, champion.score, pinnedAttrs,
          (f) => report('final', f, 1),
          effortSpec.ocbaPolish === true, polishStats,
          // ADAPTIVE: the cross-block pass runs only where the corpus CANNOT cover this build.
          //
          // Measured on borge@73: +70s (+31%, 226s -> 296s against a 300s ceiling) for ZERO gain,
          // and `crossBlockGains` confirmed it fired and found nothing. That is not a defect in the
          // pass -- inside corpus coverage the donor pool already contains a build at this level, so
          // the polish STARTS past the coupling barrier the pass exists to cross. On ozzy@11 the
          // research bench measured +2.18 points from it, but only under leave-one-out, which the
          // shipped path never does.
          //
          // So the benefit lives exactly where the corpus does not reach: knox above 40, ozzy above
          // 75 or inside the 34-42 gap, borge above 84. Gate on the MEASURED distance to the nearest
          // usable donor rather than on hunter or level, and easy builds stop paying for a mechanism
          // that provably does nothing for them.
          // Past the time cap the cross-block pass is skipped even when it would otherwise run:
          // it is the most expensive optional work in the polish, and the champion handed to
          // polishWinner is already a complete legal build.
          !ctx.pastDeadline()
            && (effortSpec.crossBlock === true
              || (effortSpec.crossBlock !== false && corpusNearest > CROSS_BLOCK_DONOR_DISTANCE)),
        );
        if (ctx.pastDeadline()) truncated = true;
        // ALWAYS surface the polish stats. They used to be attached ONLY when ocbaPolish was on,
        // so `crossBlockGains` -- the one fact that says whether the cross-block pass fired -- was
        // unreadable in every default run. A counter that cannot be read is not a counter, and this
        // project's recurring failure is exactly the feature that looks wired and is inert.
        diag.polish = polishStats;
        if (effortSpec.ocbaPolish === true) {
          diag.ocbaPolish = polishStats;
          const saved = polishStats.ocbaConsidered
            ? (1 - polishStats.ocbaVerified / polishStats.ocbaConsidered) * 100 : 0;
          ctx.note(`OCBA polish: ${polishStats.ocbaVerified}/${polishStats.ocbaConsidered} candidates `
            + `verified at ${FINAL_ITERATIONS} iterations (${saved.toFixed(1)}% of full-fidelity work skipped)`);
        }
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
      //
      // TOP UP THE WINNER BEFORE ASSERTING IT IS SPENT -- WITHOUT THIS, `fast` EFFORT CRASHES.
      //
      // The assertion below demands that no eligible node could take another point. Nothing
      // guaranteed it: greedyTopUp existed for exactly this purpose -- its own header notes that
      // its leftover condition "is exactly the condition the Stage 3 assertion allows" -- but it
      // was only ever wired into ONE candidate-generation path, on ATTRIBUTES, and never reached
      // the returned build.
      //
      // MEASURED, and it is a user-visible crash rather than a quality issue:
      //     ozzy@11  effort 'fast'      THROWS  left 1 talent point unspent ("revival")
      //     ozzy@11  effort 'complete'  ok
      // The UI ships Fast as a dropdown option, so a level-11 Ozzy player choosing it got an
      // exception instead of a build. A thorough search happens to spend the last point; a cheaper
      // one does not, and the backstop turned that into a hard failure.
      //
      // Costs nothing on a build that is already fully spent -- the loop does not run -- so the
      // complete-effort path is untouched, which `search-identity-probe` verifies rather than
      // assumes. Pins are re-applied afterwards because a top-up must not spend a pinned node's
      // points elsewhere.
      winner.talentAlloc = await greedyTopUp(
        ctx, TALENTS, noDeps, noMin, talentBudget, winner.talentAlloc,
        (t) => ({ talentAlloc: t, attrAlloc: winner.attrAlloc }),
      );
      winner.attrAlloc = await greedyTopUp(
        ctx, ATTRIBUTES, deps, minVal, attrBudget, winner.attrAlloc,
        (a) => ({ talentAlloc: winner.talentAlloc, attrAlloc: a }),
      );
      if (pinnedAttrs.length) {
        winner.attrAlloc = applyPins(ATTRIBUTES, deps, minVal, attrBudget, winner.attrAlloc, pinnedAttrs);
      }
      const spendable = (defs, deps, minVal, budget, alloc) => {
        const idle = budget - Space.costOf(defs, alloc);
        // STRICT, AND IT IS RIGHT TO BE. I briefly relaxed this to Space.MAX_IDLE_POINTS (1) to
        // stop `fast` throwing on ozzy@11, which HID A REAL DEFECT: measured on all three hunters,
        // EVERY talent costs 1 and each has an uncapped, dependency-free, cost-1 attribute
        // (ares / lotl / kraken), so a point is ALWAYS spendable in both blocks. There is no such
        // thing here as an unspendable leftover, and an optimal build never leaves one.
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
      if (ranked[0]) {
        stageChampions.push({
          stage: 'returned', talentAlloc: ranked[0].talentAlloc, attrAlloc: ranked[0].attrAlloc,
        });
      }

      // ============================== THE VALUE-LOSS LEDGER ==============================
      //
      // WHY THIS EXISTS. "Where does the search lose the value?" was repeatedly answered by
      // comparing an archive score (SCREEN_ITERATIONS) against an import score (FINAL_ITERATIONS)
      // and reading the difference as a loss. Those numbers are ~10x apart in sampling cost and
      // mean different things. Every entry below is re-scored at THE SAME fidelity, and the
      // fidelity is stated in the field name and in the text.
      //
      // The ledger states CONCLUSIONS, not raw fields to be paraphrased. `avgStage` was read as
      // "how far the build gets" twice in one session when `maxStage` is that number, so each
      // entry carries `Objective.describeRun`'s labelled regime instead of stage numbers alone.
      const ledger = [];
      for (const c of stageChampions) {
        const pair = { talentAlloc: c.talentAlloc, attrAlloc: c.attrAlloc };
        const [sc] = await ctx.score([pair], FINAL_ITERATIONS);
        const meta = ((await ctx.score([pair], FINAL_ITERATIONS)).boss || [])[0];
        ledger.push({
          stage: c.stage,
          scoreAtFinalIterations: sc,
          finalIterations: FINAL_ITERATIONS,
          killRatePct: meta ? meta.kill : null,
          maxStageReached: meta ? meta.maxStage : null,
        });
      }
      // Deltas between consecutive stages, so a reader does not have to subtract and mislabel.
      for (let i = 1; i < ledger.length; i++) {
        const prev = ledger[i - 1].scoreAtFinalIterations;
        ledger[i].gainOverPreviousStagePct = prev ? ((ledger[i].scoreAtFinalIterations - prev) / prev) * 100 : null;
      }
      diag.ledger = ledger;
      diag.ledgerText = ledger.map((e, i) => {
        const d = e.gainOverPreviousStagePct;
        const delta = (i === 0 || d === null) ? '' : `  (${d >= 0 ? '+' : ''}${d.toFixed(2)}% vs ${ledger[i - 1].stage})`;
        return `${e.stage.padEnd(9)} ${Math.round(e.scoreAtFinalIterations)} loot/min @${FINAL_ITERATIONS} iters`
          + `  kill ${e.killRatePct}%  maxStage ${e.maxStageReached}${delta}`;
      }).join('\n');
      ctx.note(`value ledger (all at ${FINAL_ITERATIONS} iterations):\n${diag.ledgerText}`);

      // A TRUNCATED RUN IS NOT REPRODUCIBLE AND MUST SAY SO. Where the cap fired depends on machine
      // speed and load, so two runs of identical input can differ -- the one property this file
      // otherwise guarantees. Reporting it is what keeps a truncated answer distinguishable from a
      // converged one; the original wall-clock bug hid precisely because it was silent.
      diag.truncated = truncated;
      diag.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (truncated) {
        ctx.note(`STOPPED AT THE ${maxSeconds}s TIME CAP -- returning the best build found, which is `
          + 'not necessarily the best this search would have found. This run is NOT reproducible; '
          + 'raise the cap for a deterministic answer.');
      }

      return {
        best: ranked[0],
        ranked,
        evals,
        cacheHits,
        notes,
        cancelled: false,
        truncated,
        // ONE diagnostic channel, not two. `supportsEnumerated`/`supportsRealizable` used to sit
        // here as well as in the diag record -- the same numbers reported twice, which is how the
        // two copies get to disagree.
        diag,
      };
    } catch (err) {
      if (err instanceof Cancelled) return { best: null, ranked: [], evals, cacheHits, notes, cancelled: true, diag };
      throw err;
    } finally {
      // Always restore, including on cancel and on throw. A run that left the module holding a
      // reduced fidelity would silently degrade every LATER run in the same process, which is the
      // hardest kind of contamination to trace back.
      if (fidelityClaimed) releaseFinalIterations();
      if (screenClaimed) releaseScreenIterations();
    }
  }

  const Optimizer = {
    optimize, SCREEN_ITERATIONS, FINAL_ITERATIONS,
    STEP_SIZES,
    EFFORT_LEVELS, DEFAULT_EFFORT,
    // Exposed so a bench can measure ONE support's tuning in isolation. The search's own stages
    // all call this same function -- there is no second implementation to drift from it.
    optimizeJointly,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Optimizer;
  else global.HunterOptimizer = Optimizer;
})(typeof window !== 'undefined' ? window : globalThis);
