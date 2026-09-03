'use strict';
// Holds the tool's own hardcoded numbers against the values a designer actually authored.
//
// Those numbers reached this repo by three routes, in descending trustworthiness: the live
// cifi-tools bundle, the game's scene data, and cifi.fandom.com / community optimizers. The last
// route has been wrong more than once -- see SHIP_NODE_CATALOG's 10x transcription notes, and the
// two coefficients tools/bench/node-coefficient-check.js caught. There was no way to check them in
// bulk until type trees made serialized MonoBehaviour data readable (tools/il2cpp-cli/typetree.py).
//
// Regenerate the authored side with:  python tools/bench/extract-authored-values.py
//
//   node tools/bench/authored-value-check.js
//   node tools/bench/authored-value-check.js --verbose
//
// Scope note: this covers RELIC COST CURVES and the GEAR per-level bases. Ship node coefficients
// have their own check (node-coefficient-check.js) because they need the ruId mapping. Relic CAPS
// are deliberately NOT here -- OuroRelics carries no MaxLevel field, so the build cannot arbitrate
// them and hunterDefs/costFormulas remain the source (see CLAUDE.md on r5/r6/r9).

const H = require('./harness.js');
const AUTHORED = require('../reference/authored-values.json');

const CF = H.browserSandbox().CostFormulas;
const verbose = process.argv.includes('--verbose');
// Authored values are float32/float64 in the build, so an exact === fails on representation alone
// (0.03 reads back as 0.029999999329447746). A real disagreement is never this small.
const TOLERANCE = 1e-6;

let checked = 0;
let mismatches = 0;
const problems = [];

function compare(label, ours, authored) {
  checked++;
  if (typeof authored !== 'number') {
    // Left as a {mantissa, exponent} pair because it exceeds float range -- see the extractor.
    problems.push(`SKIP ${label}: authored value out of float range (${JSON.stringify(authored)})`);
    checked--;
    return;
  }
  const off = authored === 0 ? Math.abs(ours) : Math.abs(ours - authored) / Math.abs(authored);
  const ok = off <= TOLERANCE;
  if (!ok) {
    mismatches++;
    problems.push(`DIFF ${label}: tool ${ours} vs authored ${authored}`);
  } else if (verbose) {
    problems.push(`ok   ${label}: ${authored}`);
  }
}

// ---- Relic cost curves -------------------------------------------------------------------
// costFormulas' RELIC_SPECS is not exported, so drive the real pricing function instead: cost at
// level 1 IS StartCost, which is the single most load-bearing number in the curve (everything
// else compounds off it). This checks the SHIPPED path, not a copy of the table.
const relics = AUTHORED.classes.OuroRelics || {};
for (let n = 1; n <= 20; n++) {
  const authoredStart = relics[`Relic${n}StartCost`];
  if (authoredStart === undefined) continue;
  let ours;
  try {
    ours = CF.relicCostAtLevel(`r${n}`, 1);   // cost of level 1 IS StartCost
  } catch (err) {
    problems.push(`SKIP r${n}: ${err.message.split('\n')[0]}`);
    continue;
  }
  compare(`r${n} StartCost`, ours, authoredStart);
}

// ---- Gear per-level bases ----------------------------------------------------------------
// computeGearNodeMultiplier raises these to the piece's level (confirmed against the binary:
// Gear::get_GreenItem1Bonus1 tail-calls BigDouble::Pow(base, level)). A wrong base here is an
// exponential error, so it is worth pinning even though it is only two numbers.
const gear = AUTHORED.classes.Gear || {};
const GEAR_EXPECTED = { GearBaseBonus1: 1.01, GearBaseBonus2: 1.02 };
for (const [field, ourValue] of Object.entries(GEAR_EXPECTED)) {
  if (gear[field] === undefined) {
    problems.push(`SKIP ${field}: not in authored data`);
    continue;
  }
  compare(`Gear ${field}`, ourValue, gear[field]);
}

problems.forEach((p) => console.log(p));
console.log(`\nchecked ${checked} value(s) against authored game data`);
if (mismatches) {
  console.log(`${mismatches} MISMATCH(ES) -- the tool disagrees with the build`);
  process.exit(1);
}
console.log('every checked value matches the game');
