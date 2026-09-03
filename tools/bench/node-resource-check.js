'use strict';
// Does each install node boost the resources the GAME says it boosts?
//
//   node tools/bench/node-resource-check.js [--verbose]
//
// The last field of the install catalog with no game verification. Name, coefficient, counter, cap
// and gate are all checked; the RESOURCE was parsed out of the node's English effect text by
// keyword, and a keyword parser is only as good as the prose it reads.
//
// This is not a display-only concern. `nodeMarginalLogGain` weights a node by the resources it is
// tagged with, so a mis-tagged node is MIS-RANKED -- the optimizer sends points somewhere else. The
// first run of this check found 11 of 23 checkable nodes wrong, from four separate causes:
//
//   * `&` parsed as a RANGE: "+0.02% MK1 & MK4 outputs" credited mk1,mk2,mk3,mk4.
//   * comma lists truncated: "+0.1% MK1, MK2, MK3 outputs" credited mk1 alone, so three of the
//     highest-percentage nodes in the fleet got a third of what they actually boost.
//   * an EDITORIAL ASIDE inside the parsed field: Zagreus 7's effect text ended `(wiki text as-is
//     -- possibly meant "all Generators")`, and those words made the tool credit all ten tiers and
//     count MK3 twice.
//   * the counter's own tier being read as a boosted tier -- "+0.5% MK1 output, per manually
//     purchased MK2 Generator" is MK1 boosted, MK2 counted. (That one was introduced by the FIRST
//     attempt at fixing the others, which is why this bench compares every node rather than the
//     ones that were originally wrong.)
//
// THE REFERENCE IS THE GAME'S CONSUMER LIST, not the effect text. Each `RU<Cat><n>Bonus` is read by
// exactly the `*Production` properties it feeds, so that list IS the node's resource set --
// extracted by `extract-node-resources.py`. Comparing our tags against the same prose we parse
// would test the parser against itself.

const H = require('./harness.js');
const ref = require('../reference/node-resources.json').productionConsumers;

const verbose = process.argv.includes('--verbose');
const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, SHIP_CATEGORY, GEN_TIERS } = sb.ShipData;
const MODELLED_TIERS = new Set(GEN_TIERS.map((n) => `mk${n}`));

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

let checked = 0;
let noConsumer = 0;
const problems = [];
const beyondModelled = [];

for (const [shipIdStr, ship] of Object.entries(CATALOG)) {
  const category = SHIP_CATEGORY[shipIdStr];
  for (const [slot, meta] of Object.entries(ship)) {
    const consumers = ((ref[category] || {})[String(meta.ruId)]) || [];
    if (!consumers.length) { noConsumer++; continue; }
    checked++;

    const tags = sb.effectResources(meta.effect);
    const ours = new Set(tags.filter((t) => /^mk\d+$/.test(t)));
    const game = new Set(consumers.map((c) => c.replace(/Production$/, '').toLowerCase()));

    // Tiers the game feeds that this tool does not model at all are reported, not failed: the
    // game's chain runs to MK12 while GEN_TIERS stops at 10, which is a scope decision. Saying so
    // out loud is the point -- a silent truncation is how "our totals match the game" quietly
    // stops being true.
    const unmodelled = [...game].filter((g) => !MODELLED_TIERS.has(g));
    unmodelled.forEach((g) => beyondModelled.push(`${meta.name} (RU${meta.ruId}${category}) also feeds ${g.toUpperCase()}`));

    const wantedHere = [...game].filter((g) => MODELLED_TIERS.has(g));
    const missing = wantedHere.filter((g) => !ours.has(g));
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

if (!checked) fail('no node had a production consumer to compare against');
else if (problems.length) problems.forEach(fail);
else {
  pass(`all ${checked} node(s) with a production consumer boost exactly the tiers the game feeds `
    + `(${noConsumer} direct-resource or amplifier node(s) have no production consumer)`);
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

if (beyondModelled.length) {
  [...new Set(beyondModelled)].forEach((b) => console.log(`note  ${b}, a tier this tool does not model`));
  console.log('note  GEN_TIERS stops at MK10 while the game\'s production chain runs to MK12; that '
    + 'is a scope decision, and these totals are correspondingly incomplete for those nodes');
}

console.log(failures ? `\n${failures} failure(s)` : '\nevery node boosts the resources the game says it does');
process.exit(failures ? 1 : 0);
