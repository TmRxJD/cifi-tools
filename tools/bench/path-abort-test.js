'use strict';
// Cancelling an Effective Path run must actually STOP the work, not just hide it.
//
// Closing the modal used to remove the overlay while leaving the walk running: invisible,
// uncancellable, and still competing for the main thread and for wasm instantiation, so each
// abandoned run made the next one slower. A stack of those is what once made a 7.5s path look
// like it took ten minutes.
//
// The regression this guards is subtle: a cancellation that is checked only between STEPS still
// burns a whole candidate sweep after the abort, which for the big columns is most of the cost.
// So this asserts on evaluation COUNT, not merely that the promise settles.
//
//   node tools/bench/path-abort-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness.js');

const PUBLIC = path.join(__dirname, '../../webapp/public');
const sb = H.browserSandbox();
sb.HunterOptimizer = H.Optimizer;
for (const f of ['hunterStatPath.js', 'hunterStatPathBrowser.js']) {
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), sb, { filename: f });
}

let failures = 0;
async function check(name, fn) {
  try {
    const problem = await fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.message}`);
    failures++;
  }
}

const HUNTER = 'borge';
const STEPS = 10;

async function cfgFor() {
  const known = H.loadKnownBuilds()[HUNTER];
  const fx = known[known.length - 1];
  const b = await H.parseBuildCode(fx.code);
  const defs = sb.HUNTER_DEFS[HUNTER];
  return {
    level: b.level, talents: b.talents, attributes: b.attributes,
    hunterStats: {}, baseOverrides: {}, globalUpgrades: {},
    gemPlannerStore: { gemStates: {} },
    TALENTS: defs.talents, ATTRIBUTES: defs.attributes,
  };
}

// Count evaluations by wrapping the compiled evaluator the walk builds for itself.
function countingEvaluator() {
  const orig = sb.HunterSim.compileEvaluator;
  const state = { calls: 0, restore: () => { sb.HunterSim.compileEvaluator = orig; } };
  sb.HunterSim.compileEvaluator = async function wrapped(hunter, cfg) {
    const f = await orig.call(this, hunter, cfg);
    return function counted(...args) { state.calls += 1; return f.apply(this, args); };
  };
  return state;
}

(async () => {
  const cfg = await cfgFor();

  // Baseline: how much work is a complete run? Everything below is measured against this.
  let full = 0;
  await check('a normal run completes and does real work', async () => {
    const c = countingEvaluator();
    try {
      const res = await sb.greedyPurchasePath(HUNTER, cfg, STEPS, true, 'loot');
      full = c.calls;
      if (!res || !res.columns) return 'no columns returned';
      if (full < 50) return `only ${full} evaluations -- too few for this to be a meaningful baseline`;
      return null;
    } finally { c.restore(); }
  });

  await check('aborting before the walk starts does almost no work', async () => {
    const ac = new AbortController();
    ac.abort();
    const c = countingEvaluator();
    try {
      await sb.greedyPurchasePath(HUNTER, cfg, STEPS, true, 'loot', null, ac.signal);
      return 'resolved instead of throwing';
    } catch (err) {
      if (err.name !== sb.HUNTER_STAT_PATH_ABORT_ERROR) return `wrong error: ${err.name} ${err.message}`;
      // One baseline evaluation per column is unavoidable -- it happens before the first check.
      if (c.calls > full / 4) return `did ${c.calls} evaluations after a pre-abort (full run is ${full})`;
      return null;
    } finally { c.restore(); }
  });

  await check('aborting mid-walk stops within the sweep, not at the end of it', async () => {
    // The granularity check. Aborting between STEPS is not good enough: a step is an entire
    // candidate sweep, so a step-only check keeps evaluating for the rest of it. Measured on a
    // real level-79 fixture: per-candidate checking does 0 further evaluations after the abort,
    // step-only checking does 16. So this counts work done AFTER the abort rather than total
    // work, which is what makes it able to fail.
    const ac = new AbortController();
    let calls = 0;
    let afterAbort = 0;
    let aborted = false;
    const orig = sb.HunterSim.compileEvaluator;
    sb.HunterSim.compileEvaluator = async function wrapped(hunter, c) {
      const f = await orig.call(this, hunter, c);
      return function counted(...args) {
        calls += 1;
        if (aborted) afterAbort += 1;
        // Abort partway in, so this exercises the in-flight path rather than the shortcut above.
        if (!aborted && calls >= 40) { aborted = true; ac.abort(); }
        return f.apply(this, args);
      };
    };
    try {
      await sb.greedyPurchasePath(HUNTER, cfg, STEPS, true, 'loot', null, ac.signal);
      return 'resolved instead of throwing';
    } catch (err) {
      if (err.name !== sb.HUNTER_STAT_PATH_ABORT_ERROR) return `wrong error: ${err.name} ${err.message}`;
      if (!aborted) return 'the run finished before the abort could fire -- test is not exercising anything';
      // Allow a couple for scheduling slack; anything near a sweep's worth means the check has
      // been moved back out to step granularity.
      if (afterAbort > 2) {
        return `${afterAbort} evaluations ran AFTER the abort -- cancellation is only being `
          + 'checked between steps, so it burns the rest of the candidate sweep';
      }
      return null;
    } finally { sb.HunterSim.compileEvaluator = orig; }
  });

  await check('no signal means no behaviour change', async () => {
    // Callers that do not care about cancellation (every test, and any future non-UI caller)
    // must be unaffected.
    const res = await sb.greedyPurchasePath(HUNTER, cfg, 2, true, 'loot');
    return res && res.columns && Object.keys(res.columns).length ? null : 'a signal-less run stopped working';
  });

  console.log(`\n${failures ? `${failures} FAILED` : 'effective-path cancellation works'}`);
  process.exit(failures ? 1 : 0);
})();
