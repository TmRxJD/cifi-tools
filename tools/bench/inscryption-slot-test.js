'use strict';
// The inscryption display-id -> save-slot mapping must agree with the GAME's own scene data.
//
// saveImport.js has to carry the map inline (the app has no build step and cannot require JSON),
// so this evaluates that shipped function directly and checks it against
// tools/reference/inscryption-slots.json, generated from the scene by
// tools/bench/extract-inscryption-slots.js.
//
// It also re-checks the structural facts that made the previous blanket "+12" rule wrong, so a
// future change cannot quietly reintroduce it:
//   - the map must be a BIJECTION over the 110-slot registry. The +12 rule was not: it left
//     slots 1-12 owned by no displayed id, while those slots are leveled on a real account.
//   - every id must resolve to a slot that EXISTS (#103-#105 used to resolve to IS115-117,
//     which do not exist, so they silently never imported).
//   - no two ids may resolve to the same slot (a shop row displays exactly one inscryption).
//
//   node tools/bench/inscryption-slot-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REF = path.join(__dirname, '../reference/inscryption-slots.json');
if (!fs.existsSync(REF)) {
  console.log(`SKIP: ${REF} missing -- regenerate with tools/bench/extract-inscryption-slots.js`);
  process.exit(0);
}
const ref = JSON.parse(fs.readFileSync(REF, 'utf8'));
const proven = ref.provenDisplayedToSlot;
const REGISTRY_SIZE = Math.max(...Object.values(proven), ...ref.unnamedSlots);

const SRC = fs.readFileSync(path.join(__dirname, '../../webapp/public/saveImport.js'), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.message}`);
    failures++;
  }
}

// Evaluate the shipped resolver itself rather than a re-typed copy of it.
const built = /const INSCRYPTION_SLOT = (\(n\) => \{[\s\S]*?\n {2}\});/.exec(SRC);
if (!built) {
  console.log('FAIL  could not locate INSCRYPTION_SLOT in saveImport.js');
  process.exit(1);
}
const slotOf = vm.runInNewContext(built[1]);

const idsOf = (name) => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(SRC);
  if (!m) throw new Error(`${name} not found in saveImport.js`);
  return m[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
};
const HUNTER_IDS = idsOf('INSCRYPTION_IDS');
const FLEET_IDS = idsOf('FLEET_INSCRYPTION_IDS');
const ALL_IDS = [...HUNTER_IDS, ...FLEET_IDS];

check('resolver matches every slot the game data proves', () => {
  const problems = [];
  for (const [displayed, slot] of Object.entries(proven)) {
    const got = slotOf(Number(displayed));
    if (got !== slot) problems.push(`#${displayed}: resolver says slot ${got}, the game says ${slot}`);
  }
  return problems.length ? problems.join('\n        ') : null;
});

check(`the map is a bijection over all ${REGISTRY_SIZE} registry slots`, () => {
  // This is the check the old +12 rule failed: it is what proves no leveled slot is orphaned
  // and no displayed id is invented.
  const seen = new Map();
  const problems = [];
  for (let n = 1; n <= REGISTRY_SIZE; n += 1) {
    const slot = slotOf(n);
    if (!Number.isInteger(slot) || slot < 1 || slot > REGISTRY_SIZE) {
      problems.push(`#${n} -> ${slot}, outside 1..${REGISTRY_SIZE}`);
      continue;
    }
    if (seen.has(slot)) problems.push(`slot ${slot} claimed by both #${seen.get(slot)} and #${n}`);
    else seen.set(slot, n);
  }
  const orphaned = [];
  for (let s = 1; s <= REGISTRY_SIZE; s += 1) if (!seen.has(s)) orphaned.push(s);
  if (orphaned.length) problems.push(`slots owned by no displayed id: ${orphaned.join(', ')}`);
  return problems.length ? problems.join('\n        ') : null;
});

check('the resolver refuses ids outside the registry instead of inventing a slot', () => {
  for (const bad of [0, -1, REGISTRY_SIZE + 1, 999]) {
    let threw = false;
    try { slotOf(bad); } catch { threw = true; }
    if (!threw) return `#${bad} resolved instead of throwing`;
  }
  return null;
});

check('every id the importer walks resolves into the registry', () => {
  const bad = ALL_IDS.map((n) => [n, slotOf(n)]).filter(([, s]) => s < 1 || s > REGISTRY_SIZE);
  return bad.length
    ? `would import nothing: ${bad.map(([n, s]) => `#${n}->IS${s}`).join(', ')}`
    : null;
});

check('no two imported ids share a slot', () => {
  const seen = new Map();
  const clashes = [];
  for (const n of ALL_IDS) {
    const slot = slotOf(n);
    if (seen.has(slot)) clashes.push(`IS${slot} claimed by both #${seen.get(slot)} and #${n}`);
    else seen.set(slot, n);
  }
  return clashes.length ? clashes.join('\n        ') : null;
});

// Show which ids rest on the bijection argument rather than a scene-proven row name, so the
// distinction stays visible even though both are now trusted.
const derived = ALL_IDS.filter((n) => proven[n] === undefined).sort((a, b) => a - b);
console.log(`\n${ALL_IDS.length - derived.length} of ${ALL_IDS.length} imported ids are proven directly by a scene row name.`);
console.log(`${derived.length} rest on the bijection argument (see the note in saveImport.js): ${derived.join(', ')}`);

console.log(`\n${failures ? `${failures} FAILED` : 'inscryption slot mapping agrees with the game'}`);
process.exit(failures ? 1 : 0);
