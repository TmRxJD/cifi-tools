'use strict';
// Embedded optimization must use cifi-tools' own same-origin evaluator worker. Recreating that
// worker behind an extension iframe measured 151-219s for the same real-account Fast run that the
// native worker completes in 58.5s. Cancellation remains pool termination, because cooperative
// checks cannot interrupt synchronous WASM already running in a worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const runner = fs.readFileSync(path.join(ROOT, 'webapp/public/optimizer/runner.js'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'webapp/public/optimizer/worker.js'), 'utf8');
const routing = fs.readFileSync(path.join(ROOT, 'extension/hostRouting.js'), 'utf8');
const manifest = fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8');

try {

function acceptsNativeWorker(source, hostSource, manifestSource) {
  return source.includes('class NativeEvaluationWorker')
    && source.includes("new Worker(url, { type: 'module' })")
    && source.includes("this.rpc('evaluate'")
    && hostSource.includes('evaluationWorker-')
    && hostSource.includes('dataset.evaluationWorkerUrl')
    && !source.includes('HUNTERSIM_WORKER_HOST_URL')
    && !manifestSource.includes('workerHost.html');
}
function acceptsCancel(source) {
  return source.includes('function cancelOptimizerRun(')
    && source.includes('pending.forEach(({ reject }) => reject(error))')
    && source.includes('global.cancelOptimizerRun = cancelOptimizerRun');
}
function boundsLostNativeReplies(source) {
  return source.includes('Native evaluation worker timed out after 60s')
    && source.includes('this.pending.delete(id)')
    && source.includes('this.pending.forEach(({reject,timer})');
}
function avoidsThrottledYield(source) {
  const score = source.indexOf("if (msg.type === 'score')");
  const counter = source.indexOf('let evaluationsSinceYield = 0;', score);
  return score >= 0 && counter > score && counter - score < 1000;
}

assert(acceptsNativeWorker(runner, routing, manifest), 'embedded mode must use the native evaluation worker directly');
assert(acceptsCancel(runner), 'runner must expose pool-level cancellation');
assert(boundsLostNativeReplies(runner), 'native worker death must reject pending evaluation RPCs');
assert(avoidsThrottledYield(worker), 'standalone worker yield counter must reset per batch');

// Known-bad replays: prove each structural regression is rejected.
assert(!acceptsNativeWorker(runner.replace('class NativeEvaluationWorker', 'class ReimplementedWorker'), routing, manifest),
  'negative control: missing native adapter was accepted');
assert(!acceptsNativeWorker(runner, routing.replace('dataset.evaluationWorkerUrl', 'dataset.otherUrl'), manifest),
  'negative control: missing native worker discovery was accepted');
assert(!acceptsCancel(runner.replace('global.cancelOptimizerRun = cancelOptimizerRun;', '')),
  'negative control: missing cancel export was accepted');
assert(!boundsLostNativeReplies(runner.replace('Native evaluation worker timed out after 60s','unbounded native request')),
  'negative control: an unbounded native worker request was accepted');
assert(!avoidsThrottledYield(worker.replace("if (msg.type === 'score') {", "if (msg.type === 'score') {\n".repeat(80))),
  'negative control: counter outside the batch boundary was accepted');

console.log('PASS  native evaluator worker, bounded lost replies, unthrottled batches, and immediate pool cancellation');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
