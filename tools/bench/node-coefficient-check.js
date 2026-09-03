'use strict';
// Every ship install node's per-level percentage, checked against the GAME'S OWN AUTHORED VALUE.
//
// Until now those percentages came from cifi.fandom.com and were only ever spot-checked -- and the
// wiki has been wrong before on this exact data (see SHIP_NODE_CATALOG's own comments: a 10x
// transcription error on Demeter node 6, another on node 9, and several understated caps). There
// was no way to check the whole catalog at once, because IL2CPP strips Unity's type trees and the
// values sit in serialized MonoBehaviour bytes with no field names attached.
//
// tools/il2cpp-cli/typetree.py reconstructs those type trees, which turns the FleetManager
// MonoBehaviour back into named fields -- `RU<n><Category>BaseBonus`, the authored per-level
// coefficient for install node <n> of the ship owning that category. Extracted into
// tools/reference/ship-node-coefficients.json; regenerate with that script.
//
// A node's coefficient is a FRACTION there (0.05) and a PERCENT in the catalog ("+5% MK1 output"),
// hence the x100. Comparison is on the ratio rather than an absolute epsilon because the values
// span five orders of magnitude (0.10 down to 0.00005), and they are float32 in the build so an
// exact === would fail on representation alone (0.05 reads back as 0.05000000074505806).
//
//   node tools/bench/node-coefficient-check.js
//   node tools/bench/node-coefficient-check.js --verbose

const path = require('path');
const H = require('./harness.js');

const COEFFS = require('../reference/ship-node-coefficients.json');
const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY } = sb.ShipData;

const verbose = process.argv.includes('--verbose');
const TOLERANCE = 1e-4;          // float32 round-trip only; a real mismatch is orders of magnitude

/** The leading percentage in a node's effect text -- the same one nodeLinearIncrement parses. */
function catalogPct(effect) {
  const m = String(effect || '').match(/([\d.]+)\s*%/);
  return m ? Number(m[1]) : null;
}

let checked = 0;
let mismatches = 0;
let unmapped = 0;
const rows = [];

for (const shipId of Object.keys(CATALOG).map(Number).sort((a, b) => a - b)) {
  const category = SHIP_CATEGORY[shipId];
  const authored = COEFFS.baseBonusByCategory[category];
  if (!authored) {
    console.log(`SKIP ship ${shipId}: no authored data for category ${category}`);
    continue;
  }
  for (const [slot, meta] of Object.entries(CATALOG[shipId])) {
    // ruId is how the catalog already maps a display slot to the game's RU index; several ships
    // are NOT identity (Cradle slot 9 is RU11), which is exactly why this check is worth running.
    const ruId = meta.ruId;
    const pct = catalogPct(meta.effect);
    if (ruId == null || pct == null) {
      unmapped++;
      if (verbose) {
        console.log(`  skip ship ${shipId} slot ${slot} (${meta.name}): `
          + `${ruId == null ? 'no ruId' : 'no % in effect text'}`);
      }
      continue;
    }
    const raw = authored[String(ruId)];
    if (raw == null) {
      unmapped++;
      if (verbose) console.log(`  skip ship ${shipId} slot ${slot}: no RU${ruId}${category}BaseBonus`);
      continue;
    }
    checked++;
    const authoredPct = raw * 100;
    const off = authoredPct === 0 ? (pct === 0 ? 0 : 1) : Math.abs(pct - authoredPct) / authoredPct;
    const ok = off <= TOLERANCE;
    if (!ok) mismatches++;
    if (!ok || verbose) {
      rows.push(`${ok ? 'ok  ' : 'DIFF'} ship ${shipId} slot ${slot.padStart(2)} RU${String(ruId).padStart(2)}`
        + ` ${String(meta.name).slice(0, 30).padEnd(30)} catalog ${String(pct).padEnd(9)}`
        + ` authored ${authoredPct.toPrecision(6)}`);
    }
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nchecked ${checked} node coefficient(s) against authored game data; `
  + `${unmapped} not comparable (no ruId or no % in the effect text)`);
if (mismatches) {
  console.log(`${mismatches} MISMATCH(ES) -- the catalog disagrees with the build`);
  process.exit(1);
}
console.log('every comparable node coefficient matches the game');
