'use strict';
// THE SAFETY NET, ASSERTED: THE OPTIMIZER MAY NEVER RETURN WORSE THAN THE BEST KNOWN GOOD BUILD.
//
//   node tools/bench/fallback-guarantee-check.js [--only=a,b,c]
//
// WHY THIS IS A GATE AND NOT A COMMENT. `search.js` admits up to 12 community builds, refit to the
// user's budget, as extra FINALISTS, and Stage 3 takes the maximum. So the returned build should be
// at least as good as the best of them -- that is the property that makes a search shortfall
// survivable, and it is the one the project owner is explicitly relying on.
//
// It has never been asserted end to end. `corpus-wiring-check` proves donors are ADMITTED; it does
// not prove the winner is at least as good as them. Those are different claims, and this project
// has repeatedly found features that were wired and still inert -- a flag that reached three of
// four call sites, `optimizeByRegime` exported and never called, three "honest reporting" functions
// that were never invoked. Admission is not protection.
//
// GATE: returned >= best refit corpus donor, minus the measured comparison noise floor. A build
// that comes back BELOW a donor it was literally handed is a defect in finalist selection, not a
// search-quality question, and no amount of search work would fix it.
//
// It also reports the MARGIN, because two very different situations both pass: the search finding
// something genuinely better, and the search returning the donor unchanged because it could not.

const H = require('./harness.js');
const R = require('./refit.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'knox@30,borge@42,ozzy@46,knox@12');
// THE SHIPPED LEVEL, BY NAME. This used to pass a hand-built spec (`{archiveEvals: 1200,
// refineSupports: 3, seeds: [...]}`) chosen to resemble `fast`. It is not `fast`: the shipped level
// carries no `seeds`, and one extra draw is enough to shift the whole random stream -- this repo has
// already measured that moving a result seven points. Testing a lookalike is how the default-effort
// mismatch invalidated the entire bench suite once before. Ask for the level by name.
const EFFORT = opt('effort', 'fast');
const ITERS = 1000;
const NOISE = 0.3;
const capOf = (d) => (d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel);

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  let failures = 0;
  let checked = 0;

  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    let fx; try { fx = H.findFixture(known, name); } catch (e) { continue; }
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const legal = (a) => cfg.ATTRIBUTES.every((d) => (a[d.id] || 0) <= capOf(d))
      && H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPS || {}, minVal, a, cfg.ATTRIBUTE_BUDGET);

    // The donor pool the SHIPPED path would see. Not leave-one-out: a real user's corpus contains
    // every community build, and the question here is the safety net rather than search quality.
    const donors = flat.filter((f) => f.hunter === fx.hunter && (f.mode || 'loot') === mode);
    let bestDonor = -Infinity; let bestName = null;
    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const shaped = [];
      for (const d of donors) {
        let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
        const t = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, db.talents);
        const a = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, db.attributes);
        if (!t || !a || !legal(a)) continue;
        shaped.push({ t, a, name: d.name || d.uid });
      }
      if (!shaped.length) { console.log(`${name}: no legal donors -- SKIP`); continue; }
      const ds = await pooled.score(shaped.map((s) => ({ talentAlloc: s.t, attrAlloc: s.a })), ITERS);
      ds.forEach((v, i) => { if (v > bestDonor) { bestDonor = v; bestName = shaped[i].name; } });

      const res = await H.Optimizer.optimize(cfg, {
        mode, scorer: pooled.score, effort: EFFORT,
      });
      const got = primary(await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, ITERS));
      checked++;

      const marginPct = 100 * (got - bestDonor) / Math.abs(bestDonor);
      const bad = marginPct < -NOISE;
      if (bad) failures++;
      console.log(`${name.padEnd(10)} returned ${got.toFixed(0).padStart(12)}`
        + `   best donor ${bestDonor.toFixed(0).padStart(12)} (${bestName})`
        + `   margin ${marginPct >= 0 ? '+' : ''}${marginPct.toFixed(2)}%`
        + (bad ? '   *** BELOW A DONOR IT WAS HANDED ***'
          : (marginPct <= NOISE ? '   (returned the donor -- the net caught it)' : '   (search beat the donor)')));
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} build(s) returned worse than a corpus donor`); process.exit(1); }
  console.log(`PASS  ${checked} build(s) at effort=${EFFORT}: never returned worse than the best known build`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
