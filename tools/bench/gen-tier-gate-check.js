'use strict';
// GENERATOR TIER UNLOCKS MATCH THE GAME.
//
//   node tools/bench/gen-tier-gate-check.js
//
// The rule, from `UnlockHandler.CheckMK<n>Overlays()` in the recovered C# (0.7.3.61):
//
//   MK1-MK8   no condition at all
//   MK9       FirstOuroResetDone && EvolutionQualityLevel >= 1
//   MK10-12   FirstOuroResetDone && EvolutionQualityLevel >= 2
//
// WHY THIS IS GATED RATHER THAN TRUSTED. The requirement was an open question in this repo for
// months -- the old comment named the Evolution gem as "thematically the most likely candidate"
// and correctly refused to invent a rule. Now that there IS a rule it is worth pinning, because
// every part of it is the kind of thing that silently drifts: the threshold differs between MK9
// and MK10+ (so "they are all the same" is wrong), the Ouroboros reset is a second, independent
// condition (so gem level alone is wrong), and `EvolutionQualityLevel` is the gem QUALITY level
// rather than the gem-tree level (whose Evolution entry maxes at 1, which would cap the rule at
// MK9 if the two were confused).
//
// THE EVIDENCE RULE IS PART OF THE CONTRACT, not a nicety: a tier the account already owns must
// stay available whatever the gem state says. Our gem picture comes from the Gem Planner, which a
// user may never have filled in, and disabling a checkbox the SAVE itself set would be the tool
// arguing with the game.
const H = require('./harness.js');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const sb = H.browserSandbox();

// The gate is read through the shipped function, with the store driven to each state, so this
// tests the code the page actually calls rather than a copy of its rule.
function requirementAt(tier, { reset, evo }) {
  sb.window = sb.window || sb;
  const store = sb.window.store || (sb.window.store = {});
  store.gems = { evolution: { level: evo, nodes: [false, false, false, false, false, false] } };
  store.ouroState = reset ? { firstOuroResetDone: true } : {};
  return sb.genTierRequirement(tier);
}

if (typeof sb.genTierRequirement !== 'function') {
  console.log('FAIL  shipsPage.js does not expose genTierRequirement -- the gate cannot be checked');
  process.exit(1);
}

// 1. MK1-MK8 are ungated in the game, and must be ungated here.
for (let n = 1; n <= 8; n++) {
  check(`MK${n} has no requirement`, requirementAt(n, { reset: false, evo: 0 }) === null);
}

// 2. The exact thresholds, per tier -- checked individually rather than generalised from MK10,
//    because assuming the top tiers share a threshold is precisely how a wrong gate ships.
const EXPECTED = { 9: 1, 10: 2, 11: 2, 12: 2 };
for (const [tier, need] of Object.entries(EXPECTED)) {
  const r = requirementAt(Number(tier), { reset: true, evo: 9 });
  check(`MK${tier} requires Evolution quality ${need}`, r && r.need === need,
    r ? `got ${r.need}` : 'no requirement returned');
}

// 3. Both conditions are required, and independently. Gem level alone must not unlock, and the
//    reset alone must not unlock.
for (const tier of [9, 10, 11, 12]) {
  const need = EXPECTED[tier];
  check(`MK${tier} locked without the Ouroboros reset (evo ${need})`,
    requirementAt(tier, { reset: false, evo: need }).met === false);
  check(`MK${tier} locked at evo ${need - 1} with the reset done`,
    requirementAt(tier, { reset: true, evo: need - 1 }).met === false);
  check(`MK${tier} unlocked at evo ${need} with the reset done`,
    requirementAt(tier, { reset: true, evo: need }).met === true);
}

// 4. MK9 opens strictly before MK10 -- the one asymmetry in the rule, and the thing a
//    "they're all the same" simplification would erase.
const mk9AtOne = requirementAt(9, { reset: true, evo: 1 }).met;
const mk10AtOne = requirementAt(10, { reset: true, evo: 1 }).met;
check('evo 1 opens MK9 but NOT MK10', mk9AtOne === true && mk10AtOne === false,
  `MK9 ${mk9AtOne}, MK10 ${mk10AtOne}`);

// 5. Corroboration against the reference account, which is a fact about the game rather than
//    about our rule: it has done the reset, has Evolution quality 0, and the save independently
//    reports MK9-MK12 as not unlocked. A rule that said otherwise would be contradicted by the
//    account it is meant to describe.
const saveRef = H.latestDecodedSave && H.latestDecodedSave();
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'gamefiles', 'save');
let decoded = null;
if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.decoded.json') || f.startsWith('decoded-'));
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  if (files.length) decoded = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}
if (!decoded) {
  console.log('SKIP  no decoded save -- the account corroboration cannot run (that is a SKIP, not a pass)');
} else {
  const reset = !!decoded.FirstOuroResetDone;
  const evo = Number(decoded.EvolutionQualityLevel || 0);
  let agreed = 0;
  for (const tier of [9, 10, 11, 12]) {
    const predicted = requirementAt(tier, { reset, evo }).met;
    const actual = !!decoded[`MK${tier}UnlockedBool`];
    // The rule says what the account CAN have, so an unlocked tier must be permitted. The
    // converse is not implied -- a player can be eligible and simply not have bought it yet.
    check(`MK${tier}: account state does not contradict the rule (reset ${reset}, evo ${evo})`,
      !(actual && !predicted), `save says unlocked but the rule forbids it`);
    agreed++;
  }
  check('corroborated against a real account', agreed === 4, `checked ${agreed}`);
}

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s): the generator tier gate does not match the game.`);
  process.exit(1);
}
console.log('PASS  generator tier unlocks match UnlockHandler.CheckMK<n>Overlays()');
