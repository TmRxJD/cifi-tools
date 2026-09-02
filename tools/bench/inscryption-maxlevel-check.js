'use strict';
// Check our inscryption max-level caps against the ORIGINAL tool's own per-inscryption
// definition table (the array of `{id:"iNN",name,hunter,type,add|multiplier,maxLevel,
// description,format,color}` objects -- a different table from `mV`/`vV`, which prices levels
// but does not carry maxLevel at all).
//
// cifi-tools.com was built in collaboration with the game's developers, so a value taken from its
// bundle is authoritative for anything the site models (see CLAUDE.md's "Where a value has to
// come from"). This is the same class of check as relic-maxlevel-check.js, for the same reason:
// a cap can be wrong in hunterDefs.js without inscryption-cost-check.js ever noticing, because
// that script only compares cost formulas, not maxLevel.
//
//   node tools/bench/inscryption-maxlevel-check.js <live-bundle.js>
//
// Fetch a bundle from the live site's network tab. It is not vendored here: it is someone else's
// build artifact and it changes without notice, so this is a check you run, not a gate that runs
// itself -- same arrangement as inscryption-cost-check.js and relic-maxlevel-check.js.

const fs = require('fs');
const vm = require('vm');
const H = require('./harness.js');

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('usage: node tools/bench/inscryption-maxlevel-check.js <live-bundle.js>');
  process.exit(2);
}
if (!fs.existsSync(bundlePath)) {
  console.error(`no such bundle: ${bundlePath}`);
  process.exit(2);
}

const bundle = fs.readFileSync(bundlePath, 'utf8');

// Anchor on the object's own shape (i3's own declaration), not a minified variable name, which
// churns between builds -- see inscryption-cost-check.js's history for why.
const marker = '{id:"i3",name:"Inscryption #3"';
const arrStart = bundle.indexOf(marker);
if (arrStart < 0) {
  console.error('could not find the inscryption definition table in this bundle -- its shape may '
    + 'have changed. Search it for `id:"i3",name:"Inscryption #3"` to find the new one.');
  process.exit(1);
}
// The table is a top-level array literal; walk backward to the '[' that opens it.
const open = bundle.lastIndexOf('[', arrStart);
let depth = 0, close = open;
for (let i = open; i < bundle.length; i += 1) {
  if (bundle[i] === '[') depth += 1;
  else if (bundle[i] === ']') { depth -= 1; if (depth === 0) { close = i; break; } }
}
const arr = vm.runInNewContext(`(${bundle.slice(open, close + 1)})`);
const live = {};
for (const e of arr) live[e.id] = e;

const sb = H.browserSandbox();
const exposed = {};
for (const [hunterName, hunter] of Object.entries(sb.HUNTER_DEFS)) {
  const items = hunter.globalUpgrades?.inscryptions?.items || [];
  for (const item of items) exposed[item.id] = { hunter: hunterName, maxLevel: item.maxLevel };
}

console.log(`original tool: ${arr.length} inscryption definitions, `
  + `${Object.keys(exposed).length} of which HunterSim exposes as overrides\n`);

let problems = 0;
for (const [id, ex] of Object.entries(exposed)) {
  const def = live[id];
  if (!def) {
    console.log(`${id} (${ex.hunter}): exposed here but not found in the live tool's table at all`);
    problems += 1;
    continue;
  }
  if (def.maxLevel !== ex.maxLevel) {
    console.log(`MISMATCH ${id} (${ex.hunter}): ours ${ex.maxLevel}, live ${def.maxLevel} ("${def.description}")`);
    problems += 1;
  }
}

if (problems === 0) {
  console.log(`every exposed inscryption max level matches the original tool exactly`);
  process.exit(0);
} else {
  console.log(`\n${problems} discrepancy(ies)`);
  process.exit(1);
}
