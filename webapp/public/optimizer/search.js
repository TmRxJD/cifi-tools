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
  const SURVEY_SUPPORTS = 8;
  const REFINE_SUPPORTS = 3;

  // Transfer sizes, largest first. Large steps cross the flat regions that trap single-point
  // hill climbing; the size-1 pass at the end is what makes the fixpoint claim above true.
  // The survey tier uses a subset -- enough to rank supports fairly, not enough to converge.
  const STEP_SIZES = [8, 4, 2, 1];
  const SURVEY_STEP_SIZES = [4, 1];

  // Bound on improving moves per block pass. Each round applies at most one move, so this only
  // binds on pathological inputs; it is reported rather than silently swallowed.
  const MAX_ROUNDS_PER_BLOCK = 400;

  class Cancelled extends Error {}

  // ---------------------------------------------------------------------------------------
  // Block optimization: fix one allocation, optimize the other to a coordinate-exchange
  // fixpoint. Deterministic throughout -- candidate moves are generated in declaration order
  // and ties are broken toward the earlier candidate, never by chance.
  // ---------------------------------------------------------------------------------------
  async function optimizeBlock(ctx, defs, deps, minVal, budget, alloc, buildPair, baseScore, stepSizes) {
    let current = { ...alloc };
    let currentScore = baseScore;
    let rounds = 0;

    for (const step of stepSizes) {
      let improved = true;
      while (improved) {
        if (ctx.shouldCancel()) throw new Cancelled();
        if (++rounds > MAX_ROUNDS_PER_BLOCK) { ctx.note(`block hit MAX_ROUNDS_PER_BLOCK at step ${step}`); break; }
        improved = false;

        const moves = [];
        const seen = new Set();
        for (const from of defs) {
          if ((current[from.id] || 0) < step) continue;
          for (const to of defs) {
            const next = Space.transfer(defs, deps, minVal, budget, current, from.id, to.id, step);
            if (!next) continue;
            const sig = Space.signature(defs, next);
            if (seen.has(sig)) continue;
            seen.add(sig);
            moves.push(next);
          }
        }
        if (!moves.length) break;

        const scores = await ctx.score(moves.map(buildPair), SCREEN_ITERATIONS);
        let bestIdx = -1;
        for (let i = 0; i < scores.length; i++) {
          if (scores[i] > currentScore && (bestIdx === -1 || scores[i] > scores[bestIdx])) bestIdx = i;
        }
        if (bestIdx !== -1) {
          current = moves[bestIdx];
          currentScore = scores[bestIdx];
          improved = true;
        }
      }
    }
    return { alloc: current, score: currentScore };
  }

  // Alternate attribute and talent blocks until neither improves. Both blocks see the other's
  // current state, so this converges on a joint fixpoint rather than optimizing each in
  // isolation against a stale partner.
  async function optimizeJointly(ctx, cfg, talentAlloc, attrAlloc, startScore, stepSizes, maxSweeps) {
    const { TALENTS, ATTRIBUTES, TALENT_BUDGET, ATTRIBUTE_BUDGET } = cfg;
    const noDeps = {};
    const noMin = {};
    let talents = { ...talentAlloc };
    let attrs = { ...attrAlloc };
    let score = startScore;

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      const before = score;

      const attrResult = await optimizeBlock(
        ctx, ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, ATTRIBUTE_BUDGET,
        attrs, (a) => ({ talentAlloc: talents, attrAlloc: a }), score, stepSizes,
      );
      attrs = attrResult.alloc;
      score = attrResult.score;

      const talentResult = await optimizeBlock(
        ctx, TALENTS, noDeps, noMin, TALENT_BUDGET,
        talents, (t) => ({ talentAlloc: t, attrAlloc: attrs }), score, stepSizes,
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
  async function optimize(cfg, { mode = 'loot', scorer, onProgress = () => {}, shouldCancel = () => false } = {}) {
    if (typeof scorer !== 'function') throw new Error('optimize() requires a scorer function');

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
      async score(pairs, iterations) {
        if (!pairs.length) return [];
        const out = new Array(pairs.length);
        const missIdx = [];
        const missPairs = [];
        const missKeys = [];
        for (let i = 0; i < pairs.length; i++) {
          const key = `${iterations}|${Space.signature(TALENTS, pairs[i].talentAlloc)}|${Space.signature(ATTRIBUTES, pairs[i].attrAlloc)}`;
          if (cache.has(key)) { out[i] = cache.get(key); cacheHits++; continue; }
          missIdx.push(i);
          missPairs.push(pairs[i]);
          missKeys.push(key);
        }
        if (missPairs.length) {
          evals += missPairs.length;
          const scores = await scorer(missPairs, iterations);
          for (let j = 0; j < missIdx.length; j++) {
            cache.set(missKeys[j], scores[j]);
            out[missIdx[j]] = scores[j];
          }
        }
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

    const report = (phase, done, total) => onProgress({ phase, done, total, evals });

    try {
      // --- Stage 0: a talent allocation to screen attribute supports against. -------------
      // Supports must be compared against SOME talent build; a canonical round-robin fill is
      // the neutral choice (it favours no particular talent), and Stage 2 re-optimizes talents
      // jointly anyway, so this only affects screening order, never the final answer's
      // legality or the set of supports considered.
      const seedTalents = Space.canonicalFill(TALENTS, noDeps, noMin, talentBudget, TALENTS.map((t) => t.id));
      if (!seedTalents) throw new Error('Could not build a legal starting talent allocation within budget');

      // --- Stage 1: exhaustive support enumeration and screening. -------------------------
      const supports = Space.enumerateSupports(ATTRIBUTES, deps, attrBudget);
      report('enumerate', supports.length, supports.length);

      const screened = [];
      const BATCH = 64;
      const realizable = [];
      for (const s of supports) {
        const fill = Space.canonicalFill(ATTRIBUTES, deps, minVal, attrBudget, s.ids);
        // A support can be dependency-legal and affordable yet still unrealizable: a tier
        // threshold it needs may be unreachable with this budget. Those are dropped here, and
        // the count is reported rather than hidden.
        if (fill) realizable.push({ support: s, attrAlloc: fill });
      }
      ctx.note(`${supports.length} supports enumerated, ${realizable.length} realizable within budget`);

      for (let i = 0; i < realizable.length; i += BATCH) {
        if (shouldCancel()) throw new Cancelled();
        const chunk = realizable.slice(i, i + BATCH);
        const scores = await ctx.score(chunk.map((c) => ({ talentAlloc: seedTalents, attrAlloc: c.attrAlloc })), SCREEN_ITERATIONS);
        chunk.forEach((c, j) => screened.push({ ...c, score: scores[j] }));
        report('screen', Math.min(i + BATCH, realizable.length), realizable.length);
      }

      // Deterministic total order: score descending, then support mask ascending so equal
      // scores never depend on iteration or floating-point tie order.
      screened.sort((a, b) => (b.score - a.score) || (a.support.mask - b.support.mask));

      // --- Stage 2a: coarse survey of the strongest supports. -----------------------------
      // Screening scores each support at a canonical fill, which says little about what that
      // support can do once its depth is tuned. The survey gives each contender a cheap, equal
      // shot at showing its real potential before the expensive tier picks winners.
      const surveyed = [];
      const toSurvey = screened.slice(0, SURVEY_SUPPORTS);
      for (let i = 0; i < toSurvey.length; i++) {
        if (shouldCancel()) throw new Cancelled();
        report('survey', i, toSurvey.length);
        const c = toSurvey[i];
        surveyed.push({
          ...(await optimizeJointly(ctx, budgets, seedTalents, c.attrAlloc, c.score, SURVEY_STEP_SIZES, 2)),
          mask: c.support.mask,
        });
      }
      surveyed.sort((a, b) => (b.score - a.score) || (a.mask - b.mask));

      // --- Stage 2b: full fixpoint refinement of the survivors. ---------------------------
      const finalists = [];
      const toRefine = surveyed.slice(0, REFINE_SUPPORTS);
      for (let i = 0; i < toRefine.length; i++) {
        if (shouldCancel()) throw new Cancelled();
        report('refine', i, toRefine.length + 1);
        const c = toRefine[i];
        finalists.push(await optimizeJointly(ctx, budgets, c.talentAlloc, c.attrAlloc, c.score, STEP_SIZES, 6));
      }
      // Survey results that didn't make the refinement cut still compete -- they are complete,
      // legal allocations, just less thoroughly tuned. Keeping them costs nothing at Stage 3
      // and removes any chance the cut discards an outright winner.
      finalists.push(...surveyed.slice(REFINE_SUPPORTS));

      // The build the user started with is refined on identical terms and competes as a
      // finalist. This is the only reason the optimizer can never hand back a downgrade: the
      // incumbent is in the same race, judged by the same Stage 3 measurement.
      if (cfg.currentTalents && cfg.currentAttrs) {
        report('refine', toRefine.length, toRefine.length + 1);
        const incumbentAttrs = { ...cfg.currentAttrs };
        Space.clearInvalidDescendants(ATTRIBUTES, deps, minVal, incumbentAttrs);
        const incumbentTalents = { ...cfg.currentTalents };

        // TOP THE INCUMBENT UP BEFORE IT COMPETES. It is the user's saved build, which may well
        // be under-spent -- a level-58 Borge build sitting at 46 of 58 talent points is a normal
        // thing to have. Entered as-is it can win Stage 3 on merit and hand back a build with 12
        // points still unspent, which is never the right answer: those points are free value.
        // Nothing else in the pipeline could rescue it either, because a transfer moves points
        // rather than adding them, and fillLeftover refuses to open new nodes.
        Space.spendRemaining(TALENTS, noDeps, noMin, talentBudget, incumbentTalents);
        Space.spendRemaining(ATTRIBUTES, deps, minVal, attrBudget, incumbentAttrs);
        const [startScore] = await ctx.score([{ talentAlloc: incumbentTalents, attrAlloc: incumbentAttrs }], SCREEN_ITERATIONS);
        finalists.push(await optimizeJointly(ctx, budgets, incumbentTalents, incumbentAttrs, startScore, STEP_SIZES, 6));
        // Also carry the incumbent through UNREFINED, so the result is provably never worse
        // than what the user already had, even if every refinement path leads somewhere weaker.
        finalists.push({ talentAlloc: incumbentTalents, attrAlloc: incumbentAttrs, score: startScore });
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
      const finalScores = await ctx.score(unique.map((f) => ({ talentAlloc: f.talentAlloc, attrAlloc: f.attrAlloc })), FINAL_ITERATIONS);
      const ranked = unique
        .map((f, i) => ({ talentAlloc: f.talentAlloc, attrAlloc: f.attrAlloc, score: finalScores[i] }))
        .sort((a, b) => b.score - a.score);

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

      // The budget must actually be SPENT, not merely not-exceeded. Unspent points are free
      // value left on the table, and an optimizer that hands them back has not done its job --
      // this is asserted rather than hoped for because a user reported exactly that symptom
      // (46 of 58 talent points after an optimize). Only the winner is checked: lower-ranked
      // entries never reach the build.
      const winner = ranked[0];
      const talentIdle = talentBudget - Space.costOf(TALENTS, winner.talentAlloc);
      const attrIdle = attrBudget - Space.costOf(ATTRIBUTES, winner.attrAlloc);
      if (talentIdle > Space.MAX_IDLE_POINTS) {
        throw new Error(`Optimizer left ${talentIdle} of ${talentBudget} talent points unspent: ${JSON.stringify(winner.talentAlloc)}`);
      }
      if (attrIdle > Space.MAX_IDLE_POINTS) {
        throw new Error(`Optimizer left ${attrIdle} of ${attrBudget} attribute points unspent: ${JSON.stringify(winner.attrAlloc)}`);
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
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Optimizer;
  else global.HunterOptimizer = Optimizer;
})(typeof window !== 'undefined' ? window : globalThis);
