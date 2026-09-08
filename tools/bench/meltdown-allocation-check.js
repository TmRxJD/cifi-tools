'use strict';
// MELTDOWN SETS THE CELLS-vs-GENERATOR SPLIT, AND A PRE-OUROBOROS ACCOUNT SITS AT THE NEUTRAL END.
//
//   node tools/bench/meltdown-allocation-check.js
//
// THE MECHANIC. Meltdown is an EXPONENT on GENERATOR-stage bonuses only: they sit inside
// `Pow(MK1Production, m)` while direct final-resource bonuses (Cells, Shards, RP, MP, Academy,
// Materials) sit outside it. So `nodeMarginalLogGain` scores a gen node `logRatio * m` and a
// direct node `logRatio * 1`, and the ratio between them IS the allocation split:
//
//     lower meltdown  -> generator nodes worth less -> Cells nodes relatively more valuable
//     higher meltdown -> generator nodes worth more
//
// "No Ouroboros reset" is m = 1, not m = 0 -- the game takes the un-melted branch, arithmetically
// identical to an exponent of 1. A stored 0 would multiply every generator node by ZERO while
// leaving Cells untouched and pour the whole budget into Cells; a player who has not reset is
// exactly the player whose save reads HighestMeltdown 0, so it would hit the accounts least able
// to spot it.
//
// THE FIXTURE MUST HAVE CREW, AND THAT IS WHY THIS CHECK NEARLY SHIPPED BACKWARDS.
// Every install node's increment is multiplied by the ship's crew, so a fresh store (crew 0) gives
// EVERY node a marginal gain of exactly 0. The greedy then picks on tie-priority and caps alone,
// every meltdown value returns an identical plan, and the honest-looking conclusion is "the
// exponent is inert" -- which was measured, reported, and WRONG. With crew set, the split moves
// from 39% to 65% generator across m = 0.3 to 3.
//
// So `the fixture is non-degenerate` runs FIRST and exits on an all-zero fixture. A bench that
// measures nothing must not be able to pass; this repo has already shipped two that did.
//
// Nodes are classified by the tool's own `effectResources`, never by a regex over the effect text
// -- "+0.006% Shards gained, per manual generator purchased" is a SHARDS node that mentions
// generators, and a regex mislabels three Cradle slots.
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
const marginal = SD.nodeMarginalLogGain;
if (typeof optimize !== 'function' || !catalog || typeof marginal !== 'function') {
  console.log('FAIL  ShipData does not export optimizeShipInstalls / SHIP_NODE_CATALOG / nodeMarginalLogGain');
  process.exit(1);
}

// Cradle: 7 of its 11 nodes are generator-stage and 4 direct-resource, so the split is observable.
// A ship dominated by one kind could not show one.
const SHIP = 1;
const BUDGET = 300;

// MK1-8 need no Ouroboros reset, so a realistic pre-Ouroboros account has them. A fresh store
// defaults to MK1 ONLY, and the allocator filters out generator nodes whose tier is not unlocked
// -- without this every gen node is excluded for an unrelated reason.
for (let n = 1; n <= 8; n++) sb.window.store.unlockedGens[n] = true;
for (let n = 9; n <= 12; n++) sb.window.store.unlockedGens[n] = false;

const input = sb.getShipInput(SHIP);
input.crew = 600;      // without crew every node's increment is 0 -- see the header
input.rank = 100;
const gear = sb.getShipGear();
for (const k of Object.keys(gear)) {
  if (typeof gear[k] === 'number' && k !== 'meltdown' && gear[k] === 0) gear[k] = 1000;
}

const WEIGHTS = { cells: 5, shards: 5, researchPoints: 5, modPoints: 5, missionMaterials: 5, academyPoints: 5 };

function isGenNode(meta) {
  const tags = sb.effectResources(meta.effect);
  return tags.includes('allGens') || tags.some((t) => /^mk\d+$/.test(t));
}

function planFor(meltdown) {
  gear.meltdown = meltdown;
  return (optimize(SHIP, BUDGET, WEIGHTS, false, 'long') || {}).levels || {};
}

function genShare(levels) {
  let gen = 0;
  let total = 0;
  for (const [slot, lvl] of Object.entries(levels)) {
    const meta = (catalog[SHIP] || {})[slot];
    if (!meta || !lvl) continue;
    total += lvl;
    if (isGenNode(meta)) gen += lvl;
  }
  return { gen, total, share: total ? gen / total : 0 };
}

// ---- 0. THE FIXTURE MEASURES SOMETHING ---------------------------------------------------------
gear.meltdown = 1;
const gains = Object.keys(catalog[SHIP] || {}).map((slot) => marginal(SHIP, slot, {}, 'long'));
const live = gains.filter((g) => g > 0).length;
check(`the fixture is non-degenerate (${live} node(s) score above zero)`, live >= 4,
  'every marginal is 0 -- the ship has no crew, so nothing below would measure the exponent');
if (live < 4) {
  console.log('\nFAIL  refusing to report on a fixture where no node has any value.');
  process.exit(1);
}

// ---- 1. THE SPLIT RESPONDS TO MELTDOWN, IN THE RIGHT DIRECTION ---------------------------------
const low = genShare(planFor(0.3));
const one = genShare(planFor(1));
const high = genShare(planFor(3));

console.log('');
console.log(`m = 0.3            generator share ${(low.share * 100).toFixed(1)}%  (${low.gen}/${low.total})`);
console.log(`m = 1 (no reset)   generator share ${(one.share * 100).toFixed(1)}%  (${one.gen}/${one.total})`);
console.log(`m = 3 (late game)  generator share ${(high.share * 100).toFixed(1)}%  (${high.gen}/${high.total})`);
console.log('');

check('a LOWER meltdown allocates MORE to direct-resource nodes', low.share < one.share,
  `0.3 -> ${(low.share * 100).toFixed(1)}%, 1 -> ${(one.share * 100).toFixed(1)}%`);
check('a HIGHER meltdown allocates MORE to generator nodes', high.share > one.share,
  `3 -> ${(high.share * 100).toFixed(1)}%, 1 -> ${(one.share * 100).toFixed(1)}%`);

// ---- 2. PRE-OUROBOROS SITS AT THE NEUTRAL POINT, NOT AT ZERO -----------------------------------
// Compared as the whole allocation, not the share -- two different plans can coincidentally share
// a ratio.
const atZero = planFor(0);
const atOne = planFor(1);
check('m = 0 (legacy stored) produces the SAME plan as m = 1',
  JSON.stringify(atZero) === JSON.stringify(atOne),
  `0: ${JSON.stringify(atZero)}\n        1: ${JSON.stringify(atOne)}`);
check('a pre-Ouroboros plan still funds generator nodes', one.gen > 0, `${one.gen} points`);
check('a pre-Ouroboros plan does not collapse into direct-resource nodes', one.share > 0.1,
  `only ${(one.share * 100).toFixed(1)}% generator`);

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s) with the meltdown allocation split.`);
  process.exit(1);
}
console.log('PASS  meltdown sets the Cells/generator split, and no-reset (m = 1) is the neutral point');
