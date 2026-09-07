'use strict';
// DO THE UPGRADES A FIXTURE'S NOTE SAYS IT NEEDS ACTUALLY REACH THE EVALUATOR?
//
//   node tools/bench/fixture-note-audit.js
//
// The community labels state required account state alongside each code -- "Anchor 40 required",
// "Wrench 130", "R4-36, R16-36", "InnoGN3, CreaGn3", "5 TIMELESS". If any of that is NOT carried by
// the share code and NOT applied elsewhere, every number measured for that build is computed under
// the wrong account state, and the whole comparison is against a build the evaluator never saw.
//
// A share code carries only CODE_PARAMS. Gadgets and some relics are in it; other upgrades are not.
// So this parses each note for a stated requirement, decodes the code, and reports whether the
// value is present -- rather than assuming the note is decorative.
//
// REPORT, not a gate: a note is free text written by players and cannot be parsed exhaustively.
// A miss here is a prompt to look, not proof of a defect.

const H = require('./harness.js');

// Note fragments -> the override key they imply. Only unambiguous ones; a guess would produce a
// confident wrong finding, which is worse than silence.
const PATTERNS = [
  [/\bAnchor\s+(\d+)/i, 'upgrades.gadgets.anchor'],
  [/\bWrench\s+(\d+)/i, 'upgrades.gadgets.wrench'],
  [/\b(?:ZAP|Zaptron)\s+(\d+)/i, 'upgrades.gadgets.zaptron'],
  [/\bR4-(\d+)/i, 'upgrades.relics.r4'],
  [/\bR16-(\d+)/i, 'upgrades.relics.r16'],
  [/\bR17-(\d+)/i, 'upgrades.relics.r17'],
  [/\bR19-(\d+)/i, 'upgrades.relics.r19'],
];

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  let checked = 0;
  let missing = 0;
  let carried = 0;

  for (const fx of flat) {
    const note = fx.note || '';
    if (!note) continue;
    const wants = [];
    for (const [re, key] of PATTERNS) {
      const m = re.exec(note);
      if (m) wants.push({ key, value: Number(m[1]) });
    }
    if (!wants.length) continue;

    let build;
    try { build = await H.parseBuildCode(fx.code, fx.hunter); } catch (e) { continue; }
    const ov = { ...build.overrides, ...build.upgradeOverrides };
    for (const w of wants) {
      checked++;
      const got = ov[w.key];
      if (got === undefined) {
        missing++;
        console.log(`MISSING  ${String(fx.name).padEnd(11)} note says ${w.key.split('.').pop()} `
          + `${w.value}, but the code carries no value for it`);
      } else if (Number(got) !== w.value) {
        missing++;
        console.log(`DIFFERS  ${String(fx.name).padEnd(11)} note says ${w.key.split('.').pop()} `
          + `${w.value}, code carries ${got}`);
      } else {
        carried++;
      }
    }
  }

  console.log('');
  console.log(`${checked} stated requirement(s) across the fixtures: ${carried} carried by the code, `
    + `${missing} not.`);
  if (missing) {
    console.log('A requirement the code does not carry is NOT applied by the evaluator -- the build');
    console.log('is being scored under different account state than the label describes.');
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
