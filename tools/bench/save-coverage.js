'use strict';
// WHAT DOES THE TOOL ASK THE USER FOR THAT THE SAVE ALREADY KNOWS?
//
// Every field the user types in by hand is a chance to be wrong, and most of them are sitting in
// the save. This walks the store's own input surface, runs the real importer over a real save,
// and reports what got filled, what did not, and -- for the gaps -- which save field families
// look like candidates.
//
// It is a REPORT, not a gate: a gap is a to-do, not a failure. It exits non-zero only if the
// importer errors or fills nothing at all, which would mean it is broken rather than incomplete.
//
//   node tools/bench/save-coverage.js [decoded-save.json]

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness.js');

const savePath = process.argv[2] || path.join(__dirname, '../gamefiles/save/decoded-20260809.json');
if (!fs.existsSync(savePath)) {
  console.log(`SKIP: no decoded save at ${savePath} (see tools/gamefiles/README.md)`);
  process.exit(0);
}
const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
const sb = H.browserSandbox();

// saveImport.js is standalone (crypto + the mapping); load it into the sandbox.
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../../webapp/public/saveImport.js'), 'utf8'),
  sb, { filename: 'saveImport.js' },
);

const mapped = sb.mapSaveToStore(save);
const filledUpgrades = new Set(Object.keys(mapped.globalUpgrades || {}));

// ---- the tool's input surface ---------------------------------------------------------------
// Everything a user can type on the Upgrades pages, per hunter, de-duplicated.
const inputs = [];
for (const hunter of ['borge', 'ozzy', 'knox']) {
  const defs = sb.HUNTER_DEFS[hunter];
  for (const [cat, group] of Object.entries(defs.globalUpgrades || {})) {
    for (const item of group.items || []) inputs.push({ kind: 'globalUpgrade', key: `${cat}.${item.id}`, label: item.label });
  }
  for (const stat of defs.baseStatKeys) inputs.push({ kind: 'hunterStat', key: `${hunter}.${stat}`, hunter, stat });
}
const seen = new Set();
const uniqueInputs = inputs.filter((i) => (seen.has(i.kind + i.key) ? false : seen.add(i.kind + i.key)));

// ---- save field families, for suggesting candidates ------------------------------------------
const families = new Map();
for (const k of Object.keys(save)) {
  const m = /^([A-Za-z_]+?)(\d+)([A-Za-z_]*)$/.exec(k);
  const sig = m ? `${m[1]}<N>${m[3]}` : k;
  families.set(sig, (families.get(sig) || 0) + 1);
}
const familyList = [...families.entries()].filter(([, n]) => n >= 3).map(([s]) => s);

function suggest(key) {
  const id = key.split('.').pop().toLowerCase();
  const cat = key.split('.')[0].toLowerCase();
  const hits = familyList.filter((f) => {
    const l = f.toLowerCase();
    return l.includes(id) || (id.replace(/[^a-z]/g, '') && l.includes(id.replace(/[^a-z]/g, '')))
      || l.startsWith(cat.slice(0, 3));
  });
  return hits.slice(0, 3);
}

// ---- report -----------------------------------------------------------------------------------
const byCat = {};
for (const inp of uniqueInputs) {
  if (inp.kind !== 'globalUpgrade') continue;
  const cat = inp.key.split('.')[0];
  (byCat[cat] ||= { total: 0, filled: 0, missing: [] });
  byCat[cat].total++;
  if (filledUpgrades.has(inp.key)) byCat[cat].filled++;
  else byCat[cat].missing.push(inp.key);
}

console.log(`importer filled ${filledUpgrades.size} global upgrade field(s) from this save\n`);
console.log('per category (tool inputs vs what the importer supplies):');
let totalInputs = 0; let totalFilled = 0;
for (const [cat, v] of Object.entries(byCat).sort()) {
  totalInputs += v.total; totalFilled += v.filled;
  const flag = v.filled === v.total ? 'ok  ' : (v.filled === 0 ? 'NONE' : 'part');
  console.log(`  ${flag} ${cat.padEnd(18)} ${String(v.filled).padStart(3)}/${String(v.total).padEnd(3)}`);
  if (v.missing.length) {
    for (const m of v.missing.slice(0, 6)) {
      const s = suggest(m);
      console.log(`         - ${m.padEnd(34)} ${s.length ? `candidates: ${s.join(', ')}` : ''}`);
    }
    if (v.missing.length > 6) console.log(`         ... and ${v.missing.length - 6} more`);
  }
}
console.log(`\n  TOTAL ${totalFilled}/${totalInputs} global upgrade inputs auto-filled`);

// Hunter base stats: the importer deliberately does not fill these.
const statsFilled = Object.values(mapped.perHunter || {}).filter((h) => h && h.hunterStats).length;
console.log(`\nhunter base stats: ${statsFilled ? 'some filled' : 'NOT filled by the importer'}`);

// Other store areas the user fills by hand.
console.log('\nother input areas:');
const areas = [
  ['gems', mapped.gems && Object.keys(mapped.gems).length],
  ['perHunter (level/talents/attributes)', mapped.perHunter && Object.keys(mapped.perHunter).length],
  ['ships / fleet', mapped.ships || mapped.fleet ? 'yes' : 0],
  ['fragments (balance/rate)', mapped.fragments ? 'yes' : 0],
];
for (const [name, v] of areas) console.log(`  ${v ? 'ok  ' : 'NONE'} ${name}${v && v !== 'yes' ? ` (${v})` : ''}`);

if (mapped.unmapped && mapped.unmapped.length) {
  console.log(`\nimporter self-reports unmapped: ${mapped.unmapped.join(', ')}`);
}

if (!filledUpgrades.size) { console.error('\nimporter filled nothing -- it is broken, not merely incomplete'); process.exit(1); }
