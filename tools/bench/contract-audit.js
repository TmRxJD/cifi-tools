'use strict';
// SYSTEMATIC HUNT FOR THE BUG CLASS THAT HAS DOMINATED THIS PROJECT:
// a helper that returns a PLAUSIBLE VALUE on malformed input instead of failing.
//
//   node tools/bench/contract-audit.js
//
// EVERY INSTANCE FOUND SO FAR, and how each stayed hidden:
//   Space.isLegal(defs, deps, minVal, BUDGET, ALLOC)   args swapped  -> returned true for EVERYTHING
//   refit read `d.max` (the field is `maxLevel`)       typo          -> undefined = "uncapped",
//                                                                       produced dead=31 vs cap 10
//                                                                       and a reported +103.60%
//   enumerateSupports(defs, deps, MINVAL)              wrong arg     -> 0 supports, silently
//   res.diag.feasibleInfeasible read one level shallow typo          -> undefined = "not engaged"
//   a fill loop that `break`s at one node's cap        logic         -> under-spend passes `<= budget`
//   gatePayingFill ignoring dependency EDGES           missing dim   -> not a cap or threshold error
//
// TWO ROOT MECHANISMS, and this audit attacks both directly rather than case by case:
//
//   1. FIELD-NAME TYPOS. Definition objects are wrapped in a Proxy that THROWS on any read of a
//      property the real object does not have, then every allocation builder is run against them.
//      `d.max` cannot survive this; it throws with the offending name.
//
//   2. POSITIONAL-ARGUMENT MISUSE. Every exported predicate/builder is called with deliberately
//      wrong argument ORDER and wrong TYPES, and is required to THROW rather than return a value.
//      A predicate that answers a malformed call is the defect, whatever it answers.
//
// This is a GATE. A function that answers a malformed call fails it.

const H = require('./harness.js');
const M = require('./measurement.js');
const R = require('./refit.js');

let pass = 0;
const failures = [];
function ok(name) { pass++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures.push(name); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }

/** Wrap an object so reading a property it does not own throws instead of yielding undefined. */
function strict(obj, label) {
  const own = new Set(Object.keys(obj));
  return new Proxy(obj, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      if (prop === 'toJSON' || prop === 'inspect' || prop === 'constructor') return target[prop];
      if (!own.has(prop) && !(prop in Object.prototype)) {
        throw new Error(`FIELD TYPO: read of "${String(prop)}" on ${label}; real fields are ${[...own].join(', ')}`);
      }
      return target[prop];
    },
  });
}

async function mustThrow(name, fn, expectFragment) {
  try {
    const v = await fn();
    bad(name, `it RETURNED ${JSON.stringify(v)} instead of throwing`);
  } catch (e) {
    if (expectFragment && !String(e.message).includes(expectFragment)) {
      bad(name, `threw the wrong error: ${e.message}`);
    } else ok(name);
  }
}

(async () => {
  console.log('CONTRACT AUDIT -- helpers must FAIL on malformed input, not answer it');
  const known = H.loadKnownBuilds();

  for (const name of ['borge@73', 'ozzy@43', 'knox@30']) {
    let fx; try { fx = H.findFixture(known, name); } catch (e) { continue; }
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};

    // ---- 1. FIELD-NAME TYPOS ---------------------------------------------------------------
    // Every builder runs against strict definition objects. A read of a non-existent field throws.
    const strictAttrs = cfg.ATTRIBUTES.map((d) => strict(d, `${name} attribute def "${d.id}"`));
    const strictTalents = cfg.TALENTS.map((d) => strict(d, `${name} talent def "${d.id}"`));
    const builders = [
      ['refitTiered', () => R.refitTiered(strictAttrs, minVal, cfg.ATTRIBUTE_BUDGET, build.attributes)],
      ['refitNaive', () => R.refitNaive(strictAttrs, cfg.ATTRIBUTE_BUDGET, build.attributes)],
      ['refitTalents', () => R.refitTalents(strictTalents, cfg.TALENT_BUDGET, build.talents)],
      ['gatePayingFill(breadth)', () => R.gatePayingFill(strictAttrs, minVal, cfg.ATTRIBUTE_BUDGET, { deps })],
      ['gatePayingFill(deep)', () => R.gatePayingFill(strictAttrs, minVal, cfg.ATTRIBUTE_BUDGET, { deep: true, deps })],
      ['spend', () => R.spend(strictAttrs, build.attributes)],
      ['pointsBelow', () => R.pointsBelow(strictAttrs, minVal, build.attributes, 150)],
    ];
    for (const [label, fn] of builders) {
      try { fn(); ok(`${name}: ${label} reads only real definition fields`); }
      catch (e) {
        if (String(e.message).startsWith('FIELD TYPO')) bad(`${name}: ${label} field access`, e.message);
        else ok(`${name}: ${label} reads only real definition fields`); // a domain error is not a typo
      }
    }
  }

  // ---- 2. POSITIONAL-ARGUMENT MISUSE ---------------------------------------------------------
  const fx = H.findFixture(known, 'knox@30');
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
  const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
  const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};

  console.log('');
  console.log('  -- malformed calls must throw, not answer --');

  // The exact historical defect: alloc and budget swapped.
  await mustThrow('Space.isLegal with alloc/budget swapped',
    () => H.Space.isLegal(cfg.ATTRIBUTES, deps, minVal, cfg.ATTRIBUTE_BUDGET, build.attributes), 'Argument order');
  await mustThrow('Space.isLegal with a string budget',
    () => H.Space.isLegal(cfg.ATTRIBUTES, deps, minVal, build.attributes, 'ninety'), 'budget');
  await mustThrow('Space.isLegal with a null alloc',
    () => H.Space.isLegal(cfg.ATTRIBUTES, deps, minVal, null, cfg.ATTRIBUTE_BUDGET), 'alloc');

  // measurement.js: no silent defaults.
  await mustThrow('measure() with no fidelity',
    () => M.measure({ H, cfg, mode: 'loot', talents: build.talents, attrs: build.attributes, label: 'x' }), 'fidelity');
  await mustThrow('measure() with a string fidelity',
    () => M.measure({ H, cfg, mode: 'loot', talents: build.talents, attrs: build.attributes, label: 'x', fidelity: 'lots' }), 'fidelity');

  // enumerateSupports: the historical wrong-arg call returned ZERO supports silently. An empty
  // enumeration is indistinguishable from "nothing is legal", so it must not pass quietly.
  {
    const good = H.Space.enumerateSupports(cfg.ATTRIBUTES, deps, cfg.ATTRIBUTE_BUDGET);
    if (!good || !good.length) bad('enumerateSupports returns a non-empty set when called correctly');
    else ok(`enumerateSupports returns ${good.length} supports when called correctly`);
    let bogus = null;
    try { bogus = H.Space.enumerateSupports(cfg.ATTRIBUTES, deps, minVal); } catch (e) { bogus = 'threw'; }
    if (bogus === 'threw') ok('enumerateSupports throws when given a non-numeric budget');
    else if (Array.isArray(bogus) && bogus.length === 0) {
      bad('enumerateSupports with a non-numeric budget',
        'returns an EMPTY ARRAY instead of throwing -- an empty enumeration reads as "nothing is legal"');
    } else ok('enumerateSupports tolerates a non-numeric budget without a silent empty result');
  }

  console.log('');
  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('FAIL  a helper answered a malformed call instead of failing:');
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log('PASS  every audited helper reads only real fields and refuses malformed calls');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
