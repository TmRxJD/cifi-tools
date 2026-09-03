'use strict';
// Does each install node boost the resources the GAME says it boosts?
//
//   node tools/bench/node-resource-check.js [--verbose]
//
// This is the last field of the install catalog to get game verification. Name, coefficient,
// counter, cap and gate all had one; the RESOURCE was parsed out of the node's English effect text
// by keyword, and a keyword parser is only as good as the prose it reads.
//
// It is not a display-only concern: `nodeMarginalLogGain` weights a node by the resources it is
// tagged with, so a mis-tagged node is MIS-RANKED. The first run found 11 of 23 checkable nodes
// wrong, from four separate causes -- `&` parsed as a range, comma lists truncated to their first
// tier, an EDITORIAL ASIDE inside the parsed field ("possibly meant all Generators") that credited
// ten tiers and squared one of them, and the counter's own tier read as a boosted tier.
//
// THE REFERENCE IS THE GAME'S CONSUMER LIST, not the prose. Each `RU<Cat><n>Bonus` is read by
// exactly the resource pools it feeds -- `MK<n>Production`, `CellProductionTotalMult`,
// `ShardsTotalMult`, `RPTotalMult`, `MPTotalMult`, `FinalAllGensBonus` -- so that list IS the
// node's resource set. Comparing our tags against the same text we parse would test the parser
// against itself.
//
// EVERY node is accounted for, and the extractor refuses to emit one that is not: a node resolves
// either to a set of resources or to `amplifier: true` (Demeter's Ahead Of The Curve grants
// operations rather than boosting a pool, consumed in `LoopModifiers.PerformLoop`). There is no
// third "could not tell" state, because that state is indistinguishable from a passing check that
// compared nothing.

const H = require('./harness.js');
const ref = require('../reference/node-resources.json').productionConsumers;

const verbose = process.argv.includes('--verbose');
const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY } = sb.ShipData;

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

// Resource tags the tool emits that name something OTHER than a game resource pool, and so have
// no counterpart in the consumer list. Each is listed with why, because an unexplained exemption
// is how a real mismatch gets waved through.
const NOT_A_POOL = new Set([
  // A MARKER the tool sets alongside the individual mk1..mk12 tags so other code can ask "is this
  // an all-gens effect?". The tiers themselves are compared; the marker names no pool of its own.
  'allGens',
  // The tool's catch-all for an effect it could not classify.
  'other',
]);

let checked = 0;
let amplifiers = 0;
const problems = [];

for (const [shipIdStr, ship] of Object.entries(CATALOG)) {
  const category = SHIP_CATEGORY[shipIdStr];
  for (const [slot, meta] of Object.entries(ship)) {
    const entry = (ref[category] || {})[String(meta.ruId)];
    if (!entry) {
      fail(`ship ${shipIdStr} slot ${slot} (RU${meta.ruId}${category}) "${meta.name}": no entry in `
        + 'node-resources.json -- re-run extract-node-resources.py; a node with no reference is a '
        + 'node nothing verifies');
      continue;
    }

    const ours = new Set(sb.effectResources(meta.effect).filter((t) => !NOT_A_POOL.has(t)));

    if (entry.amplifier) {
      amplifiers++;
      // An amplifier grants a counter. It must not be tagged with a resource, or the totals would
      // credit it with output it does not produce.
      const claimed = [...ours].filter((t) => t !== 'allGens');
      if (claimed.length) {
        problems.push(`ship ${shipIdStr} slot ${slot} "${meta.name}" is an AMPLIFIER in the game `
          + `(consumed in ${entry.consumers.join(', ')}) but the tool credits it with `
          + `${claimed.sort().join(',')}`);
      }
      continue;
    }

    checked++;
    const game = new Set(entry.resources);
    const missing = [...game].filter((g) => !ours.has(g));
    const extra = [...ours].filter((o) => !game.has(o));
    if (missing.length || extra.length) {
      problems.push(`ship ${shipIdStr} slot ${slot} (RU${meta.ruId}${category}) "${meta.name}": `
        + `${missing.length ? `missing ${missing.sort().join(',')}` : ''}`
        + `${missing.length && extra.length ? '; ' : ''}`
        + `${extra.length ? `credits ${extra.sort().join(',')} the game does not` : ''}`);
    } else if (verbose) {
      console.log(`  ok ship ${shipIdStr} slot ${slot}: ${[...ours].sort().join(',')}`);
    }
  }
}

const totalNodes = Object.values(CATALOG).reduce((n, s) => n + Object.keys(s).length, 0);
if (checked + amplifiers !== totalNodes) {
  fail(`only ${checked + amplifiers} of ${totalNodes} nodes were accounted for`);
}
if (problems.length) problems.forEach(fail);
else if (!failures) {
  pass(`all ${totalNodes} nodes match the game: ${checked} boost exactly the pools their bonus is `
    + `read by, ${amplifiers} are amplifiers granting a counter rather than a resource`);
}

// --- no node may be counted twice into one resource --------------------------------------------
// computeResourceBonuses multiplies a node's factor in once per tag, so a repeated tag SQUARES
// that node's contribution. This is the invariant Zagreus 7 violated.
const dupes = [];
for (const [shipIdStr, ship] of Object.entries(CATALOG)) {
  for (const [slot, meta] of Object.entries(ship)) {
    const tags = sb.effectResources(meta.effect);
    const seen = new Set();
    const rep = new Set();
    tags.forEach((t) => (seen.has(t) ? rep.add(t) : seen.add(t)));
    if (rep.size) dupes.push(`ship ${shipIdStr} slot ${slot}: ${[...rep].join(', ')}`);
  }
}
if (dupes.length) dupes.forEach((d) => fail(`duplicate resource tag -- its factor would be squared: ${d}`));
else pass('no node produces a duplicate resource tag');

// --- no effect string may carry commentary -----------------------------------------------------
// The field is parsed, so an aside in it becomes data. Uncertainty belongs in a code comment.
const commentary = [];
for (const [shipIdStr, ship] of Object.entries(CATALOG)) {
  for (const [slot, meta] of Object.entries(ship)) {
    if (/wiki text as-is|possibly meant|likely meant|probably|\bTODO\b|\?\?/i.test(meta.effect)) {
      commentary.push(`ship ${shipIdStr} slot ${slot}: ${meta.effect}`);
    }
  }
}
if (commentary.length) {
  commentary.forEach((c) => fail(`editorial commentary inside a PARSED effect string: ${c}`));
} else {
  pass('no effect string carries editorial commentary for the parser to misread');
}

console.log(failures ? `\n${failures} failure(s)` : '\nevery node boosts the resources the game says it does');
process.exit(failures ? 1 : 0);
