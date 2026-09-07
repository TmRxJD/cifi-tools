'use strict';
// FUMIGATION: the bug classes that do not show up as a wrong answer, but as CORRUPTION OVER TIME.
//
//   node tools/bench/fumigation-sweep.js [--verbose]
//
// The malformed-input sweep covers "answers garbage". This covers four classes it cannot see, each
// of which has a specific way of destroying a run while every individual result looks fine:
//
//   1. INPUT MUTATION. A builder that writes into the object it was handed corrupts the CALLER's
//      data. In this codebase that means a donor build mutated on first use, so every later refit
//      starts from a different corpus than the first -- and results silently depend on iteration
//      ORDER. Hunted by deep-freezing every input: a mutation throws in strict mode.
//
//   2. NON-DETERMINISM. The whole claim of the current method is "same input, same answer". A
//      wall-clock stopping rule already broke that once (+78.80% then +62.72% from an identical
//      configuration). Hunted by calling twice and comparing byte-for-byte.
//
//   3. BOUNDARY COLLAPSE. Zero budget, one node, an empty allocation, a budget smaller than the
//      cheapest node. These produce degenerate-but-plausible results -- an empty build reads as
//      "legal", and this project has already shipped a bench that passed on an empty comparison.
//
//   4. NaN CONTAMINATION. NaN compares false against everything, so a NaN score silently loses
//      every comparison and a NaN cost silently passes every budget check. It never raises an
//      error; it just quietly removes a candidate or admits an illegal one.
//
// GATE: mutation, non-determinism and NaN are always failures. Boundary results are reported with
// their values so each gets a judgement.

const H = require('./harness.js');
const R = require('./refit.js');

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
const failures = [];
const ok = (n) => { pass++; if (VERBOSE) console.log(`  ok    ${n}`); };
const bad = (n, d) => { failures.push(n); console.log(`  FAIL  ${n}${d ? ' -- ' + d : ''}`); };

/** Recursively freeze, so any write anywhere in the structure throws in strict mode. */
function deepFreeze(o) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) deepFreeze(o[k]);
  return o;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

(async () => {
  const known = H.loadKnownBuilds();
  console.log('FUMIGATION -- mutation, determinism, boundaries, NaN');

  for (const name of ['borge@73', 'ozzy@43', 'knox@30']) {
    let fx; try { fx = H.findFixture(known, name); } catch (e) { continue; }
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
    console.log(`\n=== ${name} ===`);

    // ---- 1. INPUT MUTATION -------------------------------------------------------------------
    // Every builder is called with FROZEN inputs. A write to the donor, the defs, the deps or the
    // threshold map throws, and that is the finding: the caller's data was being edited.
    const cases = [
      ['refitTiered', (donor) => R.refitTiered(deepFreeze(cfg.ATTRIBUTES), deepFreeze(clone(minVal)), cfg.ATTRIBUTE_BUDGET, deepFreeze(donor))],
      ['refitNaive', (donor) => R.refitNaive(deepFreeze(cfg.ATTRIBUTES), cfg.ATTRIBUTE_BUDGET, deepFreeze(donor))],
      ['refitTalents', () => R.refitTalents(deepFreeze(cfg.TALENTS), cfg.TALENT_BUDGET, deepFreeze(clone(build.talents)))],
      ['gatePayingFill', () => R.gatePayingFill(deepFreeze(cfg.ATTRIBUTES), deepFreeze(clone(minVal)), cfg.ATTRIBUTE_BUDGET, { deps: deepFreeze(clone(deps)) })],
      ['gatePayingFill(deep)', () => R.gatePayingFill(deepFreeze(cfg.ATTRIBUTES), deepFreeze(clone(minVal)), cfg.ATTRIBUTE_BUDGET, { deep: true, deps: deepFreeze(clone(deps)) })],
    ];
    for (const [label, fn] of cases) {
      const donor = clone(build.attributes);
      try { fn(donor); ok(`${name}: ${label} does not mutate its inputs`); }
      catch (e) {
        if (/read only|Cannot assign|not extensible|Cannot add/i.test(e.message)) {
          bad(`${name}: ${label} MUTATES its inputs`, e.message);
        } else ok(`${name}: ${label} does not mutate its inputs`);
      }
    }

    // The donor object itself must be unchanged after a refit -- the corpus is reused across
    // every target build, so a mutation here changes results by iteration order.
    {
      const donor = clone(build.attributes);
      const before = JSON.stringify(donor);
      R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, donor);
      R.refitNaive(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, donor);
      if (JSON.stringify(donor) !== before) bad(`${name}: the donor object was MODIFIED by refitting`);
      else ok(`${name}: the donor object survives refitting unchanged`);
    }

    // ---- 2. DETERMINISM ----------------------------------------------------------------------
    for (const [label, fn] of [
      ['refitTiered', () => R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, clone(build.attributes))],
      ['gatePayingFill', () => R.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deps })],
      ['gatePayingFill(deep)', () => R.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deep: true, deps })],
      ['enumerateSupports', () => H.Space.enumerateSupports(cfg.ATTRIBUTES, deps, cfg.ATTRIBUTE_BUDGET).length],
    ]) {
      const a = JSON.stringify(fn());
      const b = JSON.stringify(fn());
      if (a !== b) bad(`${name}: ${label} is NON-DETERMINISTIC`, 'two identical calls differed');
      else ok(`${name}: ${label} is deterministic`);
    }

    // ---- 3. BOUNDARY COLLAPSE -----------------------------------------------------------------
    const cheapest = Math.min(...cfg.ATTRIBUTES.map((d) => d.cost || 1));
    for (const [label, budget] of [['zero budget', 0], ['budget below the cheapest node', cheapest - 1], ['budget of exactly one node', cheapest]]) {
      for (const [fnName, fn] of [
        ['refitTiered', () => R.refitTiered(cfg.ATTRIBUTES, minVal, budget, clone(build.attributes))],
        ['gatePayingFill', () => R.gatePayingFill(cfg.ATTRIBUTES, minVal, budget, { deps })],
      ]) {
        let res;
        try { res = fn(); } catch (e) { ok(`${name}: ${fnName} at ${label} throws`); continue; }
        if (res === null) { ok(`${name}: ${fnName} at ${label} returns null`); continue; }
        const spend = R.spend(cfg.ATTRIBUTES, res);
        if (spend > budget) bad(`${name}: ${fnName} at ${label} OVERSPENDS`, `${spend} > ${budget}`);
        else ok(`${name}: ${fnName} at ${label} spends ${spend}/${budget}`);
      }
    }

    // ---- 3b. IDEMPOTENCE -----------------------------------------------------------------------
    // Re-fitting an ALREADY-fitted build to the SAME budget must be a no-op. If it is not, the
    // result depends on how many times the pipeline happened to call it -- and the corpus method
    // refits, climbs, then tops up, so a non-idempotent refit means the answer drifts with the
    // number of passes rather than with the input.
    {
      const once = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, clone(build.attributes));
      if (once) {
        const twice = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, clone(once));
        if (JSON.stringify(once) !== JSON.stringify(twice)) {
          bad(`${name}: refitTiered is NOT IDEMPOTENT`, 'refitting its own output changed it');
        } else ok(`${name}: refitTiered is idempotent`);
      }
      const t1 = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, clone(build.talents));
      if (t1) {
        const t2 = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, clone(t1));
        if (JSON.stringify(t1) !== JSON.stringify(t2)) {
          bad(`${name}: refitTalents is NOT IDEMPOTENT`, 'refitting its own output changed it');
        } else ok(`${name}: refitTalents is idempotent`);
      }
    }

    // ---- 3c. ALIASING --------------------------------------------------------------------------
    // Two calls must not hand back the SAME object. If they do, a caller editing one result
    // silently edits the other -- and this project has already been bitten by exactly that shape
    // (`getGearSets` rebuilding an array detached callers' references, and the reverse case where
    // a shared object meant a write landed on an orphan).
    {
      const a1 = R.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deps });
      const a2 = R.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deps });
      if (a1 === a2) bad(`${name}: gatePayingFill returns the SAME object on repeated calls`);
      else ok(`${name}: gatePayingFill returns a fresh object each call`);
      const r1 = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, clone(build.attributes));
      const donor2 = clone(build.attributes);
      const r2 = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, donor2);
      if (r1 === r2 || r2 === donor2) bad(`${name}: refitTiered aliases its input or a previous result`);
      else ok(`${name}: refitTiered returns a fresh object, not its input`);
    }

    // ---- 4. NaN CONTAMINATION ------------------------------------------------------------------
    // A NaN level must not sail through as a legal build: NaN compares false against every bound,
    // so `level > cap` is false and `spend <= budget` is false-but-unflagged downstream.
    {
      const poisoned = clone(build.attributes);
      const firstId = cfg.ATTRIBUTES[0].id;
      poisoned[firstId] = NaN;
      const s = H.Space.costOf(cfg.ATTRIBUTES, poisoned);
      if (Number.isNaN(s)) {
        bad(`${name}: Space.costOf returns NaN for a NaN level`,
          'NaN silently fails every budget comparison instead of raising');
      } else ok(`${name}: Space.costOf handles a NaN level without producing NaN`);
      let legal;
      try { legal = H.Space.isLegal(cfg.ATTRIBUTES, deps, minVal, poisoned, cfg.ATTRIBUTE_BUDGET); }
      catch (e) { legal = 'threw'; }
      if (legal === true) bad(`${name}: Space.isLegal says a NaN-level allocation is LEGAL`);
      else ok(`${name}: Space.isLegal does not bless a NaN-level allocation (${legal})`);
    }
  }

  console.log('');
  console.log(`${pass} check(s) passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('FAIL  infestation found:');
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log('PASS  no mutation, no non-determinism, no boundary overspend, no NaN contamination');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
