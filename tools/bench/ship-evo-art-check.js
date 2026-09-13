'use strict';
// SHIP EVOLUTION ARTWORK: every stage the game declares has a file, and the picker cannot ask for
// one that does not exist.
//
//   node tools/bench/ship-evo-art-check.js
//
// The stage counts are NOT uniform -- Cradle 8, Zeus 7, Hephaestus 6, Auxesia/Zagreus/Koios 5,
// Demeter 4 -- so a UI that assumed a single ceiling would request demeter-evo7.png and render a
// broken image. Three separate things have to agree, and this checks all three against each other
// rather than against a restatement of one of them:
//
//   1. tools/reference/ship-evo-stages.json  (extracted from FleetManager's own declarations)
//   2. the PNG files actually on disk
//   3. SHIP_MAX_EVO in shipsPage.js, which is what the picker clamps to
//
// Any pair agreeing while the third differs is exactly the drift that ships a broken image.
const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const REF = path.join(__dirname, '..', 'reference', 'ship-evo-stages.json');
const ART = path.join(__dirname, '..', '..', 'webapp', 'public', 'assets', 'ships');

if (!fs.existsSync(REF)) {
  console.log('FAIL  tools/reference/ship-evo-stages.json is missing -- run '
    + 'tools/assets/extract-ship-evo-sprites.py --write');
  process.exit(1);
}
const ref = JSON.parse(fs.readFileSync(REF, 'utf8'));
const ships = ref.ships || {};
const sb = H.browserSandbox();
const SD = sb.ShipData || {};
const MAX = SD.SHIP_MAX_EVO;
const pick = SD.shipPortraitPath;

if (!MAX || typeof pick !== 'function') {
  console.log('FAIL  shipsPage.js does not export SHIP_MAX_EVO / shipPortraitPath');
  process.exit(1);
}

const shipIds = { cradle: 1, auxesia: 2, zagreus: 3, hephaestus: 4, demeter: 5, koios: 6, zeus: 7 };

const names = Object.keys(ships);
check('the reference describes all seven ships', names.length === 7, `got ${names.length}`);

for (const [name, info] of Object.entries(ships)) {
  const id = shipIds[name];
  if (!id) { check(`${name} is a known ship`, false, 'not in the id map'); continue; }

  // 1 vs 2: every declared stage has a file. A missing one is what makes an <img> break.
  const missing = info.stages.filter((st) => !fs.existsSync(path.join(ART, `${name}-evo${st}.png`)));
  check(`${name}: all ${info.stages.length} declared stage(s) have artwork`, missing.length === 0,
    missing.length ? `missing evo ${missing.join(', ')}` : '');

  // 1 vs 3: the shipped ceiling matches the game's. This is the value the picker clamps to, so a
  // ceiling that is too HIGH requests a file that does not exist, and one too LOW silently caps a
  // fully-evolved ship at an earlier picture.
  check(`${name}: SHIP_MAX_EVO matches the game (${info.maxStage})`, MAX[id] === info.maxStage,
    `SHIP_MAX_EVO says ${MAX[id]}`);
}

// THE PICKER MUST NEVER PRODUCE A PATH THAT DOES NOT EXIST, whatever it is handed. `evo` was a
// free number input before this change, so out-of-range values are genuinely present in saved
// stores rather than hypothetical.
const abusive = [99, -3, 0, 1.7, NaN, null, undefined, '3', ''];
for (const [name, id] of Object.entries(shipIds)) {
  for (const v of abusive) {
    const p = pick(id, v);
    const file = path.join(ART, path.basename(String(p)));
    check(`${name}: evo ${JSON.stringify(v)} resolves to a file that exists`, fs.existsSync(file),
      `${p}`);
  }
}

// Ouroboros has no per-stage art and must fall back rather than 404.
const ouro = pick(8, 3);
check('ouroboros falls back to its static portrait',
  path.basename(String(ouro)) === 'ouroboros.png' && fs.existsSync(path.join(ART, 'ouroboros.png')), `${ouro}`);

// An unknown ship id returns null rather than a broken path.
check('an unknown ship id returns null', pick(99, 0) === null, `${pick(99, 0)}`);

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s) with ship evolution artwork.`);
  process.exit(1);
}
console.log('PASS  every declared evolution stage has artwork, and the picker cannot ask for one that does not');
