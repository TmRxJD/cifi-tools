'use strict';
// Do our upgrade items carry the same CAP and the same CONTROL TYPE as the live tool's?
//
//   node tools/bench/upgrade-item-parity.js <live-bundle.js>
//
// live-override-diff.js already checks WHICH keys each hunter's Overrides panel offers. This
// checks what each of those keys IS: its maxLevel, and whether it is a boolean (a checkbox) or a
// level (a number input). A cap that is too low withholds real upgrade levels; a cap that is too
// high offers levels the account can never buy; a boolean rendered as a number is a control that
// does not behave like the original's. None of those change the key set, so none of them are
// visible to the existing bench -- and the t2r7 cap disagreement this found had been shipping.
//
// FETCH THE WHOLE BUNDLE, NOT JUST index-*.js. cifi-tools is code-split: several upgrade families
// load as their own chunks. Concatenate the main bundle with every `./Name-hash.js` it references
// before running this, or items that live in a chunk read as "not declared" and a clean parity
// result gets reported as a pile of gaps.
//
// AND DO NOT READ A PAGE TABLE AS THE OVERRIDES PANEL. The same id can appear twice in the bundle
// with different data because the two objects describe different surfaces -- a dedicated page and
// the Overrides panel. `mats_exchange` is the trap: its PAGE lists three EDC items (Torkinstone,
// Pytoxene, Gigantium) while the OVERRIDES panel offers the single key
// `upgrades.mats_exchange.tysconDrives`, which is what we mirror. Comparing our panel against its
// page reports three missing items and one invented one, all of them false. This bench therefore
// only compares ids we actually expose, and treats a duplicate declaration as a question about the
// bundle rather than an answer about us.

const fs = require('fs');
const H = require('./harness.js');

const bundlePath = process.argv[2];
if (!bundlePath) { console.error('usage: upgrade-item-parity.js <live-bundle.js>'); process.exit(2); }
const src = fs.readFileSync(bundlePath, 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

/** The object literal starting at `start`, brace-aware so nested stats/tiers survive. */
function objectAt(start) {
  let depth = 0; let inStr = false; let esc = false; let q = '';
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** Only the object's OWN fields: collapse nested objects/arrays so `tiers:[{level:0,...}]` cannot
 *  contribute a `maxLevel`. Slice the outer braces off first -- collapsing them too reduces the
 *  whole object to a placeholder and every field silently reads as absent. */
function ownFields(obj) {
  let flat = obj.slice(1, -1);
  let prev;
  do {
    prev = flat;
    flat = flat.replace(/\{[^{}]*\}/g, '@').replace(/\[[^[\]]*\]/g, '@');
  } while (flat !== prev);
  return flat;
}

const live = new Map();
for (const m of src.matchAll(/\{id:"([A-Za-z0-9_]+)",(?:tier:\d+,)?(?:unlock_gem:"[a-z]+",unlock_lvl:\d+,)?name:"/g)) {
  const obj = objectAt(m.index);
  if (!obj || obj.length > 20000) continue;
  const flat = ownFields(obj);
  const max = /maxLevel:([^,}]+)/.exec(flat);
  const type = /(?:^|,)type:"([a-z]+)"/.exec(flat);
  const rec = {
    // `1/0` is how the minifier writes Infinity.
    maxLevel: max ? (max[1].trim() === '1/0' ? Infinity : Number(max[1])) : undefined,
    type: type ? type[1] : undefined,
  };
  if (!live.has(m[1])) live.set(m[1], []);
  live.get(m[1]).push(rec);
}
if (live.size < 50) fail(`only ${live.size} item objects parsed out of the bundle -- did its shape change?`);

const sb = H.browserSandbox();

const capMismatch = [];
const typeMismatch = [];
const unboundedMismatch = [];
const selfConflict = [];
const undeclared = [];
let compared = 0;

for (const hunter of ['borge', 'ozzy', 'knox']) {
  for (const [cat, group] of Object.entries(sb.HUNTER_DEFS[hunter].globalUpgrades || {})) {
    for (const item of group.items || []) {
      const recs = live.get(item.id);
      if (!recs) { undeclared.push(`${cat}.${item.id}`); continue; }
      compared++;
      const ourMax = (item.maxLevel === undefined || item.maxLevel === null) ? Infinity : item.maxLevel;
      const caps = [...new Set(recs.map((r) => r.maxLevel))];
      const declared = caps.filter((c) => c !== undefined);
      const types = [...new Set(recs.map((r) => r.type).filter(Boolean))];

      if (declared.length > 1) {
        // The bundle disagreeing with itself is not something we can be in parity with. Report it
        // and let the game-sourced bench (relic-tier2-check.js for the known case) arbitrate.
        selfConflict.push(`${cat}.${item.id}: bundle declares maxLevel ${declared.join(' and ')}; ours ${ourMax}`);
      } else if (declared.length === 1) {
        if (ourMax !== declared[0]) capMismatch.push(`${cat}.${item.id}: ours ${ourMax}, live ${declared[0]}`);
      } else if (types.length === 1) {
        // No maxLevel at all is a real state, not missing data: a boolean is on/off (we encode
        // that as a cap of 1) and a level with no cap is unbounded.
        const want = types[0] === 'boolean' ? 1 : Infinity;
        if (ourMax !== want) {
          unboundedMismatch.push(`${cat}.${item.id}: live declares no cap on a "${types[0]}" `
            + `(expected ${want}), ours ${ourMax}`);
        }
      }

      if (types.length === 1) {
        const liveBoolean = types[0] === 'boolean';
        const ourBoolean = ourMax === 1;
        if (liveBoolean !== ourBoolean) {
          typeMismatch.push(`${cat}.${item.id}: live type "${types[0]}", ours renders as `
            + `${ourBoolean ? 'a boolean' : 'a level'} (maxLevel ${ourMax})`);
        }
      }
    }
  }
}

if (!compared) fail('compared no items at all -- the bundle parse or HUNTER_DEFS shape changed');
else pass(`compared ${compared} item declarations across three hunters`);

const report = (label, list, isFailure) => {
  const unique = [...new Set(list)];
  if (!unique.length) { pass(`no ${label}`); return; }
  unique.forEach((s) => (isFailure ? fail(s) : console.log(`note  ${s}`)));
};
report('cap mismatches', capMismatch, true);
report('control-type mismatches', typeMismatch, true);
report('uncapped-item mismatches', unboundedMismatch, true);

// Not a failure: an id we expose that the bundle declares only as an override KEY (no item object)
// is the normal shape for families the site renders on their own page.
if (undeclared.length) {
  console.log(`note  ${new Set(undeclared).size} id(s) carry no item object in the bundle `
    + `(declared as override keys only): ${[...new Set(undeclared)].join(', ')}`);
}
if (selfConflict.length) {
  [...new Set(selfConflict)].forEach((s) => console.log(`note  ${s}`));
  console.log('note  a self-conflict is arbitrated against the GAME, not the bundle -- see relic-tier2-check.js');
}

console.log(failures ? `\n${failures} failure(s)` : '\nevery upgrade item matches the live tool\'s cap and control type');
process.exit(failures ? 1 : 0);
