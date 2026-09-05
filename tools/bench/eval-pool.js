'use strict';
// A worker_threads EVALUATION POOL, so a bench can measure what the app measures without going
// through a browser.
//
// WHY THIS EXISTS. Every long measurement in this repo has had to run in the browser, because the
// shipped parallelism is `optimizer/runner.js` + `worker.js` -- Web Workers, unavailable to node.
// The bench harness therefore evaluated serially, which is roughly `cores` times slower: borge@73
// at the shipped effort is minutes with a pool and hours without.
//
// That forced measurements onto the least controllable surface available, and it cost a real
// result. The Browser pane's tab reports `hidden`, and a hidden tab clamps main-thread timers to
// ~1s. The worker pool then sits idle between dispatches: MEASURED, Chrome used 1.62 seconds of
// CPU across ALL processes in a 20-second window -- about 8% of ONE core -- while an A/B was
// supposedly running. The run was not slow, it was asleep, and nothing in the page said so.
//
// DETERMINISM IS PRESERVED, AND THE REASON IS A PROPERTY THIS REPO ALREADY ESTABLISHED. The
// evaluator returns bit-identical output for identical (allocation, iterations) given a fresh
// instance, and `compileEvaluator` makes a fresh instance per call. So a pair's score depends on
// the PAIR and on nothing else -- not on which worker ran it, not on ordering, not on how the
// batch was split. Results are reassembled in the caller's original order. The search's PRNG never
// leaves the main thread.
//
// `eval-pool-check.js` asserts the identity directly rather than resting on that argument.

const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

const DEFAULT_SIZE = Math.max(1, Math.min(8, os.cpus().length - 1));

class EvalPool {
  constructor(hunter, cfg, size) {
    this.size = size || DEFAULT_SIZE;
    this.hunter = hunter;
    this.workers = [];
    this.ready = null;
    this._seq = 0;
    this._pending = new Map();
    this._cfg = cfg;
  }

  async start() {
    const file = path.join(__dirname, 'eval-pool-worker.js');
    this.workers = [];
    const boots = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(file, { workerData: { hunter: this.hunter, cfg: this._cfg } });
      w.on('message', (msg) => {
        if (msg.type === 'ready') { w.__ready(); return; }
        const p = this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg);
      });
      // A worker that dies mid-batch must REJECT the batch, not hang it. A silent hang here reads
      // exactly like the throttled-browser failure this file exists to escape.
      w.on('error', (e) => { for (const [, p] of this._pending) p.reject(e); this._pending.clear(); });
      w.on('exit', (code) => {
        if (code !== 0 && this._pending.size) {
          const e = new Error(`eval-pool: worker exited with code ${code} mid-batch`);
          for (const [, p] of this._pending) p.reject(e);
          this._pending.clear();
        }
      });
      boots.push(new Promise((res) => { w.__ready = res; }));
      this.workers.push(w);
    }
    await Promise.all(boots);
    return this;
  }

  /** Evaluate `pairs` at `iterations`, returning results in the CALLER's order. */
  async evaluate(pairs, iterations) {
    if (!this.workers.length) throw new Error('eval-pool: evaluate() before start()');
    if (!pairs.length) return [];
    // Round-robin by index so every worker gets a contiguous share; the split cannot affect values.
    const n = this.workers.length;
    const chunks = Array.from({ length: n }, () => []);
    const origin = Array.from({ length: n }, () => []);
    pairs.forEach((p, i) => { chunks[i % n].push(p); origin[i % n].push(i); });

    const out = new Array(pairs.length);
    await Promise.all(chunks.map((chunk, k) => {
      if (!chunk.length) return Promise.resolve();
      const id = ++this._seq;
      const done = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
      this.workers[k].postMessage({ id, pairs: chunk, iterations });
      return done.then((msg) => {
        msg.results.forEach((r, j) => { out[origin[k][j]] = r; });
      });
    }));
    return out;
  }

  async destroy() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}

module.exports = { EvalPool, DEFAULT_SIZE };
