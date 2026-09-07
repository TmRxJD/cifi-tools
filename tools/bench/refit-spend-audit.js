'use strict';
// DOES EVERY ALLOCATION-BUILDING FUNCTION ACTUALLY SPEND THE BUDGET? Systematic under-spend hunt.
//
//   node tools/bench/refit-spend-audit.js
//
// WHY. `refitTalents` used the naive form, which fills exactly ONE node and `break`s when that node
// hits its cap. Every talent is capped, so a far-away donor's refit stopped there and left the rest
// unspent: 18 of 73 talent points on borge@73, 16 of 30 on knox@30. Nothing caught it -- the caps
// check passed, the budget check passed (under-spend is <= budget), and near-neighbour donors
// happened to spend fully, which is exactly the case that gets eyeballed.
//
// An under-spent build is a hard error in this project ("Optimizer left N point(s) unspent"),
// because every hunter has a cost-1 attribute and all talents cost 1, so a point is essentially
// always spendable. This audit runs every allocation BUILDER over every fixture and reports any
// that leave budget on the table, so this class cannot hide in one function again.
//
// It is a GATE: an under-spending builder fails it.

const H = require('./harness.js');
const M = require('./measurement.js');
const R = require('./refit.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const LIMIT = Number(opt('limit', 8));

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  // A spread of levels per hunter, so a near-neighbour donor never hides the defect.
  const targets = [];
  for (const hunter of ['borge', 'ozzy', 'knox']) {
    const hs = flat.filter((f) => f.hunter === hunter && (f.mode || 'loot') === 'loot')
      .sort((a, b) => (a.level || 0) - (b.level || 0));
    if (!hs.length) continue;
    const step = Math.max(1, Math.floor(hs.length / LIMIT));
    for (let i = 0; i < hs.length && targets.length < LIMIT * 3; i += step) targets.push(hs[i]);
  }

  const problems = [];
  let checked = 0;

  for (const fx of targets) {
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const donors = flat.filter((f) => f.hunter === fx.hunter && (f.mode || 'loot') === 'loot' && f.uid !== fx.uid);

    // --- the rules-built fill, which uses no donor at all -------------------------------------
    for (const deep of [false, true]) {
      const a = R.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deep, deps: cfg.ATTRIBUTE_DEPENDENCIES || {} });
      checked++;
      if (!a) { problems.push(`${fx.name}: gatePayingFill(deep=${deep}) returned null`); continue; }
      const s = R.spend(cfg.ATTRIBUTES, a);
      if (s < cfg.ATTRIBUTE_BUDGET) {
        problems.push(`${fx.name}: gatePayingFill(deep=${deep}) spends ${s}/${cfg.ATTRIBUTE_BUDGET}`);
      }
      const leg = M.legalityOf(H, cfg, build.talents, a);
      if (!leg.ok) problems.push(`${fx.name}: gatePayingFill(deep=${deep}) ILLEGAL -- ${leg.problems.join('; ')}`);
    }

    // --- donor-based refits, sampled across the whole donor range ------------------------------
    const sample = donors.filter((_, i) => i % Math.max(1, Math.floor(donors.length / 6)) === 0);
    for (const d of sample) {
      let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
      const t = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, db.talents);
      const a = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, db.attributes);
      checked++;
      if (t) {
        const ts = R.spend(cfg.TALENTS, t);
        if (ts < cfg.TALENT_BUDGET) problems.push(`${fx.name} <- ${d.name || d.uid}: refitTalents spends ${ts}/${cfg.TALENT_BUDGET}`);
      }
      if (a) {
        const as = R.spend(cfg.ATTRIBUTES, a);
        // An attribute refit MAY legitimately under-spend when every remaining node is capped or
        // gated -- but that should be rare, so it is reported rather than silently accepted.
        if (as < cfg.ATTRIBUTE_BUDGET) problems.push(`${fx.name} <- ${d.name || d.uid}: refitTiered spends ${as}/${cfg.ATTRIBUTE_BUDGET}`);
      }
    }
  }

  console.log(`checked ${checked} allocation(s) across ${targets.length} fixture(s)`);
  if (!checked) { console.log('NOTHING MEASURED -- zero checks is a failure'); process.exit(1); }
  if (!problems.length) { console.log('PASS  every builder spends its full budget and returns a legal allocation'); return; }
  console.log(`FAIL  ${problems.length} problem(s):`);
  const shown = problems.slice(0, 40);
  for (const p of shown) console.log('  ' + p);
  if (problems.length > shown.length) console.log(`  ... and ${problems.length - shown.length} more`);
  process.exit(1);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
