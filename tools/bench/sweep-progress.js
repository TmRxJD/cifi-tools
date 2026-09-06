'use strict';
// HOW FAR IS THE SWEEP, AND IS WHAT IT HAS PRODUCED ACTUALLY RESULTS?
//
//   node tools/bench/sweep-progress.js [results-full.json]
//
// Written because reading the raw file misled me directly: a partially-overwritten results file
// still held 182 rows from an earlier CRASHED run (every one a ReferenceError), and counting
// "rows with a finite lootDeltaPct" returned zero shortfalls -- which reads as a clean sweep and
// is in fact a sweep that measured nothing. Same shape as the two benches this repo has already
// lost to empty comparison sets.
//
// So: errored rows are counted and shown SEPARATELY from scored rows, and a file with no scored
// rows at all reports NOTHING MEASURED rather than a pass.

const fs = require('fs');
const path = require('path');
const os = require('os');
const NL = String.fromCharCode(10);   // written this way: the shell heredoc eats escapes

// Positional = results file; flags may appear in any order, so filter them out rather than
// assuming argv[2] is the path (it was, and `--max-level=70` was read as a filename).
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const file = positional[0] || 'results-full.json';
const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
// A MISSING RESULTS FILE IS NOT AN ERROR WHILE A SWEEP IS STARTING. run.js schedules longest
// first, so the first completion on a full sweep can be several minutes out and the file does not
// exist until then. Saying "no such file" there reads like a crash -- which is exactly the wrong
// impression to give after a session that has had several.
if (!fs.existsSync(abs)) {
  const lock = `${abs}.lock`;
  if (fs.existsSync(lock)) {
    const pid = fs.readFileSync(lock, 'utf8').trim();
    let alive = false;
    try { process.kill(Number(pid), 0); alive = true; } catch (e) { alive = false; }
    const started = fs.statSync(lock).mtimeMs;
    const mins = Math.round((Date.now() - started) / 60000);
    console.log(`${path.basename(abs)}: not written yet`);
    console.log(alive
      ? `  a sweep IS running (pid ${pid}, started ${mins}m ago) and has not finished a build yet.`
      : `  lock names pid ${pid}, which is NOT running -- the sweep died before its first result.`);
    if (alive) {
      console.log('  run.js schedules the most expensive builds first, so the first result on a');
      console.log('  full sweep can take several minutes. Row counts only ever go up from here.');
    }
    process.exit(alive ? 0 : 1);
  }
  console.log(`no such file: ${abs}   (and no sweep holds a lock on it)`);
  process.exit(1);
}

let rows;
try { rows = JSON.parse(fs.readFileSync(abs, 'utf8')); }
catch (e) { console.log(`(file is mid-write: ${e.message})`); process.exit(0); }
if (!Array.isArray(rows)) { console.log('not a results array'); process.exit(1); }

const errored = rows.filter((r) => r.error);
const scored = rows.filter((r) => !r.error && Number.isFinite(r.lootDeltaPct));
const other = rows.length - errored.length - scored.length;

console.log(`${path.basename(abs)}: ${rows.length} row(s)`);

// ---------------------------------------------------------------------------------------------
// PROGRESS AND ETA, ESTIMATED FROM WORK RATHER THAN FROM COUNT.
//
// A count-based ETA (done/elapsed extrapolated) is badly wrong here for a specific reason: run.js
// schedules LONGEST FIRST, so the builds finished early are the most expensive ones and the naive
// rate makes the remaining work look far worse than it is. Build cost also spans more than 10x
// across the level range (median 58s at level 10-19, 316s at 70-79).
//
// So: model cost by level band from the builds THIS run has actually finished, apply it to the
// fixtures still outstanding, and divide by the number of lanes. Falls back to the overall median
// for a band nothing has completed in yet, and says so rather than pretending to know.
const LANES = Math.max(1, os.cpus().length - 1);
// Populated from the fixture list below; used by the shortfall report, which must name the exact
// fixture rather than hunter@level (two fixtures can share a level).
const nameByUid = new Map();   // run.js's own default concurrency
let etaLine = null;
try {
  const H = require('./harness.js');
  const known = H.loadKnownBuilds();
  const all = [];
  for (const h of Object.keys(known)) for (const f of known[h]) all.push(f);
  const doneKey = new Set(rows.map((r) => `${r.hunter}/${r.set}#${r.index}`));
  for (const f of all) nameByUid.set(`${f.hunter}/${f.set}#${f.index}`, f.name);
  // RESPECT THE LEVEL CAP THE SWEEP WAS LAUNCHED WITH, or both the count and the estimate include
  // builds this run will never attempt -- and they are the most expensive ones in the set, so the
  // ETA is inflated by more than their share. Read from the sweep's own log rather than asked for,
  // so the status cannot disagree with what is actually running.
  let maxLevel = Infinity;
  const capFlag = process.argv.find((a) => a.startsWith('--max-level='));
  if (capFlag) maxLevel = Number(capFlag.slice('--max-level='.length));
  else {
    try {
      const log = fs.readFileSync(path.join(process.cwd(), 'full-sweep.log'), 'utf8');
      const m = /--max-level=(\d+): EXCLUDING (\d+)/.exec(log);
      if (m) maxLevel = Number(m[1]);
    } catch (e) { /* no log; treat as uncapped */ }
  }
  const inScope = all.filter((f) => (f.level || 0) <= maxLevel);
  const remaining = inScope.filter((f) => !doneKey.has(`${f.hunter}/${f.set}#${f.index}`));

  const timed = rows.filter((r) => Number.isFinite(r.seconds) && Number.isFinite(r.level));
  if (timed.length && remaining.length) {
    const band = (lvl) => Math.floor((lvl || 0) / 10);
    const byBand = new Map();
    for (const r of timed) {
      const b = band(r.level);
      if (!byBand.has(b)) byBand.set(b, []);
      byBand.get(b).push(r.seconds);
    }
    const medianOf = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
    // A PRIOR FOR BANDS THIS RUN HAS NOT REACHED, WITHOUT WHICH THE ETA IS SYSTEMATICALLY LOW
    // -- AND WAS, BY MORE THAN 2x.
    //
    // run.js schedules ASCENDING by level, so everything finished so far is the cheapest work in
    // the set. Estimating the unseen remainder from ITS median assumes a level-60 build costs what
    // a level-12 build costs. It does not: measured medians run 58s at level 10-19 against 316s at
    // 70-79. The old estimator reported 2.0h for work that projects to 4.7h, and the user caught
    // it before the machine spent the afternoon on it.
    //
    // archive-seeds.log holds real per-build times measured on THIS machine across levels 10-79,
    // so it supplies the shape of the curve. It was produced with the pooled evaluator while
    // run.js evaluates serially per worker, so the two differ in absolute terms -- the ratio is
    // MEASURED in whatever bands both cover rather than assumed to be 1 (it came out 4.76x).
    const prior = new Map();
    try {
      const log = fs.readFileSync(path.join(process.cwd(), 'archive-seeds.log'), 'utf8');
      for (const line of log.split(NL)) {
        const m = /^(\w+)@(\d+)\w*\s+\S+\s+(\d+)s/.exec(line);
        if (!m) continue;
        const bb = band(Number(m[2]));
        if (!prior.has(bb)) prior.set(bb, []);
        prior.get(bb).push(Number(m[3]));
      }
    } catch (e) { /* no prior on disk; reported as GUESSED below */ }

    const ratios = [];
    for (const [bb, v] of byBand) if (prior.has(bb)) ratios.push(medianOf(v) / medianOf(prior.get(bb)));
    const ratio = ratios.length ? medianOf(ratios) : 1;
    const overall = medianOf(timed.map((r) => r.seconds));

    let fromObs = 0; let fromPrior = 0; let guessed = 0; let secs = 0;
    for (const f of remaining) {
      const bb = band(f.level);
      if (byBand.has(bb)) { secs += medianOf(byBand.get(bb)); fromObs++; }
      else if (prior.has(bb)) { secs += medianOf(prior.get(bb)) * ratio; fromPrior++; }
      else { secs += overall * 2; guessed++; }
    }
    const wall = secs / LANES;
    const hrs = wall / 3600;
    const done = rows.length;
    const pct = ((done / inScope.length) * 100).toFixed(0);
    const how = [`${fromObs} measured`,
      fromPrior ? `${fromPrior} from the level-cost prior (x${ratio.toFixed(2)})` : null,
      guessed ? `${guessed} GUESSED, no data` : null].filter(Boolean).join(', ');
    etaLine = `progress ${done}/${inScope.length} (${pct}%)   ${remaining.length} left`
      + (Number.isFinite(maxLevel) ? ` [capped at level ${maxLevel}; ${all.length - inScope.length} excluded]` : '')
      + '   '
      + `est ${hrs >= 1 ? hrs.toFixed(1) + 'h' : Math.round(wall / 60) + 'm'} remaining on ${LANES} lanes`
      + NL + `  work left ${(secs / 3600).toFixed(1)} core-hours  [${how}]`;
  } else if (remaining.length) {
    etaLine = `progress ${rows.length}/${inScope.length}   ${remaining.length} left   `
      + '(no completed build carries a duration yet, so no ETA)';
  } else {
    etaLine = `progress ${rows.length}/${inScope.length} -- COMPLETE`
      + (Number.isFinite(maxLevel) ? ` (capped at level ${maxLevel}; ${all.length - inScope.length} NOT covered)` : '');
  }
} catch (e) {
  etaLine = `(fixture list unavailable, no ETA: ${e.message})`;
}
console.log(etaLine);

console.log(`  scored  ${scored.length}`);
console.log(`  errored ${errored.length}`);
if (other) console.log(`  neither ${other}`);

if (errored.length) {
  const kinds = new Map();
  for (const r of errored) {
    const k = String(r.error).split('\n')[0].slice(0, 80);
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  console.log('  error kinds:');
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`    ${n}x  ${k}`);
}

if (!scored.length) {
  console.log('');
  console.log('NOTHING MEASURED -- this file contains no scored builds. Do not read a pass from it.');
  process.exit(0);
}

// EACH BUILD IS JUDGED ON ITS OWN OBJECTIVE, AND THE FIRST VERSION OF THIS FILE WAS NOT.
//
// It ranked every build on lootDeltaPct, so a PUSH build that gained 2.79% average stage while
// spending 5.69% loot was reported as a shortfall -- when it had beaten its import at the thing it
// was built for, and run.js had correctly marked it PASS. Pushing deeper costs loot/min; that is
// the trade, not a defect.
//
// 14 of the 195 fixtures are push builds, so this would have produced a steady drip of false
// alarms across the sweep. Same "measured against the wrong objective" error this project has now
// hit in the search, in a fixture set, and here in the reporting.
const primaryOf = (r) => (r.mode === 'push' ? r.stageDeltaPct : r.lootDeltaPct);
const primaryName = (r) => (r.mode === 'push' ? 'stage' : 'loot');

const withPrimary = scored.filter((r) => Number.isFinite(primaryOf(r)));
const vals = withPrimary.map(primaryOf).sort((a, b) => a - b);
const med = vals[Math.floor(vals.length / 2)];
const short = withPrimary.filter((r) => primaryOf(r) < -0.5);

const modes = {};
for (const r of withPrimary) modes[r.mode] = (modes[r.mode] || 0) + 1;

console.log('');
console.log(`judged on each build's OWN objective (${Object.entries(modes).map(([m, n]) => `${n} ${m}`).join(', ')})`);
console.log(`  median ${med.toFixed(2)}%   worst ${vals[0].toFixed(2)}%   best ${vals[vals.length - 1].toFixed(2)}%`);
console.log(`  met or beat (>= -0.5%): ${withPrimary.length - short.length}/${withPrimary.length}`);

if (short.length) {
  console.log('');
  console.log('short on its OWN objective by more than 0.5%:');
  for (const r of short.sort((a, b) => primaryOf(a) - primaryOf(b))) {
    // THE UNIQUE FIXTURE NAME, NOT hunter@level -- TWO FIXTURES CAN SHARE A LEVEL.
    //
    // knox has two level-35 builds: knox@35 (+0.04%, healthy) and knox@35b (-0.69%, the failing
    // one). This line printed "knox@35" for the failing one, and that ambiguous label was fed
    // straight into a spot check, which then measured the HEALTHY build and reported it as fine.
    // A report that cannot name what it is reporting on sends the next investigation to the wrong
    // place -- which is exactly what it did.
    const uid = `${r.hunter}/${r.set}#${r.index}`;
    console.log(`  ${(nameByUid.get(uid) || `${r.hunter}@${r.level}`).padEnd(10)} ${String(r.mode).padEnd(5)} `
      + `${primaryName(r)} ${primaryOf(r).toFixed(2)}%`
      + `   stage ${Number(r.importStage).toFixed(1)} -> ${Number(r.optimizedStage).toFixed(1)}`
      + `   loot ${Number(r.lootDeltaPct).toFixed(2)}%`);
  }
} else {
  console.log('  (none short on its own objective)');
}

// The secondary metric is REPORTED, never gated -- a push build trading loot for depth is doing
// its job. Shown so a real regression in the other metric is still visible.
const secondaryDown = withPrimary.filter((r) => {
  const sec = r.mode === 'push' ? r.lootDeltaPct : r.stageDeltaPct;
  return Number.isFinite(sec) && sec < -0.5;
});
console.log('');
console.log(`secondary metric down >0.5% on ${secondaryDown.length} build(s) -- reported, not gated`);

const errRows = rows.filter((r) => r.error);
if (errRows.length) console.log(`
WARNING: ${errRows.length} errored row(s) are excluded from every figure above`);
