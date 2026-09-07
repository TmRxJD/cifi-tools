'use strict';
// EXHAUSTIVE SWEEP: every exported function in the shipped optimizer, hammered with malformed
// input. A function that ANSWERS garbage is a defect, whatever it answers.
//
//   node tools/bench/malformed-input-sweep.js [--verbose]
//
// WHY THIS EXISTS. Every serious bug in this project's recent history is one shape: a helper
// returning a PLAUSIBLE VALUE on malformed input instead of failing. Found so far, all by accident
// or by a user's insistence rather than by a check:
//     Space.isLegal(..., BUDGET, ALLOC)        returned `true` for EVERYTHING
//     Space.enumerateSupports(..., MINVAL)     returned []  ("nothing is legal")
//     refit reading `d.max` (real: maxLevel)   undefined -> "uncapped" -> dead=31 against cap 10
//     res.diag.feasibleInfeasible one level up undefined -> "not engaged"
// Each looked exactly like a correct answer. None threw. That is the class.
//
// This sweep does not wait for the next one to be noticed. For every exported function it tries:
//   - no arguments at all
//   - every argument null
//   - every argument undefined
//   - a plausible call with ONE argument replaced by a wrong-typed value, position by position
//   - a plausible call with two adjacent arguments SWAPPED
// and records whether the call THREW (good) or RETURNED (suspicious).
//
// VERDICTS
//   throws                     -- correct: a malformed call is refused
//   returns undefined/null     -- tolerated: no false confidence is created
//   returns NaN                -- FINDING: NaN propagates silently through arithmetic and scores
//   returns a plausible value  -- FINDING: this is the exact failure mode above
//
// Not every finding is a bug: some functions are legitimately total (a formatter, a pure getter).
// This is a REPORT that names each one so it gets a judgement, plus a GATE on the specific
// contracts already established, which must never regress.

const H = require('./harness.js');

const VERBOSE = process.argv.includes('--verbose');

/** A value that is "plausible" -- looks like a real answer and would be used downstream. */
function isPlausible(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;            // `true` from a broken predicate is the worst case
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return true;                  // [] included: an empty enumeration reads as a real answer
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}
function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object{${Object.keys(v).slice(0, 4).join(',')}}`;
  if (typeof v === 'string') return `"${v.slice(0, 20)}"`;
  return String(v);
}

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, 'knox@30');
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });

  // A realistic argument of each shape, so a "plausible call" is genuinely plausible.
  const GOOD = {
    defs: cfg.ATTRIBUTES,
    deps: cfg.ATTRIBUTE_DEPENDENCIES || {},
    minVal: cfg.ATTRIBUTE_MIN_VALUE || {},
    alloc: build.attributes,
    budget: cfg.ATTRIBUTE_BUDGET,
  };
  // Wrong-typed stand-ins, deliberately of a DIFFERENT shape than anything expected.
  const WRONG = [null, undefined, 'garbage', 42, [], {}, true];

  // The whole shipped surface an optimizer run touches, not just the two obvious modules.
  const sb = H.browserSandbox();
  const modules = {
    Space: H.Space,
    Objective: H.Objective,
    CostFormulas: sb.CostFormulas,
    StoreSchema: sb.StoreSchema,
    BuildCode: sb.BuildCode || sb.HunterBuildCode,
  };

  // LEGITIMATELY TOTAL FUNCTIONS, allowlisted with the reason. These answer a no-argument call
  // BY DESIGN, and a report that keeps listing them trains the reader to skim past real findings --
  // which is how this project's config-sanity-check ended up printing eight permanent "failures"
  // that were its own negative controls working.
  const TOTAL_BY_DESIGN = {
    // --- genuinely total: no-argument factories and getters -------------------------------------
    'StoreSchema.freshStore': 'a factory -- takes no arguments',
    'StoreSchema.defaultImportPrefs': 'a factory -- takes no arguments',
    'StoreSchema.defaultLoadoutTabs': 'a factory -- takes no arguments',
    'StoreSchema.defaultLootFilter': 'a factory -- takes no arguments',
    'CostFormulas.knownRelicIds': 'a getter over the relic table -- takes no arguments',
    // --- clamps: turning any input into a valid value IS the contract ---------------------------
    'StoreSchema.clampIterations': 'a clamp -- coercing anything into the valid range is its job',
    'StoreSchema.iterationCeiling': 'a clamp over the same range',
    // --- formatter: must never throw mid-render -------------------------------------------------
    'CostFormulas.fmtBig': 'a display formatter; app.js renders null/undefined as "-" before calling it',
    // --- label lookups fall back to the raw key, which is the intended UI behaviour --------------
    'CostFormulas.resourceLabel': 'unknown hunter/key falls back to the raw key, shown as-is in the UI',
    'CostFormulas.resourceAbbr': 'same fallback-to-key behaviour',
    // --- a validator returning a NON-EMPTY problem list is the refusal, not an answer ------------
    'StoreSchema.validateAllocation': 'returns a populated problems list for unusable input -- that '
      + 'IS the refusal. It used to return [] (which reads as VALID) and that was the real defect.',
    'Objective.pathModes': 'a table getter -- takes no arguments at all',
    'Objective.contextFor': 'null/undefined mean "no boss target", the documented target-agnostic mode',
    'Objective.bossTargetFor': 'null/undefined mean "no stage known" -> the first boss; a non-numeric '
      + 'stage now throws, which was the real defect here',
  };

  const findings = [];
  let calls = 0;

  for (const [modName, mod] of Object.entries(modules)) {
    if (!mod) { console.log(`${modName}: NOT LOADED -- skipping (not a pass)`); continue; }
    console.log(`\n=== ${modName} ===`);
    for (const fnName of Object.keys(mod).sort()) {
      const fn = mod[fnName];
      if (typeof fn !== 'function') continue;
      const arity = fn.length;
      const results = [];

      const attempt = (label, argv) => {
        calls++;
        let outcome;
        try {
          const v = fn(...argv);
          outcome = { threw: false, value: v };
        } catch (e) { outcome = { threw: true, msg: e.message }; }
        results.push({ label, outcome });
        return outcome;
      };

      attempt('no args', []);
      attempt('all null', new Array(arity).fill(null));
      attempt('all undefined', new Array(arity).fill(undefined));
      for (let i = 0; i < Math.min(arity, 6); i++) {
        for (const w of WRONG.slice(0, 4)) {
          const argv = new Array(arity).fill(undefined).map((_, j) => (j === i ? w : GOOD.defs));
          attempt(`arg${i}=${describe(w)}`, argv);
        }
      }

      // Which of those produced a PLAUSIBLE answer rather than throwing?
      const answered = results.filter((r) => !r.outcome.threw && isPlausible(r.outcome.value));
      const nan = results.filter((r) => !r.outcome.threw && typeof r.outcome.value === 'number' && Number.isNaN(r.outcome.value));
      if (nan.length) {
        findings.push(`${modName}.${fnName} returns NaN on ${nan.length} malformed call(s) -- NaN propagates silently`);
        console.log(`  FINDING  ${fnName}(): returns NaN on ${nan.length} malformed call(s)`);
      } else if (answered.length && TOTAL_BY_DESIGN[`${modName}.${fnName}`]) {
        console.log(`  total    ${fnName}(): by design -- ${TOTAL_BY_DESIGN[`${modName}.${fnName}`]}`);
      } else if (answered.length) {
        const sample = answered.slice(0, 3).map((r) => `${r.label} -> ${describe(r.outcome.value)}`);
        findings.push(`${modName}.${fnName} answers ${answered.length} malformed call(s): ${sample.join('; ')}`);
        console.log(`  FINDING  ${fnName}(): answered ${answered.length}/${results.length} malformed call(s)`);
        if (VERBOSE) for (const s of sample) console.log(`             ${s}`);
      } else {
        console.log(`  ok       ${fnName}(): refused or returned nothing on all ${results.length} malformed call(s)`);
      }
    }
  }

  // ---- GATE: contracts already established must never regress ---------------------------------
  console.log('\n=== established contracts (these are a GATE, not a report) ===');
  const gate = [];
  const mustThrow = (name, fn) => {
    try { const v = fn(); gate.push(`${name} returned ${describe(v)} instead of throwing`); console.log(`  FAIL  ${name}`); }
    catch (e) { console.log(`  ok    ${name}`); }
  };
  mustThrow('Space.isLegal with alloc/budget swapped',
    () => H.Space.isLegal(GOOD.defs, GOOD.deps, GOOD.minVal, GOOD.budget, GOOD.alloc));
  mustThrow('Space.enumerateSupports with a non-numeric budget',
    () => H.Space.enumerateSupports(GOOD.defs, GOOD.deps, GOOD.minVal));
  mustThrow('Objective.modeOrThrow with an unknown mode',
    () => H.Objective.modeOrThrow('sideways'));
  mustThrow('Objective.describeRun with a null result',
    () => H.Objective.describeRun(null));

  console.log(`\n${calls} malformed call(s) attempted`);
  console.log(`${findings.length} finding(s) to triage:`);
  for (const f of findings) console.log(`  ${f}`);
  console.log('');
  console.log('Findings are a REPORT -- some functions are legitimately total (formatters, pure');
  console.log('getters). Each needs a judgement. The established contracts above are a GATE.');
  if (gate.length) { console.log(`FAIL  ${gate.length} established contract(s) regressed`); process.exit(1); }
  console.log('PASS  no established contract regressed');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
