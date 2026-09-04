'use strict';
// WHERE DOES THE IMPORT'S OWN SUPPORT RANK IN SCREENING? The structural predictor of a shortfall.
//
//   node tools/bench/support-rank-check.js [--sample=N] [--seed=N] [--only=ozzy#38]
//
// Stage 1 screens every realizable attribute support at its canonical fill; only the top
// SURVEY_SUPPORTS get a coarse optimization and only the top REFINE_SUPPORTS get a full fixpoint.
// So if the shape a real player actually used ranks below the survey cut, the optimizer never
// refines it and cannot match that build no matter how good the local search is. The rank is
// therefore diagnostic in a way a percentage is not: it says whether a shortfall is a SEARCH
// problem or a SCREENING problem, and those have different fixes.
//
// It has already earned its place twice. On a level-31 Knox the import's support ranked #2 of 144,
// which exonerated screening and pointed at the talent block. On a level-55 Ozzy it ranked #63 of
// 234 -- outside the cut -- which pointed at `openThreshold` dumping 135 of 165 points into one
// uncapped attribute; fixing that moved the same support to #2 and the fill to nearly the import's
// own shape.
//
// Alongside the rank it prints the properties that plausibly explain a bad one, so the pattern
// across builds is visible rather than inferred from a single case:
//   gated    the import's support contains tier-gated attributes (thresholds are what made
//            canonicalFill degenerate before)
//   conc     concentration: the largest single attribute as a share of the budget. A round-robin
//            fill represents a flat build well and a concentrated one badly.
//   walled   the import does not kill the boss it reaches, so loot is on a plateau (see the
//            boss-wall entry in CLAUDE.md) -- a different failure with a different remedy.

const H = require('./harness.js');
const Space = H.Space;

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const SAMPLE = Number(opt('sample', 8));
const SEED = Number(opt('seed', Math.floor(Math.random() * 1e6)));
const ONLY = opt('only', null);

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  const known = H.loadKnownBuilds();
  const rand = mulberry(SEED);
  const sb = H.browserSandbox();

  let picks;
  if (ONLY) {
    picks = ONLY.split(',').map((n) => H.findFixture(known, n.trim()));
  } else {
    const pool = Object.values(known).flat().filter((f) => f.mode === 'loot');
    picks = [];
    const copy = [...pool];
    while (picks.length < SAMPLE && copy.length) {
      picks.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
    }
  }
  console.log(`seed ${SEED} -- replay with --seed=${SEED}\n`);
  console.log('build                                  lvl  rank/realizable  cut  gated  conc  walled');

  const rows = [];
  for (const fx of picks) {
    const build = await H.parseBuildCode(fx.code);
    if (!build) continue;
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const deps = cfg.ATTRIBUTE_DEPENDENCIES;
    const minVal = cfg.ATTRIBUTE_MIN_VALUE;
    const scorer = await H.makeScorer(cfg, 'loot');
    const T = cfg.TALENTS;
    const key = (x) => [...x].sort().join(',');

    const impIds = cfg.ATTRIBUTES.filter((d) => (build.attributes[d.id] || 0) > 0).map((d) => d.id);
    const flatT = Space.canonicalFill(T, {}, {}, cfg.TALENT_BUDGET, T.map((x) => x.id));
    if (!flatT) continue;

    const subs = [];
    for (const s of Space.enumerateSupports(cfg.ATTRIBUTES, deps, cfg.ATTRIBUTE_BUDGET)) {
      const f = Space.canonicalFill(cfg.ATTRIBUTES, deps, minVal, cfg.ATTRIBUTE_BUDGET, s.ids);
      if (f) subs.push({ ids: s.ids, fill: f });
    }
    const scored = [];
    const B = 64;
    for (let i = 0; i < subs.length; i += B) {
      const chunk = subs.slice(i, i + B);
      const sc = await scorer(chunk.map((c) => ({ talentAlloc: flatT, attrAlloc: c.fill })), H.Optimizer.SCREEN_ITERATIONS);
      chunk.forEach((c, j) => scored.push({ ...c, score: sc[j] }));
    }
    scored.sort((a, b) => b.score - a.score);
    const rank = scored.findIndex((r) => key(r.ids) === key(impIds));

    const gated = impIds.filter((id) => (minVal[id] || 0) > 0);
    const maxDepth = Math.max(0, ...impIds.map((id) => (build.attributes[id] || 0)
      * (cfg.ATTRIBUTES.find((d) => d.id === id).cost || 1)));
    const conc = maxDepth / cfg.ATTRIBUTE_BUDGET;

    const evalFast = await sb.HunterSim.compileEvaluator(cfg.hunter, cfg);
    const r = await evalFast(build.talents, build.attributes, H.Optimizer.SCREEN_ITERATIONS);
    const walled = (r.bossKillRate || 0) <= 0;

    const inCut = rank >= 0 && rank < H.Optimizer.SURVEY_SUPPORTS;
    rows.push({ fx, level: build.level, rank, total: scored.length, inCut, gated: gated.length, conc, walled });
    console.log(`${fx.uid.padEnd(36)} ${String(build.level).padEnd(4)} `
      + `${rank < 0 ? 'UNREALIZABLE' : `${rank + 1}/${scored.length}`}`.padEnd(17)
      + ` ${inCut ? 'in ' : 'OUT'}   ${String(gated.length).padEnd(6)} `
      + `${(conc * 100).toFixed(0).padStart(3)}%  ${walled ? 'YES' : '-'}`);
  }

  const out = rows.filter((r) => !r.inCut);
  console.log('');
  console.log(`${rows.length - out.length}/${rows.length} imports screen INSIDE the survey cut `
    + `(top ${H.Optimizer.SURVEY_SUPPORTS})`);
  if (out.length) {
    console.log(`\n${out.length} whose own shape the optimizer never refines:`);
    for (const r of out) {
      console.log(`  ${r.fx.uid} lvl${r.level}  rank ${r.rank + 1}/${r.total}`
        + `  gated:${r.gated}  conc:${(r.conc * 100).toFixed(0)}%  ${r.walled ? 'boss-walled' : ''}`);
    }
    console.log('  A shortfall on these is a SCREENING problem, not a search one -- the right shape');
    console.log('  never reaches refinement, so a better local search cannot help.');
  }
  const walledCount = rows.filter((r) => r.walled).length;
  if (walledCount) console.log(`\n${walledCount}/${rows.length} imports are boss-walled (loot on a plateau).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
