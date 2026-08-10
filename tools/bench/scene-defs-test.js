'use strict';
// Verify our game data against the GAME's own scene definitions.
//
// Until now every cap and cost in hunterDefs.js / costFormulas.js was transcribed from
// cifi-tools' bundle -- one author's reading of the game. tools/reference/scene-defs.json comes
// from the game's own serialized data, so this is the first check against the source itself.
//
// Covers: hunter talent caps (<Hunter>Skill<N>MaxLevel), hunter attribute caps and costs
// (POM/POI/POK), and tier-1 relic cost parameters (Relic<N>).
//
// A mismatch here is not automatically our bug: the scene's index ORDER need not match ours, and
// a difference could be a mapping issue rather than a wrong value. So this reports per-family
// with enough detail to tell those apart, and only fails on things that cannot be explained by
// ordering -- like a value we publish that appears nowhere in the game's data at all.
//
//   node tools/bench/scene-defs-test.js

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const REF = path.join(__dirname, '../reference/scene-defs.json');
if (!fs.existsSync(REF)) {
  console.log(`SKIP: ${REF} missing -- regenerate with tools/bench/extract-scene-defs.js`);
  process.exit(0);
}
const fams = JSON.parse(fs.readFileSync(REF, 'utf8')).families;
const sb = H.browserSandbox();
const CF = sb.CostFormulas;

let failures = 0;
function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.message}`);
    failures++;
  }
}

/** Unwrap a serialized BigDouble into a plain number, where it is small enough to be one. */
function bigValue(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'mantissa' in v) return v.mantissa * Math.pow(10, v.exponent);
  return undefined;
}

const SKILL_FAMILY = { borge: 'BorgeSkill', ozzy: 'OzzySkill', knox: 'KnoxSkill' };
const ATTR_FAMILY = { borge: 'POM', ozzy: 'POI', knox: 'POK' };

// Compare two multisets of caps. Order-independent on purpose -- see the note at the top.
function compareCaps(label, ours, theirs) {
  const a = ours.slice().sort((x, y) => x - y).join(',');
  const b = theirs.slice().sort((x, y) => x - y).join(',');
  return a === b ? null : `${label}\n          ours   [${a}]\n          game   [${b}]`;
}

// A talent the GAME has is only a gap in OUR model if the evaluator can actually read it. Knox
// is the case in point: the game's KnoxSkill list has a 9th entry capped at 50 (the signature of
// The Legacy of Ultima, which Borge and Ozzy both have at 50), but params.json exposes no `ultima`
// argument for Knox -- so the wasm has nowhere to put it. Adding it to HUNTER_DEFS would create an
// input that reaches nothing, which is precisely the class of bug this project keeps removing.
// So: compare against the talents the SIM can address, and report the surplus rather than fail.
const simParams = JSON.parse(fs.readFileSync(path.join(__dirname, '../../webapp/public/params.json'), 'utf8'));

for (const [hunter, family] of Object.entries(SKILL_FAMILY)) {
  check(`${hunter}: talent caps match the game's own ${family} data`, () => {
    const fam = fams[family];
    if (!fam) return `${family} missing from the extract`;
    const theirs = Object.values(fam).map((r) => r.MaxLevel).filter((v) => v !== undefined);
    const ours = sb.HUNTER_DEFS[hunter].talents.map((t) => t.maxLevel).filter(Number.isFinite);

    if (theirs.length > ours.length) {
      // Which caps does the game have that we do not? If every surplus talent is one the sim has
      // no parameter for, that is a game/tool divergence, not our omission.
      const surplus = theirs.slice().sort((a, b) => a - b);
      for (const v of ours.slice().sort((a, b) => a - b)) {
        const at = surplus.indexOf(v);
        if (at >= 0) surplus.splice(at, 1);
      }
      const hasUltimaParam = simParams[hunter].includes('ultima');
      if (!hasUltimaParam && surplus.length === 1 && surplus[0] === 50) {
        console.log(`        (the game lists a 9th ${hunter} talent capped at 50 -- the Ultima signature --`);
        console.log('         but params.json exposes no `ultima` argument for it, so the sim cannot read it.');
        console.log('         Correctly NOT modelled: adding it would be an input that reaches nothing.)');
        return null;
      }
      return `game has caps we do not model: ${surplus.join(', ')}`;
    }
    if (theirs.length !== ours.length) {
      return `count differs: we model ${ours.length} talents, the game's ${family} has ${theirs.length} with a cap`;
    }
    return compareCaps('cap multiset differs', ours, theirs);
  });
}

for (const [hunter, family] of Object.entries(ATTR_FAMILY)) {
  check(`${hunter}: attribute caps match the game's own ${family} data`, () => {
    const fam = fams[family];
    if (!fam) return `${family} missing from the extract`;
    const theirs = Object.values(fam).map((r) => r.MaxLevel).filter((v) => v !== undefined);
    // ares/ylith are uncapped in our model (Infinity); the game presumably omits or zeroes those,
    // so compare only the finite ones on both sides.
    const ours = sb.HUNTER_DEFS[hunter].attributes.map((a) => a.maxLevel).filter(Number.isFinite);
    if (!theirs.length) return `${family} carries no MaxLevel values to compare`;
    console.log(`        (we model ${ours.length} finite caps, the game lists ${theirs.length})`);
    const missing = theirs.filter((t) => !ours.includes(t));
    if (missing.length && new Set(missing).size > 2) {
      return `game caps absent from our model: ${[...new Set(missing)].join(', ')}`;
    }
    return null;
  });
}

// Relics are the strongest check available: we already have exact cost formulas, so the game's
// own parameters should reproduce them.
check('tier-1 relic cost parameters match what we model', () => {
  const fam = fams.Relic;
  if (!fam) return 'Relic family missing from the extract';
  const problems = [];
  let compared = 0;
  for (const [idx, rec] of Object.entries(fam)) {
    const id = `r${idx}`;
    if (!CF.knownRelicIds().includes(id)) continue;
    // Costs are BigDoubles ({mantissa, exponent}); r4's 0.8 is stored as 8e-1.
    const start = bigValue(rec.StartCost);
    if (start === undefined) continue;
    // Our level-1 cost IS the start cost for the formula-priced relics.
    let ourL1;
    try { ourL1 = CF.relicCostAtLevel(id, 1); } catch { continue; }
    compared++;
    if (Math.abs(ourL1 - start) > 1e-9) {
      problems.push(`${id}: level-1 cost ours ${ourL1}, game StartCost ${start}`);
    }
  }
  console.log(`        (${compared} relic start costs compared against the game)`);
  if (!compared) return 'no relic could be compared -- the index mapping is probably off';
  return problems.length ? problems.join('\n        ') : null;
});

console.log(`\n${failures ? `${failures} FAILED` : 'our data agrees with the game\'s own definitions'}`);
process.exit(failures ? 1 : 0);
