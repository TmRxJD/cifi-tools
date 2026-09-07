'use strict';
// WHY DID borge@72 PASS IN BOSS MODE WHILE LOSING 90% LOOT AND 44 STAGES?
//
//   node tools/bench/boss-grading-diagnosis.js
//
// The gate reported:
//   PASS borge@72 (boss)  loot 2.81e9 -> 2.79e8 (-90.07%)  stage 300.2 -> 256.6 (-14.54%)
// A build that no longer reaches the stage-300 boss it was built to kill, passing the gate meant to
// protect boss builds. Either the boss objective ranks a strictly worse build higher, or the new
// per-mode grading compares the wrong quantity.
//
// This prints every input to that decision -- the target, the tier each build lands in, and the
// objective score -- instead of inferring it. The tier matters most: bossScore has three, and which
// one applies decides whether depth, boss HP, or kill rate is doing the ranking.
//
// PRINTS EVERY FIELD, because this project's recurring failure is a diagnosis made from the two or
// three fields someone happened to look at.

const fs = require('fs');
const H = require('./harness.js');

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, 'borge@72');
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });

  const ctx = H.Objective.contextFor(cfg);
  console.log(`fixture ${fx.name}  mode=${fx.mode}  note=${fx.note || ''}`);
  console.log(`account stage input: ${(cfg.baseOverrides && cfg.baseOverrides.stage)
    ?? (cfg.hunterStats && cfg.hunterStats.stage) ?? '(none)'}`);
  console.log(`bossTarget from contextFor: ${ctx.bossTarget}`);
  console.log('');

  // The optimizer's answer, taken from the gate's own result file so this diagnoses the SAME build
  // that passed rather than a fresh run that might differ.
  let optimized = null;
  for (const f of ['bossfinal.json', 'bosscheck.json']) {
    if (!fs.existsSync(f)) continue;
    try {
      const rows = Object.values(JSON.parse(fs.readFileSync(f, 'utf8')));
      const hit = rows.find((r) => r && r.level === 72 && r.optimizedTalents);
      if (hit) { optimized = hit; break; }
    } catch (e) { /* partial write */ }
  }

  const cases = [['import', build.talents, build.attributes]];
  if (optimized) cases.push(['optimizer', optimized.optimizedTalents, optimized.optimizedAttributes]);
  else console.log('(no stored optimizer allocation found -- reporting the import only)');

  for (const [label, t, a] of cases) {
    const r = await H.evaluateAllocation(cfg, t, a, 1000);
    const score = H.Objective.MODES.boss.score(r, ctx);
    const d = H.Objective.describeRun(r);
    // Which tier of bossScore applied? That is the whole question.
    const tier = r.maxStage < ctx.bossTarget ? 'TIER 0 (cannot reach target: ranked on depth)'
      : ((r.bossKillRate || 0) <= 0 ? 'TIER 1 (reached, no kill: depth then boss HP)'
        : 'TIER 2 (KILL ACHIEVED: kill rate then loot)');
    console.log(`${label}`);
    console.log(`  bossScore ${score.toExponential(6)}   ${tier}`);
    console.log(`  loot ${r.loot.toFixed(0)}  avgStage ${r.avgStage.toFixed(2)}  maxStage ${r.maxStage.toFixed(2)}`
      + `  minStage ${(r.minStage ?? 0).toFixed(2)}`);
    console.log(`  bossKillRate ${(r.bossKillRate ?? -1).toFixed(2)}  bossHpPercent ${(r.bossHpPercent ?? -1).toFixed(2)}`);
    console.log(`  regime ${d.regime}`);
    console.log('');
  }

  if (cases.length === 2) {
    const ri = await H.evaluateAllocation(cfg, cases[0][1], cases[0][2], 1000);
    const ro = await H.evaluateAllocation(cfg, cases[1][1], cases[1][2], 1000);
    const si = H.Objective.MODES.boss.score(ri, ctx);
    const so = H.Objective.MODES.boss.score(ro, ctx);
    console.log(so >= si
      ? `VERDICT: the objective ranks the optimizer's build >= the import (${so.toExponential(4)} >= ${si.toExponential(4)}),\n`
        + '         so the gate is faithfully reporting what the objective says. The defect is in the\n'
        + '         OBJECTIVE, not the grading.'
      : `VERDICT: the objective ranks the import HIGHER (${si.toExponential(4)} > ${so.toExponential(4)}),\n`
        + '         so the objective is right and the GATE let a worse build through -- the comparison\n'
        + '         it makes is not this one.');
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
