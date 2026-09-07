'use strict';
// REFIT'S CONTRACT: A MISSING `deps` MUST THROW, NOT DEFAULT TO {}.
//
//   node tools/bench/refit-contract-check.js
//
// `gatePayingFill` used to read `const deps = (opts && opts.deps) || {}`. Its own header records
// what omitting dependencies does: the first version handled tier thresholds and forgot dependency
// edges, producing ILLEGAL builds on 24 of 24 fixtures (`spartan` under `ylith 0`, `exo` under
// `lotl 0`, `pl` under `spa 0`) -- and, worse, it would have poisoned the experiment it was written
// for, because ablation-check rejects illegal candidates and the arm would have reported "no
// candidate" and been read as a finding about the search rather than a bug in the fill.
//
// A silent default re-arms exactly that for the next caller who forgets. So an absent `deps` is now
// an error, while a genuinely dependency-free space (a talent block) passes `{}` and says so.
//
// BOTH DIRECTIONS, because a guard that always throws is as broken as one that never does.

const H = require('./harness.js');

(async () => {
  H.browserSandbox();                       // loads refit.js onto the global
  const R = global.OptimizerRefit;
  if (!R || typeof R.gatePayingFill !== 'function') {
    console.log('FAIL  OptimizerRefit.gatePayingFill not reachable -- the module did not register');
    process.exit(1);
  }
  const defs = [{ id: 'root', cost: 1, maxLevel: 5 }, { id: 'child', cost: 1, maxLevel: 5 }];
  let failures = 0;

  for (const [label, opts, shouldThrow] of [
    ['opts omitted entirely', undefined, true],
    ['opts without deps', { deep: true }, true],
    ['deps explicitly null', { deps: null }, true],
    ['deps explicitly {}', { deps: {} }, false],
    ['deps with a real edge', { deps: { child: ['root'] } }, false],
  ]) {
    let threw = false;
    let msg = '';
    try { R.gatePayingFill(defs, {}, 5, opts); } catch (e) { threw = true; msg = e.message; }
    const ok = threw === shouldThrow;
    if (!ok) failures++;
    console.log(`  ${label.padEnd(24)} ${threw ? 'throws' : 'accepts'}`
      + `   expected ${shouldThrow ? 'throw' : 'accept'}   ${ok ? 'ok' : '*** WRONG ***'}`);
    // A guard is only useful if it says what to do about it.
    if (threw && shouldThrow && !/pass \{\} explicitly/.test(msg)) {
      console.log('    *** the error does not tell the caller how to fix it ***');
      failures++;
    }
  }

  console.log('');
  if (failures) { console.log(`FAIL  ${failures} contract violation(s)`); process.exit(1); }
  console.log('PASS  a missing deps throws with actionable text; an explicit {} is accepted');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
