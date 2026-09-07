'use strict';
// CAN THE CORPUS ITSELF SOLVE A BUILD, WITH NO SEARCH AT ALL?
//
//   node tools/bench/corpus-donor-check.js --only=knox@30,borge@73 [--band=0]
//
// THE IDEA. We hold 195 known-good community builds. Their STRUCTURE is highly regular per hunter,
// mode and level band -- Knox pins spa/pl at 1, dead at 10, sear at 5 and dumps the rest into
// kraken/soul; high-level Borge pins mino/herme at 20, senso/exp/weak/spart at 6/6/6/6 and dumps
// into ares. So instead of asking a stochastic archive to REDISCOVER that shape from a flat fill,
// take each OTHER build as a donor template, re-fit it to this build's budget, and evaluate it.
//
// Deterministic: no seeds, no archive, no descriptors. Same input, same answer, every time.
//
// LEAVE-ONE-OUT, BECAUSE SEEDING FROM THE CORPUS AND TESTING AGAINST THE CORPUS IS CIRCULAR.
// The target fixture is always excluded. `--band=N` additionally excludes every donor within N
// levels, which answers the harder question: is this working because the structure GENERALISES, or
// only because an almost-identical neighbour exists? Both numbers are reported; they are different
// claims and conflating them would be the same error as conflating "matches the tool" with
// "matches the game".
//
// This bench CHANGES NOTHING in the optimizer. It measures whether the idea is worth building.
//
// NOISE FLOOR. There is no seed variance: the method is deterministic, so repeated runs are
// identical rather than samples. Evaluation noise remains -- FINAL_ITERATIONS carries ~0.12% mean
// error, so a comparison of two scores carries ~0.2-0.3%, and a difference under ~0.3% is not a
// difference. (The archive search this is measured against also varied ~7 points across seeds.)

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const BAND = Number(opt('band', 0));
const ITERS = 1000;
if (!ONLY) throw new Error('corpus-donor-check: --only= is required; name exact fixtures');

/** Re-fit a donor allocation to a different budget: keep its shape, absorb the difference in its
 *  own largest node. Trim/!legal candidates are dropped rather than repaired -- a donor that cannot
 *  be made legal here is simply not a candidate, and silently repairing it would invent a build the
 *  corpus never contained. */
// THE CAP FIELD IS `maxLevel`. Reading `d.max` returns undefined, which silently means "no cap":
// the first version of this bench produced dead=31 against a cap of 10 and reported +103.60% on
// knox@30. An illegal build scores brilliantly because the evaluator is asked no questions.
function capOf(d) { return d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel; }

function refit(defs, deps, minVal, budget, donor) {
  const alloc = {};
  for (const d of defs) alloc[d.id] = Math.min(donor[d.id] || 0, capOf(d));
  const cost = () => H.Space.costOf(defs, alloc);
  // Biggest node by spend is the donor's dump stat; it absorbs the budget difference.
  let dump = null;
  for (const d of defs) {
    const v = (alloc[d.id] || 0) * (d.cost || 1);
    if (!dump || v > (alloc[dump.id] || 0) * (dump.cost || 1)) dump = d;
  }
  if (!dump) return null;
  const unit = dump.cost || 1;
  let guard = 100000;
  while (cost() > budget && (alloc[dump.id] || 0) > 0 && guard-- > 0) alloc[dump.id] -= 1;
  while (cost() + unit <= budget && guard-- > 0) {
    if ((alloc[dump.id] || 0) + 1 > capOf(dump)) break;
    alloc[dump.id] += 1;
  }
  if (cost() > budget) return null;
  // ASSERT, don't trust. Every node within its cap, or this candidate does not exist.
  for (const d of defs) {
    if ((alloc[d.id] || 0) > capOf(d)) {
      throw new Error(`refit produced ${d.id}=${alloc[d.id]} above its cap ${capOf(d)}`);
    }
  }
  return alloc;
}

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  const names = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`donors from the corpus, leave-one-out, exclusion band +-${BAND} levels, judged at ${ITERS} iters`);
  console.log('');
  let compared = 0;

  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const target = await H.evaluateAllocation(cfg, build.talents, build.attributes, ITERS);

    const donors = flat.filter((f) => f.hunter === fx.hunter
      && (f.mode || 'loot') === mode
      && f.uid !== fx.uid
      && Math.abs((f.level || 0) - (fx.level || 0)) > BAND);
    if (!donors.length) { console.log(`${name}: NO DONORS at band ${BAND} -- cannot measure`); continue; }

    let best = null;
    let evaluated = 0;
    for (const d of donors) {
      let db;
      try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
      const t = refit(cfg.TALENTS, {}, {}, cfg.TALENT_BUDGET, db.talents);
      const a = refit(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, cfg.ATTRIBUTE_BUDGET, db.attributes);
      if (!t || !a) continue;
      // (defs, deps, minVal, ALLOC, BUDGET) -- the two were swapped here, which made isLegal return
      // true unconditionally and let dependency-illegal builds be scored.
      if (!H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, a, cfg.ATTRIBUTE_BUDGET)) continue;
      const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
      let edgeOk = true;
      for (const child of Object.keys(deps)) {
        if ((a[child] || 0) <= 0) continue;
        for (const parent of deps[child]) if ((a[parent] || 0) <= 0) edgeOk = false;
      }
      if (!edgeOk) continue;
      const r = await H.evaluateAllocation(cfg, t, a, ITERS);
      evaluated++;
      const v = primary(r);
      if (!best || v > best.v) best = { v, donor: d.name || d.uid, r };
    }
    if (!evaluated) { console.log(`${name}: ZERO donors evaluated -- an empty comparison is a failure`); process.exit(1); }
    compared++;
    const pct = 100 * (best.v - primary(target)) / primary(target);
    console.log(`${name.padEnd(10)} ${mode.padEnd(5)} donors ${String(evaluated).padStart(3)}  `
      + `best ${pct.toFixed(2).padStart(8)}%  from ${String(best.donor).padEnd(10)}  `
      + `kill ${(best.r.bossKillRate === undefined ? -1 : best.r.bossKillRate).toFixed(1).padStart(5)}  `
      + `maxStage ${(best.r.maxStage || 0).toFixed(1)}`);
  }
  console.log('');
  if (!compared) { console.log('NOTHING MEASURED'); process.exit(1); }
  console.log(`${compared} build(s) compared. REPORT -- measures whether corpus structure generalises.`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
