'use strict';
// Ship install PREREQUISITES and BASE CAPS, checked against the game's own authored data.
//
// Both were transcribed from cifi.fandom.com's per-ship pages. The caps have a bad history: an
// earlier catalog baked in live-captured values that silently mixed base and researched (x5)
// numbers, and Cradle's nodes 8-11 had to be corrected by screenshot afterwards -- at which point
// CLAUDE.md recorded that the other six ships had never had the same check. This is that check,
// against `RU<n><Category>MaxLevel` and `RU<n><Category>Requirement` rather than against a wiki
// page or a screenshot.
//
// The semantics come from the game's own buy method, not from us. `FleetManager.BuyRU4Gen()`:
//
//     if (TotalInstallsCradle >= RU4GenRequirement) {
//         cap = RL.FinalShipRanksMaxLevelBonus * RU4GenMaxLevel;
//         if (MM.RU4GenLevel < cap && MM.Ship1RankPoints > 0) { ...buy... }
//     }
//
// so `gateAtTotalInstalls` is "installs spent on THAT ship", a requirement of 0 means open from
// the start, and `max` is the BASE cap that nodeMaxLevel() multiplies. Our catalog is keyed by the
// community install CODE, and `ruId` maps code -> the game's RU index; that indirection is exactly
// what this check exercises, since Cradle is known to have codes 9 and 11 swapped relative to ruId.
//
//   node tools/bench/ship-node-gate-check.js
//   node tools/bench/ship-node-gate-check.js --verbose
//
// Regenerate the reference with:
//   CIFI_APK=apk-0.7.3.61 python tools/bench/extract-ship-node-gates.py

const H = require('./harness.js');
const GATES = require('../reference/ship-node-gates.json');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY } = sb.ShipData;
const verbose = process.argv.includes('--verbose');

let checked = 0;
let gateMismatch = 0;
let capMismatch = 0;
const rows = [];

for (const [shipIdRaw, nodes] of Object.entries(CATALOG)) {
  const shipId = Number(shipIdRaw);
  const category = SHIP_CATEGORY[shipId];
  const authored = GATES.categories[category];
  if (!authored) { rows.push(`SKIP ship ${shipId}: no authored category ${category}`); continue; }

  for (const [slotRaw, meta] of Object.entries(nodes)) {
    const slot = Number(slotRaw);
    const ruId = meta.ruId;
    if (ruId == null) { rows.push(`SKIP ${category}${slot}: no ruId`); continue; }
    const game = authored[String(ruId)];
    if (!game) { rows.push(`SKIP ${category}${slot}: game has no RU${ruId}${category}`); continue; }

    checked++;
    // A node with no gateAtTotalInstalls is "open from the start", which the game writes as 0.
    const ourGate = meta.gateAtTotalInstalls || 0;
    if (ourGate !== game.requirement) {
      gateMismatch++;
      rows.push(`GATE ${category}${slot} (RU${ruId}) ${String(meta.name).slice(0, 28).padEnd(28)}`
        + ` ours=${ourGate} game=${game.requirement}`);
    }
    if (meta.max !== game.maxLevel) {
      capMismatch++;
      rows.push(`CAP  ${category}${slot} (RU${ruId}) ${String(meta.name).slice(0, 28).padEnd(28)}`
        + ` ours=${meta.max} game=${game.maxLevel}`);
    }
    if (verbose) {
      rows.push(`ok   ${category}${slot} (RU${ruId}) gate=${game.requirement} cap=${game.maxLevel}`);
    }
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nchecked ${checked} ship install node(s) against the game's authored gates and caps`);
if (gateMismatch || capMismatch) {
  console.log(`${gateMismatch} gate mismatch(es), ${capMismatch} cap mismatch(es)`);
  console.log('A wrong gate lets the optimizer spend into a node the account cannot buy; a wrong '
    + 'base cap scales straight through nodeMaxLevel into every allocation decision.');
  process.exit(1);
}
console.log('every install gate and base cap matches the game');
