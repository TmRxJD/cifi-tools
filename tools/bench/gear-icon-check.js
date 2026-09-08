'use strict';
// EVERY MODELLED GEAR PIECE HAS ITS OWN ICON, and no two pieces share one.
//
//   node tools/bench/gear-icon-check.js
//
// The icons are keyed by DISPLAYED NAME (the gear store reconciles pieces by name), and the file
// name is derived from that name by a slug rule that exists in TWO places -- the extractor and
// shipsPage.js. This checks they still agree, because a slug mismatch shows every piece with no
// icon, silently: the <img> onerror removes itself, so the page looks merely plain rather than
// broken.
//
// DISTINCTNESS IS THE LOAD-BEARING CHECK. The first version of the extractor resolved all 37 rows
// to the same sprite -- a shared panel background -- and every count it printed looked correct.
// Identical icons across pieces is the signature of reading a decoration instead of the art, so it
// is asserted here as well as in the extractor.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./harness.js');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const REF = path.join(__dirname, '..', 'reference', 'gear-icons.json');
const DIR = path.join(__dirname, '..', '..', 'webapp', 'public', 'assets', 'gear');

if (!fs.existsSync(REF)) {
  console.log('FAIL  tools/reference/gear-icons.json is missing -- run '
    + 'tools/assets/extract-gear-icons.py --write');
  process.exit(1);
}
const icons = JSON.parse(fs.readFileSync(REF, 'utf8')).icons || {};
check('the reference lists all 37 crafting rows', Object.keys(icons).length === 37,
  `got ${Object.keys(icons).length}`);

// 1. Every referenced file exists.
const missingFiles = Object.entries(icons).filter(([, f]) => !fs.existsSync(path.join(DIR, f)));
check('every referenced icon file exists', missingFiles.length === 0,
  missingFiles.map(([n]) => n).join(', '));

// 2. No two pieces share an image. Compared by CONTENT, not by file name -- two different names
// pointing at byte-identical art is exactly the shared-background failure, and distinct file names
// would hide it.
const byHash = {};
for (const [name, file] of Object.entries(icons)) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) continue;
  const h = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  (byHash[h] = byHash[h] || []).push(name);
}
const shared = Object.values(byHash).filter((v) => v.length > 1);
check('no two pieces share the same image', shared.length === 0,
  shared.map((v) => v.join(' == ')).join('; '));

// 3. THE SLUG RULES AGREE. shipsPage.js derives the filename from the displayed name; the
// extractor derived it the same way. If they drift, every icon silently disappears.
const sb = H.browserSandbox();
const slugOf = sb.gearIconSlug || (sb.ShipData && sb.ShipData.gearIconSlug);
if (typeof slugOf !== 'function') {
  check('shipsPage.js exposes gearIconSlug', false, 'not exported');
} else {
  const wrong = Object.entries(icons).filter(([name, file]) => `${slugOf(name)}.png` !== file);
  check('the UI slug rule reproduces every icon filename', wrong.length === 0,
    wrong.slice(0, 3).map(([n, f]) => `${n}: ui=${slugOf(n)}.png ref=${f}`).join('; '));
}

// 4. Every piece the TOOL MODELS has an icon. The reference covers all 37 crafting rows, but what
// matters for the page is that the pieces actually rendered are covered -- Yellow and Black are
// extracted but unmodelled, so their absence from the UI is fine while a modelled piece missing
// one is not.
const sets = (sb.ShipData && sb.ShipData.REAL_GEAR_PIECES) || null;
if (!sets) {
  console.log('note  REAL_GEAR_PIECES is not exported; skipping the modelled-piece cross-check');
} else {
  // COMPARED BY SLUG, NOT BY RAW NAME -- which is how the UI actually resolves an icon. The
  // reference is keyed by the GAME's names, which are UPPERCASE ("OCEANIC SPECIMEN"), while the
  // tool displays Title Case ("Oceanic Specimen"). Both slug to `oceanic-specimen`, so the lookup
  // works; a raw-key comparison reports all 27 as missing and would send someone renaming things
  // to fix a problem that does not exist.
  const haveSlugs = new Set(Object.values(icons).map((f) => f.replace(/\.png$/, '')));
  const modelled = Object.values(sets).flat().map((p) => p.name);
  const uncovered = modelled.filter((n) => !haveSlugs.has(slugOf(n)));
  check(`all ${modelled.length} modelled piece(s) resolve to an icon`, uncovered.length === 0,
    uncovered.join(', '));
}

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s) with gear icons.`);
  process.exit(1);
}
console.log('PASS  every gear piece has its own distinct icon, and the UI can find it');
