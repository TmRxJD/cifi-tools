'use strict';
// The boss objective aims at the NEXT boss the account has not beaten -- not at whatever boss the
// run happens to reach.
//
//   node tools/bench/boss-target-check.js
//
// WHY THIS MATTERS. Bosses stand every 100 stages and the first kill of one is what changes that
// stage's rewards, so "beat the next one" is the question a player asks. The objective used to
// maximise the kill rate on whichever boss the run reached, which for an account past stage 100 is
// a boss it has ALREADY KILLED -- a build for a fight there is no reason to take.
//
// The evaluator has no boss-target input to lean on: `stage` ("Highest Stage Reached") is a POWER
// multiplier, not a selector. Measured on one fixed Knox build, varying only that input:
//
//     stage    0 ->  killRate  0.0   loot   2,733
//     stage  101 ->  killRate 93.5   loot  64,031
//     stage  300 ->  killRate 99.4   loot  93,221
//
// while the run still ends around stage 100-106 throughout. So whether the TARGET boss is being
// fought has to be read off how deep the run gets, which is what the tier-0 branch does.

const H = require('./harness.js');
const O = H.Objective;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} got ${actual}, want ${expected}`);
};

// --- the target itself -----------------------------------------------------------------------
check('never beaten a boss (stage 0)   -> target 100', O.bossTargetFor(0), 100);
check('stage 99, still short of the first -> target 100', O.bossTargetFor(99), 100);
check('stage 100 exactly, boss beaten  -> target 200', O.bossTargetFor(100), 200);
check('stage 101 -> target 200', O.bossTargetFor(101), 200);
check('stage 104 -> target 200', O.bossTargetFor(104), 200);
check('stage 199 -> target 200', O.bossTargetFor(199), 200);
check('stage 200 -> target 300', O.bossTargetFor(200), 300);
check('garbage input floors to the first boss', O.bossTargetFor(undefined), 100);

// --- the ordering ----------------------------------------------------------------------------
const ctx = { bossTarget: 200 };
const S = (r) => O.scoreFor('boss', r, ctx);

// A build that cannot reach the target is ranked purely on depth toward it.
const shallow = { maxStage: 104, avgStage: 102, bossKillRate: 93.5, bossHpPercent: 0.1, lootPerMin: 64000 };
const deeper = { maxStage: 150, avgStage: 148, bossKillRate: 0, bossHpPercent: 100, lootPerMin: 10 };
check('a deeper build outranks a shallower one that kills an EARLIER boss',
  S(deeper) > S(shallow), true);

// Reaching the target at all beats any amount of progress short of it.
const reached = { maxStage: 200, avgStage: 199, bossKillRate: 0, bossHpPercent: 96, lootPerMin: 1 };
check('reaching the target outranks every build that falls short', S(reached) > S(deeper), true);

// At the target, less remaining boss HP wins.
const closer = { ...reached, bossHpPercent: 40 };
check('at the target, less boss HP left wins', S(closer) > S(reached), true);

// A kill outranks everything short of one, and loot only breaks ties between equal kill rates.
const kills = { maxStage: 205, avgStage: 201, bossKillRate: 12, bossHpPercent: 0, lootPerMin: 1 };
check('any kill outranks every non-kill', S(kills) > S(closer), true);
const killsMoreLoot = { ...kills, lootPerMin: 1e9 };
const killsBetter = { ...kills, bossKillRate: 12.1 };
check('a better kill rate beats more loot', S(killsBetter) > S(killsMoreLoot), true);
check('at equal kill rate, more loot wins', S(killsMoreLoot) > S(kills), true);

// --- target-agnostic fallback -----------------------------------------------------------------
// The loot cross-seed clears the target deliberately: it wants the wall capping THIS build, which
// is whatever boss the run reaches, not the next one the player has not beaten.
const agnostic = (r) => O.scoreFor('boss', r, { bossTarget: null });
check('with no target, a shallow build that KILLS outranks a deeper one that does not',
  agnostic(shallow) > agnostic(deeper), true);

console.log(failures
  ? `\n${failures} failure(s): the boss objective is not aiming where it should`
  : '\nthe boss objective aims at the next unbeaten boss, and falls back to the reachable one');
process.exit(failures ? 1 : 0);
