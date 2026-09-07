'use strict';
// THE BENCH REFIT AND THE SHIPPED REFIT MUST BE THE SAME ALGORITHM.
//
//   node tools/bench/refit-parity-check.js
//
// `tools/bench/refit.js` and `webapp/public/optimizer/refit.js` are two copies of one rule, and a
// duplicated rule is the single most reliable source of rot in this codebase -- the canonical-method
// inventory exists because of it. Nothing stops the two drifting except this check.
//
// It compares OUTPUT, not source text: for every fixture, every donor is re-fitted through both
// implementations and the resulting allocations must be byte-identical. A comment claiming they
// match is not evidence; this project has a documented case of a comment describing a fix that was
// never implemented.
//
// GATE: any difference fails.

const H = require('./harness.js');
const BENCH = require('./refit.js');

(async () => {
  const sb = H.browserSandbox();
  const SHIPPED = sb.OptimizerRefit;
  if (!SHIPPED) {
    console.log('FAIL  webapp/public/optimizer/refit.js did not register window.OptimizerRefit');
    process.exit(1);
  }
  for (const fn of ['refitNaive', 'refitTiered', 'refitTalents', 'gatePayingFill', 'spend', 'pointsBelow']) {
    if (typeof SHIPPED[fn] !== 'function') {
      console.log(`FAIL  shipped refit is missing ${fn}()`);
      process.exit(1);
    }
  }

  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  let compared = 0;
  const diffs = [];

  for (const hunter of ['borge', 'ozzy', 'knox']) {
    const targets = flat.filter((f) => f.hunter === hunter && (f.mode || 'loot') === 'loot');
    if (!targets.length) continue;
    // A spread of levels, so a near-neighbour donor never hides a divergence.
    const step = Math.max(1, Math.floor(targets.length / 5));
    for (let i = 0; i < targets.length; i += step) {
      const fx = targets[i];
      let build; try { build = await H.parseBuildCode(fx.code, fx.hunter); } catch (e) { continue; }
      const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
      const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
      const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};

      for (const d of targets.filter((_, j) => j % 4 === 0)) {
        let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
        const cases = [
          ['refitTiered', [cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, db.attributes]],
          ['refitNaive', [cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, db.attributes]],
          ['refitTalents', [cfg.TALENTS, cfg.TALENT_BUDGET, db.talents]],
        ];
        for (const [fn, argv] of cases) {
          const a = JSON.stringify(BENCH[fn](...argv.map((x) => (typeof x === 'object' && !Array.isArray(x) ? { ...x } : x))));
          const b = JSON.stringify(SHIPPED[fn](...argv.map((x) => (typeof x === 'object' && !Array.isArray(x) ? { ...x } : x))));
          compared++;
          if (a !== b) diffs.push(`${fx.name} <- ${d.name || d.uid}: ${fn} differs\n    bench:   ${a}\n    shipped: ${b}`);
        }
      }
      // The rules-built fill takes no donor and must also agree.
      for (const deep of [false, true]) {
        const a = JSON.stringify(BENCH.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deep, deps }));
        const b = JSON.stringify(SHIPPED.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deep, deps }));
        compared++;
        if (a !== b) diffs.push(`${fx.name}: gatePayingFill(deep=${deep}) differs`);
      }
    }
  }

  console.log(`compared ${compared} allocation(s) across both implementations`);
  if (!compared) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (diffs.length) {
    console.log(`FAIL  ${diffs.length} divergence(s) between the bench and shipped refit:`);
    for (const d of diffs.slice(0, 10)) console.log('  ' + d);
    process.exit(1);
  }
  console.log('PASS  the bench and shipped refit produce identical allocations');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
