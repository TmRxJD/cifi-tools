'use strict';
// Map loop-mod INDICES to their real names, without save diffing.
//
// The problem: the save stores levels as LM<N>Level and the game's scene data stores definitions
// as LM<N><Field>, but neither carries a display name -- names are runtime UI Text. Diffing a
// save would identify them one at a time, and that is not feasible: many mods cannot be
// un-purchased to test, and the unowned ones need MP that takes months to earn.
//
// The way round it: cifi-tools publishes a Loop Mod Overview listing name, tier, max level and
// the MP cost of every level as a base-10 EXPONENT. The scene stores those same costs as
// BigDoubles -- `LM<N>StartCost: {mantissa, exponent}` -- so the exponents are directly
// comparable. A mod's (first-level cost exponent, per-level step, max level) is a fingerprint,
// and matching it needs nothing from the account at all.
//
// Worked example that motivated this: the overview's "Mutual Mining Agreement: The Stelzi" costs
// e3400 at level 1 and steps +600; scene LM279 has StartCost exponent 3400 and MaxLevel 8. That
// is `stelzi` in our own hunterDefs, whose label is "Mutual Mining Agreement".
//
//   node tools/bench/match-loopmods.js [--write]
//
// Reads tools/reference/loop-mods.json (from extract-loopmods.js) and
// tools/reference/loopmod-overview.json (scraped from cifi-tools' Loop Mod Overview).

const fs = require('fs');
const path = require('path');

const REF = path.join(__dirname, '../reference/loop-mods.json');
const OVERVIEW = path.join(__dirname, '../reference/loopmod-overview.json');
const OUT = path.join(__dirname, '../reference/loopmod-names.json');
const write = process.argv.includes('--write');

for (const f of [REF, OVERVIEW]) {
  if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(2); }
}
const scene = JSON.parse(fs.readFileSync(REF, 'utf8')).loopMods;
const overview = JSON.parse(fs.readFileSync(OVERVIEW, 'utf8')).mods;

/** First-level cost exponent for a scene record, however it is stored. */
function startExponent(rec) {
  if (rec.StartCostE !== undefined) return rec.StartCostE;         // BigDouble
  if (typeof rec.StartCost === 'number') return rec.StartCost;      // small scalar, already an exponent
  return undefined;
}
/** Per-level step exponent, where the curve is linear in the exponent. */
function stepExponent(rec) {
  if (rec.CostExponentE !== undefined) return rec.CostExponentE;
  if (typeof rec.CostExponent === 'number') return rec.CostExponent;
  return undefined;
}

const results = [];
const usedIdx = new Set();

for (const mod of overview) {
  const first = mod.levels[0];
  const second = mod.levels[1];
  const wantStart = first ? first.costE : undefined;
  const wantStep = first && second ? second.costE - first.costE : undefined;
  const wantMax = mod.maxLevelShown;

  const candidates = Object.entries(scene).filter(([idx, rec]) => {
    if (usedIdx.has(idx)) return false;
    const s = startExponent(rec);
    if (s === undefined || s !== wantStart) return false;
    return true;
  });

  // Narrow with the step and the cap when more than one index shares a start cost.
  let best = candidates;
  if (best.length > 1 && wantStep !== undefined) {
    const byStep = best.filter(([, rec]) => stepExponent(rec) === wantStep);
    if (byStep.length) best = byStep;
  }
  if (best.length > 1 && wantMax !== undefined) {
    const byMax = best.filter(([, rec]) => rec.MaxLevel === wantMax);
    if (byMax.length) best = byMax;
  }

  // A single surviving candidate is not automatically right. If BOTH sides declare a max level
  // and they disagree, that is evidence against the match, not a detail to wave through -- an
  // early version accepted LM155 for a mod the overview caps at 1 while the scene caps it at 175.
  // Demote those to "conflicting" instead of reporting them as confident.
  let conflict = null;
  if (best.length === 1 && wantMax !== undefined) {
    const sceneMax = best[0][1].MaxLevel;
    // Require EXACT agreement. The overview lists every level it knows (it goes to 260 for one
    // mod), so a single row means a cap of 1, not a truncated table. Being lenient here is how a
    // wrong match sneaks through wearing a confident label.
    if (sceneMax !== undefined && sceneMax !== wantMax) {
      conflict = `scene caps at ${sceneMax}, overview shows ${wantMax}`;
    }
  }

  const confident = best.length === 1 && !conflict;
  if (confident) usedIdx.add(best[0][0]);
  results.push({
    name: mod.name,
    tier: mod.tier,
    buffs: mod.buffs,
    index: confident ? Number(best[0][0]) : null,
    matchedOn: confident
      ? ['startCostExponent', wantStep !== undefined ? 'step' : null, 'maxLevel'].filter(Boolean)
      : null,
    candidates: confident ? undefined : best.map(([i]) => Number(i)),
    conflict,
    wantStart, wantStep, wantMax,
  });
}

const matched = results.filter((r) => r.index !== null);
const conflicting = results.filter((r) => r.index === null && r.conflict);
const ambiguous = results.filter((r) => r.index === null && !r.conflict && r.candidates && r.candidates.length);
const unmatched = results.filter((r) => r.index === null && (!r.candidates || !r.candidates.length));

console.log(`${matched.length}/${results.length} named mods mapped to a scene index\n`);
for (const r of matched) {
  console.log(`  LM${String(r.index).padStart(3)}  e${String(r.wantStart).padEnd(6)} max ${String(r.wantMax).padEnd(4)} ${r.name}`);
}
if (conflicting.length) {
  console.log(`
${conflicting.length} rejected on a max-level contradiction (single candidate, but the caps disagree):`);
  for (const r of conflicting) console.log(`  ${r.name} -> LM${r.candidates[0]}: ${r.conflict}`);
}
if (ambiguous.length) {
  console.log(`\n${ambiguous.length} ambiguous (multiple indices share the fingerprint):`);
  for (const r of ambiguous) console.log(`  ${r.name} -> ${r.candidates.join(', ')}`);
}
if (unmatched.length) {
  console.log(`\n${unmatched.length} with no index at that start cost:`);
  for (const r of unmatched) console.log(`  ${r.name} (wanted e${r.wantStart}, max ${r.wantMax})`);
}

if (write) {
  fs.writeFileSync(OUT, `${JSON.stringify({
    note: 'Generated by tools/bench/match-loopmods.js. Joins the game scene\'s LM<N> cost data to '
      + 'the names cifi-tools publishes in its Loop Mod Overview, by matching base-10 cost '
      + 'exponents. No save diffing involved. Only the mods that Overview covers are here -- it is '
      + 'a curated "notable mods" list, not all 295.',
    mapped: matched.map(({ name, tier, buffs, index, wantStart, wantMax }) => ({ index, name, tier, buffs, startCostExponent: wantStart, maxLevel: wantMax })),
    ambiguous: ambiguous.map(({ name, candidates, wantStart }) => ({ name, candidates, startCostExponent: wantStart })),
    conflicting: conflicting.map(({ name, candidates, conflict }) => ({ name, candidate: candidates[0], reason: conflict })),
    unmatched: unmatched.map(({ name, wantStart, wantMax }) => ({ name, startCostExponent: wantStart, maxLevel: wantMax })),
  }, null, 1)}\n`);
  console.log(`\nwrote ${OUT}`);
}
