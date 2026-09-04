/**
 * Does `creation_galvTrinketsCount` carry the SUM of trinket levels or the COUNT of owned trinkets?
 *
 *   node tools/bench/trinket-semantics-check.js [live-bundle.js]
 *
 * This was an open question in CLAUDE.md for a long time, and deliberately so: the parameter's own
 * name says "Count", our resolver SUMS, and on the reference account those differ by 200x
 * (sum-of-levels 605 against three owned trinkets). A 200x error on a sim parameter is not
 * something to settle by guessing, and it could not be settled by A/B-ing the site either --
 * trinkets are +0.001 per level, so even at level 5000 the effect sits under the display rounding
 * and every black-box probe returns "inert", which is not an answer.
 *
 * The bundle answers it directly. cifi-tools derives the parameter as:
 *
 *   if (creation_gem5) { let e = 0; l?.trinkets && (e = Object.values(l.trinkets)
 *                          .reduce((e, t) => e + (t || 0), 0)); h = e } else h = 0
 *
 * `reduce((a, b) => a + b)` over the VALUES is a sum of levels. The name is a misnomer -- the
 * Trinkets page agrees with the code and disagrees with the name, displaying its own total as
 * `x${(1 + .001 * e).toFixed(3)}` over that same accumulated sum. So our resolver is correct and
 * nothing needed changing; what was missing was the proof.
 *
 * Two assertions, because the bundle can change and our resolver can drift independently:
 *   1. (only with a bundle path) the site's derivation is still a reduce-sum, not a length/count.
 *   2. our resolveParam returns the SUM, is gated on creation gem node 5, and treats one trinket
 *      at level 3 identically to three trinkets at level 1 -- the pair that separates the two
 *      readings (sum 3 either way; count 1 vs 3).
 */

const fs = require('fs');
const H = require('./harness.js');

const sb = H.browserSandbox();
const HunterSim = sb.HunterSim;
if (!HunterSim || typeof HunterSim.resolveParam !== 'function') {
  throw new Error('HunterSim.resolveParam is not exported; this bench cannot run');
}

const KEY = 'upgrades.gems_nodes.creation_galvTrinketsCount';
const ALL_NODES = [true, true, true, true, true, true];
const UNLOCKED = { gemStates: { creation: { level: 4, nodes: ALL_NODES, upgrades: {} } } };
const LOCKED = { gemStates: { creation: { level: 4, nodes: [false, false, false, false, false, false], upgrades: {} } } };

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} got ${actual}, want ${expected}`);
};

const resolve = (trinkets, gemPlanner) =>
  HunterSim.resolveParam(KEY, { upgrades: { trinkets }, gemPlannerStore: gemPlanner });

// --- 1. the site's own derivation -------------------------------------------------------------
const bundlePath = process.argv[2];
if (bundlePath) {
  const src = fs.readFileSync(bundlePath, 'utf8');
  const at = src.indexOf(`"${KEY}"===`);
  if (at < 0) {
    console.log(`FAIL bundle does not mention ${KEY} -- has the parameter been renamed?`);
    failures++;
  } else {
    const body = src.slice(at, at + 400);
    // A sum reduces the VALUES with `+`. A count would be `.length`, `Object.keys(...).length`,
    // or a reduce whose step adds 1 rather than the value.
    const isSum = /trinkets\)\.reduce\(\(\((\w),(\w)\)=>\1\+\(\2\|\|0\)\)/.test(body)
      || /Object\.values\([^)]*trinkets\)\.reduce/.test(body);
    const looksLikeCount = /trinkets[^;]{0,80}\.length/.test(body)
      || /trinkets[^;]{0,120}=>\s*\w\+1/.test(body);
    check('bundle derivation is a reduce-SUM over trinket values', isSum, true);
    check('bundle derivation is NOT a count', looksLikeCount, false);
    if (!isSum || looksLikeCount) console.log(`     derivation read: ${body.slice(0, 240)}`);
  }
} else {
  console.log('note  no bundle path given -- skipping the site-side assertion');
  console.log('      fetch it from cifi-tools.com/assets/index-*.js and pass the path to check it');
}

// --- 2. our resolver ---------------------------------------------------------------------------
// The decisive pair: identical sum, different count.
const oneAtThree = resolve({ last_handbook: 3 }, UNLOCKED);
const threeAtOne = resolve(
  { last_handbook: 1, transmission_amplifier: 1, ouro_codex: 1 }, UNLOCKED);

check('one trinket at level 3 -> 3 (the SUM)', oneAtThree, 3);
check('three trinkets at level 1 -> 3 (the SUM)', threeAtOne, 3);
check('the two are equal, so we SUM rather than COUNT', oneAtThree === threeAtOne, true);
check('levels add across trinkets (200+300+105)',
  resolve({ last_handbook: 200, transmission_amplifier: 300, ouro_codex: 105 }, UNLOCKED), 605);
check('gated: locked creation node 5 -> 0',
  resolve({ last_handbook: 200, transmission_amplifier: 300, ouro_codex: 105 }, LOCKED), 0);
check('no trinkets -> 0', resolve({}, UNLOCKED), 0);

console.log(failures
  ? `\n${failures} failure(s): trinket semantics no longer match the original tool`
  : '\ntrinket semantics settled: SUM of levels, gated on creation gem node 5 -- matching the site');
process.exit(failures ? 1 : 0);
