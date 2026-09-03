'use strict';
// Do our talents, attributes and base-stat caps match the live tool's, per hunter?
//
//   node tools/bench/talent-attribute-parity.js <live-bundle.js>
//
// These are the inputs the OPTIMIZER spends its budget on, so an error here is not a display bug:
// a cap that is too low makes a legal allocation unreachable, a cap that is too high makes the
// optimizer recommend a build the account cannot actually create, and a wrong point cost silently
// changes how much budget every level buys. `scene-defs-test.js` already checks caps and costs
// against the GAME's own authored data, which is the stronger source; this checks the same fields
// against the tool we are cloning, so a divergence between the two sources shows up as a
// disagreement here rather than as a quiet difference in results.
//
// THE ARRAYS ARE MATCHED BY CONTENT, NOT BY POSITION OR NAME. The bundle is minified: Borge's
// talent list is `eD=[...]` while Ozzy's and Knox's are `TALENTS:[...]`, so there is no stable
// name to key on, and the order the three hunters appear in is an implementation detail. Each
// bundle array is therefore matched to the hunter whose own id set it overlaps most, and an
// ambiguous or weak match FAILS rather than guessing -- picking the wrong array would compare
// Ozzy's caps against Borge's and report a pile of mismatches that are really a mis-join.
//
// This matters because several ids are SHARED between hunters with different values -- `pog`
// ("Presence Of A God") caps at 15 for one hunter and 10 for another, and `omen` is "The Omen Of
// Defeat" for one and "The Omen Of Decay" for another. A first-wins global map of id -> row, which
// is the obvious way to write this, reports both of those as our errors. They are not; they are
// per-hunter values that a global map cannot represent.

const fs = require('fs');
const H = require('./harness.js');

const bundlePath = process.argv[2];
if (!bundlePath) { console.error('usage: talent-attribute-parity.js <live-bundle.js>'); process.exit(2); }
const src = fs.readFileSync(bundlePath, 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

// Every `[{key,label,max[,cost]}, ...]` array in the bundle, kept whole.
const arrays = [];
for (const m of src.matchAll(/\[\{key:"[A-Za-z0-9_]+",label:"(?:[^"\\]|\\.)*",max:/g)) {
  // Walk to the matching close bracket, string-aware.
  let depth = 0; let inStr = false; let esc = false; let q = '';
  let end = -1;
  for (let i = m.index; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) continue;
  const body = src.slice(m.index, end + 1);
  const rows = new Map();
  // Deliberately NOT anchored on the row's closing brace. Borge's `ll` (Call Me Lucky Loot) is the
  // one row in the whole bundle carrying a `getMaxValue` function, and that function body contains
  // braces -- so a regex requiring a brace-free tail to the row silently drops it, and dropping one
  // id makes the whole hunter's array fail to match. The failure then reads as "the bundle changed
  // shape" rather than "the regex cannot see one row".
  //
  // `max` here is the BASE cap, which is what we store; getMaxValue is the dynamic raise, and this
  // bench deliberately compares the base against the base.
  for (const r of body.matchAll(/\{key:"([A-Za-z0-9_]+)",label:"((?:[^"\\]|\\.)*)",max:([^,}]+)(?:,cost:(\d+))?/g)) {
    rows.set(r[1], {
      label: r[2],
      max: r[3].trim() === '1/0' ? Infinity : Number(r[3]),
      cost: r[4] === undefined ? undefined : Number(r[4]),
    });
  }
  if (rows.size) arrays.push(rows);
}
if (arrays.length < 6) fail(`only ${arrays.length} keyed arrays parsed from the bundle -- shape changed?`);

/** The bundle array that best matches `ids`, or null if the match is ambiguous or weak. */
function matchArray(ids) {
  const scored = arrays
    .map((rows) => ({ rows, hit: ids.filter((id) => rows.has(id)).length }))
    .filter((s) => s.hit > 0)
    .sort((a, b) => b.hit - a.hit);
  if (!scored.length) return null;
  // Require a decisive winner: full coverage, and strictly better than anything else.
  if (scored[0].hit < ids.length) return null;
  if (scored.length > 1 && scored[1].hit === scored[0].hit && scored[1].rows.size !== scored[0].rows.size) {
    return null;
  }
  return scored[0].rows;
}

const sb = H.browserSandbox();
const labelBad = []; const maxBad = []; const costBad = []; const capBad = [];
let compared = 0;

for (const hunter of ['borge', 'ozzy', 'knox']) {
  const defs = sb.HUNTER_DEFS[hunter];
  for (const kind of ['talents', 'attributes']) {
    const items = defs[kind] || [];
    if (!items.length) { fail(`${hunter}.${kind} is empty in HUNTER_DEFS`); continue; }
    const rows = matchArray(items.map((i) => i.id));
    if (!rows) {
      fail(`${hunter}.${kind}: no unambiguous bundle array covers all ${items.length} ids`);
      continue;
    }
    for (const item of items) {
      const l = rows.get(item.id);
      compared++;
      const ourMax = item.maxLevel === null || item.maxLevel === undefined ? Infinity : item.maxLevel;
      if (l.label !== item.label) {
        labelBad.push(`${hunter}.${kind}.${item.id}: ours "${item.label}", live "${l.label}"`);
      }
      if (l.max !== ourMax) {
        maxBad.push(`${hunter}.${kind}.${item.id}: ours max ${ourMax}, live ${l.max}`);
      }
      // A row with no `cost` costs one point; that is the bundle's own default, not an assumption.
      const ourCost = item.cost === undefined ? 1 : item.cost;
      const liveCost = l.cost === undefined ? 1 : l.cost;
      if (ourCost !== liveCost) {
        costBad.push(`${hunter}.${kind}.${item.id}: ours cost ${ourCost}, live ${liveCost}`);
      }
    }
  }

  // Base-stat caps. `dr` and `evade` genuinely differ per hunter (40/70/50), which is exactly why
  // this is inside the per-hunter loop and matched the same content-first way.
  const caps = defs.statCaps || {};
  const statIds = Object.keys(caps);
  if (statIds.length) {
    const rows = matchArray(statIds);
    if (!rows) {
      fail(`${hunter}: no unambiguous bundle array covers its ${statIds.length} base stats`);
    } else {
      for (const id of statIds) {
        compared++;
        const ours = caps[id] === null || caps[id] === undefined ? Infinity : caps[id];
        if (rows.get(id).max !== ours) {
          capBad.push(`${hunter}.statCaps.${id}: ours ${ours}, live ${rows.get(id).max}`);
        }
      }
    }
  }
}

if (!compared) fail('compared nothing at all');
else pass(`compared ${compared} talent, attribute and base-stat rows across three hunters`);

const report = (label, list) => {
  const u = [...new Set(list)];
  if (!u.length) { pass(`every ${label} matches`); return; }
  u.forEach(fail);
};
report('label', labelBad);
report('cap', maxBad);
report('point cost', costBad);
report('base-stat cap', capBad);

// NOTE ON `ultima`, because an earlier draft of this bench skipped it on a false premise. It IS a
// keyed row in all three of the bundle's talent arrays, so it is compared like everything else.
// What we genuinely do not model is a DIFFERENT thing: the game has a 9th Knox talent (the Ultima
// signature) that params.json exposes no argument for, so wiring it would create an input reaching
// nothing. Skipping a row here on the strength of that unrelated fact would have hidden a real
// comparison behind a true-sounding comment.

console.log(failures ? `\n${failures} failure(s)` : '\nevery talent, attribute and base-stat cap matches the live tool');
process.exit(failures ? 1 : 0);
