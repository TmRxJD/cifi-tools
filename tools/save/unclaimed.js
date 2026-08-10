'use strict';
// Which save fields is NOTHING reading?
//
// Some inputs the tool asks for have no obvious save field -- trinkets, diamond specials, IAP.
// Searching for their names finds nothing, but the game must persist them somewhere, so the
// name is presumably not what we would call it. This inverts the search: list the fields that no
// importer touches, filter out the obvious noise, and read what is left.
//
//   node tools/save/unclaimed.js [decoded-save.json] [filter-regex]

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../bench/harness.js');

const savePath = process.argv[2] && !process.argv[2].startsWith('-')
  ? process.argv[2]
  : path.join(__dirname, '../gamefiles/save/decoded-20260809.json');
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;

const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
const sb = H.browserSandbox();
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../webapp/public/saveImport.js'), 'utf8'), sb, { filename: 'saveImport.js' });

// Everything any importer reads. Rather than parse the source, run them and record which keys
// they touch -- a Proxy makes that exact instead of approximate.
const touched = new Set();
const spy = new Proxy(save, {
  get(target, prop) { if (typeof prop === 'string') touched.add(prop); return target[prop]; },
  has(target, prop) { if (typeof prop === 'string') touched.add(prop); return prop in target; },
});
try { sb.mapSaveToStore(spy); } catch { /* keep going; partial coverage still narrows the list */ }
for (const fn of ['mapCifiSaveToShips', 'mapCifiSaveToResearchUnits', 'mapCifiSaveToUnlockedGens',
  'mapCifiSaveToShipGear', 'mapCifiSaveToGearLevels', 'mapCifiSaveToFleetBadges']) {
  try { if (sb[fn]) sb[fn](spy); } catch { /* same */ }
}
for (const k of ['RU68Level', 'RU78Level']) touched.add(k);

// Noise: telemetry, tutorials, UI toggles, timers, per-run history and all-time stats. None of it
// is a player-owned upgrade, which is what we are hunting for.
const NOISE = /(Tutorial|Toggle|Animation|Achievement|Progress$|AllTime|ThisLoop|LastLoop|ThisRun|LastRun|ThisConstruction|LastConstruction|ThisTraversal|Runs$|Highest|Best|Total|Count$|Timer|Time$|Seconds|Errors|Debug|Sorting|Open$|Warning|Claims|Notification|Online_|Ads?$|Rate$|Seen|Viewed|Shown|Order$|Index$|Sound|Music|Volume|Language|Version|Date|Stamp)/i;

const unclaimed = Object.keys(save)
  .filter((k) => !touched.has(k))
  .filter((k) => !NOISE.test(k))
  .filter((k) => (filter ? filter.test(k) : true));

// Group numbered families so a 300-entry family reads as one line.
const fams = new Map();
for (const k of unclaimed) {
  const m = /^([A-Za-z_]+?)(\d+)([A-Za-z_]*)$/.exec(k);
  const sig = m ? `${m[1]}<N>${m[3]}` : k;
  if (!fams.has(sig)) fams.set(sig, []);
  fams.get(sig).push(k);
}

const interesting = [...fams.entries()]
  .map(([sig, keys]) => {
    const nonZero = keys.filter((k) => {
      const v = save[k];
      return v === true || (typeof v === 'number' && v !== 0)
        || (v && typeof v === 'object' && v.mantissa) || (typeof v === 'string' && v.length);
    });
    return { sig, keys, nonZero: nonZero.length };
  })
  .sort((a, b) => b.nonZero - a.nonZero || b.keys.length - a.keys.length);

console.log(`${Object.keys(save).length} fields, ${touched.size} read by an importer, `
  + `${unclaimed.length} unclaimed and not obvious noise\n`);
console.log('family                                   fields  nonzero  sample');
for (const { sig, keys, nonZero } of interesting.slice(0, 45)) {
  const sample = keys.slice(0, 2).map((k) => `${k}=${JSON.stringify(save[k]).slice(0, 22)}`).join('  ');
  console.log(`  ${sig.padEnd(38)} ${String(keys.length).padStart(4)}  ${String(nonZero).padStart(6)}   ${sample}`);
}
