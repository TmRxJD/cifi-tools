'use strict';
// A readable dump of the ENTIRE ship model: every node, its raw effect text, what the parser
// extracted from that text, the category it was bucketed into, and its computed value.
//
// This exists because the ship side has no oracle. The hunter optimizer could be checked against
// the game's own release.wasm; the ship logic was written from node descriptions by hand, so the
// only way to judge whether it is sound is to put the description and the derived model
// side by side and read them. Anything the parser gets wrong here is wrong everywhere
// downstream -- weights, category round-robin and install order are all built on these tags.
//
//   node tools/bench/ship-audit.js            # all ships
//   node tools/bench/ship-audit.js 3          # one ship
//   node tools/bench/ship-audit.js --suspect  # only nodes whose parse looks questionable

const H = require('./harness.js');

const sb = H.browserSandbox();
const { SHIP_NODE_CATALOG: CATALOG, RESOURCE_TO_WEIGHT_BUCKET: BUCKET, GEN_TIERS } = sb.ShipData;

// Seed a realistic account first. nodeLinearIncrement is `percent x crew x multipliers`, so on a
// default store every increment and value is 0 and the whole report reads as broken. Auditing
// the unseeded model tells you nothing about the model.
const store = sb.StoreSchema.freshStore();
sb.window.store = store;
Object.keys(CATALOG).forEach((id) => {
  store.shipInputs[id] = { ...sb.defaultShipInput(Number(id)), rank: 20, crew: 12 };
});
GEN_TIERS.forEach((n) => { store.unlockedGens[n] = n <= 8; });

const SHIP_NAMES = {
  1: 'Cradle', 2: 'Auxesia', 3: 'Zagreus', 4: 'Hephaestus',
  5: 'Demeter', 6: 'Koios', 7: 'Zeus',
};

const args = process.argv.slice(2);
const onlySuspect = args.includes('--suspect');
const wanted = args.filter((a) => !a.startsWith('--'));

const pct = (s) => {
  const m = String(s).match(/([\d.]+)\s*%/);
  return m ? Number(m[1]) : null;
};

let suspects = 0;

for (const shipId of Object.keys(CATALOG)) {
  if (wanted.length && !wanted.includes(shipId)) continue;
  const nodes = CATALOG[shipId];
  const pools = sb.computeShipRealPoolTotals(Number(shipId));
  const lines = [];

  for (const [slot, meta] of Object.entries(nodes)) {
    const tags = sb.effectResources(meta.effect);
    const cats = [...new Set(tags.map((t) => BUCKET[t]).filter(Boolean))];
    const max = sb.nodeMaxLevel(Number(shipId), slot);
    const inc = sb.nodeLinearIncrement(Number(shipId), slot);
    const val = sb.poolAdjustedNodeValue(Number(shipId), slot, pools, 'long');
    const effect = String(meta.effect || '').replace(/\s+/g, ' ');

    // Heuristics for "the parse deserves a human look", not proof of error:
    const notes = [];
    if (!tags.length) notes.push('NO TAGS PARSED');
    if (!cats.length) notes.push('no weight category');
    if (pct(effect) === null && inc) notes.push('no % in text but has an increment');
    if (pct(effect) !== null && !inc) notes.push('% in text but zero increment');
    if (!Number.isFinite(val) || val <= 0) notes.push(`value=${val}`);
    if (notes.length) suspects++;
    if (onlySuspect && !notes.length) continue;

    lines.push(
      `  slot ${slot.padEnd(3)} max ${String(max).padStart(4)}  inc ${String(inc).padStart(8)}  val ${val.toExponential(2).padStart(10)}\n`
      + `    tags: ${tags.join(', ') || '(none)'}\n`
      + `    cats: ${cats.join(', ') || '(none)'}\n`
      + `    text: ${effect.slice(0, 150)}${effect.length > 150 ? '…' : ''}`
      + (notes.length ? `\n    >>> ${notes.join('; ')}` : ''),
    );
  }

  if (lines.length) {
    console.log(`\n=== ship ${shipId} (${SHIP_NAMES[shipId] || '?'}) ===`);
    console.log(lines.join('\n'));
  }
}

console.log(`\n${suspects} node(s) flagged for review`);
