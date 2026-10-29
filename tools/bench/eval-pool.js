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
    this._state = 'new';
    this._error = null;
    this._bootRejectors = new Set();
    this._termination = null;
    this._terminationErrors = [];
  }

  start() {
    if (this._error) return Promise.reject(this._cleanupFailure() || this._error);
    if (!this.ready) this.ready = this._start();
    return this.ready;
  }

  // A fatal lifecycle event invalidates the pool, including batches assigned to other workers.
  // Clear ownership before termination events arrive so expected exits cannot replace the cause.
  _stop(error, state = 'failed') {
    if (this._error) return;
    this._error = error instanceof Error ? error : new Error(String(error));
    this._state = state;
    for (const reject of this._bootRejectors) reject(this._error);
    this._bootRejectors.clear();
    for (const pending of this._pending.values()) pending.reject(this._error);
    this._pending.clear();
    const owned = this.workers;
    this.workers = [];
    this._termination = Promise.allSettled(owned.map(worker => Promise.resolve().then(() => worker.terminate())))
      .then(results => { this._terminationErrors = results.filter(result => result.status === 'rejected').map(result => result.reason); });
  }

  _cleanupFailure() {
    // Keep auto-cleanup observed without creating an unhandled background rejection. Startup
    // and destroy await every termination attempt and surface both cleanup errors and its cause.
    return this._terminationErrors.length
      ? new AggregateError(this._terminationErrors, `eval-pool: worker cleanup failed after ${this._error.message}`, {cause: this._error})
      : null;
  }

  async _start() {
    const file = path.join(__dirname, 'eval-pool-worker.js');
    const boots = [];
    try {
      if (this._error) throw this._error;
      this._state = 'starting';
      for (let i = 0; i < this.size; i++) {
        let resolveBoot, rejectBoot;
        boots.push(new Promise((resolve, reject) => { resolveBoot = resolve; rejectBoot = reject; }));
        this._bootRejectors.add(rejectBoot);
        const w = new Worker(file, { workerData: { hunter: this.hunter, cfg: this._cfg } });
        this.workers.push(w);
        let probing = false;
        w.on('message', msg => {
          if (this._error) return;
          if (msg.type === 'ready' && !msg.error) {
            if (probing) return;
            probing = true;
            // The existing worker's init catch sends ready THEN an out-of-band error. An empty
            // evaluation acknowledges that its message handler really installed, without running
            // WASM or touching RNG state. Ready alone cannot establish successful initialization.
            const id = ++this._seq;
            this._pending.set(id, {resolve: () => { this._bootRejectors.delete(rejectBoot); resolveBoot(); }, reject: rejectBoot});
            try { w.postMessage({id, pairs: [], iterations: 1}); }
            catch (error) { this._stop(error); }
            return;
          }
          const pending = this._pending.get(msg.id);
          if (!pending) {
            if (msg.error) this._stop(new Error(msg.error));
            return;
          }
          this._pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg);
        });
        w.on('error', error => this._stop(error));
        w.on('exit', code => this._stop(new Error(`eval-pool: worker exited with code ${code} (${this._state})`)));
      }
      await Promise.all(boots);
      if (this._error) throw this._error;
      this._state = 'running';
      return this;
    } catch (error) {
      this._stop(error);
      // Constructor failure can occur before Promise.all attaches to earlier boot promises.
      await Promise.allSettled(boots);
      await this._termination;
      throw this._cleanupFailure() || this._error;
    }
  }

  /** Evaluate `pairs` at `iterations`, returning results in the CALLER's order. */
  async evaluate(pairs, iterations) {
    if (this._error) throw this._error;
    if (this._state !== 'running') throw new Error('eval-pool: evaluate() before start() completed');
    if (!pairs.length) return [];
    // Round-robin by index so every worker gets a contiguous share; the split cannot affect values.
    const n = this.workers.length;
    const chunks = Array.from({ length: n }, () => []);
    const origin = Array.from({ length: n }, () => []);
    pairs.forEach((p, i) => { chunks[i % n].push(p); origin[i % n].push(i); });

    const out = new Array(pairs.length);
    await Promise.all(chunks.map((chunk, k) => {
      if (!chunk.length) return Promise.resolve();
      if (this._error) return Promise.reject(this._error);
      const id = ++this._seq;
      const done = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
      try { this.workers[k].postMessage({ id, pairs: chunk, iterations }); }
      catch (error) { this._stop(error); }
      return done.then((msg) => {
        msg.results.forEach((r, j) => { out[origin[k][j]] = r; });
      });
    }));
    return out;
  }

  async destroy() {
    this._stop(new Error('eval-pool: destroyed'), 'destroyed');
    await this._termination;
    const failure = this._cleanupFailure();
    if (failure) throw failure;
  }
}

module.exports = { EvalPool, DEFAULT_SIZE };
