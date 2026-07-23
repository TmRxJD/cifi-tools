// Persistent pool worker (browser Web Worker version of poolWorker.js): compiles the
// WASM evaluator once when initialized, then stays alive scoring batches as they arrive.
importScripts('hunterSimBrowser.js');

let evalFast = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    evalFast = await HunterSim.compileEvaluator(msg.cfg.hunter, msg.cfg);
    self.postMessage({ type: 'ready' });
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
