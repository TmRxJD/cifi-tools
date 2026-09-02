'use strict';
// Cross-check SHIP_NODE_CATALOG's gates/caps against SirRed's CIFI Ouroboros Helper Tool --
// an independent community optimizer (https://sirred.itch.io/cifi-ouroboros-helper-tool),
// decompiled directly (Assembly-CSharp.dll is plain Mono IL, not IL2CPP, so ILSpy reads it
// straight) rather than transcribed from its UI. tools/reference/sirred-install-slots.json
// holds every InstallEntity's real `maxLevel`/`unlockThreshold`, extracted from the Windows
// build's level0 scene via UnityPy + a TypeTreeGenerator pointed at its Managed/ assemblies
// (see tools/reference/README or the session that produced this file for the exact recipe;
// regenerate by re-running that pipeline against a fresh download if SirRed ships an update).
//
// Two independent numbering schemes meet here: SHIP_NODE_CATALOG's keys 1-11 are the
// COMMUNITY install-code numbers (this project's own header comment says so), and SirRed's own
// installDesignation strings (e.g. "Koi09") use that exact same community numbering -- so this
// is a direct key-for-key comparison, no grid/ruId remapping needed.
//
// `max` in SHIP_NODE_CATALOG is documented as the wiki's BASE cap; SirRed's maxLevel is the
// real reachable cap, which prior confirmed account values already established runs 5x the base
// (see the "300/150/200/750 at 5x" comments already in shipsPage.js). This check verifies that
// multiplier holds everywhere, not just the handful of nodes it was previously spot-checked on.
//
//   node tools/bench/sirred-ship-check.js

const path = require('path');
const H = require('./harness.js');
const slots = require('../reference/sirred-install-slots.json');

const sb = H.browserSandbox();
const CATALOG = sb.ShipData.SHIP_NODE_CATALOG;

const SHIP_PREFIX = { 1: 'Cra', 2: 'Aux', 3: 'Zag', 4: 'Heph', 5: 'Dem', 6: 'Koi', 7: 'Zeus' };
const CAP_MULTIPLIER = 5;

let problems = 0;
let compared = 0;
for (const [shipId, prefix] of Object.entries(SHIP_PREFIX)) {
  const nodes = CATALOG[shipId];
  if (!nodes) { console.log(`ship ${shipId} (${prefix}): not in SHIP_NODE_CATALOG at all`); continue; }
  for (const [code, node] of Object.entries(nodes)) {
    const designation = `${prefix}${String(code).padStart(2, '0')}`;
    const live = slots[designation];
    if (!live) { console.log(`MISSING ${designation}: SirRed's tool has no such slot`); problems++; continue; }
    compared++;
    const expectedMax = node.max * CAP_MULTIPLIER;
    const expectedGate = node.gateAtTotalInstalls || 0;
    if (live.maxLevel !== expectedMax) {
      console.log(`CAP MISMATCH ${designation} ("${node.name}"): ours ${node.max}x${CAP_MULTIPLIER}=${expectedMax}, SirRed ${live.maxLevel}`);
      problems++;
    }
    if (live.unlockThreshold !== expectedGate) {
      console.log(`GATE MISMATCH ${designation} ("${node.name}"): ours ${expectedGate}, SirRed ${live.unlockThreshold}`);
      problems++;
    }
  }
}

console.log(`\ncompared ${compared} install slots across ${Object.keys(SHIP_PREFIX).length} ships`);
if (problems === 0) {
  console.log('every cap and gate matches SirRed\'s community tool exactly (at the documented 5x multiplier)');
  process.exit(0);
} else {
  console.log(`${problems} discrepancy(ies)`);
  process.exit(1);
}
