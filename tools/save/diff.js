'use strict';
// Diff two decoded saves to identify which index belongs to which named upgrade.
//
// Some families (loop mods especially) store levels under a bare index with no name anywhere in
// the client -- names are runtime UI text. Where a cost fingerprint cannot pin them (see
// tools/bench/match-loopmods.js), the remaining way is to change ONE known thing in game and see
// which index moved.
//
// This is deliberately built around DELTAS rather than absolute values, because a delta survives
// the noise: an idle game mutates hundreds of fields between two pulls, but if you raise Scavenger
// by exactly +7 then an index that moved by exactly +7 is the one you want, even amid the churn.
//
//   node tools/save/diff.js <before.json> <after.json> [prefix]
//
// `prefix` filters to one family, e.g. LM. Omit it to see everything that changed.

const fs = require('fs');

const [beforePath, afterPath, prefix] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node tools/save/diff.js <before.json> <after.json> [prefix]');
  process.exit(2);
}

const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

const num = (v) => (typeof v === 'number' ? v : (v && typeof v === 'object' && 'mantissa' in v
  ? v.mantissa * Math.pow(10, v.exponent) : null));

const rows = [];
for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (prefix && !key.startsWith(prefix)) continue;
  const a = before[key];
  const b = after[key];
  if (JSON.stringify(a) === JSON.stringify(b)) continue;
  const na = num(a);
  const nb = num(b);
  const delta = (na !== null && nb !== null) ? nb - na : null;
  rows.push({ key, from: a, to: b, delta });
}

// Numeric changes first, largest deltas last so a deliberate +N stands out from timer churn.
const numeric = rows.filter((r) => r.delta !== null && r.delta !== 0).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
const other = rows.filter((r) => r.delta === null || r.delta === 0);

console.log(`${rows.length} field(s) changed${prefix ? ` under "${prefix}"` : ''}\n`);
if (numeric.length) {
  console.log('numeric changes (delta ascending -- a deliberate +N is easy to spot here):');
  for (const r of numeric) {
    console.log(`  ${r.key.padEnd(34)} ${String(r.from).padStart(12)} -> ${String(r.to).padEnd(12)} (${r.delta > 0 ? '+' : ''}${r.delta})`);
  }
}
if (other.length) {
  console.log(`\nnon-numeric / structural changes (${other.length}):`);
  for (const r of other.slice(0, 40)) {
    console.log(`  ${r.key.padEnd(34)} ${JSON.stringify(r.from).slice(0, 26)} -> ${JSON.stringify(r.to).slice(0, 26)}`);
  }
  if (other.length > 40) console.log(`  ... and ${other.length - 40} more`);
}

// The whole point: a unique delta identifies an index with no ambiguity.
const byDelta = new Map();
for (const r of numeric) {
  if (!byDelta.has(r.delta)) byDelta.set(r.delta, []);
  byDelta.get(r.delta).push(r.key);
}
const unique = [...byDelta.entries()].filter(([, keys]) => keys.length === 1);
if (unique.length) {
  console.log('\nUNIQUELY identified by their delta:');
  for (const [delta, keys] of unique.sort((a, b) => a[0] - b[0])) {
    console.log(`  ${delta > 0 ? '+' : ''}${delta}  ->  ${keys[0]}`);
  }
}
