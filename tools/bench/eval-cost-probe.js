'use strict';
// WHERE DOES A BUILD'S RUNTIME ACTUALLY GO -- SIMULATION, OR PER-CALL OVERHEAD?
//
// The sweep costs hours and the obvious levers (archive size, refinement width) are guesses until
// the cost of a single evaluation is known. Two things are separable and only one is reducible:
//   FIXED   per-call cost that does not depend on iterations -- a fresh WASM instance is created
//           for every evaluation, because determinism requires it (reusing one drifts ~0.05%).
//   MARGINAL cost proportional to iterations -- the simulation itself.
//
// If FIXED dominates at low levels, then low-level builds are paying mostly instantiation and the
// fix is batching, not searching less. If MARGINAL dominates, the fix is fewer full-fidelity
// evaluations. These need completely different work, so measure before choosing.
//
// Fitted from two iteration counts: t(n) = fixed + marginal*n.

const H = require('./harness.js');

const REPS = 12;

async function timeAt(cfg, talents, attrs, iters, reps) {
  const sb = H.browserSandbox();
  const evalFast = await sb.HunterSim.compileEvaluator(cfg.hunter, cfg);
  await evalFast(talents, attrs, iters);          // warm: exclude first-call compilation
  const t0 = Date.now();
  for (let i = 0; i < reps; i++) await evalFast(talents, attrs, iters);
  return (Date.now() - t0) / reps;
}

(async () => {
  const known = H.loadKnownBuilds();
  console.log('per-evaluation cost, fitted as t(n) = fixed + marginal * iterations');
  console.log('(machine is busy with a sweep, so absolute values are inflated; the SPLIT is what matters)');
  console.log('');
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['borge@12', 'borge@35', 'borge@60']) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const t100 = await timeAt(cfg, build.talents, build.attributes, 100, REPS);
    const t1000 = await timeAt(cfg, build.talents, build.attributes, 1000, Math.max(3, REPS / 4));
    // Two points, one line: marginal is the slope, fixed is what remains at n = 0.
    const marginal = (t1000 - t100) / 900;
    const fixed = t100 - marginal * 100;
    const fixedShareAt100 = (fixed / t100) * 100;
    console.log(`${name.padEnd(10)} 100 iters ${t100.toFixed(1).padStart(7)}ms   `
      + `1000 iters ${t1000.toFixed(1).padStart(8)}ms   `
      + `fixed ${fixed.toFixed(1).padStart(6)}ms/call (${fixedShareAt100.toFixed(0)}% of a screen eval)   `
      + `marginal ${(marginal * 1000).toFixed(2)}ms/1k-iters`);
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
