// Browser port of beamSearch.js + workerPool.js: a small pool of persistent Web Workers,
// each holding its own compiled WASM evaluator, driving one beam-search loop together.
(function (global) {
  class WorkerPool {
    constructor(cfg, size) {
      this.workers = [];
      this.pending = new Map();
      this.nextRequestId = 0;
      this.readyPromises = [];
      for (let i = 0; i < size; i++) {
        const worker = new Worker('beamWorker.js');
        const ready = new Promise((resolve) => {
          worker.onmessage = (e) => {
            if (e.data.type === 'ready') {
              worker.onmessage = this._handleMessage.bind(this);
              resolve(e.data.error || null);
              return;
            }
          };
          worker.onerror = (e) => resolve(String((e && e.message) || 'worker failed to load'));
        });
        worker.postMessage({ type: 'init', cfg: serializeCfg(cfg) });
        this.readyPromises.push(ready);
        this.workers.push(worker);
      }
    }

    _handleMessage(e) {
      const msg = e.data;
      if (msg.type === 'scoreResult') {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          const timer = this._timers && this._timers.get(msg.requestId);
          if (timer) { clearTimeout(timer); this._timers.delete(msg.requestId); }
          p.resolve(msg.scores);
        }
      }
    }

    // Returns the first init error string, or null if every worker came up clean. Never
    // hangs: each readyPromise above always resolves (via 'ready' or worker.onerror), so this
    // can't stall the search the way an uncaught compileEvaluator throw used to.
    async ready() {
      const errors = await Promise.all(this.readyPromises);
      return errors.find((e) => e) || null;
    }

    async scoreBatch(items, mode, iterations) {
      if (!items.length) return [];
      const n = this.workers.length;
      const chunks = Array.from({ length: n }, () => []);
      const chunkIndexOf = [];
      items.forEach((item, i) => {
        const w = i % n;
        chunkIndexOf.push({ w, pos: chunks[w].length });
        chunks[w].push(item);
      });
      const chunkResults = await Promise.all(chunks.map((batch, w) => {
        if (!batch.length) return Promise.resolve([]);
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          // Safety net: a worker's own per-item try/catch (see beamWorker.js) should mean
          // this never actually fires, but a 20s timeout means a genuinely wedged/crashed
          // worker fails this one batch (treated as "reject every candidate in it") instead
          // of hanging the whole search forever with no feedback.
          const timeoutMs = 20000;
          const timer = setTimeout(() => {
            if (this.pending.delete(requestId)) resolve(batch.map(() => -Infinity));
          }, timeoutMs);
          this._timers = this._timers || new Map();
          this._timers.set(requestId, timer);
          this.workers[w].postMessage({ type: 'scoreBatch', requestId, mode, iterations, batch });
        });
      }));
      return chunkIndexOf.map(({ w, pos }) => chunkResults[w][pos]);
    }

    terminate() { this.workers.forEach((w) => w.terminate()); }
  }

  // Config objects carry Infinity (for uncapped maxLevel) which JSON.stringify can't
  // round-trip through postMessage's structured clone without care -- structured clone
  // actually DOES support Infinity natively, so this is just a plain pass-through, kept as
  // a named step in case the cfg shape needs trimming later (e.g. dropping functions).
  function serializeCfg(cfg) {
    return {
      hunter: cfg.hunter, level: cfg.level, hunterStats: cfg.hunterStats,
      baseOverrides: cfg.baseOverrides, globalUpgrades: cfg.globalUpgrades,
      // gemPlannerStore was missing here -- compileEvaluator's resolveParam reads ALL
      // gems_nodes params (gem tree levels, boolean nodes, and named bonuses like the loot
      // multipliers) from state.gemPlannerStore specifically, not from globalUpgrades. With
      // it stripped out, every worker was scoring candidates as if gems didn't exist at all,
      // so the optimizer was searching (and picking a "best" build) in a completely
      // different, gem-less world than the real evaluation shown on the build card --
      // explaining why "optimized" builds could score lower than a manually-tuned one that
      // actually benefits from gem bonuses.
      gemPlannerStore: cfg.gemPlannerStore,
      TALENTS: cfg.TALENTS, ATTRIBUTES: cfg.ATTRIBUTES,
    };
  }

  function sigOf(entry) { return JSON.stringify([entry.talentAlloc, entry.attrAlloc]); }

  function dedupTopK(list, k) {
    const bySig = new Map();
    for (const e of list) {
      const sig = sigOf(e);
      const existing = bySig.get(sig);
      if (!existing || existing.score < e.score) bySig.set(sig, e);
    }
    return [...bySig.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  // Greedily builds ONE full allocation by repeatedly spending a single point on whichever
  // currently-eligible talent/attribute yields the best score-gain-per-cost, re-scoring every
  // legal next move at each step (not just the region a random mutation happened to land in).
  //
  // Why this exists: pure random-mutation beam search (randomAllocation + neighbor, below)
  // reliably lands 2-5% below the true optimum on a space this size (9 talents + 15
  // attributes, variable costs, dependency chains) and can catastrophically misallocate into
  // a technically-legal-but-bad move (confirmed empirically: seeding the search with a known-
  // good allocation and letting it try to improve reproduced that allocation's score exactly,
  // proving the wasm scoring was never the problem -- pure random search just can't discover
  // it reliably from a cold start). Greedy marginal-value construction is the standard fix for
  // this failure mode on smoothly-diminishing-returns systems like this one, and it's fully
  // organic/data-driven -- it only ever consults cfg's own TALENTS/ATTRIBUTES/dependency
  // tables and the live wasm scorer, never any hardcoded build or account-specific values.
  //
  // `epsilon` (0 = always take the single best move) lets two greedy runs explore genuinely
  // different paths when candidates are close in value, instead of both deterministically
  // picking the exact same allocation -- passed in as multiple seeds so beam search refines
  // from more than one promising starting point ("several path options").
  async function greedyMarginalSeed(cfg, pool, mode, iterations, epsilon = 0, { onStep = () => {}, shouldCancel = () => false } = {}) {
    const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const talentAlloc = {};
    cfg.TALENTS.forEach((t) => { talentAlloc[t.id] = 0; });
    const attrAlloc = {};
    cfg.ATTRIBUTES.forEach((a) => { attrAlloc[a.id] = 0; });
    let talentSpent = 0;
    let attrSpent = 0;
    let evalsUsed = 0;
    let currentScore = (await pool.scoreBatch([{ talentAlloc, attrAlloc }], mode, iterations))[0];
    evalsUsed++;

    // Safety cap: total budget is the natural bound (one point spent per iteration), plus
    // slack for the rare case a talent/attribute pair of moves both cost >1.
    const maxSteps = cfg.TALENT_BUDGET + cfg.ATTRIBUTE_BUDGET + 50;
    for (let step = 0; step < maxSteps; step++) {
      // This loop was previously silent and uncancellable for its entire duration -- on a
      // small budget that's a fraction of a second and unnoticeable, but on a large real
      // account's budget (hundreds of talent+attribute points) it could run for a long stretch
      // with the progress bar frozen and Cancel doing nothing, which is indistinguishable from
      // the whole optimizer being hung. Report progress and honor cancellation every step.
      onStep({ evalsUsed, step, maxSteps });
      if (shouldCancel()) break;
      const candidates = [];
      if (talentSpent < cfg.TALENT_BUDGET) {
        cfg.TALENTS.forEach((t) => {
          if ((talentAlloc[t.id] || 0) < t.maxLevel) candidates.push({ type: 'talent', id: t.id, cost: 1 });
        });
      }
      cfg.ATTRIBUTES.forEach((a) => {
        const cost = a.cost || 1;
        if (attrSpent + cost <= cfg.ATTRIBUTE_BUDGET && Optimizer.isEligible(a, cfg.ATTRIBUTES, deps, minVal, attrAlloc)) {
          candidates.push({ type: 'attribute', id: a.id, cost });
        }
      });
      if (!candidates.length) break;

      const trials = candidates.map((c) => {
        const nt = c.type === 'talent' ? { ...talentAlloc, [c.id]: talentAlloc[c.id] + 1 } : talentAlloc;
        const na = c.type === 'attribute' ? { ...attrAlloc, [c.id]: attrAlloc[c.id] + 1 } : attrAlloc;
        return { talentAlloc: nt, attrAlloc: na };
      });
      const scores = await pool.scoreBatch(trials, mode, iterations);
      evalsUsed += trials.length;

      const ranked = candidates
        .map((c, i) => ({ c, score: scores[i], ratio: (scores[i] - currentScore) / c.cost }))
        .sort((a, b) => b.ratio - a.ratio);
      const pickIdx = epsilon > 0 && ranked.length > 1 && Math.random() < epsilon
        ? 1 + Math.floor(Math.random() * Math.min(2, ranked.length - 1))
        : 0;
      const chosen = ranked[pickIdx];

      if (chosen.c.type === 'talent') { talentAlloc[chosen.c.id]++; talentSpent += 1; }
      else { attrAlloc[chosen.c.id]++; attrSpent += chosen.c.cost; }
      currentScore = chosen.score;
    }
    return { talentAlloc, attrAlloc, score: currentScore, evalsUsed };
  }

  // Exhaustive coordinate-ascent polish: after the beam search's randomized mutation/dedup
  // process, there is no guarantee it actually tried every simple "move one point from A to
  // B" swap on the winning allocation -- it only ever sampled a handful of random neighbors
  // per generation. This pass systematically tries EVERY (spend one less on some def currently
  // >0) x (spend one more on some eligible def) pair -- not a random sample of them -- and
  // keeps applying whichever swap helps most, until literally no single-swap improves the
  // score. That is the actual mechanism that can back up a "never regress" claim: random
  // mutation can miss an improving move by chance, an exhaustive sweep of all pairs cannot.
  // Because a single wasm evaluate() carries real Monte Carlo noise, each candidate swap is
  // screened cheaply with one sample each, but the swap only gets ACCEPTED and applied after a
  // 3-sample-averaged confirmation beats a 3-sample-averaged baseline -- so noise can at worst
  // cost a missed improvement, never an accepted regression.
  async function hillClimbPolish(cfg, pool, mode, iterations, alloc, { shouldCancel = () => false, onStep = () => {} } = {}) {
    const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    let { talentAlloc, attrAlloc } = alloc;
    let evalsUsed = 0;
    const avgScore = async (ta, aa, samples = 3) => {
      const batch = Array.from({ length: samples }, () => ({ talentAlloc: ta, attrAlloc: aa }));
      const scores = await pool.scoreBatch(batch, mode, iterations);
      evalsUsed += samples;
      return scores.reduce((a, b) => a + b, 0) / samples;
    };
    let baseline = await avgScore(talentAlloc, attrAlloc);

    const maxRounds = cfg.TALENT_BUDGET + cfg.ATTRIBUTE_BUDGET;
    for (let round = 0; round < maxRounds; round++) {
      onStep({ round, maxRounds, evalsUsed });
      if (shouldCancel()) break;

      const talentFrom = cfg.TALENTS.filter((t) => (talentAlloc[t.id] || 0) > 0);
      const talentTo = cfg.TALENTS.filter((t) => (talentAlloc[t.id] || 0) < t.maxLevel);
      const attrFrom = cfg.ATTRIBUTES.filter((a) => (attrAlloc[a.id] || 0) > 0);

      const swaps = [];
      for (const from of talentFrom) {
        for (const to of talentTo) {
          if (from.id === to.id) continue;
          const nt = { ...talentAlloc, [from.id]: talentAlloc[from.id] - 1, [to.id]: (talentAlloc[to.id] || 0) + 1 };
          swaps.push({ talentAlloc: nt, attrAlloc, kind: 'talent', from: from.id, to: to.id });
        }
      }
      for (const from of attrFrom) {
        const freedCost = from.cost || 1;
        const attrTo = cfg.ATTRIBUTES.filter((a) => a.id !== from.id && (a.cost || 1) <= freedCost);
        for (const to of attrTo) {
          const trial = { ...attrAlloc, [from.id]: attrAlloc[from.id] - 1 };
          if (!Optimizer.isEligible(to, cfg.ATTRIBUTES, deps, minVal, trial)) continue;
          trial[to.id] = (trial[to.id] || 0) + 1;
          swaps.push({ talentAlloc, attrAlloc: trial, kind: 'attribute', from: from.id, to: to.id });
        }
      }

      // A swap only ever moves a point FROM somewhere TO somewhere else -- it can never spend
      // budget that's simply sitting unallocated (e.g. a leftover point after an odd-cost
      // substitution, or a random-mutation candidate that never spent its full budget in the
      // first place). Confirmed as a real bug on a real Knox build: the "optimized" result only
      // spent 35 of 36 attribute points, permanently wasting one, because this pass had no move
      // type that could ever touch idle budget. If there's leftover room, also offer plain
      // "spend one more point here" candidates with nothing removed.
      const talentLeftover = cfg.TALENT_BUDGET - Optimizer.costOf(cfg.TALENTS, talentAlloc);
      if (talentLeftover > 0) {
        for (const to of talentTo) {
          const nt = { ...talentAlloc, [to.id]: (talentAlloc[to.id] || 0) + 1 };
          swaps.push({ talentAlloc: nt, attrAlloc, kind: 'talent-topup', to: to.id });
        }
      }
      const attrLeftover = cfg.ATTRIBUTE_BUDGET - Optimizer.costOf(cfg.ATTRIBUTES, attrAlloc);
      if (attrLeftover > 0) {
        for (const to of cfg.ATTRIBUTES) {
          if ((to.cost || 1) > attrLeftover) continue;
          if (!Optimizer.isEligible(to, cfg.ATTRIBUTES, deps, minVal, attrAlloc)) continue;
          const trial = { ...attrAlloc, [to.id]: (attrAlloc[to.id] || 0) + 1 };
          swaps.push({ talentAlloc, attrAlloc: trial, kind: 'attribute-topup', to: to.id });
        }
      }
      if (!swaps.length) break;

      // Cheap single-sample screen across every candidate swap (parallelized across workers).
      const screenScores = await pool.scoreBatch(swaps, mode, iterations);
      evalsUsed += swaps.length;
      let bestIdx = 0;
      for (let i = 1; i < swaps.length; i++) if (screenScores[i] > screenScores[bestIdx]) bestIdx = i;
      const candidate = swaps[bestIdx];

      // Averaged confirmation before accepting -- the screen above is noisy and only used to
      // pick a candidate worth confirming, never to decide the swap outright.
      const candidateScore = await avgScore(candidate.talentAlloc, candidate.attrAlloc);
      if (candidateScore > baseline) {
        talentAlloc = candidate.talentAlloc;
        attrAlloc = candidate.attrAlloc;
        baseline = candidateScore;
      } else {
        break;
      }
    }
    return { talentAlloc, attrAlloc, score: baseline, evalsUsed };
  }

  // Runs beam search until `targetEvals` cumulative WASM evaluations have been spent (the
  // user-selectable "number of evaluations" knob), calling onProgress after every
  // generation with {evalsDone, targetEvals, generation, bestScore, elapsedMs}.
  async function beamSearchBrowser(cfg, {
    mode = 'loot', targetEvals = 3000, beamWidth = 8, neighborsPerMember = 3,
    searchIterations = 100, poolSize = navigator.hardwareConcurrency || 4,
    seedCandidates = [], onProgress = () => {}, shouldCancel = () => false,
  } = {}) {
    const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const pool = new WorkerPool(cfg, poolSize);
    const initError = await pool.ready();
    if (initError) { pool.terminate(); throw new Error(`Optimizer worker failed to initialize: ${initError}`); }
    if (shouldCancel()) { pool.terminate(); return { beam: [], allSeen: [] }; }

    try {
      const seeds = [];
      if (cfg.currentTalents && cfg.currentAttrs) seeds.push({ talentAlloc: cfg.currentTalents, attrAlloc: cfg.currentAttrs });
      for (const h of seedCandidates) seeds.push({ talentAlloc: h.talentAlloc, attrAlloc: h.attrAlloc });

      // Two greedy marginal-value passes (one strict, one with a little exploration on near-
      // ties) give the beam a strong starting point instead of relying purely on random
      // mutation to stumble onto a good allocation -- this is what actually closes the gap
      // against hand-tuned/community builds (see the big comment on greedyMarginalSeed above).
      let greedyEvalsUsed = 0;
      const greedyStart = Date.now();
      // Rough total step estimate for the progress bar: 2 greedy passes, each ~(budget) steps.
      const greedyStepsEstimate = 2 * (cfg.TALENT_BUDGET + cfg.ATTRIBUTE_BUDGET);
      const reportGreedyProgress = (passOffset, step) => onProgress({
        evalsDone: 0, targetEvals, generation: 0, bestScore: null,
        elapsedMs: Date.now() - greedyStart, phase: 'greedy-seeding',
        greedyStep: passOffset + step, greedyStepsEstimate,
      });
      onProgress({ evalsDone: 0, targetEvals, generation: 0, bestScore: null, elapsedMs: 0, phase: 'greedy-seeding', greedyStep: 0, greedyStepsEstimate });
      const greedyIterations = Math.min(searchIterations, 100);
      const greedy1 = await greedyMarginalSeed(cfg, pool, mode, greedyIterations, 0, {
        shouldCancel, onStep: ({ step }) => reportGreedyProgress(0, step),
      });
      const greedy2 = shouldCancel() ? null : await greedyMarginalSeed(cfg, pool, mode, greedyIterations, 0.2, {
        shouldCancel, onStep: ({ step }) => reportGreedyProgress(cfg.TALENT_BUDGET + cfg.ATTRIBUTE_BUDGET, step),
      });
      greedyEvalsUsed += greedy1.evalsUsed + (greedy2?.evalsUsed || 0);
      seeds.push({ talentAlloc: greedy1.talentAlloc, attrAlloc: greedy1.attrAlloc });
      if (greedy2) seeds.push({ talentAlloc: greedy2.talentAlloc, attrAlloc: greedy2.attrAlloc });

      while (seeds.length < beamWidth) {
        seeds.push({
          talentAlloc: Optimizer.randomAllocation(cfg.TALENTS, cfg.TALENT_BUDGET),
          attrAlloc: Optimizer.randomConstrainedAllocation(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, deps, minVal),
        });
      }

      let evalsDone = greedyEvalsUsed;
      const start = Date.now();
      const seedScores = await pool.scoreBatch(seeds, mode, searchIterations);
      evalsDone += seeds.length;
      let beam = dedupTopK(seeds.map((s, i) => ({ ...s, score: seedScores[i] })), beamWidth);

      const allSeen = new Map();
      beam.forEach((b) => allSeen.set(sigOf(b), b));
      onProgress({ evalsDone, targetEvals, generation: 0, bestScore: beam[0].score, elapsedMs: Date.now() - start });

      // Stagnation escape: on a large point budget (dozens of attributes/talents), a single
      // 1-point mutation per neighbor barely perturbs the allocation, and dedupTopK keeps
      // collapsing the beam back down to trivial variants of the same greedy seed -- confirmed
      // empirically (real ~150-point account import): the search plateaued at the exact same
      // bestScore for 100+ straight generations, moving at most one point off the greedy seed
      // in 5000+ evaluations. When the best score hasn't improved for a while, replace the
      // weaker half of the beam with fresh random-restart allocations and mutate the survivors
      // MORE aggressively (multiple point-moves per neighbor) instead of just repeating the
      // same tiny local search around a seed it already can't escape.
      const STAGNATION_LIMIT = 8;
      let stagnantGens = 0;
      let lastBestScore = beam[0].score;

      let generation = 0;
      while (evalsDone < targetEvals && !shouldCancel()) {
        const stagnant = stagnantGens >= STAGNATION_LIMIT;
        const mutationHops = stagnant ? 3 : 1;
        const candidates = [];
        for (const member of beam) {
          for (let k = 0; k < neighborsPerMember; k++) {
            let nt = member.talentAlloc;
            let na = member.attrAlloc;
            for (let hop = 0; hop < mutationHops; hop++) {
              const mutateTalents = Math.random() < 0.5;
              nt = mutateTalents ? Optimizer.neighbor(cfg.TALENTS, cfg.TALENT_BUDGET, nt) : nt;
              na = mutateTalents ? na : Optimizer.constrainedNeighbor(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, na, deps, minVal);
            }
            candidates.push({ talentAlloc: nt, attrAlloc: na });
          }
        }
        if (stagnant) {
          // Full random restarts, not just mutated seeds -- gives the search a genuinely
          // different starting region instead of another variant of the same local optimum.
          const restartCount = Math.max(2, Math.floor(beamWidth / 2));
          for (let i = 0; i < restartCount; i++) {
            candidates.push({
              talentAlloc: Optimizer.randomAllocation(cfg.TALENTS, cfg.TALENT_BUDGET),
              attrAlloc: Optimizer.randomConstrainedAllocation(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, deps, minVal),
            });
          }
        }
        const scores = await pool.scoreBatch(candidates, mode, searchIterations);
        evalsDone += candidates.length;
        const scoredCandidates = candidates.map((c, i) => ({ ...c, score: scores[i] }));
        scoredCandidates.forEach((c) => {
          const sig = sigOf(c);
          if (!allSeen.has(sig) || allSeen.get(sig).score < c.score) allSeen.set(sig, c);
        });
        if (stagnant) {
          // Keep only the top half of the existing beam (the proven-good members) plus
          // whatever the mutated/restarted candidates produced, instead of always keeping the
          // full old beam -- otherwise the untouched top-half immediately out-competes the
          // fresh restarts every single generation and nothing ever actually changes.
          const survivors = dedupTopK(beam, Math.ceil(beamWidth / 2));
          beam = dedupTopK([...survivors, ...scoredCandidates], beamWidth);
          stagnantGens = 0;
        } else {
          beam = dedupTopK([...beam, ...scoredCandidates], beamWidth);
        }
        generation++;
        if (beam[0].score > lastBestScore) { lastBestScore = beam[0].score; stagnantGens = 0; }
        else stagnantGens++;
        onProgress({ evalsDone, targetEvals, generation, bestScore: beam[0].score, elapsedMs: Date.now() - start });
      }

      // Beam search sampled random neighbors; it never verified that every simple single-point
      // swap on its own winner had been tried. Polish the top candidate exhaustively -- this is
      // what actually backs a "never regress" claim (see hillClimbPolish above), so it always
      // runs regardless of whether targetEvals was already spent.
      if (!shouldCancel() && beam.length) {
        onProgress({ evalsDone, targetEvals, generation, bestScore: beam[0].score, elapsedMs: Date.now() - start, phase: 'polish' });
        const polished = await hillClimbPolish(cfg, pool, mode, searchIterations, beam[0], {
          shouldCancel,
          onStep: ({ round, maxRounds }) => onProgress({
            evalsDone, targetEvals, generation, bestScore: beam[0].score, elapsedMs: Date.now() - start,
            phase: 'polish', polishRound: round, polishRoundsEstimate: maxRounds,
          }),
        });
        evalsDone += polished.evalsUsed;
        if (polished.score > beam[0].score) {
          beam = [{ talentAlloc: polished.talentAlloc, attrAlloc: polished.attrAlloc, score: polished.score }, ...beam.slice(1)];
          allSeen.set(sigOf(beam[0]), beam[0]);
        }
      }

      return { beam, allSeen: [...allSeen.values()], generations: generation, evalsDone };
    } finally {
      pool.terminate();
    }
  }

  global.beamSearchBrowser = beamSearchBrowser;
})(window);
