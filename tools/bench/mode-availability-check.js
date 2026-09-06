'use strict';
// EVERY MODE THE UI OFFERS FOR A HUNTER MUST BE RUNNABLE FOR THAT HUNTER.
//
// `bossTimeless` pins Timeless Mastery, and the ATTRIBUTE IDS DIFFER PER HUNTER:
//     borge  timeless  cap 5  "Timeless Mastery"
//     ozzy   timeless  cap 5  "Timeless Mastery"
//     knox   time      cap 5  "Timeless Mastery"
// The mode hard-coded the id `timeless`, so every Knox run threw `Cannot pin unknown attribute
// "timeless"` out of applyPins -- a hard crash on one of the four modes the dropdown ships.
//
// THE FIRST VERSION OF THIS FILE ASSERTED THE WRONG THING. Reading the id alone, I concluded Knox
// has no Timeless Mastery and wrote a check demanding the mode be HIDDEN for Knox. Knox has it.
// That check would have locked a working feature out of a hunter and preserved a naming
// inconsistency as though it were a fact about the game. A test written from the same wrong
// assumption as the fix does not verify the fix -- it freezes it.
//
// It survived because two of the four modes had NO quality coverage at all: of 182 fixtures, 168
// are `loot` and 14 are `push`. `boss` and `bossTimeless` were run by no gate whatsoever.
//
// This check is deliberately FAST (no optimizer) so it can run on every change, and it asserts the
// property in both directions:
//   - every mode is available for EVERY hunter, since all three have every pinned node
//   - each pin RESOLVES to that hunter's own id (timeless / timeless / time)
//   - a pin that cannot resolve throws rather than silently doing nothing

const H = require('./harness.js');

const HUNTERS = ['borge', 'ozzy', 'knox'];
let failures = 0;
let checked = 0;
const fail = (m) => { failures++; console.log('FAIL  ' + m); };
const ok = (m) => console.log('ok    ' + m);

const defs = H.hunterDefs();
const Objective = H.Objective;
const ALL = Object.keys(Objective.MODES);
const EXPECTED_PIN_IDS = { borge: 'timeless', ozzy: 'timeless', knox: 'time' };

for (const hunter of HUNTERS) {
  const attributes = defs[hunter].attributes;
  const available = Objective.modesForAttributes(attributes);
  const names = Object.keys(available);
  console.log('');
  console.log(`${hunter} (${attributes.length} attributes): ${names.join(', ')}`);

  // EVERY mode, for EVERY hunter. All three have Timeless Mastery, so nothing should be hidden.
  checked++;
  if (names.length === ALL.length) ok(`${hunter} has all ${ALL.length} modes`);
  else fail(`${hunter} has only ${names.length} of ${ALL.length} modes (${names.join(', ')})`);

  for (const m of ALL) {
    checked++;
    let pins;
    try { pins = Objective.pinnedAttrsFor(m, attributes); }
    catch (e) { failures++; console.log(`FAIL  ${hunter}: "${m}" pin does not resolve -- ${e.message}`); continue; }
    const ids = new Set(attributes.map((a) => a.id));
    const bad = pins.filter((id) => !ids.has(id));
    if (bad.length) fail(`${hunter}: "${m}" resolved to non-existent id(s) ${bad.join(', ')}`);
    else ok(`${hunter}: "${m}" pins [${pins.join(', ') || 'nothing'}]`);
  }

  // The pin must resolve to THIS hunter's id, which is the whole point.
  checked++;
  const got = Objective.pinnedAttrsFor('bossTimeless', attributes);
  const want = EXPECTED_PIN_IDS[hunter];
  if (got.length === 1 && got[0] === want) ok(`${hunter}: bossTimeless pins "${want}" (this hunter's own id)`);
  else fail(`${hunter}: bossTimeless pinned [${got.join(', ')}], expected "${want}"`);

  // And it must be a real, capped node -- a pin onto an uncapped attribute would be meaningless.
  checked++;
  const node = attributes.find((a) => a.id === want);
  if (node && node.label === 'Timeless Mastery' && Number.isFinite(node.maxLevel)) {
    ok(`${hunter}: "${want}" is Timeless Mastery, cap ${node.maxLevel}`);
  } else fail(`${hunter}: "${want}" is not a capped Timeless Mastery node`);
}

// A pin that cannot resolve must THROW, never quietly return nothing -- a silent empty pin would
// make bossTimeless identical to boss while the UI presents them as different answers.
console.log('');
checked++;
{
  let threw = false;
  try { Objective.pinnedAttrsFor('bossTimeless', [{ id: 'x', label: 'Not It', maxLevel: 1 }]); }
  catch (e) { threw = /no attribute named/.test(e.message); }
  if (threw) ok('an unresolvable pin throws instead of silently pinning nothing');
  else fail('an unresolvable pin did NOT throw');
}
checked++;
{
  let threw = false;
  try { Objective.pinnedAttrsFor('bossTimeless'); } catch (e) { threw = true; }
  if (threw) ok('pinnedAttrsFor refuses to resolve a pin without an attribute list');
  else fail('pinnedAttrsFor returned a pin with no attribute list -- it cannot know the id');
}

console.log('');
if (!checked) { console.log('FAIL  compared nothing'); process.exit(1); }
if (failures) { console.log(`FAIL  ${failures} of ${checked} check(s) failed`); process.exit(1); }
console.log(`PASS  ${checked} checks across ${HUNTERS.length} hunters and ${ALL.length} modes`);
