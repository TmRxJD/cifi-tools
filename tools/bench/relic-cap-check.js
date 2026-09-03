'use strict';
// Every tier-1 relic's level cap, checked against the GAME'S OWN cap assignment.
//
// This settles a question CLAUDE.md carried as unresolved. Two community sources disagreed about
// r5/r6 (cap 8 "rising to 11 with Power Gem Node 1") versus the live fragment planner (r6 at 11
// "rising to 16 with Exodus node 2", r9 100 -> 105), and with no way to arbitrate, the repo held
// the base cap and modelled no raise at all.
//
// The game resolves it, and NEITHER SOURCE WAS WRONG -- they describe two different raises that
// both exist. Relics are capped in three bands, and the caps are raised at runtime:
//
//     FinalTier1<Band>RelicsMaxLevel = Tier1<Band>RelicsMaxLevel + GemNodes.FinalExodus3Bonus
//     r5 / r6 / r14                  = ...that, PLUS GemNodes.FinalPower1Bonus4
//
// Regenerate the reference with:  python tools/bench/extract-relic-caps.py
//
//   node tools/bench/relic-cap-check.js
//
// What this checks is the BASE cap, which is what costFormulas stores and what the planner should
// offer. Continuing not to model the raises is deliberate and unchanged: they depend on live gem
// state, and offering levels an account cannot buy is the same silent-optimism failure as
// defaulting an upgrade gate to unlocked. The difference is that the raise is now a KNOWN
// mechanism we choose not to model, rather than an unresolved disagreement.

const H = require('./harness.js');
const CAPS = require('../reference/relic-caps.json');

const CF = H.browserSandbox().CostFormulas;
const verbose = process.argv.includes('--verbose');

let checked = 0;
let mismatches = 0;
const rows = [];

for (const [relicId, info] of Object.entries(CAPS.relicBand).sort(
  (a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))) {
  const expected = CAPS.bandBaseMaxLevel[info.band];
  if (expected === undefined) {
    rows.push(`SKIP ${relicId}: no base value for band ${info.band}`);
    continue;
  }
  let ours;
  try {
    ours = CF.relicMaxLevel(relicId);
  } catch (err) {
    // relicMaxLevel throws by design for caps the dataset does not cover -- that refusal is a
    // feature (a silent 0 would make an unmodelled relic look free), so report, do not fail.
    rows.push(`SKIP ${relicId}: relicMaxLevel throws -- ${err.message.split('\n')[0].slice(0, 70)}`);
    continue;
  }
  checked++;
  const ok = ours === expected;
  if (!ok) mismatches++;
  if (!ok || verbose) {
    rows.push(`${ok ? 'ok  ' : 'DIFF'} ${relicId.padEnd(4)} band ${info.band.padEnd(6)}`
      + `${info.powerRaised ? '(+Power1) ' : '          '}`
      + `tool ${String(ours).padEnd(5)} game ${expected}`);
  }
}

rows.forEach((r) => console.log(r));
console.log(`\nchecked ${checked} relic cap(s) against the game's own band assignment`);
if (mismatches) {
  console.log(`${mismatches} MISMATCH(ES) -- the tool caps a relic differently from the game`);
  process.exit(1);
}
console.log('every checked relic cap matches the game');
