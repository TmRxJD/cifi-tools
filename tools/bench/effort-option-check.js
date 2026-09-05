'use strict';
// A MISSPELLED EFFORT FLAG MUST THROW, NOT QUIETLY DISABLE THE THING BEING MEASURED.
//
// Every search flag is read as `effortSpec.<name>`. A typo therefore reads `undefined`, the feature
// stays off, and the arm that was supposed to have it ON returns the control's number -- which gets
// written down as "measured, no effect". An A/B that cannot fail loudly produces false negatives
// that look exactly like results.
//
// This is not hypothetical. `bossDamageBands` was added to cellOf, to illuminate's signature and to
// its diag record, and was NOT passed at the call site, because the surrounding argument list used
// `!== false` where the patch matched `=== true`. Three of four sites looked correct.
//
// This check also asserts the OTHER direction, which is the one a whitelist gets wrong on its own:
// every key the whitelist permits must actually be READ by the search. A whitelist naming a key
// nothing consumes licenses a flag that does nothing -- the same lie, arriving through the guard
// meant to prevent it. (`frontierShare` was caught that way and removed.)

const path = require('path');
const fs = require('fs');
const H = require(path.join(__dirname, 'harness.js'));

const SRC = fs.readFileSync(path.join(__dirname, '../../webapp/public/optimizer/search.js'), 'utf8');

let failures = 0;
let checked = 0;
const fail = (m) => { failures++; console.log('FAIL  ' + m); };
const ok = (m) => console.log('ok    ' + m);

// --- 1. The whitelist exists and is parseable from the source. -----------------------------
const m = SRC.match(/const EFFORT_SPEC_KEYS = new Set\(\[([\s\S]*?)\]\);/);
if (!m) { console.log('FAIL  EFFORT_SPEC_KEYS not found in search.js'); process.exit(1); }
const keys = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
checked++;
if (keys.length < 5) fail(`EFFORT_SPEC_KEYS parsed only ${keys.length} key(s); the check is not comparing anything`);
else ok(`EFFORT_SPEC_KEYS declares ${keys.length} keys: ${keys.join(', ')}`);

// --- 2. Every permitted key is actually consumed. ------------------------------------------
// `label` and `help` are consumed by the UI's level picker rather than by the search, so they are
// checked against the whole public tree instead of search.js alone.
const UI = ['app.js', 'optimizer/search.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '../../webapp/public', f), 'utf8')).join('\n');
for (const k of keys) {
  checked++;
  // NO CONSTRUCTED REGEXES HERE, DELIBERATELY. The first version built these with a RegExp whose
  // pattern was assembled from a string, and the file ended up holding a single backslash before
  // the b -- so JS parsed it as a BACKSPACE character and the pattern could never match ANY key.
  // The check then reported all 13 permitted keys as unread; it failed in the safe direction only
  // by luck. This repo has already lost two benches to a stray backspace. A plain substring test
  // needs no escaping and cannot acquire the bug.
  const readBySearch = SRC.includes('effortSpec.' + k);
  const readByUi = UI.includes('.' + k);
  if (readBySearch) ok(`'${k}' is read as effortSpec.${k}`);
  else if (readByUi && (k === 'label' || k === 'help')) ok(`'${k}' is level metadata read by the UI`);
  else fail(`'${k}' is permitted by EFFORT_SPEC_KEYS but nothing reads it -- it would be a silent no-op`);
}

// --- 3. Behaviour: an unknown key throws; a known one does not. -----------------------------
async function behaviour() {
  // A SKIP HERE WOULD DEFEAT THE POINT. The static half above cannot prove the whitelist is
  // actually CONSULTED at runtime -- only that it exists and is self-consistent. So the fixture
  // must resolve, and failing to resolve it is a failure, not a skip.
  const fixture = H.findFixture(H.loadKnownBuilds(), 'borge@12');
  const build = await H.parseBuildCode(fixture.code, fixture.hunter);
  const cfg = H.cfgForImport(fixture.hunter, build);
  const scorer = await H.makeScorer(cfg, 'loot');

  const call = async (effort) => {
    try {
      await H.Optimizer.optimize(cfg, { mode: 'loot', scorer, effort });
      return null;
    } catch (e) { return String(e && e.message || e); }
  };

  checked++;
  const bad = await call({ archiveEvals: 8, refineSupports: 1, bossDamageBandz: true });
  if (bad && /unknown effort option/i.test(bad)) ok('a misspelled effort key throws: ' + bad.split(';')[0]);
  else fail('a misspelled effort key did NOT throw (got: ' + bad + ')');

  checked++;
  const good = await call({ archiveEvals: 8, refineSupports: 1, bossDamageBands: true });
  if (good && /unknown effort option/i.test(good)) fail('a VALID effort key was rejected: ' + good);
  else ok('a valid effort key is accepted');
}

behaviour().then(() => {
  console.log('');
  if (!checked) { console.log('FAIL  effort-option-check compared nothing'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} of ${checked} check(s) failed`); process.exit(1); }
  console.log(`PASS  ${checked} checks over ${keys.length} permitted effort keys`);
}).catch((e) => { console.error('FAIL ' + (e && e.stack || e)); process.exit(1); });
