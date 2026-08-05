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
          // CRITICAL: removing a point from `from` can strand anything downstream that gates on
          // it -- either a direct dependency parent (deps) or a cumulative minVal threshold sum
          // that other already-invested attributes rely on. Every other move generator in this
          // file (constrainedNeighbor in optimizerBrowser.js) cascades a clear of now-invalid
          // descendants after a removal; this hand-rolled swap loop did not, and it was the
          // cause of a real illegal build: 0 points in a gating attribute (Essence Of Ylith)
          // while attributes gated on it stayed fully maxed. Clear BEFORE checking eligibility
          // and before granting the point to `to`, so the swap can never produce or hide an
          // illegal allocation.
          Optimizer.clearInvalidDescendants(cfg.ATTRIBUTES, deps, minVal, trial);
          if (!Optimizer.isEligible(to, cfg.ATTRIBUTES, deps, minVal, trial)) continue;
          trial[to.id] = (trial[to.id] || 0) + 1;
          swaps.push({ talentAlloc, attrAlloc: trial, kind: 'attribute', from: from.id, to: to.id });
        }
      }

      // Chain-unlock: a real Knox import deliberately spends 1 point in a weak "gate" attribute
      // (A Pirates Life For Knox) purely to unlock a much stronger downstream one (Timeless
      // Mastery, 5 levels at cost 3 each) that is worthless on its own until unlocked. A single
      // one-for-one swap can NEVER discover this: investing that first gate point alone looks
      // like a pure loss (no visible payoff yet), so it never gets accepted by itself, and the
      // real payoff only exists once the whole chain plus its target are funded together.
      // Confirmed directly: cold-start Knox searches kept landing 60%+ below the import because
      // nothing in this file could ever evaluate "unlock this chain" as one atomic move. Try
      // funding the minimal unlock (1 point in every zero ancestor, plus 1 in the target) from a
      // single already-invested donor that can afford the whole cost, and let it compete
      // alongside every other candidate on actual score.
      for (const to of cfg.ATTRIBUTES) {
        if ((attrAlloc[to.id] || 0) > 0) continue;
        const chain = [];
        const seen = new Set();
        let cursor = to;
        while (true) {
          const parents = deps[cursor.id];
          if (!parents || !parents.length) break;
          const blocked = parents.find((p) => (attrAlloc[p] || 0) <= 0 && !seen.has(p));
          if (!blocked) break;
          seen.add(blocked);
          const pdef = cfg.ATTRIBUTES.find((a) => a.id === blocked);
          if (!pdef) break;
          chain.push(pdef);
          cursor = pdef;
        }
        if (!chain.length) continue;
        const unlockCost = chain.reduce((sum, d) => sum + (d.cost || 1), 0) + (to.cost || 1);
        for (const donor of attrFrom) {
          if (donor.id === to.id || chain.some((d) => d.id === donor.id)) continue;
          const donorCost = donor.cost || 1;
          if (attrAlloc[donor.id] * donorCost < unlockCost) continue;
          const trial = { ...attrAlloc };
          let freed = 0;
          while (freed < unlockCost && trial[donor.id] > 0) { trial[donor.id]--; freed += donorCost; }
          Optimizer.clearInvalidDescendants(cfg.ATTRIBUTES, deps, minVal, trial);
          let ok = true;
          for (const d of [...chain].reverse()) {
            if (!Optimizer.isEligible(d, cfg.ATTRIBUTES, deps, minVal, trial)) { ok = false; break; }
            trial[d.id] = (trial[d.id] || 0) + 1;
          }
          if (ok && Optimizer.isEligible(to, cfg.ATTRIBUTES, deps, minVal, trial)) {
            trial[to.id] = (trial[to.id] || 0) + 1;
            swaps.push({ talentAlloc, attrAlloc: trial, kind: 'chain-unlock', to: to.id, donor: donor.id });
          }
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

  // Runs ONE full greedy-seed -> beam-search -> polish pipeline against a shared, already-ready
  // worker pool. Split out of beamSearchBrowser so the outer function can run several
  // INDEPENDENT passes (multi-restart) and keep whichever converges highest -- see the big
  // comment on beamSearchBrowser below for why that's necessary, not just nice-to-have.
  async function runOnePass(cfg, pool, {
    mode, targetEvals, beamWidth, neighborsPerMember, searchIterations, seedCandidates, onProgress, shouldCancel,
  }) {
    const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    {
      // Root cause of a recurring illegal-allocation bug finally traced here: seedCandidates
      // come from localStorage history (saveHistory/loadHistory in app.js) written by EARLIER
      // runs, including runs from before every legality fix in this file existed. Seeds are
      // taken as ground truth and pushed straight into the beam with NO eligibility check at
      // all -- confirmed directly: every single one of 20 saved Knox history entries carried
      // the same illegal allocation (Timeless Mastery maxed with its gating prerequisite at 0),
      // and each new search kept reintroducing that exact illegal state no matter how many
      // generator-level fixes landed, because the seed intake itself was the unguarded path.
      // Sanitize every incoming seed the same way a legal allocation would look -- cheap,
      // synchronous, no wasm calls needed.
      const seeds = [];
      const sanitizeSeed = (talentAlloc, attrAlloc) => {
        const cleanAttrs = { ...attrAlloc };
        Optimizer.clearInvalidDescendants(cfg.ATTRIBUTES, deps, minVal, cleanAttrs);
        return { talentAlloc, attrAlloc: cleanAttrs };
      };
      if (cfg.currentTalents && cfg.currentAttrs) seeds.push(sanitizeSeed(cfg.currentTalents, cfg.currentAttrs));
      for (const h of seedCandidates) seeds.push(sanitizeSeed(h.talentAlloc, h.attrAlloc));

      // Several greedy marginal-value passes at increasing exploration (EPSILONS below) give
      // the beam a strong, diverse starting point instead of relying purely on random mutation
      // to stumble onto a good allocation -- this is what actually closes the gap against
      // hand-tuned/community builds (see the big comment on greedyMarginalSeed above).
      const EPSILONS = [0, 0.15, 0.3, 0.45];
      let greedyEvalsUsed = 0;
      // ONE timer anchor for the entire pass, set before any work starts. This used to be two
      // separate `Date.now()` anchors -- `greedyStart` for the seeding phase, then a second
      // fresh `start` declared only after seeding finished for every phase after that -- so
      // the instant seeding ended, elapsed time reported relative to the NEW anchor and
      // visibly dropped back near zero. That's exactly the "elapsed time resets partway
      // through" bug: not a display issue, the underlying timestamp really was restarting.
      const passStart = Date.now();
      // Total step estimate for the progress bar: one pass per EPSILONS entry, each
      // ~(budget) steps. This used to be hardcoded to "2 greedy passes" while EPSILONS
      // actually had 4 entries, so the seeding progress bar blew past 100% partway through the
      // 3rd/4th pass instead of tracking real progress -- now derived from the same array the
      // loop below actually iterates, so it can't drift out of sync again.
      const greedyStepsEstimate = EPSILONS.length * (cfg.TALENT_BUDGET + cfg.ATTRIBUTE_BUDGET);
      const reportGreedyProgress = (passOffset, step) => onProgress({
        evalsDone: 0, targetEvals, generation: 0, bestScore: null,
        elapsedMs: Date.now() - passStart, phase: 'greedy-seeding',
        greedyStep: passOffset + step, greedyStepsEstimate,
      });
      onProgress({ evalsDone: 0, targetEvals, generation: 0, bestScore: null, elapsedMs: 0, phase: 'greedy-seeding', greedyStep: 0, greedyStepsEstimate });
      const greedyIterations = Math.min(searchIterations, 100);
      // Pure greedy marginal-value construction (epsilon=0) is myopic on attribute trees with
      // threshold-gated tiers (ATTRIBUTE_MIN_VALUE): it always takes whichever single point
      // looks best RIGHT NOW, so it can systematically under-invest in a cheap foundational
      // attribute that only pays off once several points deep unlock something bigger --
      // confirmed on a real cold-start (level-only) Borge search landing ~11% below the
      // hand-tuned import even after polish, because the greedy seed anchored on a foundational
      // choice (Soul Of Ares vs Essence Of Ylith) that a purely-greedy pass has no way to
      // revisit. Multiple passes with increasing exploration (epsilon) let later passes take a
      // few "worse-right-now" moves that a single deterministic pass never would, giving the
      // beam actually different regions to refine instead of near-identical variants of one
      // greedy path.
      const greedyRuns = [];
      for (let i = 0; i < EPSILONS.length; i++) {
        if (shouldCancel()) break;
        const passOffset = i * (cfg.TALENT_BUDGET + cfg.ATTRIBUTE_BUDGET);
        const run = await greedyMarginalSeed(cfg, pool, mode, greedyIterations, EPSILONS[i], {
          shouldCancel, onStep: ({ step }) => reportGreedyProgress(passOffset, step),
        });
        greedyRuns.push(run);
      }
      greedyEvalsUsed += greedyRuns.reduce((sum, r) => sum + r.evalsUsed, 0);
      for (const run of greedyRuns) seeds.push({ talentAlloc: run.talentAlloc, attrAlloc: run.attrAlloc });

      while (seeds.length < beamWidth) {
        seeds.push({
          talentAlloc: Optimizer.randomAllocation(cfg.TALENTS, cfg.TALENT_BUDGET),
          attrAlloc: Optimizer.randomConstrainedAllocation(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, deps, minVal),
        });
      }

      // `genEvalsDone` tracks ONLY the generation loop's own spend, deliberately NOT seeded
      // with greedyEvalsUsed. On a real account with a large point budget, the greedy-seeding
      // passes above (4 epsilon passes, each stepping through the whole budget) can cost far
      // more than targetEvals/RESTARTS by themselves -- confirmed directly: a level-80 account
      // (320 combined talent+attribute points) can burn 10,000+ evals on seeding alone against
      // a 1500-eval per-restart budget. Folding that cost into the SAME counter the generation
      // `while` loop checks meant the loop's own condition (`evalsDone < targetEvals`) was
      // already false before it ever ran once -- generation stayed stuck at 0 and the search
      // silently skipped straight from seeding to polish every time, on every real account.
      // `totalEvalsDone()` still reports the true combined cost for progress display/accounting.
      let genEvalsDone = 0;
      const totalEvalsDone = () => greedyEvalsUsed + genEvalsDone;
      const seedScores = await pool.scoreBatch(seeds, mode, searchIterations);
      genEvalsDone += seeds.length;
      let beam = dedupTopK(seeds.map((s, i) => ({ ...s, score: seedScores[i] })), beamWidth);

      const allSeen = new Map();
      beam.forEach((b) => allSeen.set(sigOf(b), b));
      onProgress({ evalsDone: totalEvalsDone(), targetEvals, generation: 0, bestScore: beam[0].score, elapsedMs: Date.now() - passStart });

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
      while (genEvalsDone < targetEvals && !shouldCancel()) {
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
        genEvalsDone += candidates.length;
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
        onProgress({ evalsDone: totalEvalsDone(), targetEvals, generation, bestScore: beam[0].score, elapsedMs: Date.now() - passStart });
      }

      // Beam search sampled random neighbors; it never verified that every simple single-point
      // swap on its own winner had been tried. Polishing ONLY beam[0] risks getting stuck if the
      // beam's single best member sits in a worse local-optimum basin than #2 or #3 -- confirmed
      // on a real cold-start (level-only, no seed build) Borge search: the search landed 12.7%
      // below the hand-tuned import despite this exact polish pass already existing, because
      // whichever candidate the randomized beam happened to rank #1 wasn't necessarily the one
      // closest to the true optimum. Polish the top few distinct candidates independently and
      // keep whichever converges highest -- this is what actually backs a "never regress" claim
      // (see hillClimbPolish above), so it always runs regardless of remaining eval budget.
      if (!shouldCancel() && beam.length) {
        const toPolish = dedupTopK(beam, Math.min(3, beam.length));
        let bestPolished = null;
        for (const candidate of toPolish) {
          if (shouldCancel()) break;
          onProgress({ evalsDone: totalEvalsDone(), targetEvals, generation, bestScore: beam[0].score, elapsedMs: Date.now() - passStart, phase: 'polish' });
          const polished = await hillClimbPolish(cfg, pool, mode, searchIterations, candidate, {
            shouldCancel,
            onStep: ({ round, maxRounds }) => onProgress({
              evalsDone: totalEvalsDone(), targetEvals, generation, bestScore: beam[0].score, elapsedMs: Date.now() - passStart,
              phase: 'polish', polishRound: round, polishRoundsEstimate: maxRounds,
            }),
          });
          genEvalsDone += polished.evalsUsed;
          if (!bestPolished || polished.score > bestPolished.score) bestPolished = polished;
        }
        if (bestPolished && bestPolished.score > beam[0].score) {
          beam = [{ talentAlloc: bestPolished.talentAlloc, attrAlloc: bestPolished.attrAlloc, score: bestPolished.score }, ...beam.slice(1)];
          allSeen.set(sigOf(beam[0]), beam[0]);
        }
      }

      if (beam.length) {
        const repaired = await repairLegality(cfg, pool, mode, searchIterations, beam[0]);
        if (repaired) { beam[0] = repaired; genEvalsDone += repaired.evalsUsed; allSeen.set(sigOf(beam[0]), beam[0]); }
      }

      // Field name is `evalsDone` (not `evalsUsed`) -- matched by beamSearchBrowser's
      // `totalEvalsDone += result.evalsUsed` below, which was a stale typo referencing a field
      // that never existed on this return value. That meant `totalEvalsDone` became NaN after
      // the very first restart pass, corrupting the progress display (and its eval counts) for
      // every restart after the first -- fixed by renaming the accumulator on the caller side
      // to match this field instead of guessing which name was "right."
      return { beam, allSeen: [...allSeen.values()], generations: generation, evalsDone: totalEvalsDone() };
    }
  }

  // Confirmed on real cold-start searches (Borge: Essence Of Ylith at 0 while Spartan Lineage/
  // Timeless Mastery -- both gated on it -- stayed maxed; Knox: same pattern with A Pirates Life
  // For Knox / Timeless Mastery) that a winning allocation can carry an illegal dependency-gate
  // violation the real game would never allow. Rather than keep hunting for the exact generator
  // responsible, this hard-repairs whatever allocation is about to become a FINAL answer: clear
  // any stranded descendant, top up any budget that repair frees, and rescore. Called on each
  // pass's own winner AND (critically) on the winner AFTER merging multiple restart passes --
  // the merge can promote a candidate that was never that pass's own beam[0] and therefore never
  // got checked, which is exactly how the Knox violation slipped through the first version of
  // this guarantee.
  async function repairLegality(cfg, pool, mode, searchIterations, entry) {
    const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    let evalsUsed = 0;
    const attrAlloc = { ...entry.attrAlloc };
    const talentAlloc = { ...entry.talentAlloc };
    let changed = false;

    const attrBefore = JSON.stringify(attrAlloc);
    Optimizer.clearInvalidDescendants(cfg.ATTRIBUTES, deps, minVal, attrAlloc);
    if (JSON.stringify(attrAlloc) !== attrBefore) changed = true;

    // Talent budget can end up overflowed by mutation steps that were each individually legal
    // in isolation but never re-validated as a composed whole -- confirmed directly: a real
    // winning candidate landed at 46/45 talent points after a swap mutation, and nothing
    // downstream caught it until app.js's OWN unrelated over-budget guard (added for a level-
    // downgrade bug) silently trimmed the exact point the search had just added back off,
    // making "Optimize" look like a complete no-op even though the dialog correctly reported a
    // real score improvement for the (illegal) candidate it never should have returned. Trim
    // here, before this candidate can ever become a final answer: remove points from whichever
    // talent currently holds the most, until back within budget, same heuristic app.js uses.
    let talentSpent = cfg.TALENTS.reduce((s, t) => s + (talentAlloc[t.id] || 0), 0);
    if (talentSpent > cfg.TALENT_BUDGET) {
      changed = true;
      while (talentSpent > cfg.TALENT_BUDGET) {
        let topId = null; let topLevel = 0;
        cfg.TALENTS.forEach((t) => { if ((talentAlloc[t.id] || 0) > topLevel) { topLevel = talentAlloc[t.id]; topId = t.id; } });
        if (!topId) break;
        talentAlloc[topId]--; talentSpent--;
      }
    }

    if (!changed) return null;

    let leftover = cfg.ATTRIBUTE_BUDGET - Optimizer.costOf(cfg.ATTRIBUTES, attrAlloc);
    let guard = 0;
    while (leftover > 0 && guard++ < cfg.ATTRIBUTE_BUDGET) {
      const eligible = cfg.ATTRIBUTES.filter((a) => (a.cost || 1) <= leftover && Optimizer.isEligible(a, cfg.ATTRIBUTES, deps, minVal, attrAlloc));
      if (!eligible.length) break;
      const topupScores = await pool.scoreBatch(
        eligible.map((a) => ({ talentAlloc, attrAlloc: { ...attrAlloc, [a.id]: (attrAlloc[a.id] || 0) + 1 } })),
        mode, searchIterations,
      );
      evalsUsed += eligible.length;
      let bestIdx = 0;
      for (let i = 1; i < topupScores.length; i++) if (topupScores[i] > topupScores[bestIdx]) bestIdx = i;
      attrAlloc[eligible[bestIdx].id] = (attrAlloc[eligible[bestIdx].id] || 0) + 1;
      leftover = cfg.ATTRIBUTE_BUDGET - Optimizer.costOf(cfg.ATTRIBUTES, attrAlloc);
    }
    // The topup loop above only asks "which single eligible def gives the best score right
    // now", which is exactly the same greedy myopia documented on greedyMarginalSeed -- and
    // confirmed to fail badly here: repairing a real Knox cold-start build this way spent the
    // freed budget on the wrong things and landed 62.5% BELOW the import, legal but far worse
    // than the illegal build it replaced. Route the topped-up allocation through the exhaustive
    // swap-based polish (which tries every reallocation, not just a greedy fill) so the freed
    // budget actually gets optimized instead of dumped wherever looked best in isolation.
    const polished = await hillClimbPolish(cfg, pool, mode, searchIterations, { talentAlloc, attrAlloc }, {});
    evalsUsed += polished.evalsUsed;
    return { talentAlloc: polished.talentAlloc, attrAlloc: polished.attrAlloc, score: polished.score, evalsUsed };
  }

  // Runs beam search until `targetEvals` cumulative WASM evaluations have been spent (the
  // user-selectable "number of evaluations" knob), calling onProgress with
  // {evalsDone, targetEvals, generation, bestScore, elapsedMs, phase}.
  //
  // A SINGLE pass: greedy-seed -> beam generations -> exhaustive polish -> legality repair,
  // once, start to finish, using the full evaluation budget. This used to run the entire
  // pipeline 2-4 times ("multi-restart") and keep whichever attempt scored highest, on the
  // theory that a single run can get anchored on one region of the allocation space. In
  // practice that produced a progress dialog no one could make sense of -- a best score that
  // appears then visibly resets, a bar that jumps and free-falls at each restart boundary,
  // runs that "stop early" because a later, weaker pass's smaller sub-budget ran out -- and it
  // was never something the user asked for. Cut back to one pass using the FULL budget: still
  // greedy-seed -> beam -> polish, still legality-repaired, just not repeated. If search
  // quality on very large accounts turns out to need more than one pass's worth of budget,
  // that's solved by raising targetEvals for a single deeper pass, not by re-adding restarts.
  async function beamSearchBrowser(cfg, {
    mode = 'loot', targetEvals = 3000, beamWidth = 8, neighborsPerMember = 3,
    searchIterations = 100, poolSize = navigator.hardwareConcurrency || 4,
    seedCandidates = [], onProgress = () => {}, shouldCancel = () => false,
  } = {}) {
    const pool = new WorkerPool(cfg, poolSize);
    const initError = await pool.ready();
    if (initError) { pool.terminate(); throw new Error(`Optimizer worker failed to initialize: ${initError}`); }
    if (shouldCancel()) { pool.terminate(); return { beam: [], allSeen: [] }; }

    try {
      const result = await runOnePass(cfg, pool, {
        mode, targetEvals, beamWidth, neighborsPerMember, searchIterations, seedCandidates,
        shouldCancel, onProgress,
      });
      let beam = dedupTopK(result.beam, beamWidth);
      const allSeen = new Map();
      result.allSeen.forEach((c) => allSeen.set(sigOf(c), c));
      let evalsDone = result.evalsDone;

      // app.js's shortlist takes the top 5 beam entries (not just #1) and re-scores all of them
      // to pick the final answer -- repairing only beam[0] left ranks #2-#5 completely
      // unchecked, and confirmed on a real Knox cold-start run: an illegal allocation (A
      // Pirates Life For Knox at 0 while the gated Timeless Mastery stayed maxed) reached the
      // saved build because app.js's own re-scoring picked one of those never-repaired lower
      // ranks, not beam[0]. Repair every entry that could realistically end up in that
      // shortlist, not just the presumptive #1.
      for (let i = 0; i < beam.length; i++) {
        const repaired = await repairLegality(cfg, pool, mode, searchIterations, beam[i]);
        if (repaired) {
          beam[i] = repaired;
          evalsDone += repaired.evalsUsed;
          allSeen.set(sigOf(beam[i]), beam[i]);
        }
      }
      beam = dedupTopK(beam, beamWidth);

      return { beam, allSeen: [...allSeen.values()], generations: result.generations, evalsDone };
    } finally {
      pool.terminate();
    }
  }

  global.beamSearchBrowser = beamSearchBrowser;
})(window);
