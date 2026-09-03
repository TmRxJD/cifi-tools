'use strict';
// Validate every game-derived reference file against its zod schema, and check that the files
// agree about which BUILD they came from.
//
// Two failure modes, both of which have happened during this work:
//
//   1. A silently EMPTY or reshaped reference. When an extractor changes shape, a consumer reads
//      `undefined` and the bench comparing it to another `undefined` passes -- an empty reference
//      looks exactly like a clean run. Parsing first turns that into a loud failure naming the
//      exact path.
//   2. MIXED BUILDS. Resolving one build's offsets against another's dump.cs returns confident
//      nonsense rather than an error (`ExpansionNextBonusText` where a bonus belonged). Files that
//      disagree about `_game` are the early warning for that whole class of mistake.
//
// Zod is a dev dependency used by benches only -- the shipped webapp still has no build step.
//
//   node tools/bench/reference-schema-test.js

const fs = require('fs');
const path = require('path');
const { schemas } = require('./reference-schemas.js');

const REF_DIR = path.join(__dirname, '..', 'reference');
let failures = 0;
const builds = new Map();

for (const [file, schema] of Object.entries(schemas)) {
  const full = path.join(REF_DIR, file);
  if (!fs.existsSync(full)) {
    failures++;
    console.log(`FAIL ${file}: missing -- a bench that requires it would crash on load`);
    continue;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    failures++;
    console.log(`FAIL ${file}: not valid JSON (${e.message})`);
    continue;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    failures++;
    console.log(`FAIL ${file}:`);
    parsed.error.issues.slice(0, 6).forEach((i) => {
      console.log(`       ${i.path.join('.') || '(root)'}: ${i.message}`);
    });
    if (parsed.error.issues.length > 6) {
      console.log(`       … and ${parsed.error.issues.length - 6} more`);
    }
    continue;
  }
  // Record which build each file claims, however it spells it.
  const declared = [raw._game, raw._mappingFrom, raw._valuesFrom].filter(Boolean);
  declared.forEach((b) => {
    const key = String(b).match(/\d+\.\d+\.\d+\.\d+/)?.[0] || String(b);
    if (!builds.has(key)) builds.set(key, []);
    builds.get(key).push(file);
  });
  console.log(`ok   ${file}`);
}

console.log(`\nvalidated ${Object.keys(schemas).length} reference file(s) against their schemas`);

if (builds.size > 1) {
  console.log('\nNOTE: these references come from more than one build:');
  [...builds.entries()].sort().forEach(([b, files]) => {
    console.log(`   ${b}: ${files.join(', ')}`);
  });
  console.log('That is allowed -- older files stay valid until re-extracted -- but any check that '
    + 'compares them, or resolves offsets across them, must not assume one build.');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('every reference file matches its schema');
