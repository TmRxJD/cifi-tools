'use strict';
// THE CROSS-BLOCK PASS MAY NEVER MAKE A BUILD WORSE.
//
//   node tools/bench/joint-monotonicity-check.js [--only=a,b,c] [--joint=32]
//
// WHY THIS IS A GATE AND NOT A COMMENT. The pass only accepts a STRICT improvement
// (`score > cur.v + 1e-9`), so in principle it cannot return a worse build than leaving it off.
// "In principle" is exactly what this project has watched fail: a flag reached three of four call
// sites and was dead at the fourth; a draw taken for a check that could never pass shifted every
// later random draw and moved a result 7 points. An inert-when-off claim is worth precisely as much
// as the test that checks it.
//
// It also answers the standing worry that fixing one build breaks another. That WAS the behaviour
// of the old archive search, where every change was a tuned tradeoff. A monotone pass is a
// different kind of change, and this is the check that keeps it that way -- if someone later makes
// the pass accept a non-improving move (to "escape a plateau", say), this fails immediately.
//
// GATE: for every build, joint=K must score >= joint=0 minus the measured noise floor. A build that
// comes back WORSE with the pass enabled is a defect in the pass, not a tradeoff to accept.

const { execFileSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
// Cheap builds by default: this must be runnable per-change, and a gate too slow to run is a gate
// nobody runs. ozzy@11 is the coupling reproducer -- the pass MUST fire there, which is the
// positive control that stops this passing on a no-op.
const ONLY = opt('only', 'ozzy@11,knox@12,knox@13,borge@13');
const JOINT = opt('joint', '32');
const NOISE = 0.3;
const SCRIPT = path.join(__dirname, 'corpus-donor-refine.js');

function run(name, joint) {
  const out = execFileSync(process.execPath, [
    SCRIPT, `--only=${name}`, '--maxevals=60000', `--joint=${joint}`,
  ], { cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // "+VND  <pct>%" is the re-measured delta the bench prints for the returned build.
  const m = /\+VND\s+(-?[0-9.]+)%/.exec(out);
  if (!m) throw new Error(`could not parse a result for ${name} at joint=${joint}`);
  return Number(m[1]);
}

let failures = 0;
let fired = 0;
let checked = 0;
for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
  const off = run(name, 0);
  const on = run(name, JOINT);
  checked++;
  const delta = on - off;
  if (delta > NOISE) fired++;
  const verdict = delta < -NOISE ? '  *** WORSE WITH THE PASS ON -- the pass is not monotone ***' : '';
  console.log(`${name.padEnd(12)} joint=0 ${off.toFixed(2).padStart(8)}%   joint=${JOINT} ${on.toFixed(2).padStart(8)}%`
    + `   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pts${verdict}`);
  if (delta < -NOISE) failures++;
}

console.log('');
if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
// A gate that can only pass is decoration. The reproducer must actually improve, or this bench is
// comparing two runs of the same code path and would pass with the pass entirely disabled.
if (!fired) {
  console.log('FAIL  the pass never fired on any build -- this cannot distinguish a working pass');
  console.log('      from a dead one. ozzy@11 is the known coupling reproducer and MUST improve.');
  process.exit(1);
}
if (failures) { console.log(`FAIL  ${failures} build(s) got WORSE with the cross-block pass enabled`); process.exit(1); }
console.log(`PASS  ${checked} build(s), none regressed, and the pass demonstrably fired on ${fired}`);
