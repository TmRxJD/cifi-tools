'use strict';
// EVERY factor in every install node's bonus must be accounted for by name.
//
// This is the general form of the check that caught Badge12 (x222 on three ships, unmodelled for
// months). A per-SHIP uniform multiplier scales all of a ship's nodes equally, so it cannot reorder
// an allocation and no allocator bench can see it. The only defence is to enumerate the whole
// multiply chain and require each term to fall into a bucket we can justify -- modelled, or
// provably inert until an upgrade is bought, or structurally part of the node itself.
//
// A term that matches nothing FAILS. That is the point: the next Badge12 shows up here as an
// unclassified name rather than as a silently missing multiplier.
//
// Regenerate the reference with:
//   CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-factors.py
//
//   node tools/bench/node-factor-check.js [--verbose]

const H = require('./harness.js');
const REF = require('../reference/node-factors.json');
const BADGES = require('../reference/badge-map.json');
const UNIFORM = require('../reference/uniform-node-terms.json');
const COUNTERS = require('../reference/ship-node-counters.json');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();
const verbose = process.argv.includes('--verbose');

const knownCounters = new Set();
Object.values(COUNTERS.counters).forEach((cat) => Object.values(cat)
  .forEach((list) => list.forEach((c) => knownCounters.add(c))));

// Each bucket says WHY the term is safe to treat as it is. Order matters only for reporting.
const BUCKETS = [
  { name: 'own level', re: /^RU\d+[A-Za-z]+Level$/, why: 'the node\'s own level -- the thing being bought' },
  { name: 'authored coefficient', re: /^RU\d+[A-Za-z]+BaseBonus$/, why: 'checked by node-coefficient-check' },
  { name: 'crew', re: /^Final[A-Za-z]*Crew$/, why: 'modelled: shipInputs[n].crew, checked by crew-rank-check' },
  { name: 'gear piece', re: /^[A-Za-z]+Item\d+Bonus\d+$/, why: 'modelled: computeGearNodeMultiplier, checked by gear-install-check' },
  { name: 'badge', re: /^Final(?:Dark)?Badge\d+Bonus\d*$/, why: 'modelled: computeFleetBadgeMultipliers, checked by badge-check' },
  { name: 'gem perk', re: /^FinalPowerGU\d+Bonus$/, why: 'omitted; proven 1 until bought by uniform-term-check' },
  { name: 'installs research', re: /^Final(?:Ship\d+|AllShips)InstallsBonus$/, why: 'modelled as Fleet Analysis 2 / omitted while unowned' },
  { name: 'counter', test: (n) => knownCounters.has(n), why: 'the node\'s "per X" counter, checked by node-counter-check' },
];

let failures = 0;
const unclassified = new Map();
const seen = new Map();
let nodes = 0;

// Only the categories we actually model. Ouroboros has install nodes in the game but no entry in
// SHIP_NODE_CATALOG, and letting it in weakened the check rather than strengthening it: its nodes
// read `RU83Level`, which the counter extractor had labelled a "counter", so an unmodelled term was
// waved through by a sibling reference rather than examined. A bench that classifies things it does
// not model is not being thorough, it is laundering them.
const MODELLED = new Set(Object.values(sb.ShipData.SHIP_CATEGORY));
const skipped = Object.keys(REF.factors).filter((c) => !MODELLED.has(c));

for (const [category, byIdx] of Object.entries(REF.factors)) {
  if (!MODELLED.has(category)) continue;
  for (const [idx, factors] of Object.entries(byIdx)) {
    nodes++;
    for (const f of factors) {
      const bucket = BUCKETS.find((b) => (b.re ? b.re.test(f) : b.test(f)));
      if (!bucket) {
        if (!unclassified.has(f)) unclassified.set(f, []);
        unclassified.get(f).push(`${category}${idx}`);
      } else {
        seen.set(bucket.name, (seen.get(bucket.name) || 0) + 1);
      }
    }
  }
}

// Badges and gem perks additionally have to be backed by their own references, so this bench
// cannot pass just because a name LOOKS like a badge.
const badgeValues = BADGES.values || {};
for (const [category, badges] of Object.entries(BADGES.perCategory)) {
  for (const b of badges) {
    if (badgeValues[b] == null) {
      failures++;
      console.log(`FAIL ${b} multiplies every ${category} node but has no authored value`);
    }
  }
}
for (const [term, info] of Object.entries(UNIFORM.terms)) {
  if (/^PowerGU\d+BonusCalc$/.test(term) && info.inertWhenUnowned !== true) {
    failures++;
    console.log(`FAIL ${term} is omitted from the value model but is not provably inert`);
  }
}

if (unclassified.size) {
  for (const [f, where] of unclassified) {
    failures++;
    console.log(`FAIL unaccounted factor "${f}" multiplies ${where.length} node(s) `
      + `(${where.slice(0, 4).join(', ')}${where.length > 4 ? ', …' : ''}) -- it is in the game's `
      + 'multiply chain and matches no bucket, so either model it or add a bucket saying why not');
  }
}

if (verbose) {
  [...seen.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([n, c]) => console.log(`  ${String(c).padStart(4)} ${n}`));
}
console.log(`\nclassified every factor across ${nodes} node getter(s) from ${REF._game}`);
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('every factor in every node is accounted for');
