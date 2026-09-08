'use strict';
// Validate the app's own data against its zod schemas: the wasm parameter lists, the persisted
// store, and the decoded-save fixture.
//
//   node tools/bench/app-schema-test.js
//
// reference-schema-test.js covers the game-derived files under tools/reference/. This covers
// everything else the tool runs on, so that "schema enforced" means all of the data rather than
// the extracted half of it.
//
// The store is checked in three states, because a shape can be right when it is created and wrong
// once it has been used: a fresh store, a store after a real save import (skipped when no save has
// been pulled), and a store carrying an imported build. A schema that only ever sees `freshStore()`
// is testing the factory, not the data.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');
const { storeSchema, paramsSchema, decodedSaveSchema } = require('./app-schemas.js');

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

function check(label, schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) { pass(label); return true; }
  fail(label);
  parsed.error.issues.slice(0, 8).forEach((i) => {
    console.log(`        ${i.path.join('.') || '(root)'}: ${i.message}`);
  });
  if (parsed.error.issues.length > 8) console.log(`        … and ${parsed.error.issues.length - 8} more`);
  return false;
}

const sb = H.browserSandbox();

// --- 1. the wasm parameter lists ---------------------------------------------------------------
const paramsPath = path.join(__dirname, '../../webapp/public/params.json');
check('params.json matches its schema (no duplicate slot names)',
  paramsSchema, JSON.parse(fs.readFileSync(paramsPath, 'utf8')));

// --- 2. the persisted store, in three states ---------------------------------------------------
const fresh = sb.StoreSchema.freshStore();
check('a fresh store matches the store schema', storeSchema, fresh);

// DRIFT GUARD. The zod schema is hand-written because StoreSchema.SCHEMA declares factories, not
// types, so there is nothing to derive it from -- which makes it exactly the kind of duplicated
// rule this repo has watched drift before (ship-test.js's private copy of the node-weight rule).
// Comparing the two key sets is what keeps a field added to SCHEMA from going unvalidated here.
const declared = new Set(Object.keys(sb.StoreSchema.SCHEMA || {}));
const schemaKeys = new Set(Object.keys(storeSchema.shape));
const missing = [...declared].filter((k) => !schemaKeys.has(k));
const extra = [...schemaKeys].filter((k) => !declared.has(k));
if (!declared.size) {
  fail('StoreSchema.SCHEMA is empty or unreadable -- the drift guard cannot run');
} else if (missing.length || extra.length) {
  if (missing.length) fail(`store fields in SCHEMA with no zod entry: ${missing.join(', ')}`);
  if (extra.length) fail(`zod entries for store fields SCHEMA does not declare: ${extra.join(', ')}`);
} else {
  pass(`the store schema covers all ${declared.size} fields StoreSchema declares, and no others`);
}

// A store that has actually been used: import a real build code into it.
const used = sb.StoreSchema.freshStore();
// THE REAL BUILD SHAPE, from the app's own factory. This used to push
// `{ name, code, allocation }` -- a shape NO code path produces (newDraftBuild makes
// `{id, name, level, talents, attributes, categoryId, overrides}`), so the store-with-a-build case
// was validating an invented object and could never have caught a real build defect. A fixture
// that does not match reality is a test of nothing, which is why the schema tightening found it.
used.borge.builds.push({
  id: null, name: 'probe', level: 12, talents: { revival: 1 }, attributes: { ares: 2 },
  categoryId: 'active', overrides: {},
});
used.gems.exodus.level = 5;
used.gems.exodus.nodes = used.gems.exodus.nodes.map(() => true);
used.fragments.current = 12345;
used.fragments.currentAt = Date.now();
check('a store carrying a build and gem state still matches', storeSchema, used);

// --- 3. a store after a REAL save import -------------------------------------------------------
// The importer writes far more of the store than any hand-built fixture does, so this is where a
// shape mistake in mapSaveToStore would actually show up. Skipped rather than faked when no save
// has been pulled: a synthetic save would only re-test the factory.
const saveDir = path.join(__dirname, '../gamefiles/save');
const decoded = fs.existsSync(saveDir)
  ? fs.readdirSync(saveDir).filter((f) => f.startsWith('decoded-') && f.endsWith('.json'))
  : [];
if (!decoded.length) {
  console.log('skip  no decoded save pulled -- the post-import store shape is unchecked '
    + '(run tools/save/inspect.js against a real save to enable this)');
} else {
  const raw = JSON.parse(fs.readFileSync(path.join(saveDir, decoded[0]), 'utf8'));
  check(`the decoded save fixture (${decoded[0]}) is a non-empty flat field map`,
    decodedSaveSchema, raw);
  const imported = sb.StoreSchema.freshStore();
  try {
    sb.mapSaveToStore(raw, imported);
    if (sb.applyImportedShipData) sb.applyImportedShipData(raw, imported);
    check('a store after a REAL save import matches the store schema', storeSchema, imported);
  } catch (e) {
    fail(`importing the real save threw before the shape could be checked: ${e.message}`);
  }
}

// The bridge's own fixture, which the save tooling is developed against.
const fixture = path.join(__dirname, '../../bridge/test-fixtures/sample-save-decoded.json');
if (fs.existsSync(fixture)) {
  check('bridge/test-fixtures/sample-save-decoded.json is a non-empty flat field map',
    decodedSaveSchema, JSON.parse(fs.readFileSync(fixture, 'utf8')));
} else {
  console.log('skip  bridge sample-save fixture not present');
}

console.log(failures ? `\n${failures} failure(s)` : '\nevery app data file matches its schema');
process.exit(failures ? 1 : 0);
