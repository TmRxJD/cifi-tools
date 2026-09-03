'use strict';
// Which install node each gear piece buffs, checked against the GAME'S OWN dispatch.
//
// This is the gear mapping the optimizer is most sensitive to. Every other multiplier found so far
// -- badges, Fleet Analysis, PowerGU1, the all-ships installs bonus, evolution -- is UNIFORM across
// a ship's nodes, so it scales all candidates equally and cannot reorder them. Gear is the
// exception: `computeGearNodeMultiplier` applies to ONE node, and it is exponential in the piece's
// level (`Gear::get_<Color>Item<N>Bonus<M>` tail-calls `BigDouble.Pow(base, level)`, base 1.01 for
// install1 and 1.02 for install2). A level-913 piece is worth ~8819x on its target node. Point it
// at the wrong node and the optimizer confidently pours points into the wrong place.
//
// Until now that mapping came from cifi.fandom.com's Gear Sets page and had never been checked.
// The game states it directly: each `RU<Category><n>Bonus` property multiplies in the specific
// `Gear.<Color>Item<N>Bonus<M>` that targets it. tools/reference/gear-install-map.json is that
// dispatch, extracted from the recovered C#; regenerate with
// `python tools/bench/extract-gear-installs.py`.
//
//   node tools/bench/gear-install-check.js
//   node tools/bench/gear-install-check.js --verbose
//
// Bonus1 is the piece's install1 target and Bonus2 its install2 -- consistent with the x1.01 /
// x1.02 split the wiki documents and the binary confirms.

const H = require('./harness.js');
const MAP = require('../reference/gear-install-map.json');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY } = sb.ShipData;
const verbose = process.argv.includes('--verbose');

// category -> shipId, inverted from the catalog's own table so it cannot drift.
const SHIP_FOR_CATEGORY = {};
Object.entries(SHIP_CATEGORY).forEach(([shipId, cat]) => { SHIP_FOR_CATEGORY[cat] = Number(shipId); });

// Our pieces are ordered within a colour; the game names them <Color>Item<N> in that same order.
const pieces = sb.getGearSets().pieces;
const byColorIndex = {};
pieces.forEach((p) => {
  const list = (byColorIndex[p.color] = byColorIndex[p.color] || []);
  list.push(p);
});

/** "CRA1" -> {shipId, slot}. shipsPage's own parser returns {ship, code}; normalise it. */
function parseInstallCode(code) {
  const parsed = sb.parseInstallCode ? sb.parseInstallCode(code) : null;
  if (parsed && parsed.ship) return { shipId: parsed.ship, slot: parsed.code };
  const m = String(code || '').match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  const prefix = { CRA: 1, AUX: 2, ZAG: 3, HEP: 4, HEPH: 4, DEM: 5, KOI: 6, ZEUS: 7 }[m[1]];
  return prefix ? { shipId: prefix, slot: Number(m[2]) } : null;
}

/** The catalog slot whose ruId is the game's node number (slot != ruId on several ships). */
function slotForRuId(shipId, ruId) {
  const nodes = CATALOG[shipId] || {};
  for (const [slot, meta] of Object.entries(nodes)) {
    if (Number(meta.ruId) === Number(ruId)) return Number(slot);
  }
  return null;
}

let checked = 0;
let mismatches = 0;
const rows = [];

for (const entry of MAP.mappings) {
  const { category, node, color, item, bonus } = entry;
  const shipId = SHIP_FOR_CATEGORY[category];
  if (!shipId) { rows.push(`SKIP ${category} node ${node}: no ship owns that category`); continue; }
  const ourSlot = slotForRuId(shipId, node);
  if (ourSlot == null) {
    // The game has 13 slots per category; our catalog only models the ones the wiki documented.
    rows.push(`SKIP ${category} node ${node}: not in our catalog for ship ${shipId}`);
    continue;
  }
  const list = byColorIndex[color] || [];
  const piece = list[item - 1];
  if (!piece) { rows.push(`SKIP ${color}Item${item}: we model only ${list.length} ${color} pieces`); continue; }

  const code = bonus === 1 ? piece.install1 : piece.install2;
  const target = parseInstallCode(code);
  checked++;
  const ok = target && target.shipId === shipId && target.slot === ourSlot;
  if (!ok) mismatches++;
  if (!ok || verbose) {
    rows.push(`${ok ? 'ok  ' : 'DIFF'} ${color}Item${item}Bonus${bonus} ${String(piece.name).slice(0, 24).padEnd(24)}`
      + ` game=${category} node ${node} (ship ${shipId} slot ${ourSlot})`
      + `  tool=${code}${target ? ` (ship ${target.shipId} slot ${target.slot})` : ' UNPARSEABLE'}`);
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nchecked ${checked} gear->install mapping(s) against the game's own dispatch`);
if (mismatches) {
  console.log(`${mismatches} MISMATCH(ES) -- a gear piece buffs a different node than we think, `
    + 'which directly misdirects the optimizer');
  process.exit(1);
}
console.log('every checked gear->install mapping matches the game');
