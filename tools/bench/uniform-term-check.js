'use strict';
// The uniform per-node multipliers the optimizer deliberately OMITS must each be provably 1 until
// their upgrade is bought.
//
// These terms (the per-ship Power gem upgrade, the ship-installs research, the all-ships research)
// are identical across a ship's nodes, so they cannot reorder an allocation -- that is why the
// value model leaves them out. But "cannot reorder" is not "safe to ignore": if any of them were
// non-1 by default, every absolute figure the Fleet page prints would be wrong, silently, for
// every account.
//
// So the omission is only exact while each term is inert at level 0, and that is a fact about the
// game's code which a future build can change. This asserts it, so the day one of them stops being
// inert the tool says so instead of quietly under-reporting.
//
// Regenerate with:
//   CIFI_APK=apk-0.7.3.61 python tools/bench/extract-uniform-terms.py
//
//   node tools/bench/uniform-term-check.js

const REF = require('../reference/uniform-node-terms.json');

let failures = 0;
const rows = [];
const terms = Object.entries(REF.terms);

for (const [name, info] of terms) {
  if (!info.found) {
    failures++;
    rows.push(`FAIL ${name}: getter not found in ${info.type} -- it may have been renamed, and a `
      + 'term we cannot see is a term we cannot claim is inert');
  } else if (info.inertWhenUnowned === null) {
    failures++;
    rows.push(`FAIL ${name}: no gate on ${info.levelField} found, so inertness is UNDETERMINABLE. `
      + 'Do not read this as "not inert" -- it means the getter shape changed and the check needs '
      + 'updating before the omission can still be called exact.');
  } else if (info.inertWhenUnowned !== true) {
    failures++;
    rows.push(`FAIL ${name}: NOT inert at ${info.levelField} = 0. The optimizer omits this term, so `
      + 'omitting it is no longer exact and the value model needs it.');
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nchecked ${terms.length} uniform per-node term(s) from ${REF._game}`);
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('every omitted uniform term is provably 1 until its upgrade is bought');
