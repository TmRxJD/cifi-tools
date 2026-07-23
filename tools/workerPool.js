'use strict';
const path = require('path');
const { Worker } = require('worker_threads');

class WorkerPool {
  constructor(configPath, size) {
    this.workers = [];
    this.pending = new Map(); // requestId -> {resolve, reject}
    this.nextRequestId = 0;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(path.join(__dirname, 'poolWorker.js'), { workerData: { configPath } });
      worker.on('message', (msg) => {
        const p = this.pending.get(msg.requestId);
        if (p) { this.pending.delete(msg.requestId); p.resolve(msg.scores); }
      });
      worker.on('error', (err) => {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      });
      this.workers.push(worker);
    }
  }

  // Splits `items` (each {talentAlloc, attrAlloc}) evenly across the pool, scores them all
  // in parallel, returns scores in the SAME order as `items`.
  async scoreBatch(items, mode, iterations) {
    if (!items.length) return [];
    const n = this.workers.length;
    const chunks = Array.from({ length: n }, () => []);
    const chunkIndexOf = [];
    items.forEach((item, i) => {
      const w = i % n;
      chunkIndexOf.push({ w, pos: chunks[w].length });
      chunks[w].push(item);
    });

    const chunkResults = await Promise.all(
      chunks.map((batch, w) => {
        if (!batch.length) return Promise.resolve([]);
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          this.workers[w].postMessage({ requestId, mode, iterations, batch });
        });
      }),
    );

    return chunkIndexOf.map(({ w, pos }) => chunkResults[w][pos]);
  }

  async terminate() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

module.exports = { WorkerPool };
