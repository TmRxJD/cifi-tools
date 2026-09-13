// Scoring worker. Compiles the WASM evaluator once on init, then scores batches of candidate
// allocations as they arrive. Holds no search state -- the search itself lives on the main
// thread in search.js, and this is purely the parallel arm of its scorer.
//
// hunterDefs.js assigns to `window.*` (it normally runs on the main thread) and a dedicated
// Worker's global is `self`, not `window`. Alias before importing so those assignments land on
// this worker's own global.
self.window = self;
// This worker lives one directory below the site root, so relative fetch() inside
// hunterSimBrowser.js would resolve params.json/release.wasm against optimizer/ and 404.
// Pin the asset base to the root before importing it.
self.HUNTERSIM_ASSET_BASE = self.HUNTERSIM_ASSET_BASE || new URL('..', location.href).href;
const WORKER_ASSET_BASE = self.HUNTERSIM_ASSET_BASE;
importScripts(
  new URL('hunterDefs.js', WORKER_ASSET_BASE).href,
  new URL('hunterSimBrowser.js', WORKER_ASSET_BASE).href,
  new URL('optimizer/objective.js', WORKER_ASSET_BASE).href,
);

let evalFast = null;
let scoreMode = 'loot';
let scoreCtx = null;

// Evaluations between macrotask yields -- see the note in the scoring loop below.
const YIELD_EVERY = 32;

// Backoff delays (ms) used when the engine reports it cannot allocate memory for a new WASM
// instance. Each retry is preceded by a real timer so the garbage collector gets a turn.
const GC_RETRY_DELAYS = [0, 25, 100, 400];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Evaluate one candidate, retrying through a GC pause if the engine runs out of room for a new
 * WASM instance.
 *
 * Determinism forces a fresh instance per evaluation: the evaluator's RNG state lives in
 * mutable wasm globals, so a reused instance drifts, and restoring linear memory alone leaves
 * it in a state that aborts on the next call (both verified directly). Fresh instances are
 * cheap individually but each reserves a guard region, and a long await-chain of microtasks
 * never lets the collector reclaim the dead ones -- at high levels that surfaced as
 * "Cannot allocate Wasm memory for new instance" partway through a search.
 *
 * Retrying is safe rather than a papered-over failure: evaluation is a pure function of its
 * arguments, so the retried call returns the identical value the first attempt would have. If
 * every backoff is exhausted the error propagates and fails the search loudly.
 */
async function evaluateWithGcRetry(item, iterations) {
  // A 'score' message can only arrive after 'ready', because the pool awaits ready() before
  // scoring anything. State the invariant rather than trusting it: if it is ever violated the
  // failure should name the cause, not surface as "cannot invoke null" from inside a loop.
  if (!evalFast) throw new Error('scoring worker received a batch before init completed');
  let lastError = null;
  for (const delay of GC_RETRY_DELAYS) {
    try {
      return await evalFast(item.talentAlloc, item.attrAlloc, iterations, item.hunterStats, item.upgradeValues);
    } catch (err) {
      const message = String((err && err.message) || err);
      if (!/out of memory|cannot allocate/i.test(message)) throw err;
      lastError = err;
      await sleep(delay);
    }
  }
  throw lastError;
}

// A WORKER MUST NEVER FETCH THE ENGINE ITSELF. It has no `document`, so it cannot reach the
// companion extension (a content script does not run in workers), and falling back to fetching
// `release.wasm` from our own origin is exactly the copy the extension exists to avoid serving.
// The pool resolves it once on the main thread and posts the COMPILED MODULE; this parks the
// loader on a promise that message settles, so an engine that never arrives WAITS visibly rather
// than silently downloading one.
HunterSim.expectInjectedWasm();

self.onmessage = async (e) => {
  const msg = e.data;

  // Delivered by ScoringPool right after `init`. `init` is async and awaits the module, so this
  // message is processed while it waits -- the ordering is safe by construction, not by luck.
  if (msg.type === 'engine') {
    if (msg.error) HunterSim.failWasmModule(msg.error);
    else {
      try {
        const module = msg.module || await WebAssembly.compile(msg.bytes);
        HunterSim.setWasmModule(module);
      } catch (error) {
        HunterSim.failWasmModule(String((error && error.message) || error));
      }
    }
    return;
  }

  if (msg.type === 'init') {
    // A throw here must still post a reply. If it doesn't, the main thread's ready() promise
    // never settles and the whole optimizer hangs with Cancel unable to help, because cancel is
    // only consulted after the pool is up.
    try {
      evalFast = await HunterSim.compileEvaluator(msg.cfg.hunter, msg.cfg);
      scoreMode = msg.mode;
      OptimizerObjective.modeOrThrow(scoreMode); // fail loudly on an unknown mode, not silently as loot
      // Derived once per worker from the cfg it was initialised with -- the boss target cannot
      // change mid-search, and recomputing it per evaluation would be per-eval work for a constant.
      // An objective-context override, kept because a caller may legitimately need to score a
      // mode with different context (e.g. a bench pinning a boss target).
      scoreCtx = { ...OptimizerObjective.contextFor(msg.cfg), ...(msg.scoreCtxOverride || {}) };
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'ready', error: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === 'score') {
    const { requestId, iterations, batch } = msg;
    const scores = [];
    // BOSS PROGRESS TRAVELS WITH THE SCORE. The evaluator returns bossKillRate and bossHpPercent
    // in the same result as lootPerMin, at no extra cost -- discarding them is what forced a whole
    // second search to recover the same information. The search uses them to keep boss-capable
    // shapes in play while still ranking on the caller's objective.
    const boss = [];
    try {
      let evaluationsSinceYield = 0;
      for (const item of batch) {
        const r = await evaluateWithGcRetry(item, iterations);
        scores.push(OptimizerObjective.scoreFor(scoreMode, r, scoreCtx));
        boss.push({ kill: r.bossKillRate, hp: r.bossHpPercent, maxStage: r.maxStage });
        // Determinism requires a FRESH WASM instance per evaluation (the evaluator's RNG state
        // lives in mutable wasm globals -- verified: restoring linear memory alone leaves the
        // instance in a state that aborts on the next call, so there is no cheaper reset).
        // Each instance reserves a large guard region, and an unbroken await-chain of
        // microtasks never lets the GC reclaim the dead ones: at high levels that reliably hit
        // "Cannot allocate Wasm memory for new instance" partway through a search. Yielding to
        // the macrotask queue periodically gives the collector a chance to run. This costs a
        // few milliseconds per batch and does not change any score.
        if (++evaluationsSinceYield >= YIELD_EVERY) {
          evaluationsSinceYield = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      self.postMessage({ type: 'scored', requestId, scores, boss });
    } catch (err) {
      // Fail the request explicitly rather than returning a sentinel score. A candidate that
      // cannot be evaluated is a bug to surface, not a candidate to silently rank last -- the
      // old engine's -Infinity fallback let real evaluation failures pass as "bad builds".
      self.postMessage({ type: 'scored', requestId, error: String((err && err.message) || err) });
    }
  }
};
