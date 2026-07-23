'use strict';
// Persistent pool worker: loads the config + compiled WASM evaluator ONCE, then stays
// alive scoring batches of allocations as they arrive. This avoids the "spawn N workers,
// recompile WASM in each, throw them away" overhead of the old per-restart-worker design --
// the pool is created once per run and reused across every generation of the search.
const { workerData, parentPort } = require('worker_threads');
const { getEvalFast } = require('./optimizer');

const cfg = require(workerData.configPath);
const evalFast = getEvalFast(cfg);

parentPort.on('message', async (msg) => {
  if (msg.type === 'shutdown') { process.exit(0); }
  const { requestId, mode, iterations, batch } = msg;
  const results = [];
  for (const item of batch) {
    const r = await evalFast(item.talentAlloc, item.attrAlloc, iterations);
    results.push(mode === 'push' ? r.avgStage : r.lootPerMin);
  }
  parentPort.postMessage({ requestId, scores: results });
});
