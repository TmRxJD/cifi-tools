'use strict';
// Every install node's displayed NAME, checked against the game's own fleet tooltips.
//
// Name was the last field of a node that came from cifi.fandom.com rather than the game -- the
// coefficient, gate, base cap and "per X" counter are each verified by their own bench. It matters
// less than those for the math and more for trust: a node labelled with the wrong name is a plan
// the player cannot follow.
//
// KEYED BY ruId, NOT BY SLOT. The scene's `Tooltip<N>` index is the node's ruId, while our catalog
// is keyed by the community install code, and the two differ on six of seven ships. Indexing by
// slot reports 15 false mismatches. The key is not assumed: Cradle's ruIds 9/10/11 carry three
// distinct authored coefficients, which pins each node independently of any name, and the titles
// agree with that pinning.
//
// Regenerate with:
//   CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-names.py
//
//   node tools/bench/node-name-check.js [--verbose]

const H = require('./harness.js');
const REF = require('../reference/ship-node-names.json');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();
const { SHIP_NODE_CATALOG: CATALOG } = sb.ShipData;
const verbose = process.argv.includes('--verbose');

// Our ship ids -> the scene's UpgradePanel names.
const PANEL = {
  1: 'TheCradle', 2: 'TheAuxesia', 3: 'TheZagreus', 4: 'TheHephaestus',
  5: 'TheDemeter', 6: 'TheKoios', 7: 'TheZeus',
};
const norm = (s) => String(s).toUpperCase().replace(/\s+/g, ' ').trim();

let checked = 0;
let bad = 0;
const rows = [];

for (const [shipIdRaw, nodes] of Object.entries(CATALOG)) {
  const shipId = Number(shipIdRaw);
  const panel = REF.panels[PANEL[shipId]];
  if (!panel) { rows.push(`SKIP ship ${shipId}: no panel ${PANEL[shipId]}`); continue; }
  for (const [slot, meta] of Object.entries(nodes)) {
    const entry = panel[String(meta.ruId)];
    const title = entry && entry.Title;
    if (!title) { rows.push(`SKIP ship ${shipId} slot ${slot}: no tooltip for ruId ${meta.ruId}`); continue; }
    checked++;
    if (norm(title) !== norm(meta.name)) {
      bad++;
      rows.push(`DIFF ship ${shipId} slot ${slot} (ruId ${meta.ruId}): ours="${meta.name}" game="${title}"`);
    } else if (verbose) {
      rows.push(`ok   ship ${shipId} slot ${slot} (ruId ${meta.ruId}): ${meta.name}`);
    }
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nchecked ${checked} node name(s) against the game's fleet tooltips`);
if (bad) {
  console.log(`${bad} mismatch(es)`);
  process.exit(1);
}
console.log('every node name matches the game');
