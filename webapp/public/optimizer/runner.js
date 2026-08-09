// Browser entry point for the optimizer: stands up a pool of scoring workers, hands
// search.js a parallel scorer, and tears the pool down afterwards.
//
// The division of labour is deliberate. search.js owns the ALGORITHM and is completely
// synchronous in its logic -- it emits batches of candidate allocations and consumes scores.
// This file owns the PARALLELISM and nothing else. That is why the Node benchmark can run the
// identical search with a plain single-threaded scorer and prove something meaningful about
// what ships: the two differ only in how scores are fetched, never in what gets searched.
(function (global) {
  'use strict';

  // Bump alongside the ?v= on the <script> tags in index.html. A Worker URL is cached
  // independently of the page, so without this a worker.js change silently keeps running the
  // previous version after a reload.
  const WORKER_VERSION = '20260809f';

  // Each worker compiles and holds its OWN copy of the WASM module and churns a fresh instance
  // per evaluation (required for determinism -- the evaluator's RNG state lives in mutable wasm
  // globals). That is fine per worker but multiplies: at high levels, one pool per logical core
  // reliably hit "Cannot allocate Wasm memory for new instance" partway through a search, while
  // the identical workload single-threaded completed cleanly. Cap the pool so total WASM
  // residency stays bounded regardless of how many cores the machine reports.
  const MAX_POOL_SIZE = 6;

  class ScoringPool {
    constructor(cfg, mode, size) {
      this.workers = [];
      this.pending = new Map();
      this.nextRequestId = 0;
      this.readyPromises = [];

      for (let i = 0; i < size; i++) {
        const worker = new Worker(`optimizer/worker.js?v=${WORKER_VERSION}`);
        const ready = new Promise((resolve) => {
          worker.onmessage = (e) => {
            if (e.data.type !== 'ready') return;
            worker.onmessage = (ev) => this._onMessage(ev);
            resolve(e.data.error || null);
          };
          // Always resolves, so ready() can never hang on a worker that failed to load.
          worker.onerror = (e) => resolve(String((e && e.message) || 'worker failed to load'));
        });
        worker.postMessage({ type: 'init', cfg: serializeCfg(cfg), mode });
        this.readyPromises.push(ready);
        this.workers.push(worker);
      }
    }

    _onMessage(e) {
      const msg = e.data;
      if (msg.type !== 'scored') return;
      const entry = this.pending.get(msg.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.scores);
    }

    /** First init error, or null if every worker came up clean. */
    async ready() {
      const errors = await Promise.all(this.readyPromises);
      return errors.find((e) => e) || null;
    }

    /** Score a batch, split evenly across workers, preserving input order. */
    async score(pairs, iterations) {
      if (!pairs.length) return [];
      const n = this.workers.length;
      const chunks = Array.from({ length: n }, () => []);
      const placement = pairs.map((pair, i) => {
        const w = i % n;
        const pos = chunks[w].length;
        chunks[w].push(pair);
        return { w, pos };
      });

      const chunkScores = await Promise.all(chunks.map((batch, w) => {
        if (!batch.length) return Promise.resolve([]);
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          this.workers[w].postMessage({ type: 'score', requestId, iterations, batch });
        });
      }));

      return placement.map(({ w, pos }) => chunkScores[w][pos]);
    }

    terminate() {
      this.workers.forEach((w) => w.terminate());
      this.pending.clear();
    }
  }

  // Only the fields a worker needs to compile an evaluator. gemPlannerStore is REQUIRED:
  // compileEvaluator's resolveParam reads every gems_nodes param from it specifically, not
  // from globalUpgrades. Omitting it makes workers score in a gem-less world while the build
  // card scores in the real one, so the search optimizes a different game than the one being
  // displayed.
  function serializeCfg(cfg) {
    return {
      hunter: cfg.hunter,
      level: cfg.level,
      hunterStats: cfg.hunterStats,
      baseOverrides: cfg.baseOverrides,
      globalUpgrades: cfg.globalUpgrades,
      gemPlannerStore: cfg.gemPlannerStore,
      TALENTS: cfg.TALENTS,
      ATTRIBUTES: cfg.ATTRIBUTES,
    };
  }

  /**
   * Run the optimizer for a build.
   *
   * @param {object} cfg      as built by app.js's cfgFor()
   * @param {object} options  { mode, onProgress, shouldCancel, poolSize }
   * @returns the search result: { best, ranked, evals, cacheHits, notes, cancelled }
   */
  async function runOptimizer(cfg, { mode = 'loot', onProgress = () => {}, shouldCancel = () => false, poolSize } = {}) {
    const size = poolSize || Math.max(2, Math.min(MAX_POOL_SIZE, (navigator.hardwareConcurrency || 4) - 1));
    const pool = new ScoringPool(cfg, mode, size);
    try {
      const initError = await pool.ready();
      if (initError) {
        // "worker failed to load" almost always means the PAGE is stale, not that the optimizer
        // is broken: a cached index.html requests asset URLs from an older release, and any that
        // were renamed or deleted 404. Say so, because the raw message sends people looking in
        // the wrong place. app.js's reloadIfShellIsStale() normally repairs this automatically.
        const stale = /failed to load/i.test(initError)
          ? ' This usually means the page is a cached older version — reload (or pull to refresh) and try again.'
          : '';
        throw new Error(`Optimizer worker failed to initialize: ${initError}.${stale}`);
      }
      return await global.HunterOptimizer.optimize(cfg, {
        mode,
        scorer: (pairs, iterations) => pool.score(pairs, iterations),
        onProgress,
        shouldCancel,
      });
    } finally {
      pool.terminate();
    }
  }

  global.runOptimizer = runOptimizer;
})(window);
