'use strict';
// Usage: node run.js <borge|ozzy|knox> <loot|push> [maxSeconds]
// maxSeconds is a TOTAL wall-clock target (default 60s) -- apportioned between the
// parallel beam search and the fixed overhead of pool startup + final high-precision
// re-verification.
const hunterArg = ['borge', 'ozzy', 'knox'].includes(process.argv[2]) ? process.argv[2] : 'borge';
const mode = process.argv[3] === 'push' ? 'push' : 'loot';
const maxSeconds = Number(process.argv[4]) > 0 ? Number(process.argv[4]) : 60;
const configPath = `./${hunterArg}Config`;
const cfg = require(configPath);
const { scoreAllocation } = require('./optimizer');
const { beamSearch } = require('./beamSearch');
const history = require('./history');

async function main() {
  console.log(`Optimizing ${cfg.hunter} for: ${mode === 'push' ? 'Ø Stage (push)' : 'Loot Score'} (max ${maxSeconds}s)\n`);

  const baseline = await scoreAllocation(cfg, cfg.currentTalents, cfg.currentAttrs, mode, 1000);
  console.log('Your current build:', mode === 'push' ? baseline.result.avgStage : baseline.result.lootPerMin);

  const overheadReserveMs = 8000; // pool startup (once) + final re-verification pass
  const searchBudgetMs = Math.max(3000, maxSeconds * 1000 - overheadReserveMs);

  const start = Date.now();
  const { beam, allSeen } = await beamSearch(configPath, cfg, {
    mode,
    timeBudgetMs: searchBudgetMs,
    beamWidth: 8,
    neighborsPerMember: 3,
    searchIterations: 100,
    log: console.log,
  });

  // Re-verify the beam's top few at high precision (search-time scores are cheap/noisy);
  // always include your real current build so the result can never regress below it.
  const finalIterations = maxSeconds >= 120 ? 1000 : 500;
  const shortlist = beam.slice(0, 5);
  if (cfg.currentTalents && cfg.currentAttrs) shortlist.push({ talentAlloc: cfg.currentTalents, attrAlloc: cfg.currentAttrs });

  let best = null;
  for (const c of shortlist) {
    const { score, result } = await scoreAllocation(cfg, c.talentAlloc, c.attrAlloc, mode, finalIterations);
    if (!best || score > best.score) best = { talentAlloc: c.talentAlloc, attrAlloc: c.attrAlloc, score, finalResult: result };
  }
  console.log(`\n(search took ${((Date.now() - start) / 1000).toFixed(1)}s)`);

  // Carry everything this run learned into the next one.
  history.save(cfg.hunter, mode, allSeen);

  console.log('\n=== Best allocation found ===');
  console.log('Talents:', best.talentAlloc, `(spent ${cfg.TALENTS.reduce((s, d) => s + best.talentAlloc[d.id] * (d.cost || 1), 0)}/${cfg.TALENT_BUDGET})`);
  console.log('Attributes:', best.attrAlloc, `(spent ${cfg.ATTRIBUTES.reduce((s, d) => s + best.attrAlloc[d.id] * (d.cost || 1), 0)}/${cfg.ATTRIBUTE_BUDGET})`);
  console.log('\nResult:', best.finalResult);
  const key = mode === 'push' ? 'avgStage' : 'lootPerMin';
  console.log(`\nImprovement: ${baseline.result[key].toFixed(2)} -> ${best.finalResult[key].toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
