'use strict';
// Are talent max levels fixed game data, or per-account state stored in the save?
const fs = require('fs');
const path = require('path');
const save = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, '../../bridge/test-fixtures/sample-save-decoded.json'), 'utf8'));
const real = (v) => (v && typeof v === 'object' && 'fakeValue' in v ? v.fakeValue : v);
const keys = Object.keys(save).filter((k) => /Skill\d+MaxLevel$/.test(k) || /Skill\d+Level$/.test(k));
const byPrefix = {};
for (const k of keys) {
  const m = k.match(/^(.*?)Skill(\d+)(MaxLevel|Level)$/);
  if (!m) continue;
  const [, prefix, n, kind] = m;
  (byPrefix[prefix] = byPrefix[prefix] || {})[`${n}:${kind}`] = real(save[k]);
}
for (const [prefix, vals] of Object.entries(byPrefix)) {
  const nums = [...new Set(Object.keys(vals).map((k) => Number(k.split(':')[0])))].sort((a, b) => a - b);
  console.log(`\n${prefix || '(none)'}Skill*`);
  for (const n of nums) {
    console.log(`  Skill${String(n).padEnd(2)}  level=${String(vals[`${n}:Level`] ?? '-').padStart(4)}   max=${String(vals[`${n}:MaxLevel`] ?? '-').padStart(4)}`);
  }
}
