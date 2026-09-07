'use strict';
// LIVE STATUS OF THE CORPUS-METHOD SWEEP. Read-only, safe to run at any time.
//
//   node tools/bench/sweep-status.js            # summary per hunter + anything short
//   node tools/bench/sweep-status.js --short    # ONLY the builds that came up short
//   node tools/bench/sweep-status.js --all      # every build, worst first
//
// Reads new-<hunter>.json, which the sweep rewrites after EVERY build, so this is current to the
// last completed build rather than to the last checkpoint.
//
// The threshold is the measured comparison noise floor (0.3%), not a round number: eval-precision
// -check puts a FINAL_ITERATIONS score at ~0.12% mean error, so a difference of two scores carries
// ~0.2%. Anything inside that is parity, not a win or a loss, and calling it either would be
// reading noise as signal.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const SHORT_ONLY = args.includes('--short');
const SHOW_ALL = args.includes('--all');
const NOISE = 0.3;
const ROOT = path.join(__dirname, '../..');

// FIXTURE TOTALS ARE COUNTED FROM THE FIXTURE FILES, NOT HARD-CODED.
// A hard-coded {borge:82, ozzy:66, knox:34} printed "knox 36/34" -- more builds done than exist --
// because those figures came from a summary table in CLAUDE.md that predates fixtures being added.
// A denominator nobody checks is exactly the kind of stale constant this project keeps getting
// burned by, and here it made a correct sweep look broken.
const FIXTURE_FILES = { borge: 'known-builds.mjs', ozzy: 'known-builds-ozzy.mjs', knox: 'known-builds-knox.mjs' };
const TOTALS = {};
for (const [h, f] of Object.entries(FIXTURE_FILES)) {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'compare-mcp', f), 'utf8');
    TOTALS[h] = (src.match(/code:/g) || []).length;
  } catch (e) { TOTALS[h] = null; } // unknown beats wrong: the line prints just the count
}

let anyFile = false;
const every = [];

for (const hunter of ['borge', 'ozzy', 'knox']) {
  const file = path.join(ROOT, `new-${hunter}.json`);
  if (!fs.existsSync(file)) { console.log(`${hunter.padEnd(6)} not started`); continue; }
  anyFile = true;
  let rows;
  try {
    rows = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    // A partial write is normal while the sweep is mid-build. Say so rather than crashing.
    console.log(`${hunter.padEnd(6)} file being written right now -- try again in a second`);
    continue;
  }
  if (!rows.length) { console.log(`${hunter.padEnd(6)} 0 builds`); continue; }
  every.push(...rows);

  const ds = rows.map((r) => r.deltaPct).sort((a, b) => a - b);
  const short = rows.filter((r) => r.deltaPct < -NOISE);
  const beat = rows.filter((r) => r.deltaPct > NOISE);
  const secs = rows.reduce((s, r) => s + (r.seconds || 0), 0);
  const done = rows.length;
  const total = TOTALS[hunter] ? `/${TOTALS[hunter]}` : '';

  console.log(`${hunter.padEnd(6)} ${String(done).padStart(3)}${total}`
    + `  worst ${ds[0].toFixed(2)}%  median ${ds[Math.floor(ds.length / 2)].toFixed(2)}%  best ${ds[ds.length - 1].toFixed(2)}%`
    + `  |  met-or-beat ${done - short.length}/${done}  strictly beat ${beat.length}`
    + `  |  ${Math.round(secs / 60)} min, ${Math.round(secs / done)}s/build`
    + (rows.some((r) => r.truncated) ? `  ${rows.filter((r) => r.truncated).length} TRUNCATED` : ''));
}

if (!anyFile) { console.log('no sweep output yet'); process.exit(0); }

const show = SHOW_ALL ? every.slice() : every.filter((r) => r.deltaPct < -NOISE);
show.sort((a, b) => a.deltaPct - b.deltaPct);

if (!SHORT_ONLY || show.length) {
  console.log('');
  console.log(SHOW_ALL ? 'EVERY BUILD, worst first' : `SHORT OF THE IMPORT (worse than -${NOISE}%)`);
  if (!show.length) console.log('  (none)');
  for (const r of show) {
    console.log(`  ${String(r.name || r.uid).padEnd(14)} ${String(r.mode || '').padEnd(4)}`
      + ` ${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(2)}%`.padStart(9)
      + `   donors-only ${r.donorsOnlyPct >= 0 ? '+' : ''}${r.donorsOnlyPct.toFixed(2)}%`
      + `   ${String(r.evals).padStart(5)} evals  ${String(r.seconds).padStart(4)}s`
      + (r.truncated ? '  TRUNCATED -- not converged' : ''));
  }
}

if (every.length) {
  const ds = every.map((r) => r.deltaPct).sort((a, b) => a - b);
  const short = every.filter((r) => r.deltaPct < -NOISE);
  console.log('');
  console.log(`OVERALL  ${every.length}/${Object.values(TOTALS).reduce((s,x)=>s+(x||0),0)} built  |  met-or-beat ${every.length - short.length}/${every.length}`
    + `  |  worst ${ds[0].toFixed(2)}%  median ${ds[Math.floor(ds.length / 2)].toFixed(2)}%`
    + `  |  ${Math.round(every.reduce((s, r) => s + (r.seconds || 0), 0) / 60)} min of compute`);
  console.log(fs.existsSync(path.join(ROOT, 'new-done.log')) ? 'sweep COMPLETE' : 'sweep still RUNNING');
}
