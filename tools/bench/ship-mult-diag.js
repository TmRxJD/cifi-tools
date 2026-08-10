'use strict';
const H = require('./harness.js');
const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CAT, GEN_TIERS } = sb.ShipData;
const store = sb.StoreSchema.freshStore();
sb.window.store = store;
Object.keys(CAT).forEach((id) => { store.shipInputs[id] = { ...sb.defaultShipInput(Number(id)), rank: 20, crew: 12 }; });
GEN_TIERS.forEach((n) => { store.unlockedGens[n] = n <= 8; });

const research = sb.computeFleetResearchShipMultipliers();
const badge = sb.computeFleetBadgeMultipliers();
const boosts = sb.computeFleetBoostTotals();
for (const id of [1, 3, 5]) {
  const slot = '1';
  const meta = CAT[id][slot];
  const gear = sb.getShipGear();
  console.log(`ship ${id} slot ${slot}`);
  console.log(`   gearKey            = ${JSON.stringify(meta.gearKey)}`);
  console.log(`   crew(input)        = ${sb.getShipInput(id).crew}`);
  console.log(`   crew(boost)        = ${boosts[id]?.crew ?? 0}`);
  console.log(`   gearMultiplierFor  = ${sb.gearMultiplierFor(meta.gearKey, gear)}`);
  console.log(`   researchMult       = ${research[id]}`);
  console.log(`   badgeMult          = ${badge[id]}`);
  console.log(`   gearNodeMult       = ${sb.computeGearNodeMultiplier(Number(id), Number(slot))}`);
  console.log(`   => increment       = ${sb.nodeLinearIncrement(id, slot)}`);
}
