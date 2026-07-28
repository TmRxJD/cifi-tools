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
            if (e.data.type === 'ready') { worker.onmessage = this._handleMessage.bind(this); resolve(); return; }
          };
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

    async ready() { await Promise.all(this.readyPromises); }

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
  async function greedyMarginalSeed(cfg, pool, mode, iterations, epsilon = 0) {
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
    await pool.ready();

    try {
      const seeds = [];
      if (cfg.currentTalents && cfg.currentAttrs) seeds.push({ talentAlloc: cfg.currentTalents, attrAlloc: cfg.currentAttrs });
      for (const h of seedCandidates) seeds.push({ talentAlloc: h.talentAlloc, attrAlloc: h.attrAlloc });

      // Two greedy marginal-value passes (one strict, one with a little exploration on near-
      // ties) give the beam a strong starting point instead of relying purely on random
      // mutation to stumble onto a good allocation -- this is what actually closes the gap
      // against hand-tuned/community builds (see the big comment on greedyMarginalSeed above).
      let greedyEvalsUsed = 0;
      onProgress({ evalsDone: 0, targetEvals, generation: 0, bestScore: null, elapsedMs: 0, phase: 'greedy-seeding' });
      const greedyIterations = Math.min(searchIterations, 100);
      const greedy1 = await greedyMarginalSeed(cfg, pool, mode, greedyIterations, 0);
      const greedy2 = await greedyMarginalSeed(cfg, pool, mode, greedyIterations, 0.2);
      greedyEvalsUsed += greedy1.evalsUsed + greedy2.evalsUsed;
      seeds.push({ talentAlloc: greedy1.talentAlloc, attrAlloc: greedy1.attrAlloc });
      seeds.push({ talentAlloc: greedy2.talentAlloc, attrAlloc: greedy2.attrAlloc });

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

      let generation = 0;
      while (evalsDone < targetEvals && !shouldCancel()) {
        const candidates = [];
        for (const member of beam) {
          for (let k = 0; k < neighborsPerMember; k++) {
            const mutateTalents = Math.random() < 0.5;
            const nt = mutateTalents ? Optimizer.neighbor(cfg.TALENTS, cfg.TALENT_BUDGET, member.talentAlloc) : member.talentAlloc;
            const na = mutateTalents ? member.attrAlloc : Optimizer.constrainedNeighbor(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, member.attrAlloc, deps, minVal);
            candidates.push({ talentAlloc: nt, attrAlloc: na });
          }
        }
        const scores = await pool.scoreBatch(candidates, mode, searchIterations);
        evalsDone += candidates.length;
        const scoredCandidates = candidates.map((c, i) => ({ ...c, score: scores[i] }));
        scoredCandidates.forEach((c) => {
          const sig = sigOf(c);
          if (!allSeen.has(sig) || allSeen.get(sig).score < c.score) allSeen.set(sig, c);
        });
        beam = dedupTopK([...beam, ...scoredCandidates], beamWidth);
        generation++;
        onProgress({ evalsDone, targetEvals, generation, bestScore: beam[0].score, elapsedMs: Date.now() - start });
      }

      return { beam, allSeen: [...allSeen.values()], generations: generation, evalsDone };
    } finally {
      pool.terminate();
    }
  }

  global.beamSearchBrowser = beamSearchBrowser;
})(window);
