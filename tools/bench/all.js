'use strict';
// Run every gate in one command, and make SKIPS as visible as failures.
//
//   node tools/bench/all.js                 # everything that needs no external input
//   node tools/bench/all.js --bundle=<path> # also the checks that compare against cifi-tools
//   node tools/bench/all.js --strict        # a SKIP is a failure too
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

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const bundleArg = args.find((a) => a.startsWith('--bundle='));
const bundle = bundleArg ? bundleArg.slice('--bundle='.length) : null;

// Gates that need nothing beyond the repo.
const LOCAL = [
  'schema-test', 'app-schema-test', 'reference-schema-test',
  'relic-cost-test', 'relic-cap-check', 'relic-tier2-check',
  'node-coefficient-check', 'node-counter-check', 'node-name-check', 'node-effect-probe',
  'node-resource-check', 'node-factor-check', 'fleet-formula-check',
  'ship-node-gate-check', 'badge-check', 'uniform-term-check', 'crew-rank-check',
  'growth-counter-check', 'allocator-check', 'ship-test',
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
  // Structural/self-audit gates that existed but were in no list, so nothing ran them.
  'config-sanity-check', 'guard-liveness-check',
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

const startedAt = Date.now();
const results = [];
function run(name, extra) {
  const file = path.join(__dirname, `${name}.js`);
  if (!fs.existsSync(file)) {
    results.push({ name, status: 'MISSING', line: 'no such bench' });
    return;
  }
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [file, ...(extra || [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? 1 : e.status;
  }
  const lines = out.trimEnd().split('\n');
  const last = lines[lines.length - 1] || '';
  // A bench that printed SKIP verified less than it claims, even though it exited 0.
  const skipped = /^\s*(SKIP|skip)\b/m.test(out);
  const status = code !== 0 ? 'FAIL' : (skipped ? 'SKIP' : 'PASS');
  results.push({ name, status, line: last.trim(), out });
  // PRINT AS IT GOES, not only in the summary at the end.
  //
  // This suite runs ~45 gates sequentially and several of them run the optimizer, so a full pass
  // takes tens of minutes. Buffering everything to the end means it is silent for that whole time
  // and indistinguishable from a hang -- the same defect the sweep had, where the silence got
  // reported as a malfunction. The summary table below still prints; this is in addition.
  const t = Math.round((Date.now() - startedAt) / 1000);
  process.stdout.write(`  ${String(t).padStart(4)}s  ${status.padEnd(4)}  ${name}
`);
}

LOCAL.forEach((n) => run(n));
if (bundle) NEEDS_BUNDLE.forEach((n) => run(n, [bundle]));
REPORTS.forEach((n) => run(n));
const reportNames = new Set(REPORTS);

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
  console.log(`note  ${NEEDS_BUNDLE.length} bundle-comparison gate(s) not run -- pass `
    + '--bundle=<live-bundle.js> to include them (fetch the main bundle AND every chunk it '
    + 'references; comparing against index-*.js alone reports false gaps)');
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
process.exit(bad ? 1 : 0);
