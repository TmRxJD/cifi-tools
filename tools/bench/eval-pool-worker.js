'use strict';
// One evaluation worker for eval-pool.js. It builds its OWN browser sandbox and its own compiled
// evaluator, so nothing is shared between threads except the config that was cloned in.
//
// It returns the RAW evaluator fields, not a score. Scoring belongs to the caller, on the main
// thread, through the one canonical Objective -- a worker that scored would be a second place
// where mode rules live, which is the parallel-implementation trap this repo bans.

const { parentPort, workerData } = require('worker_threads');
const H = require('./harness.js');

(async () => {
  const sb = H.browserSandbox();
  const evalFast = await sb.HunterSim.compileEvaluator(workerData.hunter, workerData.cfg);
  parentPort.postMessage({ type: 'ready' });

  parentPort.on('message', async (msg) => {
    try {
      const results = [];
      for (const p of msg.pairs) {
        const r = await evalFast(p.talentAlloc, p.attrAlloc, msg.iterations);
        // Every field the evaluator returns. Trimming this to the three the caller happens to want
        // today is how relic-sweep called r7 inert while it doubled materials, and how a Knox
        // investigation chased a search defect that was really bossKillRate 93.5 vs 0.
        results.push({
          lootPerMin: r.lootPerMin, avgStage: r.avgStage, avgTime: r.avgTime,
          minStage: r.minStage, maxStage: r.maxStage,
          bossHpPercent: r.bossHpPercent, bossKillRate: r.bossKillRate,
          mat1: r.mat1, mat2: r.mat2, mat3: r.mat3, xp: r.xp,
        });
      }
      parentPort.postMessage({ id: msg.id, results });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, error: String((e && e.stack) || e) });
    }
  });
})().catch((e) => {
  parentPort.postMessage({ type: 'ready' });
  parentPort.postMessage({ id: -1, error: String((e && e.stack) || e) });
});
