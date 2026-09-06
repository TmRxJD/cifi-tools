'use strict';
// A GATE THAT CANNOT FAIL IS NOT A GATE, AND IT LOOKS EXACTLY LIKE ONE THAT PASSES.
//
//   node tools/bench/bench-integrity-check.js
//
// This repo has been bitten by measurement defects far more often than by real bugs. Today alone:
//   - sweep-progress ranked PUSH builds on loot, so a push build that beat its import on stage was
//     reported as a shortfall
//   - its ETA extrapolated from the cheapest builds only, under-reporting by more than 2x
//   - config-sanity-check counted its own negative controls as failures, so a clean run printed
//     "3303/3311 checks passed"
//   - boss-damage-ab built its scorer from the fixture's mode but hardcoded `mode: 'loot'` into
//     optimize(), which would have silently corrupted any push measurement
//   - all.js buffered everything to the end, so a 40-minute suite was indistinguishable from a hang
//   - schema-test asserted the very id-hardcoding bug it was meant to guard against
// and historically: two benches disabled by a stray backspace, and an inscryption check that ran
// over an empty list and passed regardless.
//
// So the benches need a bench. This one asserts the properties that make a result trustworthy at
// all, and it is deliberately CHEAP (pure source inspection, no evaluation) so it can run always.
//
// PROPERTY 1 -- a gate must be able to exit non-zero. A file that looks like a gate (named
//   *-check/*-test, or printing PASS) but has no non-zero exit reports success unconditionally.
//   A REPORT is legitimate -- several questions here are genuinely answered by "theory not
//   supported" -- but it must SAY so, because from the outside the two are identical.
//
// PROPERTY 2 -- a bench that judges fixtures must not hardcode an objective. Fixtures carry a
//   mode; judging a push build on loot fails it for succeeding at what it was built for.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const HELPERS = new Set([
  'harness.js', 'app-schemas.js', 'reference-schemas.js', 'eval-pool.js', 'eval-pool-worker.js',
  'worker.js', 'show.js', 'summarize.js', 'run.js', 'all.js', 'bench-integrity-check.js',
]);

let failures = 0;
let checked = 0;
const fail = (m) => { failures++; console.log('FAIL  ' + m); };

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && !HELPERS.has(f));

// --- PROPERTY 1 -------------------------------------------------------------------------------
const silent = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const looksLikeGate = /-check\.js$|-test\.js$/.test(f) || /\bPASS\b/.test(src);
  if (!looksLikeGate) continue;
  checked++;
  let canFail = false;
  for (const m of src.matchAll(/process\.exit(?:Code)?\s*(?:\(|=)\s*([^)\n;]*)/g)) {
    const arg = (m[1] || '').trim();
    if (arg && arg !== '0') { canFail = true; break; }
  }
  const declaredReport = /THIS IS A REPORT|is a REPORT|REPORT, NOT A GATE|report only|exits? 0 even/i.test(src);
  if (!canFail && !declaredReport) {
    silent.push(f);
    fail(`${f} looks like a gate but can never exit non-zero, and does not declare itself a REPORT`);
  }
}
if (!silent.length) console.log(`ok    all ${checked} gate-shaped bench(es) can fail, or declare themselves reports`);

// --- PROPERTY 2 -------------------------------------------------------------------------------
// Only benches that actually read fixture modes are in scope: a bench operating on one named
// build, or on data files, has no mode to respect.
const modeAware = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  // SCOPED TO BENCHES THAT JUDGE A BUILD AGAINST ITS IMPORT, which is where mode decides the
  // verdict. A bench that merely USES a fixture as a vehicle -- effort-option-check exercising the
  // option whitelist, pareto-archive-check inspecting archive structure -- has no verdict to skew,
  // and flagging it was this check making the same over-broad-measurement mistake it exists to
  // catch. The signature of a verdict is comparing the optimizer's result to the import's.
  const judgesFixtures = /loadKnownBuilds\(/.test(src)
    && /Optimizer\.optimize\(/.test(src)
    && /(importLoot|imported\.|reference\.|primaryOf|expectedLootScore)/.test(src);
  if (!judgesFixtures) continue;
  checked++;
  const hardcodes = /mode:\s*'loot'/.test(src);
  const respectsMode = /\.mode\b/.test(src);
  if (hardcodes && !respectsMode) {
    fail(`${f} optimizes fixtures with a hardcoded mode:'loot' and never reads a fixture's own mode`
      + ' -- a push build judged on loot fails for succeeding at what it was built for');
  } else {
    modeAware.push(f);
  }
}
console.log(`ok    ${modeAware.length} fixture-judging bench(es) respect the fixture's own mode`);

// --- PROPERTY 3: an A/B must assert its flag from the RESULT, not the argument ------------------
// bossDamageBands reached cellOf, illuminate's signature and its diag record and was NEVER passed
// at the call site. Unnoticed, the ON arm returns the control's number and it is written down as
// "measured, no effect" -- a false negative indistinguishable from a real one. Any bench that
// toggles an effort flag between arms must read it back from res.diag and refuse to report if it
// disagrees.
console.log('');
const abBenches = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  // An A/B is a bench that sets an effort flag from a variable rather than a literal.
  const togglesFlag = /effort:\s*\{[^}]*(bossDamageBands|feasibleInfeasible|ocbaPolish|betAndRun|paretoDepth|finalIterations):\s*[a-z]/i.test(src);
  if (!togglesFlag) continue;
  checked++;
  abBenches.push(f);
  const readsBack = /diag[\s\S]{0,80}(archive|betAndRun|ocbaPolish)/.test(src)
    && /(recorded|readBack|!==\s*(on|fi|depth|k))/.test(src);
  if (!readsBack) {
    fail(`${f} toggles an effort flag between arms but never asserts it from res.diag `
      + '-- an unwired flag would make the ON arm silently report the control');
  }
}
if (abBenches.length) console.log(`ok    ${abBenches.length} A/B bench(es) assert their flag from the result`);

// --- PROPERTY 4: a bench comparing scores must state its noise floor ----------------------------
// The search varies ~7 percentage points across seeds and a comparison of two FINAL_ITERATIONS
// scores carries ~0.3%. A bench that prints a delta without referencing either invites a reader to
// treat noise as signal -- which is exactly what happened to knox@31's "regression".
console.log('');
let noisy = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const printsDelta = /(pct|delta|Delta)[\s\S]{0,40}toFixed\(2\)/.test(src);
  if (!printsDelta) continue;
  checked++;
  const statesFloor = /noise|variance|seed variance|comparison floor|NOISE_PCT|one sample|ONE SAMPLE/i.test(src);
  if (!statesFloor) { noisy++; fail(`${f} prints a score delta but never states a noise floor or seed variance`); }
}
if (!noisy) console.log('ok    every delta-printing bench states its noise floor');

// --- PROPERTY 5: no constructed regexes with escapes in bench tooling ---------------------------
// Five patches this session had a backslash level eaten by the heredoc that wrote them, turning an
// escaped word-boundary into a literal backspace that matches nothing. Two benches were historically
// disabled that way and passed on empty matches.
console.log('');
let backspaces = 0;
for (const f of files) {
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
  checked++;
  // An actual 0x08 in the source is always a mistake.
  if (raw.includes(String.fromCharCode(8))) {
    backspaces++;
    fail(`${f} contains a literal BACKSPACE byte -- almost certainly an eaten regex escape`);
  }
}
if (!backspaces) console.log('ok    no bench contains a literal backspace byte');

console.log('');
if (!checked) { console.log('FAIL  bench-integrity-check inspected nothing'); process.exit(1); }
if (failures) { console.log(`FAIL  ${failures} bench integrity problem(s) across ${files.length} files`); process.exit(1); }
console.log(`PASS  ${checked} checks over ${files.length} bench files`);
