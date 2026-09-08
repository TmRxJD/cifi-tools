'use strict';
// EVERY EFFORT FLAG, DERIVED FROM THE SOURCE: is it read, and does a shipped level set it?
//
//   node tools/bench/effort-flag-audit.js
//
// WHY THIS EXISTS. CLAUDE.md carried an entry stating five measured-dead flags were DELETED and
// that the whitelist had dropped to 11 keys. One of the five (`bossDamageBands`) had since been
// re-added to run a comparison, and the whitelist was 18. So the file that is supposed to be the
// record of what the code does described a state the code had left -- which is exactly the failure
// that file warns about in its own words: "a comment describing a fix, and a CLAUDE.md entry
// describing a fix, are not evidence the fix exists".
//
// A hand-maintained list of flags drifts. A derived one cannot. This reads EFFORT_SPEC_KEYS and
// EFFORT_LEVELS out of search.js and reports the real state, so the next person checks in one
// second instead of trusting prose.
//
// GATE, narrowly: a whitelisted key that NOTHING reads is a failure -- it is a flag a caller can
// set and silently have ignored, which this project has been bitten by (`bossDamageBands` reached
// three of four call sites and no-oped; `frontierShare` was whitelisted while only ever read as a
// module constant). `label`/`help` are metadata and exempt by name.
//
// It deliberately does NOT fail a flag for shipping OFF. Several are A/B instruments kept on
// purpose, with their measurements recorded; "unused by a shipped level" is a fact to report, not
// a defect.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'webapp', 'public', 'optimizer', 'search.js');
const src = fs.readFileSync(SRC, 'utf8');

const METADATA = new Set(['label', 'help']);

const whitelist = src.match(/EFFORT_SPEC_KEYS = new Set\(\[([\s\S]*?)\]\)/);
if (!whitelist) { console.log('FAIL  could not find EFFORT_SPEC_KEYS in search.js'); process.exit(1); }
const keys = [...whitelist[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]);

const levels = src.match(/const EFFORT_LEVELS = \{([\s\S]*?)\n {2}\};/);
if (!levels) { console.log('FAIL  could not find EFFORT_LEVELS in search.js'); process.exit(1); }
// EVERY key on a line, not just the first. Shipped levels are written inline
// (`label: 'Fast', archiveEvals: 1200, refineSupports: 3, ocbaPolish: true,`), and a line-anchored
// match reported archiveEvals as never shipped -- a plainly false result from a working-looking
// script, which is the shape of bug this file is about.
const shippedKeys = new Set([...levels[1].matchAll(/([a-zA-Z]+):/g)].map((x) => x[1]));
const levelNames = [...levels[1].matchAll(/^\s{4}([a-zA-Z]+): \{/gm)].map((x) => x[1]);

let failures = 0;
const rows = keys.map((k) => ({
  key: k,
  read: new RegExp(`effortSpec\\.${k}\\b`).test(src),
  shipped: shippedKeys.has(k),
}));

console.log(`shipped effort levels: ${levelNames.join(', ')}`);
console.log(`whitelisted keys: ${keys.length}\n`);
for (const r of rows) {
  const meta = METADATA.has(r.key);
  const bad = !r.read && !meta;
  if (bad) failures++;
  console.log(`  ${bad ? 'FAIL' : 'ok  '} ${r.key.padEnd(20)}`
    + ` read=${r.read ? 'yes' : 'NO '}`
    + `  shipped=${r.shipped ? 'yes' : 'no '}`
    + (meta ? '  (metadata, not read by the search)' : ''));
}

const abOnly = rows.filter((r) => r.read && !r.shipped).map((r) => r.key);
console.log(`\n${abOnly.length} flag(s) read but not set by any shipped level (A/B instruments):`);
console.log(`  ${abOnly.join(', ')}`);
console.log('\nThat is a report, not a defect: each is an instrument with a recorded measurement.');

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} whitelisted key(s) that nothing reads -- a caller could set one`);
  console.log('      and have it silently ignored, which is how a measured A/B records the');
  console.log("      control's number as the treatment's.");
  process.exit(1);
}
console.log(`PASS  every whitelisted flag is read; ${keys.length} key(s) across `
  + `${levelNames.length} shipped level(s)`);
