'use strict';
// Does EVERY install node actually change the tool's output when you buy it?
//
// The hunter side has this check already (`relic-arg-probe.js` / `relic-sweep.js`), and it earned
// its keep: it found four relics that reach the evaluator and move nothing, which the tool must
// never recommend spending on. The fleet side had no equivalent, so a node could be perfectly
// verified against the game -- right name, coefficient, gate, cap and counter -- and still be a
// dead input here if its effect text failed to parse, its resource tag were unrecognised, or its
// counter were missing from the fixture. Verified-and-inert is the failure this catches.
//
// Two things are probed per node, on a fixture where every "per X" counter is non-zero:
//   1. its own bonus percentage moves when the level does (nodeOwnBonusPct), and
//   2. that shows up in the ship's resource totals (computeResourceBonuses), on at least one
//      resource -- i.e. the effect's tags actually route somewhere.
//
//   node tools/bench/node-effect-probe.js [--verbose]

const H = require('./harness.js');

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, GEN_TIERS } = sb.ShipData;
const verbose = process.argv.includes('--verbose');

const store = sb.StoreSchema.freshStore();
sb.window.store = store;
Object.keys(CATALOG).map(Number).forEach((id) => {
  store.shipInputs[id] = { ...sb.defaultShipInput(id), rank: 20, crew: 12 };
});
GEN_TIERS.forEach((n) => { store.unlockedGens[n] = true; });
// Every counter non-zero: a zero counter legitimately makes a node inert, and that case is
// covered by growth-counter-check. Here we want to know the node works when its inputs are real.
Object.assign(store.shipGear, {
  manualMK2Gens: 40, manualMK3Gens: 30, totalManualGens: 120,
  techUpgrades: 25, hardwareUpgrades: 15, softwareUpgrades: 15,
  loopModsOwned: 35, loopFillsThisRun: 8, loopResetsDone: 12,
  automationsUnlocked: 6, ticksThisLoop: 500, operationsCompleted: 60,
  studiesThisLR: 20, researchLevels: 40, totalCompletedResearch: 25,
  missionsCompleted: 75, meltdown: 1,
});

let checked = 0;
let dead = 0;
const rows = [];

for (const [shipIdRaw, nodes] of Object.entries(CATALOG)) {
  const shipId = Number(shipIdRaw);
  for (const [slot, meta] of Object.entries(nodes)) {
    checked++;
    const at = (lvl) => sb.nodeOwnBonusPct(shipId, slot, lvl);
    const pct0 = at(0);
    const pct1 = at(1);
    const pctMoves = Number.isFinite(pct1) && pct1 !== pct0;

    // A node with no percentage in its effect is an AMPLIFIER, not a direct multiplier: Demeter's
    // Ahead Of The Curve grants operations, which is the counter this ship's other nodes scale
    // with. Probing it alone would always read "inert" -- there is nothing to amplify -- so it is
    // probed alongside a node that uses the counter it feeds. Every node must move the output
    // either directly or in combination; neither kind gets a free pass.
    const amplifier = !/%/.test(meta.effect || '');
    let companion = null;
    if (amplifier) {
      companion = Object.keys(nodes).find((s) => s !== slot && /%/.test(nodes[s].effect || '')
        && nodes[s].gearKey === 'operationsCompleted');
    }
    const withoutLevels = companion ? { [companion]: 1 } : {};
    const withLevels = companion ? { [companion]: 1, [slot]: 1 } : { [slot]: 1 };
    const base = sb.computeResourceBonuses(shipId, withoutLevels);
    const bumped = sb.computeResourceBonuses(shipId, withLevels);
    const changedResources = [...new Set([...Object.keys(base), ...Object.keys(bumped)])]
      .filter((r) => (base[r] || 1) !== (bumped[r] || 1));

    if ((!pctMoves && !amplifier) || !changedResources.length) {
      dead++;
      rows.push(`DEAD ship ${shipId} slot ${slot} "${String(meta.name).slice(0, 30)}"`
        + `\n      pct 0->1: ${pct0} -> ${pct1}; resources changed: ${JSON.stringify(changedResources)}`
        + `\n      effect: ${meta.effect}`);
    } else if (verbose) {
      rows.push(`ok   ship ${shipId} slot ${slot}: +${pct1}% -> ${changedResources.join(', ')}`);
    }
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nprobed ${checked} install node(s) for a real effect on the tool's output`);
if (dead) {
  console.log(`${dead} node(s) are INERT: buying them changes nothing the tool computes. A node can `
    + 'be fully verified against the game and still be dead here -- an unparsed effect string or an '
    + 'unrouted resource tag is enough.');
  process.exit(1);
}
console.log('every install node changes the tool\'s output when bought');
