// Persistent pool worker (browser Web Worker version of poolWorker.js): compiles the
// WASM evaluator once when initialized, then stays alive scoring batches as they arrive.
// hunterDefs.js unconditionally assigns to `window.*` (it's normally loaded on the main
// thread) -- a dedicated Worker's global scope has no `window`, only `self`, so importing it
// as-is would throw ReferenceError: window is not defined. Alias it before importing so those
// assignments land on this worker's own global instead.
self.window = self;
// hunterDefs.js must load first -- it defines window.GEM_UPGRADE_ALIASES, the single
// canonical alias table that hunterSimBrowser.js's resolveParam reads from (global.
// GEM_UPGRADE_ALIASES). Without it, compileEvaluator throws "Cannot read properties of
// undefined (reading 'catchUp')" on the first gem-aliased param it resolves -- and since that
// throw used to be uncaught in this worker's init handler, 'ready' never posted and the main
// thread's pool.ready() awaited forever: this was the actual "optimizer stuck at optimizing,
// Cancel does nothing" bug.
importScripts('hunterDefs.js', 'hunterSimBrowser.js');

let evalFast = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // If compileEvaluator throws (bad cfg, wasm/params fetch failure, etc.) and this isn't
    // caught, 'ready' never posts and the main thread's pool.ready() promise waits forever --
    // this was the "optimizer stuck at 'optimizing', Cancel does nothing" bug: cancel is only
    // checked *after* pool.ready() resolves, so a wedged init couldn't be escaped at all.
    try {
      evalFast = await HunterSim.compileEvaluator(msg.cfg.hunter, msg.cfg);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'ready', error: String(err && err.message || err) });
    }
    return;
  }
  if (msg.type === 'scoreBatch') {
    const { requestId, mode, iterations, batch } = msg;
    // evalFast is async now (it instantiates a fresh wasm instance per call to keep scoring
    // deterministic/reproducible -- see hunterSimBrowser.js), so these must run in sequence
    // rather than via a plain .map(). CRITICAL: if any single candidate throws (e.g. a
    // randomly-mutated talent/attribute combo trips the wasm's internal abort/assert), an
    // uncaught rejection here means self.postMessage never fires, and the main thread's
    // pending promise for this requestId waits forever -- freezing the whole beam search
    // (every generation awaits scoreBatch before continuing). This was the "optimizer
    // freezes partway through" bug: a per-item try/catch here so one bad candidate scores
    // as "reject this candidate" instead of hanging the entire worker.
    const scores = [];
    for (const item of batch) {
      try {
        const r = await evalFast(item.talentAlloc, item.attrAlloc, iterations);
        scores.push(mode === 'push' ? r.avgStage : r.lootPerMin);
      } catch (err) {
        scores.push(-Infinity);
      }
    }
    self.postMessage({ type: 'scoreResult', requestId, scores });
  }
};
