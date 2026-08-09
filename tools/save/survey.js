'use strict';
// Survey a decoded save: which field families are positional (Name0..N / Name[]) and therefore
// depend on an enum index we must resolve, versus explicitly-named fields that need no mapping.
//
//   node tools/save/survey.js [path-to-decoded-save.json]

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '../../bridge/test-fixtures/sample-save-decoded.json');
const save = JSON.parse(fs.readFileSync(file, 'utf8'));
const keys = Object.keys(save);

const realNum = (v) => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'fakeValue' in v) return v.fakeValue;
  return null;
};

// Group by "shape": digits collapsed to #, so Skill1Level/Skill2Level become one family.
const families = new Map();
for (const k of keys) {
  const shape = k.replace(/\d+/g, '#');
  if (!families.has(shape)) families.set(shape, []);
  families.get(shape).push(k);
}

const arrays = keys.filter((k) => Array.isArray(save[k]));

const rows = [...families.entries()]
  .filter(([, members]) => members.length > 1)
  .map(([shape, members]) => {
    const nonZero = members.filter((k) => {
      const n = realNum(save[k]);
      return n !== null && n !== 0;
    });
    return { shape, count: members.length, nonZero: nonZero.length };
  })
  .sort((a, b) => b.count - a.count);

console.log(`${file}`);
console.log(`${keys.length} top-level fields, ${arrays.length} arrays, ${families.size} distinct shapes\n`);
console.log('POSITIONAL FAMILIES (index -> meaning must come from the enum, not from diffing)');
console.log('shape'.padEnd(40), 'members'.padStart(8), 'nonzero'.padStart(8));
for (const r of rows.filter((r) => r.count >= 3)) {
  console.log(r.shape.padEnd(40), String(r.count).padStart(8), String(r.nonZero).padStart(8));
}

console.log('\nARRAY FIELDS (index -> meaning likewise enum-driven)');
for (const k of arrays) {
  const v = save[k];
  const nz = v.map(realNum).filter((n) => n !== null && n !== 0).length;
  console.log(`  ${k.padEnd(38)} len ${String(v.length).padStart(4)}  nonzero ${nz}`);
}
