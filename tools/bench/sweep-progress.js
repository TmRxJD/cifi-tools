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

const by = (m) => scored.map((r) => r[m]).filter(Number.isFinite).sort((a, b) => a - b);
const loot = by('lootDeltaPct');
const med = loot[Math.floor(loot.length / 2)];
const short = scored.filter((r) => r.lootDeltaPct < -0.5);
console.log('');
console.log(`loot delta: median ${med.toFixed(2)}%  worst ${loot[0].toFixed(2)}%  best ${loot[loot.length - 1].toFixed(2)}%`);
console.log(`met or beat (>= -0.5%): ${scored.length - short.length}/${scored.length}`);
if (short.length) {
  console.log(`\nshort by more than 0.5%:`);
  for (const r of short.sort((a, b) => a.lootDeltaPct - b.lootDeltaPct)) {
    console.log(`  ${r.hunter}@${r.level} ${String(r.mode || '').padEnd(5)} ${r.lootDeltaPct.toFixed(2)}%`
      + `  stage ${Number(r.importStage).toFixed(1)} -> ${Number(r.optimizedStage).toFixed(1)}`);
  }
}
