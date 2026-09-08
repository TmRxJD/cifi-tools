'use strict';
// Run every gate in one command, and make SKIPS as visible as failures.
//
//   node tools/bench/all.js                 # THE PRE-PUSH CHECK: structural gates only, seconds
//   node tools/bench/all.js --sims          # also the simulation gates (tens of minutes)
//   node tools/bench/all.js --bundle=<path> # also the checks that compare against cifi-tools
//   node tools/bench/all.js --strict        # a SKIP is a failure too
//
// WHAT IS AND IS NOT IN THE DEFAULT RUN, decided by measurement rather than taste. A full run was
// 66 gates in 4,279s -- and NINE of them accounted for 4,212s of that, 98%. The other 57 gates
// total SIXTY-SEVEN SECONDS. The expensive nine all re-run the optimizer over fixtures, which
// answers "is the search still good", not "is this change safe to ship".
//
// Those are a manual, deliberate run -- the same category as the build sweep in run.js -- and they
// are no longer paid for on every push. `--sims` includes them.
//
// WHY THIS EXISTS. Several checks in this suite depend on gitignored inputs -- a pulled save, an
// extracted reference, the live bundle -- and each of them handled a missing input by printing
// SKIP and exiting 0. Run one at a time that is defensible; run as a suite it means a green board
// can hide checks that verified nothing, which is the exact failure this repo has now hit three
// times (a `\b` that became a literal backspace made two benches match nothing and pass; the
// inscryption fleet-slot check ran over an empty list and passed).
//
// So: every bench is classified PASS / FAIL / SKIP here, skips are counted and listed separately,
// and `--strict` turns them into failures for a machine that should have every input present.
// A bench that exits 0 while printing SKIP is reported as SKIP, not PASS.

const { execFile } = require('child_process');
const os = require('node:os');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const bundleArg = args.find((a) => a.startsWith('--bundle='));
const jobsArg = args.find((a) => a.startsWith('--jobs='));
// HOW MANY GATES AT ONCE. Several gates run the real optimizer, and each of those spawns its
// own WASM worker pool -- so this is bounded well below the core count on purpose. Uncapped
// parallelism here trades a suite that is slow for one that dies on
// "Cannot allocate Wasm memory for new instance", which is the failure MAX_POOL_SIZE exists
// to prevent inside a single process and which nothing prevents across several.
const JOBS = jobsArg ? Math.max(1, Number(jobsArg.slice('--jobs='.length)))
  : Math.max(1, Math.min(4, os.cpus().length - 1));
const bundle = bundleArg ? bundleArg.slice('--bundle='.length) : null;

// Gates that need nothing beyond the repo.
const LOCAL = [
  // The benches' own bench. Cheap (pure source inspection) and first, because every number the
  // rest of this suite prints is only as trustworthy as the bench that produced it.
  'bench-integrity-check',
  // Every shipped effort level must return a build. `fast` used to THROW on ozzy@11.
  'effort-level-check',
  'asset-version-check',
  'time-cap-check',
  'cross-block-gate-check',
  'corpus-recombine-check',
  'fallback-guarantee-check',
  'mode-fidelity-matrix',
  'underspend-repro',
  'refit-contract-check',
  'install-multiplier-tripwire',
  'corpus-mode-check',
  'time-cap-binds-check',
  'schema-test', 'app-schema-test', 'reference-schema-test',
  'relic-cost-test', 'relic-cap-check', 'relic-tier2-check',
  'node-coefficient-check', 'node-counter-check', 'node-name-check', 'node-effect-probe',
  'node-resource-check', 'node-factor-check', 'fleet-formula-check',
  'ship-node-gate-check', 'badge-check', 'uniform-term-check', 'crew-rank-check',
  'big-number-io-check', 'ship-evo-art-check', 'gen-tier-gate-check', 'growth-counter-check', 'allocator-check', 'ship-test',
  'attribute-tree-check', 'cap-raise-check',
  'gem-coverage-test', 'gem-tree-test',
  'param-plumbing-check', 'override-liveness-check', 'wasm-arity-check',
  'trinket-semantics-check', 'boss-target-check', 'import-legality-check',
  'gear-install-check', 'gear-name-check',
  'inscryption-slot-test', 'scene-defs-test',
  'path-relic-test', 'path-abort-test', 'route-test', 'gate-visibility-check',
  'underspend-test',
  // SEARCH-SIDE INVARIANTS. These were written for the borge@73 investigation and each one caught
  // a real defect while being written, which is the argument for running them every time:
  //   describe-run-check  -- describeRun labelled a stage-303 run "boss at 400", contradicting the
  //                          kill rate printed beside it, in exactly the case a boss diagnosis reads
  //   effort-option-check -- a misspelled effort flag silently disabled the feature under test, so
  //                          an A/B would have recorded the control's number as "no effect"
  //   boss-parity-check   -- the optimizer must never clear fewer bosses than the build it is given
  'describe-run-check', 'effort-option-check', 'boss-parity-check',
  // Derived from the source, because a hand-maintained list of flags drifts: CLAUDE.md said
  // five flags were deleted and the whitelist was 11 keys, while one was back and it was 18.
  'effort-flag-audit',
  // Share links were broken at BOTH ends for as long as the feature existed, and the person
  // who generates one never sees it fail -- only whoever clicks it does.
  'share-link-check',
  // Structural/self-audit gates that existed but were in no list, so nothing ran them.
  'config-sanity-check', 'guard-liveness-check', 'dead-symbol-audit',
  // THE MEASUREMENT MODULE'S OWN NEGATIVE CONTROLS. Every case is a real failure replayed: an
  // illegal build that scored +7.50%, a wall-clock stopping rule that made a PRNG-free method
  // return +78.80% then +62.72%, two arms judged at different fidelities, a sub-noise delta
  // reported as a win. If this stops refusing them, every number the suite prints is suspect.
  'measurement-check',
  // UNDER-SPEND AND ILLEGALITY IN THE ALLOCATION BUILDERS. This class has bitten twice: a fill loop
  // that `break`s at one node's cap left 55 of 73 talent points unspent on a far-away donor, and a
  // gate-paying fill that handled tier thresholds but forgot dependency EDGES produced illegal
  // builds on 24 of 24 fixtures. Both passed the caps check and the budget check, because
  // under-spend is <= budget and a missing parent is not a cap violation.
  'refit-spend-audit',
  // THE CLASS ITSELF: a helper that answers a MALFORMED call instead of failing. Wraps definition
  // objects in a Proxy that throws on any read of a field they do not have (catching `d.max` where
  // the field is `maxLevel`), and calls every exported predicate with swapped/wrong-typed arguments
  // demanding a throw. Every bug in this class today was invisible because the wrong answer looked
  // like a right one: isLegal returned `true` for everything, enumerateSupports returned [].
  'contract-audit',
  // CORRUPTION-OVER-TIME classes the malformed-input sweep cannot see: a builder that MUTATES the
  // caller's data (a donor edited on first use makes every later result depend on iteration order),
  // non-determinism, boundary collapse at zero/one-node budgets, NaN contamination (NaN compares
  // false against every bound, so it silently loses comparisons and passes budget checks), plus
  // idempotence and aliasing. Verified to FAIL on injected mutation and injected non-idempotence.
  'fumigation-sweep',
  // Every exported optimizer function called with wrong-typed and swapped arguments; a function
  // that ANSWERS garbage is the finding. Caught isEligible/isHeld returning `true` for strings,
  // costOf returning 0 (the banned silent-zero shape), and signature() colliding with a real
  // all-zeros allocation -- a poisoned memo key, where 54% of evaluation requests are memo hits.
  'malformed-input-sweep',
  // REACHABILITY, not reference counting. dead-symbol-audit and noop-audit both MISSED
  // `optimizeByRegime`: ~90 lines, exported, never called by the app or by optimize(), kept looking
  // alive by five in-file references and one bench. A bench is not production use. Its own selftest
  // runs every time and fails the gate if the tool stops being able to see that.
  // CORPUS SEEDING: is it actually wired, and is it strictly additive? A feature that looks wired
  // and does nothing is this project's signature failure -- optimizeByRegime was 90 exported lines
  // nobody called, and bossDamageBands reached three of four sites and silently no-oped. This
  // asserts from the run's own diag that donors were ADMITTED, not merely offered. It has already
  // caught the block being inert twice: once because refit/corpus registered only in the vm sandbox
  // and not on Node's global, once because the async parseBuildCode was called synchronously.
  'corpus-wiring-check',
  // The bench refit and the SHIPPED refit are two copies of one rule. Compares 864 allocations.
  'refit-parity-check',
  'reachability-audit',
];

// Gates that compare against the live cifi-tools bundle; they need --bundle=.
const NEEDS_BUNDLE = [
  'gate-coverage', 'upgrade-item-parity', 'talent-attribute-parity', 'live-override-diff',
  'inscryption-cost-check', 'base-stat-cost-check',
  'relic-maxlevel-check', 'inscryption-maxlevel-check',
];

// REPORTS, deliberately: they exit 0 even when they disagree, because a stronger check owns the
// same question (see each file's own note). Listed so they are run and read, never silently
// counted as gates.
const REPORTS = ['sirred-ship-check', 'save-coverage', 'loopmod-test'];

// SIMULATION GATES: they run the real optimizer or evaluator over fixtures, and each costs
// minutes. Excluded from the default run and included by --sims. Seconds are from a measured full
// run, so the cost of adding one here is visible rather than guessed.
//
// This is NOT "gates we trust less". They catch real defects -- effort-level-check exists because
// `fast` threw on a shipped dropdown option, fallback-guarantee-check asserts the corpus safety
// net. It is a statement about WHEN to pay for them: before a release or after touching the
// search, not before every push of a UI or importer change.
const SIMS = new Set([
  'effort-level-check',        // 1407s
  'underspend-repro',          //  938s
  'underspend-test',           //  600s+
  'fallback-guarantee-check',  //  712s
  'mode-fidelity-matrix',      //  407s
  'corpus-recombine-check',    //  277s
  'cross-block-gate-check',    //  205s
  'effort-option-check',       //  143s
  'corpus-wiring-check',       //   99s
  'boss-parity-check',
  'search-quality-check',
  // Wall-clock gates: expensive AND meaningless under load, so they are simulation-run only.
  'time-cap-check',
  'time-cap-binds-check',
  'runtime-ceiling-check',
  'effort-value-check',
]);
const withSims = args.includes('--sims');

const startedAt = Date.now();
const results = [];

// GATES THAT MEASURE WALL CLOCK MUST RUN ALONE.
//
// These assert things like "the default effort finishes inside the stated ceiling" and "the time
// cap actually bounds a run". Under load those numbers are inflated by contention and the gate
// fails for a reason that has nothing to do with the code -- exactly the mistake made when a
// per-build figure from a 7-way parallel sweep was read as a runtime violation. They run last,
// one at a time, after the pool has drained.
const TIMING_SENSITIVE = new Set([
  'time-cap-check',
  'time-cap-binds-check',
  'runtime-ceiling-check',
  'effort-value-check',
]);

function run(name, extra) {
  const file = path.join(__dirname, `${name}.js`);
  if (!fs.existsSync(file)) {
    results.push({ name, status: 'MISSING', line: 'no such bench' });
    return Promise.resolve();
  }
  const gateStart = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...(extra || [])],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`;
        const code = err ? (err.code === undefined ? 1 : err.code) : 0;
        finish(name, out, code, gateStart);
        resolve();
      });
  });
}

function finish(name, out, code, gateStart) {
  const lines = out.trimEnd().split('\n');
  const last = lines[lines.length - 1] || '';
  // A bench that printed SKIP verified less than it claims, even though it exited 0.
  const skipped = /^\s*(SKIP|skip)\b/m.test(out);
  const status = code !== 0 ? 'FAIL' : (skipped ? 'SKIP' : 'PASS');
  const gateSecs = Math.round((Date.now() - gateStart) / 1000);
  results.push({ name, status, line: last.trim(), out, secs: gateSecs });
  // PRINT AS IT GOES, not only in the summary at the end.
  //
  // This suite runs ~45 gates sequentially and several of them run the optimizer, so a full pass
  // takes tens of minutes. Buffering everything to the end means it is silent for that whole time
  // and indistinguishable from a hang -- the same defect the sweep had, where the silence got
  // reported as a malfunction. The summary table below still prints; this is in addition.
  // PER-GATE seconds as well as elapsed. Total runtime alone cannot answer "which gate should be
  // in a --quick subset"; only the per-gate cost can, and picking that subset by guesswork is how
  // a suite ends up dropping the gates that actually catch things.
  const t = Math.round((Date.now() - startedAt) / 1000);
  process.stdout.write(`  ${String(t).padStart(4)}s  ${status.padEnd(4)}  ${String(gateSecs).padStart(4)}s  ${name}
`);
}

/** Run `tasks` with at most `limit` in flight. */
async function pool(tasks, limit) {
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
}

async function main() {
  const queued = [];
  const serial = [];
  let skippedSims = 0;
  const add = (n, extra) => {
    if (SIMS.has(n) && !withSims) { skippedSims++; return; }
    (TIMING_SENSITIVE.has(n) ? serial : queued).push({ name: n, extra });
  };
  LOCAL.forEach((n) => add(n));
  if (bundle) NEEDS_BUNDLE.forEach((n) => add(n, [bundle]));
  REPORTS.forEach((n) => add(n));

  // LONGEST FIRST. The suite finishes no sooner than its slowest gate, so starting the known
  // heavyweights immediately is what keeps the tail short -- the same scheduling the build sweep
  // uses. Anything not named here is assumed cheap and sorts after; being wrong about one only
  // costs a little tail, while being wrong in the other direction leaves a 900s gate starting last.
  const HEAVY = ['effort-level-check', 'underspend-repro', 'underspend-test',
    'fallback-guarantee-check', 'mode-fidelity-matrix', 'corpus-recombine-check',
    'cross-block-gate-check', 'search-quality-check', 'boss-parity-check'];
  queued.sort((a, b) => {
    const ai = HEAVY.indexOf(a.name); const bi = HEAVY.indexOf(b.name);
    return (ai === -1 ? HEAVY.length : ai) - (bi === -1 ? HEAVY.length : bi);
  });

  console.log(`running ${queued.length} gate(s) ${JOBS} at a time`
    + (serial.length ? `, then ${serial.length} timing-sensitive gate(s) alone` : ''));
  if (skippedSims) {
    // NAMED, NOT SILENT. A suite that quietly runs less than it used to is how a green board stops
    // meaning anything -- the same reason SKIP is reported as loudly as FAIL here.
    console.log(`  (${skippedSims} simulation gate(s) NOT run -- add --sims for those; `
      + 'they are a manual run, not a pre-push check)');
  }
  await pool(queued.map((g) => () => run(g.name, g.extra)), JOBS);
  for (const g of serial) await run(g.name, g.extra);
  report();
}

const reportNames = new Set(REPORTS);

function report() {

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const tag = reportNames.has(r.name) ? `${r.status} (report)` : r.status;
  console.log(`${r.name.padEnd(width)}  ${tag.padEnd(14)} ${r.line.slice(0, 100)}`);
}

const gates = results.filter((r) => !reportNames.has(r.name));
const failed = gates.filter((r) => r.status === 'FAIL' || r.status === 'MISSING');
const skipped = gates.filter((r) => r.status === 'SKIP');

console.log('');
if (!bundle) {
  // ACTIONABLE, NOT JUST TRUE. This note used to say "pass --bundle=<live-bundle.js>" and stop
  // there -- a file nobody had, that had to be assembled by hand from a code-split site. So the
  // note printed on every run and everyone read past it, and the eight checks against the ORIGINAL
  // tool -- the strongest correctness evidence in this repo -- had never run in a suite pass.
  // fetch-bundle.js now assembles it in one command, so the instruction is two lines someone will
  // actually follow.
  console.log(`note  ${NEEDS_BUNDLE.length} bundle-comparison gate(s) not run. These check this `
    + 'tool against the ORIGINAL, which is the strongest correctness evidence available here.');
  console.log('      node tools/bench/fetch-bundle.js');
  console.log('      node tools/bench/all.js --bundle=tools/bench/live-bundle.js');
}
console.log(`${gates.length - failed.length - skipped.length} passed, ${failed.length} failed, `
  + `${skipped.length} skipped, ${REPORTS.length} report(s)`);

if (failed.length) {
  console.log('\nfailures:');
  failed.forEach((r) => {
    console.log(`\n=== ${r.name} ===`);
    (r.out || '').split('\n').filter((l) => /FAIL|failure/.test(l)).slice(0, 8)
      .forEach((l) => console.log(`  ${l.trim()}`));
  });
}
if (skipped.length) {
  console.log('\nskipped (these verified NOTHING -- a green board here is not a clean board):');
  skipped.forEach((r) => {
    const why = (r.out || '').split('\n').find((l) => /^\s*(SKIP|skip)\b/.test(l)) || '';
    console.log(`  ${r.name}: ${why.trim()}`);
  });
}

  const bad = failed.length + (strict ? skipped.length : 0);
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error('FAIL  the suite itself crashed: ' + ((e && e.stack) || e));
  process.exit(1);
});
