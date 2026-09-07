'use strict';
// GENERATE SEED BUILDS FOR LEVELS THE CORPUS DOES NOT COVER.
//
//   node tools/bench/corpus-extend.js --hunter=knox --levels=15,29,41,42,43
//   node tools/bench/corpus-extend.js --hunter=knox --gaps        # interior gaps only
//   node tools/bench/corpus-extend.js --hunter=knox --above=5     # N levels past the ceiling
//
// WHY. The fallback that makes a search shortfall survivable -- up to 12 community builds refit to
// the user's budget and entered as finalists -- only protects where the corpus HAS coverage:
// borge 12-84, ozzy 11-75, knox 12-40, with interior gaps (ozzy 34-42 is eight levels wide).
// Outside that, there is nothing to fall back TO. That is a DATA gap, not an algorithm one, and it
// is far cheaper to close than another metaheuristic.
//
// METHOD: bootstrap upward, one level at a time. Each new level is optimised by the SHIPPED
// optimizer -- not a reimplemented climb, which would be the fourth parallel search in this repo --
// starting from a corpus that already contains everything generated below it. So level 41 seeds 42,
// which seeds 43.
//
// THE ACCEPTANCE TEST, and it is the point rather than a formality: a generated build must BEAT the
// previous level's build measured under the SAME config. More budget cannot make the true optimum
// worse, so a generated level that fails to beat its predecessor has not found anything -- it has
// just spent extra points badly, and admitting it would poison the corpus for every level above it.
// Generated builds that fail are REPORTED AND DISCARDED, never emitted.
//
// Account state is inherited from the donor, so these extrapolate one real account forward. They
// are SEEDS -- plausible good builds for an uncovered level -- not claims about what a real player
// at that level has. Nothing here is validated against a real account, and it cannot be.

const H = require('./harness.js');
const R = require('./refit.js');
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const HUNTER = opt('hunter', 'knox');
const ABOVE = Number(opt('above', 0));
const WANT_GAPS = args.includes('--gaps');
const EXPLICIT = opt('levels', null);
const OUT = opt('out', `extended-${HUNTER}.json`);
const ITERS = 1000;
const capOf = (d) => (d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel);

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  const mine = flat.filter((f) => f.hunter === HUNTER && (f.mode || 'loot') === 'loot' && Number.isFinite(f.level));
  if (!mine.length) throw new Error(`no loot fixtures for ${HUNTER}`);
  const levels = [...new Set(mine.map((f) => f.level))].sort((a, b) => a - b);
  const ceiling = levels[levels.length - 1];

  let targets = [];
  if (EXPLICIT) targets = EXPLICIT.split(',').map(Number).filter(Number.isFinite);
  else {
    if (WANT_GAPS) {
      for (let i = 1; i < levels.length; i++) {
        for (let L = levels[i - 1] + 1; L < levels[i]; L++) targets.push(L);
      }
    }
    for (let i = 1; i <= ABOVE; i++) targets.push(ceiling + i);
  }
  targets = [...new Set(targets)].sort((a, b) => a - b);
  if (!targets.length) throw new Error('nothing to generate -- pass --levels=, --gaps or --above=');

  console.log(`${HUNTER}: corpus covers ${levels[0]}-${ceiling} (${levels.length} levels)`);
  console.log(`generating ${targets.length} level(s): ${targets.join(', ')}`);
  console.log('');

  // Generated builds join the pool as they are accepted, so each bootstraps the next.
  const pool = mine.map((f) => ({ level: f.level, code: f.code, generated: false }));
  const accepted = [];

  for (const L of targets) {
    // Nearest donor BELOW the target, generated ones included.
    const below = pool.filter((p) => p.level < L).sort((a, b) => b.level - a.level);
    if (!below.length) { console.log(`L${L}: no donor below -- skipped`); continue; }
    const donorRow = below[0];
    let donor;
    try { donor = await H.parseBuildCode(donorRow.code, HUNTER); } catch (e) { console.log(`L${L}: donor unparseable -- skipped`); continue; }

    // Config at the TARGET level: budgets from the level formulas, account state from the donor.
    const cfg = H.cfgForImport(HUNTER, { ...donor, level: L }, { budgetMode: 'level' });
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const legal = (a) => cfg.ATTRIBUTES.every((d) => (a[d.id] || 0) <= capOf(d))
      && H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPS || {}, minVal, a, cfg.ATTRIBUTE_BUDGET);

    const pooled = await H.makePooledScorer(cfg, 'loot');
    try {
      // BASELINE: the donor's own shape, refit to the target's larger budget. This is what "the
      // previous level's build" means at this level, and it is the bar to beat.
      const bt = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, donor.talents);
      const ba = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, donor.attributes);
      if (!bt || !ba || !legal(ba)) { console.log(`L${L}: donor refit illegal -- skipped`); continue; }
      const baseline = (await pooled.score([{ talentAlloc: bt, attrAlloc: ba }], ITERS))[0];

      const res = await H.Optimizer.optimize(cfg, {
        mode: 'loot', scorer: pooled.score,
        effort: { archiveEvals: 1200, refineSupports: 3, seeds: [0x9e3779b9] },
      });
      const got = (await pooled.score([{ talentAlloc: res.best.talentAlloc, attrAlloc: res.best.attrAlloc }], ITERS))[0];
      const gain = 100 * (got - baseline) / Math.abs(baseline);

      const tSpend = H.Space.costOf(cfg.TALENTS, res.best.talentAlloc);
      const aSpend = H.Space.costOf(cfg.ATTRIBUTES, res.best.attrAlloc);
      const fullySpent = tSpend === cfg.TALENT_BUDGET && aSpend === cfg.ATTRIBUTE_BUDGET;
      const ok = got > baseline && legal(res.best.attrAlloc) && fullySpent;

      let code = null;
      if (ok) {
        try {
          // AWAIT IT. generateBuildCode is async, so an un-awaited call yields a Promise and any
          // error inside becomes an unhandled rejection that this try/catch cannot see -- which
          // killed a run that had already produced an accepted build.
          code = await H.generateBuildCode(
            HUNTER,
            { ...donor, level: L, talents: res.best.talentAlloc, attributes: res.best.attrAlloc },
            donor.hunterStats || {}, donor.overrides || {}, donor.gems || {},
          );
        } catch (e) { code = null; console.log(`      (code emit failed: ${e.message})`); }
        if (code) pool.push({ level: L, code, generated: true });
        accepted.push({
          level: L, from: donorRow.level, fromGenerated: donorRow.generated,
          baseline, score: got, gainPct: gain, code,
          talents: res.best.talentAlloc, attrs: res.best.attrAlloc,
        });
      }

      console.log(`L${String(L).padStart(3)}  from L${String(donorRow.level).padStart(3)}${donorRow.generated ? '*' : ' '}`
        + `  baseline ${baseline.toFixed(0).padStart(12)} -> ${got.toFixed(0).padStart(12)}`
        + `  ${gain >= 0 ? '+' : ''}${gain.toFixed(2)}%`
        + `  spend ${tSpend}/${cfg.TALENT_BUDGET},${aSpend}/${cfg.ATTRIBUTE_BUDGET}`
        + (ok ? (code ? '  ACCEPTED' : '  accepted (no code emitted)') : '  *** REJECTED ***')
        + (!fullySpent ? ' under-spent' : '')
        + (got <= baseline ? ' no better than the level below' : ''));
    } finally { await pooled.destroy(); }
  }

  console.log('');
  console.log(`${accepted.length}/${targets.length} generated build(s) beat the level below them.`);
  if (accepted.length) {
    fs.writeFileSync(OUT, JSON.stringify(accepted, null, 1));
    console.log(`written to ${OUT}`);
    console.log('These are SEEDS extrapolated from one account, not observed player builds. They');
    console.log('extend the fallback into uncovered levels; they are not evidence about the game.');
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
