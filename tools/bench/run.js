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
//   node tools/bench/run.js --sample=12        # THE EVERYDAY GATE: a stratified random handful
//   node tools/bench/run.js --sample=12 --seed=1234   # reproduce a specific handful exactly
//   node tools/bench/run.js                    # every build, stop at first failure
//   node tools/bench/run.js --all              # every build, never stop early
//   node tools/bench/run.js borge              # one hunter
//   node tools/bench/run.js borge 0 10         # a slice
//   node tools/bench/run.js --batch=6          # override batch size
//   node tools/bench/run.js borge --all --resume --out=borge.json
//
// WHICH ONE TO RUN. The full sweep is 182 builds and takes HOURS -- the high-level Borge builds
// dominate, since evaluation cost scales with how far a build progresses. That is too slow to
// run per change, and a gate nobody runs catches nothing. So `--sample=N` is the everyday gate
// and the full sweep is reserved for large or fundamental changes (anything touching the search,
// the legality model, the objective table, or the cost/param resolution).
//
// SAMPLING IS STRATIFIED, NOT UNIFORM. A uniform draw over 182 fixtures is mostly cheap
// low-level builds -- fast, and nearly blind to the high-level behaviour where problems actually
// live. The sample instead splits the fixtures of each hunter into N/hunters level bands and
// draws one from each band, so every run covers the whole level range.
//
// AND IT IS SEEDED. The seed defaults to a different value each run (that is the point -- a new
// handful each time eventually covers everything), but it is always PRINTED, and `--seed=` replays
// that exact handful. So the gate stays varied without a failure ever being unreproducible.
//
// The pass criteria are IDENTICAL in sampled and full runs. Sampling reduces how much is checked,
// never how strictly. Do not "speed up" this gate by loosening a threshold.
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
  const sampleFlag = flags.find((f) => f.startsWith('--sample='));
  // SELECT BY NAME, e.g. --only=ozzy@34b,borge@72. The positional `from`/`to` are INDICES into the
  // level-sorted list, and they READ like levels -- `run.js ozzy 34 35` selects neither level 34 nor
  // ozzy@34b. That has produced a wrong-build run three times, so naming is now the supported path
  // and the indices are kept only for slicing a large sweep.
  const onlyFlag = flags.find((f) => f.startsWith('--only='));
  const maxLevelFlag = flags.find((f) => f.startsWith('--max-level='));
  const seedFlag = flags.find((f) => f.startsWith('--seed='));
  const effortFlag = flags.find((f) => f.startsWith('--effort='));
  const sample = sampleFlag ? Number(sampleFlag.split('=')[1]) : 0;
  if (sampleFlag && !(Number.isInteger(sample) && sample > 0)) {
    throw new Error(`--sample must be a positive integer, got "${sampleFlag.split('=')[1]}"`);
  }
  return {
    only: onlyFlag ? onlyFlag.slice('--only='.length).split(',').map((x) => x.trim()).filter(Boolean) : null,
    sample,
    // Varies per run by default so repeated gates cover different builds over time; always
    // reported, so any failure can be replayed exactly with --seed=.
    seed: seedFlag ? Number(seedFlag.split('=')[1]) : (Date.now() % 2147483647),
    // Which shipped effort level to grade. Omitted means the optimizer's own default, which is
    // what a user gets; naming one lets the CHEAP level be graded, and it had no quality coverage
    // at all before this -- only a check that it returns something legal.
    effort: effortFlag ? effortFlag.slice('--effort='.length) : null,
    runAll: flags.includes('--all'),
    // Print the chosen fixtures and exit. Lets you see what a seed selects (and confirm a seed
    // reproduces) without paying for the run.
    listOnly: flags.includes('--list'),
    resume: flags.includes('--resume'),
    // A separate results file per run keeps hunters independent, so --resume can never carry
    // one hunter's results into another's run.
    outFile: outFlag ? outFlag.slice('--out='.length) : DEFAULT_RESULTS_FILE,
    batchSize: batchFlag ? Number(batchFlag.split('=')[1]) : Math.max(1, os.cpus().length - 1),
    // Cap the level so a sweep can skip the expensive tail. The top builds dominate wall clock --
    // measured medians run 58s at level 10-19 against 316s at 70-79, and the level 80+ fixtures are
    // slower still -- so excluding them turns a many-hour sweep into a much shorter one covering
    // the great majority of builds. The excluded ones are REPORTED, never silently dropped.
    maxLevel: maxLevelFlag ? Number(maxLevelFlag.slice('--max-level='.length)) : null,
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
  // Level cap, applied BEFORE sampling so a capped sample stratifies over the range it will
  // actually run. Excluded builds are reported by the caller, never dropped silently -- a sweep
  // that quietly skipped its hardest cases would be the most flattering possible bug.
  if (Number.isFinite(args.maxLevel)) {
    const before = all.length;
    all = all.filter((f) => (f.level || 0) <= args.maxLevel);
    args.excludedByLevel = before - all.length;
  }
  // NAMES WIN OVER EVERYTHING. findFixture throws on an ambiguous name rather than guessing, which
  // is the behaviour that makes this safe to prefer over indices.
  if (args.only) {
    const known2 = H.loadKnownBuilds();
    return args.only.map((n) => H.findFixture(known2, n));
  }
  if (args.sample) return stratifiedSample(all, hunters, args.sample, args.seed);
  return all.slice(args.from, args.to === undefined ? all.length : args.to);
}

// Deterministic PRNG. Math.random would make a failing sample unreproducible, which is the one
// thing a sampled gate cannot afford: "it failed on some builds, I don't know which" is not a
// bug report. mulberry32 -- small, well-distributed, and seeded.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `count` fixtures spread across every hunter AND across each hunter's level range.
 *
 * Uniform sampling over the pooled fixtures would skew toward whichever hunter has the most of
 * them and toward the cheap low-level builds, which is close to useless: the interesting
 * behaviour (and every parity oddity we know of) lives at high level. Splitting each hunter's
 * fixtures into equal level bands and drawing one per band guarantees the run touches the whole
 * range every time, however small the sample.
 */
function stratifiedSample(all, hunters, count, seed) {
  const rand = mulberry32(seed);
  const perHunter = Math.max(1, Math.floor(count / hunters.length));
  const picked = [];

  for (const h of hunters) {
    const pool = all.filter((f) => f.hunter === h);
    if (!pool.length) continue;
    const bands = Math.min(perHunter, pool.length);
    for (let b = 0; b < bands; b++) {
      const lo = Math.floor((b * pool.length) / bands);
      const hi = Math.floor(((b + 1) * pool.length) / bands);
      const band = pool.slice(lo, Math.max(hi, lo + 1));
      picked.push(band[Math.floor(rand() * band.length)]);
    }
  }

  // Any remainder from the integer division goes to builds not already chosen, so --sample=10
  // across 3 hunters really runs 10 rather than silently running 9.
  const chosen = new Set(picked.map((f) => `${f.hunter}/${f.set}#${f.index}`));
  const rest = all.filter((f) => !chosen.has(`${f.hunter}/${f.set}#${f.index}`));
  while (picked.length < count && rest.length) {
    picked.push(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
  }

  picked.sort((a, b) => (a.level || 0) - (b.level || 0));
  return picked;
}

// THE VERDICT RULE LIVES IN verdict.js, shared with summarize.js. It used to be defined here and
// copied there, and the copies drifted: on one 42-build sweep this file reported 1 failure and the
// summary reported 2, because the copy still treated parity-overcount as fatal and had no boss
// case. A rule with two homes is a rule that will disagree with itself.
const { failureOf, secondaryWarningOf } = require('./verdict.js');



function describe(res) {
  // LABEL BY THE BUILD'S NAME, NOT set#index. `#3` reads as a level and is not one -- ozzy@34b is
  // KNOWN_OZZY_PUSH_BUILDS#3 -- and this repo has already lost a debugging session to investigating
  // a different build than the one a gate flagged. The uid is kept alongside so the exact fixture is
  // still unambiguous.
  const label = `${res.name || `${res.hunter}@?`} lvl${res.level ?? '?'} ${res.mode}`
    + ` [${res.hunter}/${res.set}#${res.index}]`;
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

/** Run one fixture in its own worker. */
function runFixture(fixture, effort) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE);
    worker.on('message', (res) => { worker.terminate(); resolve(res); });
    worker.on('error', (err) => { worker.terminate(); reject(err); });
    // `effort` rides along with the fixture rather than being a worker option, so a resumed run
    // records which level produced each row -- comparing a `fast` row against a `complete` one
    // would be the same category of mistake as the default-effort mismatch that once invalidated
    // every quality gate in this suite.
    worker.postMessage(effort ? { ...fixture, effort } : fixture);
  });
}

//
// A ROLLING QUEUE, NOT FIXED BATCHES -- because build times differ by more than 10x and a batch
// runs at the speed of its slowest member.
//
// Measured on the first batch of a real sweep: 26s, 254s, 336s, 29s, 52s, 464s, 275s. Under
// Promise.all across the whole batch that is 464s of wall clock for 1,436s of work, with six cores
// idle for most of it. A queue that hands a worker the next fixture the moment it finishes keeps
// every core busy instead.
async function runQueue(fixtures, concurrency, onResult, shouldStop) {
  let next = 0;
  let stopped = false;
  const lane = async () => {
    for (;;) {
      if (stopped) return;
      const i = next++;
      if (i >= fixtures.length) return;
      // ANNOUNCE THE START, NOT JUST THE FINISH.
      //
      // Longest-first scheduling means the first seven builds of a full sweep are the most
      // expensive ones in the set, so the log stays completely silent for the first several
      // minutes -- which is indistinguishable from a hang, and was reported as one. The
      // scheduling is right (it is what keeps the tail short); the silence was the defect.
      const f = fixtures[i];
      console.log(`      ... started ${f.hunter}/${f.set}#${f.index} lvl${f.level} (${f.mode})`);
      const res = await runFixture(f, f.effort);
      await onResult(res);
      if (shouldStop && shouldStop(res)) { stopped = true; return; }
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, fixtures.length));
  await Promise.all(Array.from({ length: lanes }, lane));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsFile = args.outFile;

  //
  // ONE SWEEP PER RESULTS FILE, ENFORCED. TWO CONCURRENT RUNS SILENTLY DESTROY EACH OTHER'S WORK.
  //
  // This happened for real, three deep: sweeps started at 17:03, 17:10 and 17:21 all wrote
  // results-full.json. Each rewrites the WHOLE file from its own in-memory list, so a run without
  // --resume (starting from zero) overwrites a resumed run's larger list with its own smaller one.
  // Checking progress showed 21 rows, then 15 rows twenty minutes later -- work going BACKWARDS,
  // with no error anywhere and the three runs quietly splitting the cores between them.
  //
  // The kill that was supposed to prevent it (`pkill -f "run.js --all"`) matched nothing on this
  // platform and reported success. So the guard cannot live in the invocation; it has to be here.
  //
  // Stale locks are cleared automatically -- a sweep that was killed part way (which happens
  // often, this file's own --resume exists for it) must not block the next one forever.
  const lockFile = `${resultsFile}.lock`;
  if (fs.existsSync(lockFile)) {
    const holder = Number(fs.readFileSync(lockFile, 'utf8').trim());
    let alive = false;
    try { process.kill(holder, 0); alive = true; } catch (e) { alive = false; }
    if (alive) {
      console.error(`Another sweep (pid ${holder}) is already writing ${path.basename(resultsFile)}.`);
      console.error('Two runs would overwrite each other. Stop it first, or use --out= to write elsewhere.');
      process.exit(2);
    }
    console.log(`(clearing stale lock from pid ${holder}, which is no longer running)`);
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, String(process.pid));
  const releaseLock = () => { try { fs.unlinkSync(lockFile); } catch (e) { /* already gone */ } };
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(130); });
  let fixtures = selectFixtures(args);
  // Stamp the chosen effort onto every fixture, so the level travels with the row into the
  // worker AND into the results file. Threading it as a separate argument put it out of scope
  // in the queue and, worse, would have let a resumed run mix rows produced at two different
  // levels while looking like one sweep.
  if (args.effort) fixtures = fixtures.map((f) => ({ ...f, effort: args.effort }));

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

  if (args.listOnly) {
    // Name-first, so a listing can be pasted straight back into --only=.
  console.log(`${fixtures.length} build(s)${args.sample ? `, seed ${args.seed}` : ''}:`);
    // NAME FIRST, so a listing can be pasted straight back into --only= without translation.
    for (const f of fixtures) {
      console.log(`  ${String(f.name || '?').padEnd(12)} level ${f.level} (${f.mode})   [${f.uid}]`);
    }
    return;
  }

  totalTarget = results.length + fixtures.length;
  if (args.sample) {
    // Printed BEFORE the run, not just at the end -- a run that gets killed part way through
    // must still leave behind enough to replay exactly what it was doing.
    console.log(`SAMPLED GATE: ${fixtures.length} of the full 182 builds, seed ${args.seed}`);
    console.log(`  replay this exact handful:  node tools/bench/run.js --sample=${args.sample} --seed=${args.seed}`);
    console.log(`  full sweep (hours):         node tools/bench/run.js --all`);
    console.log(`  ${fixtures.map((f) => `${f.hunter}#${f.index}(L${f.level})`).join(' ')}`);
  }
  console.log(`${fixtures.length} build(s) to run, batches of ${args.batchSize}, ${args.runAll ? 'running all' : 'stopping at first failure'}\n`);

  const startedAt = Date.now();
  let aborted = false;

  // Expensive builds first, so the cheap ones fill the tail instead of the other way round.
  // Fail-fast keeps SOURCE order: stopping at "the first failure" should mean the first in the
  // list the user asked for, not whichever slow build happened to be scheduled first.
  // ASCENDING BY LEVEL.
  //
  // This was longest-first (LPT), which minimises the tail -- but it puts the seven most expensive
  // builds in the set on the seven lanes at the start, so a full sweep produced no result at all
  // for the first several minutes and looked exactly like a hang. Cheap builds first means results
  // start landing in seconds and the whole low-level range is confirmed before anything expensive
  // is attempted, which is worth more than a shorter tail on a run people watch.
  const queue = args.runAll
    ? fixtures.slice().sort((a, b) => (a.level || 0) - (b.level || 0))
    : fixtures;

  await runQueue(queue, args.batchSize, async (res) => {
    results.push(res);
    console.log(`[${results.length}/${totalTarget}] ${describe(res)}`);
    // Persist after EVERY result, not just at the end. A full sweep is hours; losing all of it
    // because the process was interrupted at build 150 is avoidable, and stdout redirected to a
    // file is block-buffered, so a killed run leaves a truncated log and nothing else. Sorted on
    // write so the file is stable regardless of completion order.
    const ordered = results.slice().sort((a, b) => (a.hunter || '').localeCompare(b.hunter || '')
      || (a.level || 0) - (b.level || 0) || (a.index || 0) - (b.index || 0));
    fs.writeFileSync(resultsFile, JSON.stringify(ordered, null, 2));
  }, (res) => {
    if (args.runAll || !failureOf(res)) return false;
    aborted = true;
    console.log('Stopping early: a build failed. Re-run with --all for the full picture.');
    return true;
  });

  const failures = results.map((r) => ({ res: r, why: failureOf(r) })).filter((x) => x.why);
  const warnings = results.map((r) => ({ res: r, why: secondaryWarningOf(r) })).filter((x) => x.why);
  const quality = results.filter((r) => r.ok);
  const lootDeltas = quality.map((r) => r.lootDeltaPct).sort((a, b) => a - b);

  console.log('\n' + '='.repeat(74));
  console.log(`have ${results.length}/${totalTarget} build(s); this run took ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min`);
  const undercounts = results.filter((r) => r.ok && r.parity === 'undercount');
  const overcounts = results.filter((r) => r.ok && r.parity === 'overcount');
  console.log(`parity match    : ${results.filter((r) => r.ok && r.parity === 'match').length}`);
  console.log(`parity over     : ${overcounts.length}  (diagnostic -- a code and a recorded score describe different account states)`);
  console.log(`parity under    : ${undercounts.length}  (diagnostic -- same reason, opposite sign)`);
  // NON-UNIFORMITY is the part that can actually reorder candidates. A constant bias cannot; a
  // bias that flips sign between neighbouring levels can, so print the SPREAD rather than a count.
  const pd = results.filter((r) => r.ok && Number.isFinite(r.parityDeltaPct)).map((r) => r.parityDeltaPct);
  if (pd.length) {
    const sorted = pd.slice().sort((a, b) => a - b);
    const mean = pd.reduce((s, x) => s + x, 0) / pd.length;
    console.log(`parity spread   : ${sorted[0].toFixed(2)}% .. +${sorted[sorted.length - 1].toFixed(2)}%  mean ${mean.toFixed(2)}%`
      + '  (wide + sign-flipping between adjacent levels = a ranking hazard)');
  }
  console.log(`quality failures: ${results.filter((r) => r.ok && failureOf(r)).length}`);
  console.log(`errors          : ${results.filter((r) => !r.ok).length}`);
  if (lootDeltas.length) {
    const median = lootDeltas[Math.floor(lootDeltas.length / 2)];
    console.log(`loot vs import  : worst ${lootDeltas[0].toFixed(2)}%  median ${median.toFixed(2)}%  best ${lootDeltas[lootDeltas.length - 1].toFixed(2)}%`);
  }
  console.log(`secondary down  : ${warnings.length} (not fatal -- the other metric traded off)`);
  for (const { res, why } of failures) console.log(`  FAIL ${res.name || res.uid} lvl${res.level ?? '?'} ${res.mode}: ${why}`);
  for (const { res, why } of warnings) console.log(`  warn ${res.name || res.uid} lvl${res.level ?? '?'} ${res.mode}: ${why}`);
  console.log(`\ndetail written to ${path.relative(process.cwd(), resultsFile)}`);

  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
