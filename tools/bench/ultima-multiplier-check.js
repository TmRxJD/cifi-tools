'use strict';
// `upgrades.ultima.ulti` IS A MULTIPLIER, AND NOTHING MAY WRITE A LEVEL INTO IT.
//
//   node tools/bench/ultima-multiplier-check.js
//
// THE BUG THIS COVERS. The save importer mapped `DiamondUltimaLevel` -> `upgrades.ultima.ulti` on a
// {Name}Level name match. But that key does not hold a level: the original tool's Ultima page
// renders it `display-as-multiplier` as a 1.0000-10.0000 value with step 0.0001 ("Current
// Multiplier x"), and our own card does the same. So every save import reset a real x1.1989 back to
// x1.0000 -- reported by the player as "Diamond Ultima isn't being scanned". A level of 7 would have
// been fed to the evaluator as x7 loot, so it fails in both directions.
//
// It survived because the field NAME looked exactly like every other confirmed mapping, and because
// the reference account read 1 -- which is a legal multiplier, so nothing downstream complained.
//
// GATE: importing a real save must not touch ultima.ulti, and the UI must offer it as a decimal
// multiplier rather than an integer level.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  -- ${detail}` : ''}`);
};

(async () => {
  // 1. The importer must leave it alone. Uses a REAL save: a synthetic one would only re-test
  //    whatever the fixture author believed, which is the belief that was wrong.
  const saveDir = path.join(__dirname, '..', 'gamefiles', 'save');
  const decoded = fs.existsSync(saveDir)
    ? fs.readdirSync(saveDir).filter((f) => f.endsWith('.decoded.json') || /^decoded-/.test(f)).sort().pop()
    : null;

  if (!decoded) {
    console.log('SKIP  no decoded save pulled -- cannot check the importer against real data.');
    console.log('      That is a SKIP, not a pass: run tools/save/inspect.js on a real save first.');
  } else {
    const save = JSON.parse(fs.readFileSync(path.join(saveDir, decoded), 'utf8'));
    const sb = H.browserSandbox();
    const store = sb.mapSaveToStore(save);
    const got = store && store.globalUpgrades ? store.globalUpgrades['ultima.ulti'] : undefined;
    check(`importer leaves ultima.ulti alone (${decoded})`, got === undefined,
      got === undefined ? '' : `imported ${got} from DiamondUltimaLevel=${save.DiamondUltimaLevel}`);

    // The specific corruption: whatever the save says, the imported value must never be the level.
    if (save.DiamondUltimaLevel !== undefined) {
      check('the raw DiamondUltimaLevel is never used as the multiplier',
        got !== Number(save.DiamondUltimaLevel) || got === undefined);
    }
  }

  // 2. The UI must present a multiplier, not a level. A step of 1 makes x1.1989 untypeable, which
  //    is the same defect wearing a different hat.
  const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'webapp', 'public', 'app.js'), 'utf8');
  const card = appSrc.slice(appSrc.indexOf("fullKey === 'ultima.ulti'"));
  check('the Ultima control accepts decimals', /step="0\.0001"/.test(card.slice(0, 2000)));
  check('the Ultima control is bounded 1..10 like the original',
    /min="1"/.test(card.slice(0, 2000)) && /max="10"/.test(card.slice(0, 2000)));

  console.log('');
  if (failures) {
    console.log(`FAIL  ${failures} problem(s): ultima.ulti is being treated as a level somewhere.`);
    process.exit(1);
  }
  console.log('PASS  ultima.ulti is a multiplier end to end');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
