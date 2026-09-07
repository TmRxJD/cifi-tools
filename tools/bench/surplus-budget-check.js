'use strict';
// THE CASE NO FIXTURE CAN REPRESENT: a budget LARGER than any import ever spent.
//
//   node tools/bench/surplus-budget-check.js
//
// WHY THIS IS A HOLE. Every fixture's level is INFERRED from its own spend (no share code encodes
// `lvl`), so `talentBudgetForLevel(inferredLevel)` equals the spend and 'level' mode is identical
// to 'spend' mode -- measured, byte-for-byte, on five builds. Both modes therefore test only the
// case budget == spend.
//
// A REAL PLAYER IS NOT LIKE THAT. They have a level, and they may be sitting on unspent points --
// after a level-up, before a respec, mid-save-up. That is budget > spend, and NO fixture can
// produce it. This project has already shipped an under-spend bug into a user's hands while the
// gate reported 182/182 "as good or better", precisely because the failure was unconstructible in
// the mode being tested.
//
// So: take real builds, GRANT extra budget beyond what they spent, and require that the optimizer
// spends it. A build handed 10 more attribute points must come back having used them -- every
// hunter has an uncapped cost-1 attribute (borge ares, ozzy lotl, knox kraken) and every talent
// costs 1, so a point is always spendable and leaving one is a defect, not a rounding artifact.
//
// GATE: an under-spent result, an illegal result, or a result WORSE than the same build optimized
// at its original budget, all fail.

const H = require('./harness.js');
const M = require('./measurement.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'knox@30,borge@32,ozzy@43');
const SURPLUS = Number(opt('surplus', 10));
const ITERS = 1000;

(async () => {
  const known = H.loadKnownBuilds();
  let failures = 0;
  let checked = 0;

  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    let fx; try { fx = H.findFixture(known, name); } catch (e) { continue; }
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const base = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);

    // Same account, same node tables -- only the budget is raised.
    const cfg = {
      ...base,
      TALENT_BUDGET: base.TALENT_BUDGET + SURPLUS,
      ATTRIBUTE_BUDGET: base.ATTRIBUTE_BUDGET + SURPLUS,
    };

    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const res = await H.Optimizer.optimize(cfg, {
        mode, scorer: pooled.score, effort: { archiveEvals: 1200, refineSupports: 3, seeds: [0x9e3779b9] },
      });
      checked++;
      const m = await M.measure({
        H, cfg, mode, fidelity: ITERS, label: name,
        talents: res.best.talentAlloc, attrs: res.best.attrAlloc,
      });
      const tSpend = m.legality.talentSpend;
      const aSpend = m.legality.attrSpend;
      const okSpend = tSpend === cfg.TALENT_BUDGET && aSpend === cfg.ATTRIBUTE_BUDGET;
      const okLegal = m.legality.ok;

      // More budget cannot make the true optimum worse, so a surplus run scoring BELOW the
      // original-budget import is a search failure, not a modelling subtlety.
      const imp = primary(await H.evaluateAllocation(base, build.talents, build.attributes, ITERS));
      const pct = 100 * (m.primary - imp) / imp;

      console.log(`${name.padEnd(10)} +${SURPLUS} pts  spend ${tSpend}/${cfg.TALENT_BUDGET},${aSpend}/${cfg.ATTRIBUTE_BUDGET}`
        + `  legal ${okLegal}  vs original import ${pct.toFixed(2)}%`
        + (okSpend ? '' : '   *** UNDER-SPENT ***')
        + (okLegal ? '' : `   *** ILLEGAL: ${m.legality.problems.join('; ')} ***`)
        + (pct < -M.NOISE_FLOOR_PCT ? '   *** WORSE THAN THE IMPORT DESPITE MORE BUDGET ***' : ''));

      if (!okSpend) failures++;
      if (!okLegal) failures++;
      if (pct < -M.NOISE_FLOOR_PCT) failures++;
    } catch (e) {
      // The under-spend assertion inside the optimizer throws rather than returning a bad build.
      // That is a PASS for correctness and a FAIL for this gate, and the message must say which.
      console.log(`${name.padEnd(10)} THREW: ${e.message.slice(0, 140)}`);
      failures++;
      checked++;
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} problem(s) with a budget larger than the import's spend`); process.exit(1); }
  console.log(`PASS  ${checked} build(s) spend a surplus budget fully, legally, without regressing`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
