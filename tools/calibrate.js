'use strict';
// Empirically measures Monte Carlo noise at various iteration counts, on your actual
// current build, so the search loop can use the lowest count that's still reliable
// instead of guessing. Usage: node calibrate.js <borge|ozzy> [loot|push]
const hunterArg = ['borge', 'ozzy', 'knox'].includes(process.argv[2]) ? process.argv[2] : 'borge';
const mode = process.argv[3] === 'push' ? 'push' : 'loot';
const cfg = require(`./${hunterArg}Config`);
const { scoreAllocation } = require('./optimizer');

function stats(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev, relStdDevPct: (stdDev / mean) * 100 };
}

async function main() {
  const candidates = [50, 100, 200, 300, 500, 1000];
  const trialsPerLevel = 8;
  console.log(`Calibrating Monte Carlo noise for ${hunterArg} (${mode} score), ${trialsPerLevel} trials per iteration count:\n`);

  for (const iterations of candidates) {
    const scores = [];
    const start = Date.now();
    for (let t = 0; t < trialsPerLevel; t++) {
      const { score } = await scoreAllocation(cfg, cfg.currentTalents, cfg.currentAttrs, mode, iterations);
      scores.push(score);
    }
    const elapsedMs = Date.now() - start;
    const { mean, relStdDevPct } = stats(scores);
    console.log(
      `iterations=${String(iterations).padStart(4)}  mean=${mean.toFixed(0).padStart(9)}  `
      + `relative noise=${relStdDevPct.toFixed(2).padStart(5)}%  `
      + `(${(elapsedMs / trialsPerLevel).toFixed(1)}ms/eval)`,
    );
  }
  console.log('\nRule of thumb: pick the smallest iteration count with relative noise well under ~2-3%');
  console.log('(a "best score" spike smaller than the noise floor is not a real improvement).');
}

main().catch((e) => { console.error(e); process.exit(1); });
