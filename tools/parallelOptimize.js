'use strict';
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { scoreAllocation } = require('./optimizer');

function runWorkerRestart(configPath, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'restartWorker.js'), {
      workerData: { configPath, ...opts },
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`restart worker exited with code ${code}`)); });
  });
}

// A single-threaded calibration doesn't predict real throughput once N worker threads
// actually contend for the same physical cores (memory bandwidth, cache, scheduler) --
// on an 8-core/8-thread CPU we measured ~2.6x slower per-eval under full 8-way concurrent
// WASM load than in isolation. So: run a short REAL warmup batch at the intended
// concurrency level first, time it, and size the real step count off of that.
async function calibrateConcurrent(configPath, cfg, mode, searchIterations, restarts, warmupSteps, log) {
  const start = Date.now();
  const jobs = [];
  for (let r = 0; r < restarts; r++) {
    jobs.push(runWorkerRestart(configPath, { mode, steps: warmupSteps, searchIterations, seeded: false, topK: 1, restartLabel: `warmup-${r}` }));
  }
  await Promise.all(jobs);
  const elapsedMs = Date.now() - start;
  const msPerStepUnderLoad = elapsedMs / warmupSteps;
  log(`Warmup: ${restarts}-way concurrent, ${warmupSteps} steps took ${(elapsedMs / 1000).toFixed(1)}s -> ${msPerStepUnderLoad.toFixed(1)}ms/step under real load`);
  return msPerStepUnderLoad;
}

async function parallelOptimize(configPath, cfg, {
  mode = 'loot', searchIterations = 150, finalIterations = 1000,
  restarts = os.cpus().length, topK = 5,
  timeBudgetMs = 45000, minSteps = 150, maxSteps = 4000, warmupSteps = 40,
  log = () => {},
} = {}) {
  log(`Launching ${restarts} parallel restart workers (${os.cpus().length} CPU cores available)...`);
  const msPerStepUnderLoad = await calibrateConcurrent(configPath, cfg, mode, searchIterations, restarts, warmupSteps, log);
  const remainingBudgetMs = timeBudgetMs - warmupSteps * msPerStepUnderLoad;
  const steps = Math.min(maxSteps, Math.max(minSteps, Math.floor(remainingBudgetMs / msPerStepUnderLoad)));
  log(`Running ${restarts} restarts x ${steps} steps (fits remaining ${(remainingBudgetMs / 1000).toFixed(0)}s budget)...`);

  const jobs = [];
  for (let r = 0; r < restarts; r++) {
    jobs.push(runWorkerRestart(configPath, { mode, steps, searchIterations, seeded: r === 0, topK, restartLabel: r }));
  }
  const results = await Promise.all(jobs);
  log(`All restarts finished. Re-verifying ${results.flat().length} shortlisted candidates at ${finalIterations} iterations...`);

  // Mid-search shortlists are built from noisy low-iteration scores, so your real current
  // build can get evicted from a restart's top-K purely by chance even though it's seeded
  // in -- always include it explicitly so the final answer can never regress below it.
  const allCandidates = results.flat();
  if (cfg.currentTalents && cfg.currentAttrs) {
    allCandidates.push({ talentAlloc: cfg.currentTalents, attrAlloc: cfg.currentAttrs });
  }
  let best = null;
  for (const c of allCandidates) {
    const { score, result } = await scoreAllocation(cfg, c.talentAlloc, c.attrAlloc, mode, finalIterations);
    if (!best || score > best.score) best = { talentAlloc: c.talentAlloc, attrAlloc: c.attrAlloc, score, finalResult: result };
  }
  return best;
}

module.exports = { parallelOptimize };
