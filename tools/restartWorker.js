'use strict';
// Runs ONE simulated-annealing restart chain inside its own worker thread (own V8 heap,
// own WASM instance) so multiple restarts genuinely run in parallel across CPU cores
// instead of interleaving on a single thread.
const { workerData, parentPort } = require('worker_threads');
const { runSingleRestart } = require('./optimizer');

(async () => {
  const cfg = require(workerData.configPath);
  const top = await runSingleRestart(cfg, {
    mode: workerData.mode,
    steps: workerData.steps,
    searchIterations: workerData.searchIterations,
    seeded: workerData.seeded,
    topK: workerData.topK,
    restartLabel: workerData.restartLabel,
  });
  parentPort.postMessage(top.map((c) => ({ talentAlloc: c.talentAlloc, attrAlloc: c.attrAlloc, score: c.score })));
})();
