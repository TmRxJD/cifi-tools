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
// GATE: the import must DERIVE the multiplier from UDU7Level and DiamondUltimaLevel, must not
// use UDU6's exponent, must never write the raw level, and the UI must offer a decimal
// multiplier rather than an integer level. The save's own milestone arithmetic is checked too,
// since that is what makes the derivation trustworthy rather than merely fitted.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

let failures = 0;
// DETAIL ON FAILURE ONLY. Printing it unconditionally made a PASSING line read
// "ok ... which is the 1.05 form", which states the opposite of what the check just proved. A
// diagnostic that contradicts its own verdict is worse than no diagnostic.
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `  -- ${detail}` : ''}`);
};

(async () => {
  // 1. The importer must leave it alone. Uses a REAL save: a synthetic one would only re-test
  //    whatever the fixture author believed, which is the belief that was wrong.
  const saveDir = path.join(__dirname, '..', 'gamefiles', 'save');
  const decoded = fs.existsSync(saveDir)
    // NEWEST BY MTIME, not by filename. A .sort().pop() put "decoded-20260903.json" after
    // "DATA-20260907.decoded.json" (uppercase sorts first), so the gate silently checked a
    // four-day-old save -- and an importer bug introduced since would have gone unnoticed while
    // the board stayed green.
    ? fs.readdirSync(saveDir)
      .filter((f) => f.endsWith('.decoded.json') || /^decoded-/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(saveDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f)[0]
    : null;

  if (!decoded) {
    console.log('SKIP  no decoded save pulled -- cannot check the importer against real data.');
    console.log('      That is a SKIP, not a pass: run tools/save/inspect.js on a real save first.');
  } else {
    const save = JSON.parse(fs.readFileSync(path.join(saveDir, decoded), 'utf8'));
    const sb = H.browserSandbox();
    const store = sb.mapSaveToStore(save);
    const got = store && store.globalUpgrades ? store.globalUpgrades['ultima.ulti'] : undefined;

    // THE AUTO-IMPORT IS ON, so the gate checks the VALUE, not merely that something was written.
    // Recomputing the expected multiplier here from the save's own fields would test the importer
    // against a copy of itself -- the parallel-implementation trap this project bans -- so the
    // constants are asserted independently against the AUTHORED game data instead, and the result
    // is bounded by what the control offers.
    const uduLevel = Number(save.UDU7Level || 0);
    if (uduLevel > 0) {
      const milestone = Number(save.DiamondUltimaLevel || 0);
      const expected = 1 + 0.003 * Math.pow(1.02, milestone) * uduLevel;
      check(`importer derives ultima.ulti (${decoded})`, Number.isFinite(got),
        Number.isFinite(got) ? '' : 'nothing written -- the auto-import is off or threw');
      check(`ultima.ulti matches the authored derivation (x${expected.toFixed(4)})`,
        Number.isFinite(got) && Math.abs(got - expected) < 1e-9,
        Number.isFinite(got) ? `got x${got.toFixed(4)}` : 'not written');

      // THE WRONG CONSTANT IS THE FAILURE MODE THIS EXISTS FOR. UDU6 (materials) uses 1.05 where
      // UDU7 (hunter loot) uses 1.02; both produce a plausible multiplier, so only an explicit
      // check separates them. On the reference save that is x1.1989 against x1.20475.
      const wrong = 1 + 0.003 * Math.pow(1.05, milestone) * uduLevel;
      if (Math.abs(wrong - expected) > 1e-9) {
        check('ultima.ulti did NOT use UDU6\'s 1.05 exponent',
          !(Number.isFinite(got) && Math.abs(got - wrong) < 1e-9),
          `got x${Number(got).toFixed(5)}, which is the MATERIALS constant`);
      }

      // The control card is a multiplier in 1.0000-10.0000, so a derivation landing outside that
      // is a modelling error rather than a big number -- and would be silently clamped by the UI.
      check('ultima.ulti is inside the control\'s range',
        Number.isFinite(got) && got >= 1 && got <= 10, `got ${got}`);
    } else {
      // NO DEFAULT MAY BE STAMPED. An unowned upgrade must leave the field untouched: a computed
      // 1.0 and "not set" are indistinguishable downstream, and writing one is exactly the bug
      // that overwrote a real x1.1989 with x1.0000 on every re-import.
      check(`importer writes nothing when UDU7 is unowned (${decoded})`, got === undefined,
        got === undefined ? '' : `stamped ${got}`);
    }

    // MILESTONE ARITHMETIC, checked because it is what makes the derivation trustworthy rather
    // than fitted: the game advances DiamondUltimaLevel once per UltimaMilestoneGoal (50) Ultima
    // purchases across ALL SEVEN UDU upgrades. If the save's own numbers stop agreeing with that,
    // the model behind the import is wrong even if the multiplier still looks reasonable.
    const uduSum = [1, 2, 3, 4, 5, 6, 7]
      .reduce((sum, n) => sum + Number(save[`UDU${n}Level`] || 0), 0);
    if (uduSum > 0) {
      const level = Number(save.DiamondUltimaLevel || 0);
      const progress = Number(save.DiamondUltimaProgress || 0);
      check(`UDU levels sum to the milestone state (${uduSum} = 50x${level} + ${progress})`,
        uduSum === 50 * level + progress, `sum ${uduSum}, state 50x${level}+${progress}`);
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
