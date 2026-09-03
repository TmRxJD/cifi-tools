'use strict';
// Is every cap the GAME can raise accounted for -- and has a new one appeared?
//
//   node tools/bench/cap-raise-check.js
//
// This game raises caps as an account progresses, so an authored `MaxLevel` is frequently only the
// BASE. A tool holding the base withholds levels the account can really buy; a tool holding a
// raised value unconditionally offers levels it cannot. Neither shows up as an error -- the
// optimizer just allocates against the wrong ceiling and reports a confident result.
//
// The game marks its own raisable caps: a raisable one has a computed `Final<X>MaxLevel` property
// beside the authored field, and the property body IS the raise formula. So this bench does two
// things a per-value comparison cannot:
//
//   1. Every raise formula must fall into a KNOWN bucket -- modelled by us, deliberately not
//      modelled, or belonging to a system we do not model at all. An unrecognised operand fails.
//   2. Caps we treat as STATIC must have no such property at all. That absence is the evidence,
//      and it is what makes "attribute caps cannot be raised" a checked claim rather than an
//      assumption. If a future build adds one, this fails.
//
// It also watches slots the game has WIRED but not AUTHORED. Install nodes 12 and 13 exist in
// every category with a Requirement and UI objects but MaxLevel 0 and BaseBonus 0, so they cannot
// be bought and contribute nothing -- correctly unmodelled today. When a build authors one, that
// is a real fleet-model gap, and this is where it surfaces.

const H = require('./harness.js');
const ref = require('../reference/cap-raises.json');

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

// Operands that are structural rather than a raise: the authored base being raised, and the
// artefacts Cpp2IL leaves where it could not resolve something.
const STRUCTURAL = /MaxLevel$|^Unmanaged$|^Method$|^Math$|^OuroRelics$|^ExodusGemNodes$/;

// Every raise mechanism the game has, and our stance on it. A formula whose operands are not all
// covered here FAILS -- the point is that a new mechanism cannot slip in unexamined.
const KNOWN = {
  FinalShipRanksMaxLevelBonus: {
    verdict: 'modelled',
    why: 'ship install caps: nodeMaxLevel() multiplies the authored base by exactly this',
  },
  FinalAttraction2Bonus2LuckyLooterLevel: {
    verdict: 'modelled',
    why: "Borge's Call Me Lucky Loot: hunterDefs dynamicMaxLevel raises 10 -> 12 on Attraction "
      + 'gem node 2, the same rule the live tool implements as getMaxValue',
  },
  FinalExodus3Bonus2: {
    verdict: 'base-only',
    why: 'tier-1 relic band caps. Deliberately not modelled: the raise depends on live gem state, '
      + 'and offering levels the account cannot buy is the silent-optimism failure this repo bans',
  },
  FinalPower1Bonus4: {
    verdict: 'base-only',
    why: 'the second tier-1 relic raise, on r5/r6/r14 only -- same policy as Exodus3',
  },
  FinalOuroRank: {
    verdict: 'not-modelled-system',
    why: 'Ouroboros ship install caps; the Ouroboros ship is outside the 7 ships we model',
  },
  FinalT2Relic3Bonus: {
    verdict: 'not-modelled-system',
    why: 'the other operand of the Ouroboros install cap',
  },
};

// --- 1. every raise formula is accounted for ---------------------------------------------------
const byVerdict = {};
const unknown = [];
for (const [prop, info] of Object.entries(ref.raisable)) {
  const raisers = info.operands.filter((o) => !STRUCTURAL.test(o));
  if (!raisers.length) {
    // A Final* property that raises by nothing is suspicious enough to name: it either means the
    // parse missed an operand or the game left a no-op wrapper.
    unknown.push(`${prop}: no raise operand found -- parse gap or a no-op wrapper?`);
    continue;
  }
  for (const r of raisers) {
    if (!KNOWN[r]) { unknown.push(`${prop}: unrecognised raise operand "${r}"`); continue; }
    (byVerdict[KNOWN[r].verdict] = byVerdict[KNOWN[r].verdict] || new Set()).add(prop);
  }
}
if (unknown.length) [...new Set(unknown)].forEach(fail);
else {
  const summary = Object.entries(byVerdict)
    .map(([v, set]) => `${set.size} ${v}`).sort().join(', ');
  pass(`all ${Object.keys(ref.raisable).length} raisable caps are accounted for (${summary})`);
}

// --- 2. caps we treat as static really are static ----------------------------------------------
// Each entry: a human name, and a pattern that a Final*MaxLevel property WOULD match if the game
// started raising it. Checked against the full name list grepped from dump.cs, not just the
// classes decompiled, so a raise defined elsewhere still trips it.
const MUST_STAY_STATIC = [
  ['hunter attribute caps (POM/POI/POK)', /^Final(POM|POI|POK)\d+MaxLevel/],
  ['tier-2 relic caps', /^FinalT2Relic\d+MaxLevel/],
  ['hunter talent caps other than Borge skill 6', /^Final(Ozzy|Knox)Skill\d+MaxLevel/],
];
const names = ref.allFinalMaxLevelNames || [];
if (!names.length) fail('the Final*MaxLevel name list is empty -- the audit read nothing');
let staticOk = 0;
for (const [label, pattern] of MUST_STAY_STATIC) {
  const hits = names.filter((n) => pattern.test(n));
  if (hits.length) {
    fail(`${label} are now RAISABLE in the game (${hits.join(', ')}) -- we model them as static, `
      + 'so the cap we offer is wrong; model the raise or document it as base-only');
  } else staticOk++;
}
// Borge skill 6 is the one talent with a raise, and it must keep having one: if it vanished, our
// dynamicMaxLevel would be raising a cap the game no longer raises.
if (!names.includes('FinalBorgeSkill6MaxLevel')) {
  fail('FinalBorgeSkill6MaxLevel is gone -- our dynamicMaxLevel on Call Me Lucky Loot would be '
    + 'raising a cap the game no longer raises');
} else staticOk++;
if (staticOk === MUST_STAY_STATIC.length + 1) {
  pass('every cap we treat as static has no raise property in the game, and the one raised talent '
    + 'still has its');
}

// --- 3. wired-but-unauthored slots are still unauthored ----------------------------------------
const slots = ref.unreleasedSlots || {};
const nowLive = Object.entries(slots).filter(([, v]) => v.maxLevel || v.baseBonus);
if (!Object.keys(slots).length) {
  fail('no wired-but-unauthored slots recorded -- the extractor found none, which would itself be '
    + 'a change worth looking at');
} else if (nowLive.length) {
  nowLive.forEach(([k, v]) => fail(`${k} is now AUTHORED (maxLevel ${v.maxLevel}, baseBonus `
    + `${v.baseBonus}) -- the game released an install node we do not model`));
} else {
  pass(`all ${Object.keys(slots).length} wired-but-unauthored install slot(s) are still `
    + 'unauthored, so not modelling them remains correct');
}

// --- 4. the caps we ship really are the authored BASE, not something else ----------------------
// Cheap cross-check that ties this audit to the shipped data: the ship-node catalog's `max` is
// documented as the base the game multiplies, and ship-node-gate-check.js already compares all 77
// against the authored fields. Assert that bench's premise here rather than leaving it implicit.
const sb = H.browserSandbox();
const catalog = sb.ShipData.SHIP_NODE_CATALOG;
const nodeCount = Object.values(catalog).reduce((n, ship) => n + Object.keys(ship).length, 0);
const nonBase = [];
for (const [shipId, ship] of Object.entries(catalog)) {
  for (const [slot, node] of Object.entries(ship)) {
    if (!Number.isInteger(node.max) || node.max <= 0) {
      nonBase.push(`ship ${shipId} slot ${slot}: max ${node.max} is not a positive base cap`);
    }
  }
}
if (nonBase.length) nonBase.forEach(fail);
else pass(`all ${nodeCount} shipped install caps are positive integers, as base caps must be`);

console.log(failures ? `\n${failures} failure(s)` : '\nevery raisable cap is accounted for');
process.exit(failures ? 1 : 0);
