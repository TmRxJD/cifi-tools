'use strict';
// The optimizer acceptance gate.
//
// For every known real build code -- the community/progression builds in compare-mcp's
// known-builds*.mjs -- this runs two gates in order:
//
//   Gate 1 (parity)  the clone's loot score for the imported code matches what the original
//                    tool reported for that same code, within Monte Carlo tolerance. If the
//                    two tools disagree about what a build is worth, nothing downstream means
//                    anything, so a parity failure short-circuits that build.
//   Gate 2 (quality) given exactly the budget that build spent, the optimizer's result is at
//                    least as good on BOTH loot per minute and average stage.
//
// The bar is zero-tolerance, and that is only fair because evaluation is deterministic (a
// fresh WASM instance returns bit-identical output for identical arguments). A failure is
// always a real failure, never sampling luck, and re-running gives identical numbers.
//
// FAIL FAST. Builds run in small parallel batches and the sweep aborts on the first failure
// rather than burning an hour to tell you something it knew in the first minute. Pass --all to
// run everything regardless (for a full picture once it's close).
//
//   node tools/bench/run.js                    # every build, stop at first failure
//   node tools/bench/run.js --all              # every build, never stop early
//   node tools/bench/run.js borge              # one hunter
//   node tools/bench/run.js borge 0 10         # a slice
//   node tools/bench/run.js --batch=6          # override batch size
//   node tools/bench/run.js borge --all --resume --out=borge.json
//
// RESUMABLE. A full sweep runs for hours, and long runs here have repeatedly been killed part
// way through with their buffered stdout lost -- which made every attempt start over from zero.
// Results are therefore written after EVERY batch, and `--resume` skips whatever the target
// results file already contains. Re-invoking the same command until it reports no remaining
// builds converges on a complete run instead of restarting. Use `--out=` to give each hunter its
// own file so resuming one never picks up another's results.
//
// Summarize any results file (including a partial one) with tools/bench/summarize.js.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const H = require('./harness.js');

const WORKER_FILE = path.join(__dirname, 'worker.js');
const DEFAULT_RESULTS_FILE = path.join(__dirname, 'results.json');

function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const batchFlag = flags.find((f) => f.startsWith('--batch='));
  const outFlag = flags.find((f) => f.startsWith('--out='));
  return {
    runAll: flags.includes('--all'),
    resume: flags.includes('--resume'),
    // A separate results file per run keeps hunters independent, so --resume can never carry
    // one hunter's results into another's run.
    outFile: outFlag ? outFlag.slice('--out='.length) : DEFAULT_RESULTS_FILE,
    batchSize: batchFlag ? Number(batchFlag.split('=')[1]) : Math.max(1, os.cpus().length - 1),
    hunter: positional[0],
    from: positional[1] !== undefined ? Number(positional[1]) : 0,
    to: positional[2] !== undefined ? Number(positional[2]) : undefined,
  };
}

function selectFixtures(args) {
  const known = H.loadKnownBuilds();
  const hunters = args.hunter ? [args.hunter] : ['borge', 'ozzy', 'knox'];
  let all = [];
  for (const h of hunters) {
    if (!known[h]) throw new Error(`Unknown hunter "${h}"`);
    all = all.concat(known[h]);
  }
  // Cheapest (lowest level) first, so a systemic problem surfaces in seconds rather than after
  // the slowest high-level builds have run.
  all.sort((a, b) => (a.level || 0) - (b.level || 0));
  return all.slice(args.from, args.to === undefined ? all.length : args.to);
}

/**
 * Classify a completed case. Returns null when it passed.
 *
 * A build is gated on ITS OWN objective: loot builds on loot per minute, push builds on
 * average stage. Gating both metrics on every build sounds stricter but is simply wrong --
 * pushing deeper costs loot per minute, so a push build that correctly gains stage would be
 * failed for succeeding. Measured directly: the level-12 and level-13 Borge push fixtures gain
 * +2.8% stage while shedding ~6-9% loot, which is the trade a push build exists to make.
 *
 * The secondary metric is still measured and surfaced (see secondaryWarningOf) so a genuine
 * "gained loot by gutting progression" result can never hide -- it just doesn't fail the gate.
 */
function failureOf(res) {
  if (!res.ok) return `ERROR ${res.error.split('\n')[0]}`;
  // Only an OVERCOUNT is a parity failure. A share code cannot carry ~7 ambient account-wide
  // gem params, so a code-only evaluation can legitimately land below a score recorded on a
  // fully-invested account -- confirmed against the live site for knox #19. Nothing, however,
  // can make it land above one, so an overcount is a genuine clone-side math error.
  if (res.parity === 'overcount') {
    return `PARITY clone ${res.importLoot.toFixed(2)} EXCEEDS recorded ${res.expectedLootScore} (+${res.parityDeltaPct.toFixed(2)}%)`;
  }
  if (res.mode === 'push') {
    if (res.optimizedStage < res.importStage) {
      return `STAGE ${res.importStage.toFixed(2)} -> ${res.optimizedStage.toFixed(2)} (${res.stageDeltaPct.toFixed(2)}%)`;
    }
  } else if (res.optimizedLoot < res.importLoot) {
    return `LOOT ${res.importLoot.toFixed(2)} -> ${res.optimizedLoot.toFixed(2)} (${res.lootDeltaPct.toFixed(2)}%)`;
  }
  return null;
}

/** The non-objective metric moving backwards -- reported, never fatal. */
function secondaryWarningOf(res) {
  if (!res.ok) return null;
  if (res.mode === 'push') {
    return res.optimizedLoot < res.importLoot ? `loot ${res.lootDeltaPct.toFixed(2)}%` : null;
  }
  return res.optimizedStage < res.importStage ? `stage ${res.stageDeltaPct.toFixed(2)}%` : null;
}

function describe(res) {
  const label = `${res.hunter}/${res.set}#${res.index} lvl${res.level ?? '?'} ${res.mode}`;
  const failure = failureOf(res);
  if (failure) return `FAIL ${label}  ${failure}`;
  const warn = secondaryWarningOf(res);
  return `PASS ${label}  loot ${res.importLoot.toFixed(2)} -> ${res.optimizedLoot.toFixed(2)}`
    + ` (${res.lootDeltaPct >= 0 ? '+' : ''}${res.lootDeltaPct.toFixed(2)}%)`
    + `  stage ${res.importStage.toFixed(1)} -> ${res.optimizedStage.toFixed(1)}`
    + ` (${res.stageDeltaPct >= 0 ? '+' : ''}${res.stageDeltaPct.toFixed(2)}%)`
    + `  ${res.evals} evals ${res.seconds.toFixed(0)}s`
    + (warn ? `  [secondary down: ${warn}]` : '');
}

/** Run one batch of fixtures concurrently, one worker per fixture. */
function runBatch(fixtures) {
  return Promise.all(fixtures.map((fixture) => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE);
    worker.on('message', (res) => { worker.terminate(); resolve(res); });
    worker.on('error', (err) => { worker.terminate(); reject(err); });
    worker.postMessage(fixture);
  })));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsFile = args.outFile;
  let fixtures = selectFixtures(args);

  // --resume: carry forward whatever a previous (possibly interrupted) run already finished and
  // only run what is left. A full sweep takes hours and has been observed dying partway through
  // with its buffered tail lost, which made every attempt start from zero. Combined with the
  // per-batch write above, repeated invocations now converge instead of restarting.
  const results = [];
  let totalTarget = 0;
  if (args.resume && fs.existsSync(resultsFile)) {
    const prior = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const done = new Set(prior.map((r) => `${r.hunter}/${r.set}#${r.index}`));
    results.push(...prior);
    const before = fixtures.length;
    fixtures = fixtures.filter((f) => !done.has(`${f.hunter}/${f.set}#${f.index}`));
    console.log(`resuming: ${prior.length} build(s) already done, ${before - fixtures.length} skipped`);
  }

  totalTarget = results.length + fixtures.length;
  console.log(`${fixtures.length} build(s) to run, batches of ${args.batchSize}, ${args.runAll ? 'running all' : 'stopping at first failure'}\n`);

  const startedAt = Date.now();
  let aborted = false;

  for (let i = 0; i < fixtures.length && !aborted; i += args.batchSize) {
    const batch = fixtures.slice(i, i + args.batchSize);
    const batchResults = await runBatch(batch);
    batchResults.sort((a, b) => (a.level || 0) - (b.level || 0));
    for (const res of batchResults) {
      results.push(res);
      console.log(`[${results.length}/${totalTarget}] ${describe(res)}`);
    }
    // Persist after EVERY batch, not just at the end. A full sweep is ~2 hours; losing all of it
    // because the process was interrupted at build 150 is avoidable, and stdout redirected to a
    // file is block-buffered, so a killed run leaves a truncated log and nothing else. Now the
    // completed work is always on disk and readable with `node tools/bench/show.js`.
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

    if (!args.runAll && batchResults.some((r) => failureOf(r))) {
      aborted = true;
      console.log('\nStopping early: this batch contained a failure. Re-run with --all for the full picture.');
    }
  }

  const failures = results.map((r) => ({ res: r, why: failureOf(r) })).filter((x) => x.why);
  const warnings = results.map((r) => ({ res: r, why: secondaryWarningOf(r) })).filter((x) => x.why);
  const quality = results.filter((r) => r.ok);
  const lootDeltas = quality.map((r) => r.lootDeltaPct).sort((a, b) => a - b);

  console.log('\n' + '='.repeat(74));
  console.log(`have ${results.length}/${totalTarget} build(s); this run took ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min`);
  const undercounts = results.filter((r) => r.ok && r.parity === 'undercount');
  console.log(`parity match    : ${results.filter((r) => r.ok && r.parity === 'match').length}`);
  console.log(`parity overcount: ${results.filter((r) => r.ok && r.parity === 'overcount').length}  (fatal -- clone math wrong)`);
  console.log(`parity under    : ${undercounts.length}  (expected where the recorded score came from account state a share code can't carry)`);
  console.log(`quality failures: ${results.filter((r) => r.ok && failureOf(r) && r.parity !== 'overcount').length}`);
  console.log(`errors          : ${results.filter((r) => !r.ok).length}`);
  if (lootDeltas.length) {
    const median = lootDeltas[Math.floor(lootDeltas.length / 2)];
    console.log(`loot vs import  : worst ${lootDeltas[0].toFixed(2)}%  median ${median.toFixed(2)}%  best ${lootDeltas[lootDeltas.length - 1].toFixed(2)}%`);
  }
  console.log(`secondary down  : ${warnings.length} (not fatal -- the other metric traded off)`);
  for (const { res, why } of failures) console.log(`  FAIL ${res.hunter}/${res.set}#${res.index} lvl${res.level ?? '?'}: ${why}`);
  for (const { res, why } of warnings) console.log(`  warn ${res.hunter}/${res.set}#${res.index} lvl${res.level ?? '?'} ${res.mode}: ${why}`);
  console.log(`\ndetail written to ${path.relative(process.cwd(), resultsFile)}`);

  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
