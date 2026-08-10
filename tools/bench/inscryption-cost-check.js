'use strict';
// Check our inscryption cost table against the ORIGINAL tool's own `mV` object.
//
// cifi-tools.com was built in collaboration with the game's developers, so a value taken from its
// bundle is authoritative -- for anything the site actually models, matching it IS the
// verification, and there is no need to go to the game files. (The things that genuinely need
// independent proof are the ones the site does NOT model: save-field mappings, fleet data. Those
// are checked against the APK/scene instead -- see inscryption-slot-test.js and ship-test.js.)
//
// Costs are cost(L) = startValue * multiplier^(L-1), keyed by inscryption id. The bundle keeps
// them in a minified top-level object literal assigned to `mV`.
//
//   node tools/bench/inscryption-cost-check.js <live-bundle.js>
//
// Fetch a bundle from the live site's network tab. It is not vendored here: it is someone else's
// build artifact and it changes without notice, so this is a check you run, not a gate that runs
// itself -- same arrangement as gate-coverage.js and live-override-diff.js.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('usage: node tools/bench/inscryption-cost-check.js <live-bundle.js>');
  process.exit(2);
}
if (!fs.existsSync(bundlePath)) {
  console.error(`no such bundle: ${bundlePath}`);
  process.exit(2);
}

/** Slice a balanced object literal starting at the first `{` at or after `from`. */
function objectLiteralAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

const bundle = fs.readFileSync(bundlePath, 'utf8');
// Anchor on the assignment rather than a bare `mV`, which also appears at call sites.
const at = bundle.indexOf('mV={');
if (at < 0) {
  console.error('could not find the `mV=` cost map in this bundle -- the site may have been '
    + 'rebuilt with different minified names. Search it for `startValue:` to find the new one.');
  process.exit(1);
}
const liveSrc = objectLiteralAt(bundle, at);
if (!liveSrc) { console.error('`mV=` found but its object literal is unbalanced'); process.exit(1); }
const live = vm.runInNewContext(`(${liveSrc})`);

const oursSrc = fs.readFileSync(path.join(__dirname, '../../webapp/public/costFormulas.js'), 'utf8');
const marker = oursSrc.indexOf('const INSCRYPTION_TABLE = {');
if (marker < 0) { console.error('INSCRYPTION_TABLE not found in costFormulas.js'); process.exit(1); }
const ours = vm.runInNewContext(`(${objectLiteralAt(oursSrc, marker)})`);

const liveIds = Object.keys(live);
const ourIds = Object.keys(ours);
console.log(`original tool: ${liveIds.length} inscryption cost entries`);
console.log(`this clone:    ${ourIds.length}\n`);

const problems = [];
for (const id of liveIds) {
  if (!(id in ours)) {
    problems.push(`${id}: priced by the original tool, MISSING here -- ${JSON.stringify(live[id])}`);
    continue;
  }
  if (live[id].startValue !== ours[id].startValue || live[id].multiplier !== ours[id].multiplier) {
    problems.push(`${id}: ours ${JSON.stringify(ours[id])} vs original ${JSON.stringify(live[id])}`);
  }
}
// An id we price that the original does not is just as much a defect: it means we invented a cost.
for (const id of ourIds) {
  if (!(id in live)) problems.push(`${id}: priced here but ABSENT from the original -- ${JSON.stringify(ours[id])}`);
}

if (problems.length) {
  console.log(`${problems.length} discrepancy(ies):`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log('every inscryption cost matches the original tool exactly');
