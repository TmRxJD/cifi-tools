'use strict';
// Check our base-stat cost formulas against the ORIGINAL tool's own cost function.
//
// cifi-tools.com was built in collaboration with the game's developers, so a value taken from its
// bundle is authoritative for anything the site models (see CLAUDE.md's "Where a value has to
// come from"). The bundle keeps this as one big function keyed by stat id and hunter, with a
// distinctive signature: `function(e,t,n){return t<=0?0:"hp"===e?...}`.
//
//   node tools/bench/base-stat-cost-check.js <live-bundle.js>
//
// Fetch a bundle from the live site's network tab. It is not vendored here: it is someone else's
// build artifact and it changes without notice, so this is a check you run, not a gate that runs
// itself -- same arrangement as inscryption-cost-check.js and relic-maxlevel-check.js.

const fs = require('fs');
const vm = require('vm');
const H = require('./harness.js');

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('usage: node tools/bench/base-stat-cost-check.js <live-bundle.js>');
  process.exit(2);
}
if (!fs.existsSync(bundlePath)) {
  console.error(`no such bundle: ${bundlePath}`);
  process.exit(2);
}

const bundle = fs.readFileSync(bundlePath, 'utf8');
const marker = 'return t<=0?0:"hp"===e?';
const markerAt = bundle.indexOf(marker);
if (markerAt < 0) {
  console.error('could not find the base-stat cost function in this bundle -- its shape may have '
    + 'changed. Search it for `"hp"===e?` to find the new one.');
  process.exit(1);
}
// Walk back to the enclosing `function(e,t,n){`.
const fnStart = bundle.lastIndexOf('function(', markerAt);
let depth = 0, i = bundle.indexOf('{', fnStart), j = i;
for (; j < bundle.length; j += 1) {
  if (bundle[j] === '{') depth += 1;
  else if (bundle[j] === '}') { depth -= 1; if (depth === 0) break; }
}
const fnSrc = bundle.slice(fnStart, j + 1);
const liveCostAtLevel = vm.runInNewContext(`(${fnSrc})`);

const CF = H.browserSandbox().CostFormulas;

const STATS = ['hp', 'atk', 'regen', 'dr', 'evade', 'effect', 'critchance', 'critpower', 'atkspeed'];
const HUNTERS = ['borge', 'ozzy', 'knox'];
const LEVELS = [1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];

let problems = 0;
let compared = 0;
for (const hunter of HUNTERS) {
  for (const stat of STATS) {
    for (const level of LEVELS) {
      const live = liveCostAtLevel(stat, level, hunter);
      const ours = CF.baseStatCostAtLevel(stat, level, hunter);
      if (live === undefined) continue; // formula table ran out on the live side too
      compared += 1;
      if (ours !== live) {
        console.log(`MISMATCH ${hunter} ${stat} L${level}: ours ${ours}, live ${live}`);
        problems += 1;
      }
    }
  }
}

console.log(`compared ${compared} (hunter, stat, level) combinations\n`);
if (problems === 0) {
  console.log('every base-stat cost matches the original tool exactly');
  process.exit(0);
} else {
  console.log(`${problems} mismatch(es)`);
  process.exit(1);
}
