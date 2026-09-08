'use strict';
// A PRE-OUROBOROS PLAYER MUST NOT BE PUSHED INTO CELLS NODES.
//
//   node tools/bench/meltdown-allocation-check.js
//
// THE RISK. Meltdown is an EXPONENT applied to GENERATOR-stage bonuses only -- they sit inside
// `Pow(MK1Production, m)` while direct final-resource bonuses (Cells, Shards, RP, MP, Academy,
// Materials) sit outside it. `nodeMarginalLogGain` scores a gen node `logRatio * m` and a direct
// node `logRatio * 1`.
//
// So a stored 0 would not merely mis-scale: it multiplies every generator node by ZERO while
// leaving Cells untouched. A player who has not done their first Ouroboros reset is exactly the
// player whose save reads HighestMeltdown 0, so it would hit the accounts least able to spot it.
// "No reset" is m = 1, not m = 0 -- the game takes the un-melted branch, which is arithmetically
// identical to an exponent of 1.
//
// MEASURED FINDING, RECORDED SO IT IS NOT RE-DERIVED: the exponent is currently INERT in the
// allocator. Across 7 ships x 5 budgets the plan is byte-identical from m = 0.3 to m = 5, a 16x
// range. `getShipGear` is called ~1091 times per run so the value IS read; it simply never
// changes which node wins a pick -- the plans are driven by gates and caps, not by the margin
// between a gen node and a direct one.
//
// That is GOOD NEWS for the question this file asks (a pre-Ouroboros account cannot be skewed by
// something that changes nothing) and it is ALSO a real limitation: the Meltdown term is not
// currently influencing allocation for anyone. It is left as a reported fact rather than
// "fixed", because the fix is a modelling decision -- and per the project owner, meltdown above 1
// is late-game-only, so the term is near-neutral for almost every real account anyway.
//
// A NODE IS CLASSIFIED BY THE TOOL'S OWN `effectResources`, never by a regex over the effect
// text. An earlier version of this bench matched /MK\d|Generator/ and mislabelled Cradle slots 9,
// 10 and 11 -- "+0.006% Shards gained, per manual generator purchased" is a SHARDS node that
// mentions generators. That produced a "direct-resource share" that was simply wrong.
const H = require('./harness.js');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const sb = H.browserSandbox();
sb.window = sb.window || sb;
sb.window.store = sb.StoreSchema.freshStore();

const SD = sb.ShipData || {};
const optimize = SD.optimizeShipInstalls;
const catalog = SD.SHIP_NODE_CATALOG;
if (typeof optimize !== 'function' || !catalog) {
  console.log('FAIL  ShipData does not export optimizeShipInstalls / SHIP_NODE_CATALOG');
  process.exit(1);
}

// Cradle: the ship whose nodes span both kinds (Cells at slot 1, generator tiers elsewhere), so a
// skew is visible. A ship with only one kind could not show one.
// MK1-8 need no Ouroboros reset, so a realistic pre-Ouroboros account has them. A FRESH store
// defaults to MK1 only, and the allocator filters out generator nodes whose tier is not unlocked
// -- so without this the fixture excludes gen nodes for an unrelated reason and "measures" a skew
// that is really the default unlock set.
for (let n = 1; n <= 8; n++) sb.window.store.unlockedGens[n] = true;
for (let n = 9; n <= 12; n++) sb.window.store.unlockedGens[n] = false;

const SHIP = 1;
const BUDGET = 300;   // 150 leaves slot 8 (gate 100, cap 100) unreachable, so no gen node is bought

function planFor(meltdown) {
  const gear = sb.getShipGear ? sb.getShipGear() : sb.window.store.shipGear;
  gear.meltdown = meltdown;
  // Counters must be non-zero or every counter-scaled node scores 0 and the plan collapses for an
  // unrelated reason -- the growth-counter warning this repo already documents.
  for (const k of Object.keys(gear)) {
    if (typeof gear[k] === 'number' && k !== 'meltdown' && gear[k] === 0) gear[k] = 1000;
  }
  // Even focus weights: with uneven ones the objective stops being the flat product and the
  // comparison would be measuring the weighting rather than the exponent.
  const weights = { cells: 5, shards: 5, researchPoints: 5, modPoints: 5, missionMaterials: 5, academyPoints: 5 };
  const res = optimize(SHIP, BUDGET, weights, false, 'long');
  return (res && res.levels) || {};
}

function cellsShare(levels) {
  let cells = 0;
  let total = 0;
  for (const [slot, lvl] of Object.entries(levels)) {
    const meta = (catalog[SHIP] || {})[slot];
    if (!meta || !lvl) continue;
    total += lvl;
    // THE TOOL'S OWN CLASSIFIER, not a regex over the prose. `effectResources` is what
    // nodeMarginalLogGain itself uses to decide whether the exponent applies, so this cannot
    // disagree with the code under test.
    const tags = sb.effectResources(meta.effect);
    const isGen = tags.includes('allGens') || tags.some((t) => /^mk\d+$/.test(t));
    if (!isGen) cells += lvl;
  }
  return { cells, total, share: total ? cells / total : 0 };
}

const atOne = planFor(1);
const atZero = planFor(0);
const atReal = planFor(0.461);

const s1 = cellsShare(atOne);
const s0 = cellsShare(atZero);
const sr = cellsShare(atReal);

console.log(`m = 1     (pre-Ouroboros)  direct-resource share ${(s1.share * 100).toFixed(1)}%  (${s1.cells}/${s1.total} points)`);
console.log(`m = 0     (legacy stored)  direct-resource share ${(s0.share * 100).toFixed(1)}%  (${s0.cells}/${s0.total} points)`);
console.log(`m = 0.461 (real account)   direct-resource share ${(sr.share * 100).toFixed(1)}%  (${sr.cells}/${sr.total} points)`);
console.log('');

// 1. THE POINT OF THE FILE: a pre-Ouroboros plan does not collapse into direct-resource nodes.
// The threshold is deliberately generous -- the failure mode is ~100%, so this is checking for a
// COLLAPSE, not tuning a ratio.
check('a pre-Ouroboros plan does not collapse into direct-resource nodes', s1.share < 0.9,
  `${(s1.share * 100).toFixed(1)}% of points`);

// 2. Real generator-stage points are still bought at m = 1, which is the other half of "not
// skewed": a plan could avoid a collapse and still buy no generator nodes at all.
check('a pre-Ouroboros plan still funds generator-stage nodes', s1.total - s1.cells > 0,
  `${s1.total - s1.cells} generator points`);

// 3. A legacy store holding 0 allocates IDENTICALLY to the corrected default. Compared as the whole
// allocation, not the share -- two different plans can coincidentally share a ratio.
check('m = 0 and m = 1 produce the SAME plan', JSON.stringify(atZero) === JSON.stringify(atOne),
  `0: ${JSON.stringify(atZero)}
        1: ${JSON.stringify(atOne)}`);

// 4. And so does a real sub-1 value -- see the INERT finding in the header. Asserted rather than
// assumed so that if the exponent ever DOES start moving allocations, this fails and the header's
// claim gets revisited instead of quietly going stale.
check('a real m = 0.461 also produces the same plan (the exponent is currently inert)',
  JSON.stringify(atReal) === JSON.stringify(atOne),
  `0.461: ${JSON.stringify(atReal)}`);

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s): meltdown is skewing allocation for pre-Ouroboros players.`);
  process.exit(1);
}
console.log('PASS  a pre-Ouroboros account (m = 1) allocates normally; a legacy 0 is identical');
