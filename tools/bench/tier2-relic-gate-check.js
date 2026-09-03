'use strict';
// Tier-2 relics must be INERT until the Power gem unlocks them, exactly as the live site treats
// them -- and must work normally once it does.
//
//   node tools/bench/tier2-relic-gate-check.js
//
// This is a measured behaviour of cifi-tools, not an inference from the gate table. Feeding the
// site `relics.t2r7` at 5, 40, or anything else while Power gem level < 3 returns BYTE-IDENTICAL
// output; at Power 3 it applies normally. This tool applied it unconditionally, and the gap was
// large rather than subtle: a level-70 Borge read 55.12m loot against the site's 16.54m -- a 70%
// overstatement -- with average stage 251.6 against 222.6.
//
// The relic MATH was never wrong. With Power 3 on both sides the two agree exactly (55,123,454 here
// against the site's 55.12m, stage 251.6202 against 251.6). Only the gate was missing, which is why
// this bench checks BOTH directions: a gate that is always closed would "pass" a locked-side-only
// test while silently discarding a relic the account has actually unlocked.
//
// SCOPE, and why it is narrow. Other gated categories are deliberately NOT gated in the sim,
// because the site was measured not to gate them there: a Borge build with `gadgets.wrench: 60` and
// no gem state matches the site within 0.33%, despite the wrench being nominally Exodus-4 gated.
// Any additional category needs the same measurement first.

const H = require('./harness.js');

const sb = H.browserSandbox();

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

const GATED = [];
for (const [key, gate] of Object.entries(sb.UPGRADE_GATES || {})) {
  if (/^upgrades\.relics\.t2r\d+$/.test(key)) GATED.push({ key, gate });
}
if (!GATED.length) fail('no tier-2 relic gates found in UPGRADE_GATES');

function resolve(key, level, gemStates) {
  return sb.HunterSim.resolveParam(key, {
    overrides: { [key]: level },
    gemPlannerStore: { gemStates },
  });
}

for (const { key, gate } of GATED) {
  // 1. LOCKED: no gem state at all, and the gate's tree one level short.
  const noGems = resolve(key, 40, {});
  const short = resolve(key, 40, { [gate.gem]: { level: gate.level - 1, nodes: [], upgrades: {} } });
  if (noGems !== 0) {
    fail(`${key} resolves to ${noGems} with no gem state -- the site ignores it below `
      + `${gate.gem} ${gate.level}`);
  } else if (short !== 0) {
    fail(`${key} resolves to ${short} at ${gate.gem} ${gate.level - 1} -- one level short of its gate`);
  } else {
    pass(`${key} is inert below ${gate.gem} ${gate.level}, as the site treats it`);
  }

  // 2. UNLOCKED: the gate met, and above it. A permanently-closed gate would discard a relic the
  // account really owns, which is the opposite failure and just as wrong.
  const atGate = resolve(key, 40, { [gate.gem]: { level: gate.level, nodes: [], upgrades: {} } });
  const above = resolve(key, 40, { [gate.gem]: { level: gate.level + 2, nodes: [], upgrades: {} } });
  if (atGate !== 40) {
    fail(`${key} resolves to ${atGate} at ${gate.gem} ${gate.level} -- the gate is met, it must apply`);
  } else if (above !== 40) {
    fail(`${key} resolves to ${above} above its gate`);
  } else {
    pass(`${key} applies in full at ${gate.gem} ${gate.level} and above`);
  }
}

// 3. The gate must not leak onto TIER-1 relics, which the site applies with no gem state at all.
const t1 = resolve('upgrades.relics.r4', 20, {});
if (t1 !== 20) {
  fail(`tier-1 relic r4 resolves to ${t1} with no gem state -- only tier-2 relics are gated here, `
    + 'and a Borge build with r4 and no gems matches the site');
} else {
  pass('tier-1 relics are unaffected by the tier-2 gate');
}

console.log(failures ? `\n${failures} failure(s)` : '\ntier-2 relics are gated exactly as the site gates them');
process.exit(failures ? 1 : 0);
