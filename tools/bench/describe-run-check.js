'use strict';
// describeRun IS THE THING REPORTS QUOTE, SO A WRONG LABEL IN IT BECOMES A WRONG INVESTIGATION.
//
// It exists because reading raw evaluator fields produced two opposite wrong diagnoses of the same
// Knox run in one session. It then produced a third one itself: labelling a build that reaches
// stage 303.8 and kills 31.7% of the time as "boss at 400" -- a boss it cannot reach, so the label
// and the kill rate printed beside it described different fights.
//
// Every case below is a REAL measured run, named, so a future change has to keep agreeing with
// runs that actually happened rather than with a hand-invented table.

const path = require('path');
const H = require(path.join(__dirname, 'harness.js'));

const D = H.Objective.describeRun;
const INTERVAL = H.Objective.BOSS_INTERVAL;

let failures = 0;
let checked = 0;

function check(what, got, want) {
  checked++;
  const ok = got === want;
  if (!ok) { failures++; console.log(`FAIL  ${what}\n        got  ${got}\n        want ${want}`); }
  else console.log(`ok    ${what} = ${got}`);
}

function run(name, result, expect) {
  console.log(`\n-- ${name}`);
  const d = D(result);
  console.log(`   ${d.summary}`);
  for (const k of Object.keys(expect)) check(`${name}.${k}`, d[k], expect[k]);
}

console.log(`BOSS_INTERVAL = ${INTERVAL}`);

// borge@73, the community reference build. Clears the stage-300 boss about a third of the time,
// which is why its average run ends just past 300. It has NO kill rate against the 400 boss.
run('borge@73 reference', {
  minStage: 297.1, avgStage: 300.4963, maxStage: 303.8,
  bossKillRate: 31.7, bossHpPercent: 3.43, lootPerMin: 5006701219,
}, { regime: 'kills-boss', bossStage: 300, reachesBoss: true, killsBoss: true });

// borge@73, what the optimizer returns. Reaches the same boss, removes a third of its HP, dies.
run('borge@73 optimizer', {
  minStage: 296.0, avgStage: 299.9032, maxStage: 300.0,
  bossKillRate: 0, bossHpPercent: 67.44, lootPerMin: 3032202766,
}, { regime: 'reaches-cannot-kill', bossStage: 300, reachesBoss: true, killsBoss: false });

// The Knox run that was misread twice. Reaches the boss, does no damage, dies there.
run('knox reaches-cannot-kill', {
  minStage: 91.0, avgStage: 96.1, maxStage: 100.0,
  bossKillRate: 0, bossHpPercent: 99.996, lootPerMin: 3078,
}, { regime: 'reaches-cannot-kill', bossStage: 100, reachesBoss: true, killsBoss: false });

// A build that never meets a boss at all must not be labelled with one.
run('below the first boss', {
  minStage: 80.0, avgStage: 92.4, maxStage: 99.7,
  bossKillRate: 0, bossHpPercent: 0, lootPerMin: 100,
}, { regime: 'cannot-reach-boss', bossStage: 0, reachesBoss: false, killsBoss: false });

// Exactly on a boundary and dying there: the boss met is that boundary, not the next one.
run('dies exactly on the boundary', {
  minStage: 190.0, avgStage: 199.7, maxStage: 200.0,
  bossKillRate: 0, bossHpPercent: 55.0, lootPerMin: 100,
}, { regime: 'reaches-cannot-kill', bossStage: 200, reachesBoss: true, killsBoss: false });

// THE REGRESSION THIS FILE WAS WRITTEN FOR. Under the old `ceil` rule this said 400.
console.log('\n-- summary must never name a boss deeper than the run reached');
{
  const d = D({ minStage: 297, avgStage: 300.5, maxStage: 303.8,
    bossKillRate: 31.7, bossHpPercent: 3.43, lootPerMin: 1 });
  checked++;
  if (/boss contested 400|boss at 400/.test(d.summary)) {
    failures++;
    console.log(`FAIL  summary names boss 400 for a run reaching 303.8:\n        ${d.summary}`);
  } else console.log(`ok    names boss ${d.bossStage}, not 400`);
}

// A malformed result must THROW, never return a plausible-looking description.
console.log('\n-- malformed input must throw');
for (const [what, bad] of [
  ['null', null],
  ['missing bossHpPercent', { avgStage: 1, maxStage: 1, minStage: 1, bossKillRate: 0 }],
  ['string stage', { avgStage: '1', maxStage: 1, minStage: 1, bossKillRate: 0, bossHpPercent: 0 }],
]) {
  checked++;
  let threw = false;
  try { D(bad); } catch (e) { threw = true; }
  if (threw) console.log(`ok    throws on ${what}`);
  else { failures++; console.log(`FAIL  did NOT throw on ${what}`); }
}

console.log('');
if (!checked) { console.log('FAIL  describe-run-check compared nothing'); process.exit(1); }
if (failures) { console.log(`FAIL  ${failures} of ${checked} assertion(s) failed`); process.exit(1); }
console.log(`PASS  ${checked} assertions over 5 measured runs + 3 malformed inputs`);
