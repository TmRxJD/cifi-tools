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
self.HUNTERSIM_ASSET_BASE = new URL('..', location.href).href;
importScripts('../hunterDefs.js', '../hunterSimBrowser.js');

let evalFast = null;
let scoreKey = 'lootPerMin';

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
      return await evalFast(item.talentAlloc, item.attrAlloc, iterations);
    } catch (err) {
      const message = String((err && err.message) || err);
      if (!/out of memory|cannot allocate/i.test(message)) throw err;
      lastError = err;
      await sleep(delay);
    }
  }
  throw lastError;
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    // A throw here must still post a reply. If it doesn't, the main thread's ready() promise
    // never settles and the whole optimizer hangs with Cancel unable to help, because cancel is
    // only consulted after the pool is up.
    try {
      evalFast = await HunterSim.compileEvaluator(msg.cfg.hunter, msg.cfg);
      scoreKey = msg.mode === 'push' ? 'avgStage' : 'lootPerMin';
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'ready', error: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === 'score') {
    const { requestId, iterations, batch } = msg;
    const scores = [];
    try {
      let sinceYield = 0;
      for (const item of batch) {
        const r = await evaluateWithGcRetry(item, iterations);
        scores.push(r[scoreKey]);
        // Determinism requires a FRESH WASM instance per evaluation (the evaluator's RNG state
        // lives in mutable wasm globals -- verified: restoring linear memory alone leaves the
        // instance in a state that aborts on the next call, so there is no cheaper reset).
        // Each instance reserves a large guard region, and an unbroken await-chain of
        // microtasks never lets the GC reclaim the dead ones: at high levels that reliably hit
        // "Cannot allocate Wasm memory for new instance" partway through a search. Yielding to
        // the macrotask queue periodically gives the collector a chance to run. This costs a
        // few milliseconds per batch and does not change any score.
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      self.postMessage({ type: 'scored', requestId, scores });
    } catch (err) {
      // Fail the request explicitly rather than returning a sentinel score. A candidate that
      // cannot be evaluated is a bug to surface, not a candidate to silently rank last -- the
      // old engine's -Infinity fallback let real evaluation failures pass as "bad builds".
      self.postMessage({ type: 'scored', requestId, error: String((err && err.message) || err) });
    }
  }
};
