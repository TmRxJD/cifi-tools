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
  const WORKER_VERSION = '20260910b-path-pool';

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
  let activePool = null;

  function abortError() {
    const error = new Error('Optimizer cancelled');
    error.name = 'AbortError';
    return error;
  }

  // cifi-tools already owns a same-origin evaluation worker. Embedded mode uses that exact worker
  // rather than moving the search into a hidden extension document, which Chrome deprioritizes.
  // This adapter presents the small Worker-shaped protocol ScoringPool already consumes while the
  // underlying request is the site's Comlink wire format and evaluator.
  class NativeEvaluationWorker {
    constructor() {
      const registry = document.getElementById('cifi-companion-navigation');
      const url = registry?.dataset.evaluationWorkerUrl;
      if (!url) throw new Error('cifi-tools evaluation worker URL is unavailable');
      this.worker = new Worker(url, { type: 'module' });
      this.onmessage = null;
      this.onerror = null;
      this.cfg = null;
      this.mode = null;
      this.scoreCtxOverride = null;
      this.pending = new Map();
      this.nextId = 0;
      this.worker.onerror = event => {
        const error=new Error(event?.message || 'Native evaluation worker failed');
        this.pending.forEach(({reject,timer})=>{ clearTimeout(timer); reject(error); });
        this.pending.clear();
        this.onerror?.(event);
      };
      this.worker.onmessage = event => {
        const entry = this.pending.get(event.data?.id);
        if (!entry) return;
        this.pending.delete(event.data.id);
        clearTimeout(entry.timer);
        if (event.data.type === 'RAW') entry.resolve(event.data.value);
        else entry.reject(new Error(event.data.value?.message || 'Native evaluation worker failed'));
      };
    }

    rpc(method, args) {
      const id = `cifi-${++this.nextId}`;
      return new Promise((resolve, reject) => {
        // A worker process can disappear without dispatching an ErrorEvent (observed as the UI
        // sitting forever at one tuning percentage). Bound every native RPC so that failure is
        // reported and the optimizer modal can close/cancel instead of awaiting a lost reply.
        const timer=setTimeout(()=>{
          if (!this.pending.delete(id)) return;
          reject(new Error(`Native evaluation worker timed out after 60s (${id})`));
        },60000);
        this.pending.set(id, { resolve, reject, timer });
        this.worker.postMessage({
          id, type: 'APPLY', path: [method],
          argumentList: args.map(value => ({ type: 'RAW', value })),
        });
      });
    }

    postMessage(message) {
      if (message.type === 'engine') return; // the native worker loads its own same-origin engine
      if (message.type === 'init') {
        this.cfg = message.cfg;
        this.mode = message.mode;
        this.scoreCtxOverride = message.scoreCtxOverride;
        queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
        return;
      }
      if (message.type !== 'score') return;
      (async () => {
        try {
          const scores = [];
          const boss = [];
          const ctx = { ...global.OptimizerObjective.contextFor(this.cfg), ...(this.scoreCtxOverride || {}) };
          for (const item of message.batch) {
            const upgrades = JSON.parse(JSON.stringify(this.cfg.globalUpgrades || {}));
            Object.entries(item.upgradeValues || {}).forEach(([param, value]) => {
              const [, category, id] = param.split('.');
              if (!upgrades[category]) upgrades[category] = {};
              upgrades[category][id] = value;
            });
            const build = {
              level: this.cfg.level,
              talents: item.talentAlloc,
              attributes: item.attrAlloc,
              overrides: { ...(this.cfg.baseOverrides || {}), ...(item.upgradeValues || {}) },
            };
            const storeData = {
              hunterStats: { [this.cfg.hunter]: item.hunterStats || this.cfg.hunterStats },
              upgrades,
              hunterIterations: { [this.cfg.hunter]: message.iterations },
              hunterSeedSettings: {},
              gemPlannerStore: this.cfg.gemPlannerStore,
            };
            const result = await this.rpc('evaluate', [this.cfg.hunter, build, storeData]);
            scores.push(global.OptimizerObjective.scoreFor(this.mode, result, ctx));
            boss.push({ kill: result.bossKillRate, hp: result.bossHpPercent, maxStage: result.maxStage });
          }
          this.onmessage?.({ data: { type: 'scored', requestId: message.requestId, scores, boss } });
        } catch (error) {
          this.onmessage?.({ data: { type: 'scored', requestId: message.requestId, error: String(error?.message || error) } });
        }
      })();
    }

    terminate() {
      const error = abortError();
      this.pending.forEach(({ reject,timer }) => { clearTimeout(timer); reject(error); });
      this.pending.clear();
      this.worker.terminate();
    }
  }

  function scoringWorker() {
    return global.HUNTERSIM_EMBEDDED
      ? new NativeEvaluationWorker()
      : new Worker(global.HUNTERSIM_WORKER_URL || `optimizer/worker.js?v=${WORKER_VERSION}`);
  }

  class ScoringPool {
    constructor(cfg, mode, size, scoreCtxOverride) {
      this.scoreCtxOverride = scoreCtxOverride || null;
      this.workers = [];
      this.pending = new Map();
      this.nextRequestId = 0;
      this.readyPromises = [];

      for (let i = 0; i < size; i++) {
        // Standalone uses our shipped worker. Embedded mode uses cifi-tools' own same-origin
        // evaluation worker through NativeEvaluationWorker above.
        const worker = scoringWorker();
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

      // THE ENGINE IS RESOLVED ONCE, HERE, AND HANDED TO EVERY WORKER.
      //
      // Only the main thread can reach the companion extension, so only it can obtain
      // cifi-tools' evaluator without our site serving a copy. Compiling once and cloning the
      // Module to each worker is also strictly cheaper than N fetches and N compiles.
      //
      // A failure is FORWARDED rather than swallowed: each worker is waiting on an injected
      // module, so without this every one of them would wait forever and ready() would never
      // settle -- the hang that the onerror handler above exists to prevent for the other
      // failure mode.
      this.enginePromise = (global.HUNTERSIM_EMBEDDED
        ? Promise.resolve({})
        : HunterSim.loadWasmModule().then((module) => ({ module })))
        .then((engine) => {
        // A compiled WebAssembly.Module does not survive the page-origin -> extension-origin
        // MessageChannel relay in Chromium. Embedded mode passes the bytes fetched directly from
        // cifi-tools.com's own origin and each extension worker compiles them locally. Nothing is
        // hosted, persisted or fetched by the extension origin.
        this.workers.forEach((w) => w.postMessage({ type: 'engine', ...engine }));
        return null;
      }).catch((err) => {
        const error = String((err && err.message) || err);
        this.workers.forEach((w) => w.postMessage({ type: 'engine', error }));
        return error;
      });
    }

    _onMessage(e) {
      const msg = e.data;
      if (msg.type !== 'scored') return;
      const entry = this.pending.get(msg.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve({ scores: msg.scores, boss: msg.boss || [] });
    }

    /** First init error, or null if every worker came up clean. */
    async ready() {
      // The engine is awaited alongside the workers, so a pool is never reported ready while its
      // evaluator is still unresolved -- scoring may only start once both are settled.
      const workerReadiness = Promise.race([
        Promise.all(this.readyPromises),
        new Promise((resolve) => setTimeout(() => resolve(['worker initialization timed out']), 20000)),
      ]);
      const [engineError, errors] = await Promise.all([this.enginePromise, workerReadiness]);
      return engineError || errors.find((e) => e) || null;
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

      const chunkResults = await Promise.all(chunks.map((batch, w) => {
        if (!batch.length) return Promise.resolve([]);
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          this.workers[w].postMessage({ type: 'score', requestId, iterations, batch });
        });
      }));

      // Scores are returned as before. Boss progress rides alongside on `score.boss`, so callers
      // that want it (screening) can read it and callers that do not are unaffected.
      const out = placement.map(({ w, pos }) => chunkResults[w].scores[pos]);
      out.boss = placement.map(({ w, pos }) => (chunkResults[w].boss || [])[pos]);
      return out;
    }

    terminate() {
      // DROP EVERY REFERENCE, not just the workers. Each worker holds a compiled WASM module and
      // an instance; the browser reclaims that lazily, so anything still pointing at a terminated
      // worker keeps its memory alive. Three optimize runs in one page session were enough to hit
      // "Cannot allocate Wasm memory for new instance" -- a user pressing Optimize a third time
      // without reloading, which is entirely ordinary.
      const error = abortError();
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
      this.workers.forEach((w) => {
        w.onmessage = null;
        w.onerror = null;
        w.terminate();
      });
      this.workers.length = 0;
      this.readyPromises.length = 0;
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
  async function runOptimizer(cfg, { mode = 'loot', effort, maxSeconds, onProgress = () => {}, shouldCancel = () => false, poolSize } = {}) {
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
    const pool = acquirePool(cfg, mode, size);
    activePool = pool;
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
        // Forwarded only when the caller set it, for the same reason as `effort`: optimize() owns
        // the default, so there is one place that decides what "unspecified" means.
        ...(Number.isFinite(maxSeconds) ? { maxSeconds } : {}),
        scorer: (pairs, iterations) => pool.score(pairs, iterations),
        // Tracked so `finally` terminates it even when the search throws or is cancelled: leaking
        // a pool leaks a WASM module per worker, which is what MAX_POOL_SIZE exists to prevent.
        onProgress,
        shouldCancel,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (cachedPool?.pool === pool) cachedPool = null;
        return { best: null, ranked: [], cancelled: true };
      }
      throw error;
    } finally {
      if (activePool === pool) activePool = null;
      // The pool is REUSED by the next run with the same account and mode -- rebuilding six WASM
      // instances per run is what exhausted memory after two consecutive level-62 Ozzy optimizes.
      // It is released when that key changes, or by releaseScoringPools().
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Release the cached workers -- for when the app knows no further run is coming. */
  function releaseScoringPools() {
    if (!cachedPool) return;
    cachedPool.pool.terminate();
    cachedPool = null;
  }

  function cancelOptimizerRun() {
    if (!activePool) return;
    const pool = activePool;
    activePool = null;
    if (cachedPool?.pool === pool) cachedPool = null;
    pool.terminate();
  }

  // Purchase paths vary base stats/upgrades instead of talent/attribute allocations, but they use
  // the same evaluator and need the same bounded parallelism. Expose a narrowly-scoped scorer so
  // hunterStatPathBrowser.js can batch a whole candidate sweep across this canonical worker pool.
  //
  // THE PATH NOW REUSES ITS POOL EXACTLY AS THE SIM DOES. It used to build a new ScoringPool on
  // every call and terminate it at the end -- so every Effective Path open, and every mode switch
  // inside it, paid a full worker spin-up and a WASM compile per worker before scoring anything.
  // That fixed cost is the "slow to generate" that the optimizer had long since stopped paying.
  async function createHunterPathScorer(cfg, mode) {
    const size = Math.max(2, Math.min(MAX_POOL_SIZE, (navigator.hardwareConcurrency || 4) - 1));
    const pool = acquirePool(cfg, mode, size);
    const error = await pool.ready();
    if (error) {
      if (cachedPool?.pool === pool) cachedPool = null;
      pool.terminate();
      throw new Error(`Effective Path worker failed to initialize: ${error}`);
    }
    return {
      score: (items, iterations) => pool.score(items, iterations),
      // Finishing a run RELEASES the pool for the next one; only an abort destroys it, because
      // terminating is the one way to stop a batch already inside the workers.
      release: () => {},
      abort: () => {
        if (cachedPool?.pool === pool) cachedPool = null;
        pool.terminate();
      },
    };
  }

  // ONE cache slot for every consumer, keyed by what a worker is initialised with. A second slot for
  // the path would hold a second set of up to MAX_POOL_SIZE WASM instances beside the optimizer's --
  // exactly the unbounded residency MAX_POOL_SIZE exists to prevent. Switching between the two
  // costs a rebuild; memory stays bounded.
  function acquirePool(cfg, mode, size) {
    const key = `${mode}|${JSON.stringify(serializeCfg(cfg))}`;
    if (cachedPool && cachedPool.key !== key) {
      cachedPool.pool.terminate();
      cachedPool = null;
    }
    if (!cachedPool) cachedPool = { key, pool: new ScoringPool(cfg, mode, size) };
    return cachedPool.pool;
  }

  global.runOptimizer = runOptimizer;
  global.releaseScoringPools = releaseScoringPools;
  global.cancelOptimizerRun = cancelOptimizerRun;
  global.createHunterPathScorer = createHunterPathScorer;
})(window);
