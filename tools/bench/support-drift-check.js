'use strict';
// DOES THE STARTING SUPPORT ACTUALLY DECIDE THE ANSWER? -- i.e. does screening rank matter?
//
//   node tools/bench/support-drift-check.js --only=knox#26[,ozzy#38] [--sample=N] [--seed=N]
//
// Stage 1 ranks supports at a flat fill and only the top few are refined, so a support that screens
// badly is never optimized. That looks alarming, and `support-rank-check.js` measures it -- but it
// is only a DEFECT if the starting support determines the final answer. `Space.transfer` may grant
// points to a node currently at 0, so refinement can widen a narrow support back out; if it
// reliably does, screening is a seed rather than a decision and a bad rank costs nothing.
//
// This measures that directly. For one build it refines from two different starting supports --
// the top-screened one, and the import's OWN, which may rank anywhere -- and reports:
//   * the score each reaches, so a difference in outcome is visible
//   * how much each one's SUPPORT SET drifted during refinement (members gained/lost), which is the
//     mechanism that would make the starting choice unimportant
//
// The distinction matters because the two readings call for opposite work. If outcomes match and
// supports drift, screening rank is a red herring and the fix for a shortfall is elsewhere. If
// outcomes diverge, the screen is deciding the answer at a flat fill, and that is worth fixing.

const H = require('./harness.js');
const Space = H.Space;
const O = H.Optimizer;

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'knox#26');

const setOf = (defs, a) => defs.filter((d) => (a[d.id] || 0) > 0).map((d) => d.id).sort();

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY.split(',').map((x) => x.trim());
  let diverged = 0;

  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const deps = cfg.ATTRIBUTE_DEPENDENCIES;
    const minVal = cfg.ATTRIBUTE_MIN_VALUE;
    const scorer = await H.makeScorer(cfg, 'loot');
    const sb = H.browserSandbox();
    const evalFast = await sb.HunterSim.compileEvaluator(cfg.hunter, cfg);
    const T = cfg.TALENTS;
    const flatT = Space.canonicalFill(T, {}, {}, cfg.TALENT_BUDGET, T.map((x) => x.id));
    const impScore = (await evalFast(build.talents, build.attributes, O.FINAL_ITERATIONS)).lootPerMin;

    // Screen every realizable support, exactly as Stage 1 does.
    const subs = [];
    for (const s of Space.enumerateSupports(cfg.ATTRIBUTES, deps, cfg.ATTRIBUTE_BUDGET)) {
      const f = Space.canonicalFill(cfg.ATTRIBUTES, deps, minVal, cfg.ATTRIBUTE_BUDGET, s.ids);
      if (f) subs.push({ ids: s.ids, fill: f });
    }
    const rows = [];
    const B = 64;
    for (let i = 0; i < subs.length; i += B) {
      const chunk = subs.slice(i, i + B);
      const sc = await scorer(chunk.map((c) => ({ talentAlloc: flatT, attrAlloc: c.fill })), O.SCREEN_ITERATIONS);
      chunk.forEach((c, j) => rows.push({ ...c, score: sc[j] }));
    }
    rows.sort((a, b) => b.score - a.score);
    const impIds = setOf(cfg.ATTRIBUTES, build.attributes);
    const key = (x) => [...x].sort().join(',');
    const impRank = rows.findIndex((r) => key(r.ids) === key(impIds));

    console.log(`${fx.uid} lvl${build.level}   import ${impScore.toFixed(2)}`);
    console.log(`   import support ranks ${impRank + 1}/${rows.length}, ${impIds.length} members`);

    // Refine from each starting support with the optimizer's own machinery: seed the incumbent so
    // optimize() refines exactly that shape, rather than re-running the whole pipeline.
    const results = [];
    for (const [label, start] of [['top-screened', rows[0]], ['import\'s own', rows[impRank]]]) {
      if (!start) continue;
      const seeded = { ...cfg, currentTalents: flatT, currentAttrs: start.fill };
      const s2 = await H.makeScorer(seeded, 'loot');
      const res = await O.optimize(seeded, { mode: 'loot', scorer: s2 });
      const v = (await evalFast(res.best.talentAlloc, res.best.attrAlloc, O.FINAL_ITERATIONS)).lootPerMin;
      const endIds = setOf(cfg.ATTRIBUTES, res.best.attrAlloc);
      const gained = endIds.filter((i) => !start.ids.includes(i));
      const lost = start.ids.filter((i) => !endIds.includes(i));
      results.push({ label, v, startN: start.ids.length, endN: endIds.length, gained, lost });
      console.log(`   from ${label.padEnd(13)} -> ${v.toFixed(2).padStart(12)}  `
        + `(${(100 * (v - impScore) / impScore).toFixed(2)}% vs import)   support ${start.ids.length} -> ${endIds.length}`
        + `${gained.length ? `  +${gained.join(',')}` : ''}${lost.length ? `  -${lost.join(',')}` : ''}`);
    }
    if (results.length === 2) {
      const gap = 100 * Math.abs(results[0].v - results[1].v) / Math.max(results[0].v, results[1].v);
      const drifted = results.some((r) => r.gained.length || r.lost.length);
      console.log(`   outcomes differ by ${gap.toFixed(2)}%; refinement ${drifted ? 'DID' : 'did NOT'} change the support set`);
      // 1% is the measured precision floor -- see eval-precision-check.js. Below it, the two
      // starting supports produced the same answer as far as this evaluator can tell.
      if (gap > 1) {
        diverged++;
        console.log('   -> the STARTING SUPPORT decided the answer: screening rank is load-bearing here');
      } else {
        console.log('   -> the starting support did NOT decide the answer: refinement recovered it');
      }
    }
    console.log('');
  }
  console.log(diverged
    ? `${diverged} build(s) where the starting support decided the outcome -- screening rank matters there`
    : 'on every build checked, refinement reached the same answer from either starting support');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
