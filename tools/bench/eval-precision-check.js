'use strict';
// HOW PRECISE IS A FINAL_ITERATIONS SCORE? Every quality gate reads a difference between two of
// them, so the answer bounds what any of those gates can honestly claim.
//
//   node tools/bench/eval-precision-check.js [--iters=1000,2000,4000,8000,16000]
//
// The evaluator is exactly deterministic for a given (allocation, iterations) -- that is settled,
// and it is what makes memoization sound. Determinism is NOT precision: 1000 iterations is a SAMPLE
// of a stochastic run, so the number it returns is an estimate of the build's true expected loot
// with a sampling error of its own. Two different allocations compared at 1000 iterations therefore
// differ by (real difference + two sampling errors), and a gate that treats a 4% gap as a search
// defect is only right if that error is well under 4%.
//
// Method: take each fixture's OWN import allocation -- a fixed build, so nothing about the search is
// involved -- and evaluate it at rising iteration counts. The drift from the 1000-iteration value
// toward the high-iteration value is the error that FINAL_ITERATIONS carries. Reported per build and
// as a worst case, because it is the worst case that bounds a gate threshold.
//
// This is a REPORT. It does not assert a number, because the right threshold for the other gates is
// a judgement about what precision is worth paying for, not a fact about the code.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ITERS = opt('iters', '1000,2000,4000,8000,16000').split(',').map(Number);
const REF = ITERS[ITERS.length - 1];

(async () => {
  const known = H.loadKnownBuilds();
  const sb = H.browserSandbox();
  const picks = [
    ['ozzy', 38], ['borge', 57], ['borge', 38], ['knox', 32], ['knox', 22], ['borge', 16],
  ];
  const drifts = [];

  console.log(`each build's OWN import allocation, evaluated at rising fidelity`);
  console.log(`drift is measured against the ${REF}-iteration value\n`);
  for (const [hunter, idx] of picks) {
    const fx = known[hunter].filter((f) => f.mode === 'loot').find((f) => f.index === idx);
    if (!fx) continue;
    const build = await H.parseBuildCode(fx.code);
    const cfg = H.cfgForImport(hunter, build, { budgetMode: 'spend' });
    const evalFast = await sb.HunterSim.compileEvaluator(cfg.hunter, cfg);

    const vals = [];
    for (const n of ITERS) {
      const r = await evalFast(build.talents, build.attributes, n);
      vals.push(r.lootPerMin);
    }
    const ref = vals[vals.length - 1];
    const drift = 100 * (vals[0] - ref) / ref;
    drifts.push({ hunter, idx, level: build.level, drift });
    const cells = ITERS.map((n, i) => `${n}:${(100 * (vals[i] - ref) / ref).toFixed(2)}%`).join('  ');
    console.log(`${(hunter + '#' + idx).padEnd(12)} lvl${String(build.level).padEnd(3)} ${cells}`);
  }

  const worst = drifts.reduce((a, b) => (Math.abs(a.drift) >= Math.abs(b.drift) ? a : b));
  const mean = drifts.reduce((s, d) => s + Math.abs(d.drift), 0) / drifts.length;
  console.log('');
  console.log(`FINAL_ITERATIONS (${ITERS[0]}) carries a mean absolute error of ${mean.toFixed(2)}% `
    + `and a worst of ${Math.abs(worst.drift).toFixed(2)}% (${worst.hunter}#${worst.idx})`);
  console.log('A gate comparing two of these numbers sees roughly twice that in the worst case, so a');
  console.log('shortfall smaller than about ' + (2 * mean).toFixed(1) + '% is not evidence of a search defect.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
