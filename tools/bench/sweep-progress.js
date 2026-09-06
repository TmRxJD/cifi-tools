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

const file = process.argv[2] || 'results-full.json';
const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
if (!fs.existsSync(abs)) { console.log(`no such file: ${abs}`); process.exit(1); }

let rows;
try { rows = JSON.parse(fs.readFileSync(abs, 'utf8')); }
catch (e) { console.log(`(file is mid-write: ${e.message})`); process.exit(0); }
if (!Array.isArray(rows)) { console.log('not a results array'); process.exit(1); }

const errored = rows.filter((r) => r.error);
const scored = rows.filter((r) => !r.error && Number.isFinite(r.lootDeltaPct));
const other = rows.length - errored.length - scored.length;

console.log(`${path.basename(abs)}: ${rows.length} row(s)`);
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
    console.log(`  ${r.hunter}@${r.level} ${String(r.mode).padEnd(5)} `
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
