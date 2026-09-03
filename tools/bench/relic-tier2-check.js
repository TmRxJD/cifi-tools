'use strict';
// Tier-2 relic caps: ours vs the GAME's authored `Relic.baseMaxLevel`.
//
//   node tools/bench/relic-tier2-check.js [live-bundle.js]
//
// WHY THIS IS A GAME CHECK AND NOT A BUNDLE CHECK. This repo's standing rule is that cifi-tools
// is authoritative for anything it models -- but that rule assumes the site speaks with one voice,
// and here it does not. The bundle declares t2r7 TWICE with different caps: its relic planner says
// `maxLevel:40` and its Overrides panel says `maxLevel:100`. t2r7 is one of the handful of relics
// that genuinely moves the simulation, so the difference is not cosmetic -- it is 60 levels of a
// real upgrade either offered or withheld.
//
// The game settles it. `OuroRelics.CheckRelicMaxLevel()` compares the player's level against
// `Relic+0x50`, which dump.cs names as the exponent half of `Relic.baseMaxLevel`, and that field
// reads 40 for T2_07. So our 40 is right, the relic planner is right, and the Overrides panel is
// the original's own bug. We deliberately do NOT mirror that bug: parity with the site's plumbing
// is the goal, but where the site contradicts ITSELF there is no parity to have, and the game is
// the tiebreak. Every other tier-2 relic agrees across all three sources.
//
// If a bundle path is given, that disagreement is re-detected rather than remembered, so a future
// bundle that fixes it stops being reported.

const fs = require('fs');
const H = require('./harness.js');
const ref = require('../reference/relic-tier2.json');

const sb = H.browserSandbox();

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

// --- 1. every tier-2 relic we expose is capped at the game's authored value -------------------
const ours = new Map();
for (const hunter of ['borge', 'ozzy', 'knox']) {
  const relics = (sb.HUNTER_DEFS[hunter].globalUpgrades || {}).relics;
  for (const item of (relics && relics.items) || []) {
    if (!/^t2r\d+$/.test(item.id)) continue;
    const cap = item.maxLevel === undefined || item.maxLevel === null ? null : item.maxLevel;
    const seen = ours.get(item.id);
    if (seen !== undefined && seen !== cap) {
      fail(`${item.id} is declared with two different caps across hunters: ${seen} and ${cap}`);
    }
    ours.set(item.id, cap);
  }
}
if (!ours.size) fail('no tier-2 relics found in HUNTER_DEFS at all -- has the id scheme changed?');

const capProblems = [];
for (const [id, cap] of ours) {
  const authored = ref.relics[id];
  if (!authored) { capProblems.push(`${id}: not in relic-tier2.json (re-run extract-relic-tier2.py)`); continue; }
  if (cap !== authored.maxLevel) capProblems.push(`${id}: ours ${cap}, the game says ${authored.maxLevel}`);
}
if (capProblems.length) capProblems.forEach(fail);
else pass(`all ${ours.size} tier-2 relic cap(s) we expose match the game's authored baseMaxLevel`);

// --- 2. the reference itself is sane -----------------------------------------------------------
// A cap of 0 or a non-integer would mean the BigDouble parse drifted, which is exactly the failure
// mode that produces confident nonsense rather than an error.
const bad = Object.entries(ref.relics)
  .filter(([, r]) => !Number.isInteger(r.maxLevel) || r.maxLevel < 1 || r.maxLevel > 1000);
if (bad.length) fail(`implausible authored cap(s): ${bad.map(([k, r]) => `${k}=${r.maxLevel}`).join(', ')}`);
else pass(`all ${Object.keys(ref.relics).length} authored tier-2 caps are plausible integers`);

// --- 3. re-detect the bundle's self-contradiction ----------------------------------------------
const bundlePath = process.argv[2];
if (!bundlePath) {
  console.log('note  pass a live bundle path to also re-check the site\'s own two tables');
} else {
  const src = fs.readFileSync(bundlePath, 'utf8');
  const conflicts = [];
  for (const id of Object.keys(ref.relics)) {
    const caps = new Set();
    for (const m of src.matchAll(new RegExp(`id:"${id}"[^{}]*?maxLevel:([^,}]+)`, 'g'))) {
      caps.add(m[1].trim() === '1/0' ? Infinity : Number(m[1]));
    }
    if (caps.size > 1) conflicts.push({ id, caps: [...caps], authored: ref.relics[id].maxLevel });
  }
  if (!conflicts.length) {
    pass('the live bundle no longer contradicts itself on any tier-2 relic cap');
  } else {
    conflicts.forEach((c) => {
      const agrees = c.caps.includes(c.authored);
      console.log(`note  the bundle declares ${c.id} as ${c.caps.join(' and ')}; the game says `
        + `${c.authored}${agrees ? ' (one of its tables is right)' : ' -- NEITHER matches the game'}`);
      if (!agrees) fail(`${c.id}: neither of the bundle's caps matches the game -- re-check ours`);
    });
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\ntier-2 relic caps agree with the game');
process.exit(failures ? 1 : 0);
