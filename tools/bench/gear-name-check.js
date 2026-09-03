'use strict';
// Gear piece NAMES and SET BONUSES, checked against the game itself.
//
// Both were wiki transcriptions that had never been verified, and both were wrong in ways that are
// invisible from inside the tool:
//
//   * three names were misspelled ("Gamma Round" for GAMMA ROUNDS, "Chrysis Suit" for CRYSIS SUIT,
//     "Cell Based Loop Tank" for CELL BASED LOOP-TANK);
//   * the White set was missing entirely, and its bonuses cannot be guessed -- the game's own
//     `CheckWhiteSetBonusTexts()` refreshes the Cells/RP/Shards/AP labels, which looks like the
//     answer, while the actual aggregator puts White on Mod Points and not on Research Points.
//
// Two references, regenerated from the game:
//   python tools/bench/extract-gear-names.py       -> tools/reference/gear-names.json
//   python tools/bench/extract-gear-set-bonuses.py -> tools/reference/gear-set-bonus-map.json
//
//   node tools/bench/gear-name-check.js
//
// The name check leans on a structural fact rather than on fuzzy matching: the crafting menu's 37
// rows are the pieces in order, and the first 22 are our five colours at sizes 3/4/5/5/5. If that
// block alignment ever stops holding, the mapping under it is not trustworthy and this fails.

const H = require('./harness.js');
const NAMES = require('../reference/gear-names.json');
const BONUS = require('../reference/gear-set-bonus-map.json');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();
const pieces = sb.getGearSets().pieces;

let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

// --- names, by menu row order -------------------------------------------------------------
const rows = NAMES.rows;
if (rows.length < pieces.length) {
  fail(`the menu lists ${rows.length} rows but we model ${pieces.length} pieces`);
}
pieces.forEach((piece, i) => {
  const row = rows[i];
  if (!row) { fail(`no menu row for piece ${i} (${piece.name})`); return; }
  if (row.name.toUpperCase() !== piece.name.toUpperCase()) {
    fail(`piece ${i}: we call it ${JSON.stringify(piece.name)}, the game calls it `
      + `${JSON.stringify(row.name)}`);
  }
});

// --- set bonuses: resource AND magnitude ---------------------------------------------------
// Our pieces are ordered within a colour and the game's <Color>SetBonus<N> uses that same index.
const indexInColor = {};
pieces.forEach((piece) => {
  const n = (indexInColor[piece.color] = (indexInColor[piece.color] || 0) + 1);
  const entry = BONUS.mappings.find((m) => m.color === piece.color && m.index === n);
  if (!entry) {
    // Not every bonus is a multiplier on one of the five resource totals, so absence from the
    // aggregator is not an error. Orange piece 2 awards "3000 Diamonds" -- a one-off grant with no
    // total to feed. What we CAN still check is the magnitude against the authored value.
    const authored = (BONUS.unusedBonuses || []).find((u) => u.name === `${piece.color}SetBonus${n}`);
    if (!authored) { fail(`${piece.name}: ${piece.color}SetBonus${n} exists in neither map`); return; }
    if (/\bGained$/i.test(piece.setBonus || '')) {
      fail(`${piece.name}: we describe ${JSON.stringify(piece.setBonus)} as a resource multiplier, `
        + `but ${piece.color}SetBonus${n} feeds no resource total`);
      return;
    }
    const num = String(piece.setBonus || '').match(/([\d.]+(?:e[+-]?\d+)?)/i);
    if (!num) { fail(`${piece.name}: no number in ${JSON.stringify(piece.setBonus)}`); return; }
    if (!(Math.abs(parseFloat(num[1]) - authored.value) <= Math.abs(authored.value) * 1e-9)) {
      fail(`${piece.name}: we show ${num[1]}, the game authored ${authored.value}`);
    }
    return;
  }
  const m = String(piece.setBonus || '').match(/^x([\d.]+(?:e[+-]?\d+)?)\s+(.+?)\s+Gained$/i);
  if (!m) { fail(`${piece.name}: unparseable set bonus ${JSON.stringify(piece.setBonus)}`); return; }
  if (m[2].toLowerCase() !== entry.resourceLabel.toLowerCase()) {
    fail(`${piece.name}: we apply it to ${m[2]}, the game applies it to ${entry.resourceLabel}`);
  }
  const ours = parseFloat(m[1]);
  // Relative comparison: the values span 1.5 to 1e65, so an absolute epsilon is meaningless.
  if (!(Math.abs(ours - entry.value) <= Math.abs(entry.value) * 1e-9)) {
    fail(`${piece.name}: we show x${m[1]}, the game authored x${entry.value}`);
  }
});

// --- the colour-size structure the name mapping rests on -----------------------------------
const sizes = {};
pieces.forEach((p) => { sizes[p.color] = (sizes[p.color] || 0) + 1; });
const EXPECTED = { Purple: 3, Orange: 4, Red: 5, Green: 5, Blue: 5, White: 5 };
Object.entries(EXPECTED).forEach(([color, n]) => {
  if (sizes[color] !== n) fail(`${color} has ${sizes[color]} piece(s), expected ${n}`);
});

console.log(`\nchecked ${pieces.length} gear piece name(s) and set bonus(es) against the game`);
if (BONUS.unusedBonuses && BONUS.unusedBonuses.length) {
  console.log(`note: ${BONUS.unusedBonuses.length} authored bonus(es) feed no resource total `
    + `(${BONUS.unusedBonuses.map((u) => u.name).join(', ')}) -- Yellow and Black are gem-gated `
    + 'sets we do not model, and OrangeSetBonus2 is a one-off Diamonds grant');
}
if (failures) {
  console.log(`${failures} MISMATCH(ES)`);
  process.exit(1);
}
console.log('every piece name and set bonus matches the game');
