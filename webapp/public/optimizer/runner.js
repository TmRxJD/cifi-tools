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
  const WORKER_VERSION = '20260905h';

  // Each worker compiles and holds its OWN copy of the WASM module and churns a fresh instance
  // per evaluation (required for determinism -- the evaluator's RNG state lives in mutable wasm
  // globals). That is fine per worker but multiplies: at high levels, one pool per logical core
  // reliably hit "Cannot allocate Wasm memory for new instance" partway through a search, while
  // the identical workload single-threaded completed cleanly. Cap the pool so total WASM
  // residency stays bounded regardless of how many cores the machine reports.
  const MAX_POOL_SIZE = 6;

  // The live pool, reused across runs. Module-scoped rather than per-call, which is the whole
  // point: rebuilding it every run is what exhausted wasm memory.
  let cachedPool = null;

  class ScoringPool {
    constructor(cfg, mode, size, scoreCtxOverride) {
      this.scoreCtxOverride = scoreCtxOverride || null;
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
        worker.postMessage({ type: 'init', cfg: serializeCfg(cfg), mode, scoreCtxOverride: this.scoreCtxOverride });
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
      // DROP EVERY REFERENCE, not just the workers. Each worker holds a compiled WASM module and
      // an instance; the browser reclaims that lazily, so anything still pointing at a terminated
      // worker keeps its memory alive. Three optimize runs in one page session were enough to hit
      // "Cannot allocate Wasm memory for new instance" -- a user pressing Optimize a third time
      // without reloading, which is entirely ordinary.
      this.workers.forEach((w) => {
        w.onmessage = null;
        w.onerror = null;
        w.terminate();
      });
      this.workers.length = 0;
      this.readyPromises.length = 0;
      this.pending.clear();
    }
  }

  // The worker's view of the config comes from AccountState's adapter, not a field list kept
  // here. This used to be a hand-written copy, and an earlier version of it omitted
  // gemPlannerStore -- so every worker scored candidates in a gem-less world while the build card
  // scored the real one, and the optimizer optimized a different game than the page displayed.
  // The adapter throws on a missing field instead.
  function serializeCfg(cfg) {
    return global.AccountState.workerCfg(cfg);
  }


  /**
   * Run the optimizer for a build.
   *
   * @param {object} cfg      as built by app.js's cfgFor()
   * @param {object} options  { mode, onProgress, shouldCancel, poolSize }
   * @returns the search result: { best, ranked, evals, cacheHits, notes, cancelled }
   */
  async function runOptimizer(cfg, { mode = 'loot', effort, onProgress = () => {}, shouldCancel = () => false, poolSize } = {}) {
    const size = poolSize || Math.max(2, Math.min(MAX_POOL_SIZE, (navigator.hardwareConcurrency || 4) - 1));
    // POOLS ARE REUSED ACROSS RUNS, not built and thrown away each time.
    //
    // Every run used to allocate a fresh set of workers, each compiling its own WASM instance, and
    // terminate them at the end. The browser reclaims that memory lazily, so back-to-back runs
    // raced it: two consecutive level-62 Ozzy optimizes died with "Cannot allocate Wasm memory for
    // new instance". Pressing Optimize twice is not an unusual thing to do.
    //
    // Keyed by the serialized cfg and mode, because that is exactly what a worker is initialised
    // with -- if either changes the old pool cannot answer for the new account and is replaced.
    const poolKey = `${mode}|${JSON.stringify(serializeCfg(cfg))}`;
    if (cachedPool && cachedPool.key !== poolKey) {
      cachedPool.pool.terminate();
      for (const p of cachedPool.crossPools.values()) p.terminate();
      cachedPool = null;
    }
    if (!cachedPool) {
      cachedPool = { key: poolKey, pool: new ScoringPool(cfg, mode, size), crossPools: new Map() };
    }
    const pool = cachedPool.pool;
    // Cross-seed pools, keyed by (mode, context). A pool is bound to ONE objective at init, so a
    // second objective needs its own; built lazily, so a mode that does not cross-seed never pays.
    // Cached alongside the main pool for the same reason.
    const crossPools = cachedPool.crossPools;
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
        // Omitted rather than defaulted here: optimize() owns DEFAULT_EFFORT, so there is one
        // place that decides what an unspecified effort means.
        ...(effort ? { effort } : {}),
        scorer: (pairs, iterations) => pool.score(pairs, iterations),
        // Tracked so `finally` terminates it even when the search throws or is cancelled: leaking
        // a pool leaks a WASM module per worker, which is what MAX_POOL_SIZE exists to prevent.
        scorerFor: async (crossMode, ctxOverride) => {
          const key = `${crossMode}|${JSON.stringify(ctxOverride || null)}`;
          if (!crossPools.has(key)) {
            // HALF SIZE, AND AT LEAST 2. A cross-seed pool is a SECOND set of workers, each
            // holding its own WASM module, alive at the same time as the main pool -- which is
            // precisely what MAX_POOL_SIZE exists to bound. At full size the pair exceeded the
            // browser's wasm allocation on a level-60 Borge and the search died with
            // "Cannot allocate Wasm memory for new instance".
            //
            // The pass is a single extra search whose answer is then judged like any other
            // candidate, so halving its parallelism costs some wall clock on the builds that need
            // it and nothing at all on the builds that skip it.
            const crossSize = 2;   // secondary search: minimum viable parallelism
            const crossPool = new ScoringPool(cfg, crossMode, crossSize, ctxOverride);
            crossPools.set(key, crossPool);
            const err = await crossPool.ready();
            if (err) throw new Error(`Cross-seed worker failed to initialize: ${err}`);
          }
          const p = crossPools.get(key);
          return (pairs, iterations) => p.score(pairs, iterations);
        },
        onProgress,
        shouldCancel,
      });
    } finally {
      // THE MAIN POOL IS KEPT, THE CROSS-SEED POOL IS NOT.
      //
      // The main pool is used throughout every run, so rebuilding it each time is what exhausted
      // wasm memory in the first place. The cross-seed pool is used for ONE pass, and holding it
      // afterwards means two pools' worth of WASM instances alive between runs -- which brought
      // the OOM straight back on a level-62 Ozzy (6 main + 3 cross workers, each with its own
      // instance). Freed here; rebuilt on demand by the next run that actually cross-seeds.
      for (const p of cachedPool.crossPools.values()) p.terminate();
      cachedPool.crossPools.clear();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Release the cached workers -- for when the app knows no further run is coming. */
  function releaseScoringPools() {
    if (!cachedPool) return;
    cachedPool.pool.terminate();
    for (const p of cachedPool.crossPools.values()) p.terminate();
    cachedPool = null;
  }

  global.runOptimizer = runOptimizer;
  global.releaseScoringPools = releaseScoringPools;
})(window);
