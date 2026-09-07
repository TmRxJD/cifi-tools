'use strict';
// Summarize a results.json produced by run.js -- including a PARTIAL one from a run that was
// interrupted. run.js writes after every batch precisely so an interrupted sweep still yields
// usable evidence instead of nothing.
//
//   node tools/bench/summarize.js [results.json ...]

const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) files.push(path.join(__dirname, 'results.json'));

// ONE definition of "failed", shared with run.js. This file used to carry its own copy and they
// drifted: on the same 42-build sweep run.js reported 1 failure and this reported 2 -- it still
// counted parity-overcount as fatal, and had no boss case, so it flagged a boss build for shedding
// loot. See verdict.js for why parity is a diagnostic and why each mode is judged on its own
// objective.
const { categoryOf } = require('./verdict.js');
const isFailure = categoryOf;

let all = [];
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`${f}: missing`); continue; }
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  all = all.concat(rows);
  report(path.basename(f), rows);
}
if (files.length > 1) report('COMBINED', all);

function report(label, rows) {
  const scored = rows.filter((r) => r.ok);
  const failures = rows.map((r) => [r, isFailure(r)]).filter(([, why]) => why);
  const deltas = scored.map((r) => r.lootDeltaPct).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const levels = rows.map((r) => r.level).filter(Number.isFinite);
  const beatOrMatched = scored.filter((r) => (r.mode === 'push' ? r.optimizedStage >= r.importStage : r.optimizedLoot >= r.importLoot));
  const strictlyBetter = scored.filter((r) => (r.mode === 'push' ? r.optimizedStage > r.importStage : r.optimizedLoot > r.importLoot));

  console.log(`\n=== ${label} ===`);
  console.log(`builds        : ${rows.length}${levels.length ? `  (levels ${Math.min(...levels)}-${Math.max(...levels)})` : ''}`);
  console.log(`failures      : ${failures.length}`);
  console.log(`met or beat   : ${beatOrMatched.length}/${scored.length}`);
  console.log(`strictly beat : ${strictlyBetter.length}`);
  console.log(`parity        : match ${rows.filter((r) => r.parity === 'match').length}, under ${rows.filter((r) => r.parity === 'undercount').length}, OVERCOUNT ${rows.filter((r) => r.parity === 'overcount').length}`);
  if (deltas.length) {
    console.log(`loot vs import: worst ${deltas[0].toFixed(2)}%  median ${deltas[Math.floor(deltas.length / 2)].toFixed(2)}%  best ${deltas[deltas.length - 1].toFixed(2)}%`);
  }
  for (const [r, why] of failures) {
    console.log(`  FAIL ${r.hunter}/${r.set}#${r.index} lvl${r.level ?? '?'} ${why}${r.error ? `: ${r.error.split('\n')[0]}` : ''}`);
  }
}
