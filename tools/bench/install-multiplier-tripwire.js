'use strict';
// TRIPWIRE: installBonusGlobalMultiplier IS DEAD, AND MUST STAY HARMLESS WHILE IT IS.
//
//   node tools/bench/install-multiplier-tripwire.js
//
// `installBonusGlobalMultiplier()` computes the PowerGU1 factor the game applies to EVERY install
// node's bonus. Nothing calls it, so the fleet model does not apply it. That is currently harmless
// for one reason only: the function returns a literal 1 when `powerGU1Level()` is 0, and the gem
// store carries tree levels, node booleans and named upgrades but NOT per-GU levels -- so the level
// reads 0 for every account and the multiplier is 1.
//
// It stops being harmless the moment that input exists. Then every install bonus is silently
// understated by a factor the game does apply, with nothing failing -- the classic shape of this
// project's worst bugs (a wrong gate returns 0 rather than throwing; a missing operand renders as
// `(BigDouble)0`).
//
// Wiring it CHANGES NUMBERS, so CLAUDE.md deliberately leaves that as a decision rather than a
// quiet switch-on. This does not make that decision. It makes the day it matters LOUD:
//
//   1. The function must still be dead. If someone wires it, this fails and the entry describing
//      it as unwired is stale -- documentation claiming a gap that no longer exists is its own
//      defect, and this file has been wrong that way before.
//   2. Its "harmless" precondition must still hold: with no per-GU level available, it returns
//      exactly 1. If the gem store ever grows that input, this fails and says the model now has a
//      real gap.
//
// Same tripwire pattern as install nodes 12/13 in cap-raises.json: record the inert thing, and fail
// the moment it stops being inert.

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../webapp/public');
const src = fs.readFileSync(path.join(PUBLIC, 'shipsPage.js'), 'utf8');

let failures = 0;

// ---- 1. still dead? ---------------------------------------------------------------------------
// Count real references, excluding the definition line and comment lines: a name inside a comment
// is not a call, and this repo has mis-accused live code by counting those.
const refs = src.split('\n').filter((l) => {
  const t = l.trim();
  if (t.startsWith('//') || t.startsWith('*')) return false;
  if (t.startsWith('function installBonusGlobalMultiplier')) return false;
  return l.includes('installBonusGlobalMultiplier');
});
if (refs.length === 0) {
  console.log('ok    installBonusGlobalMultiplier is still unwired (the fleet model does not apply it)');
} else {
  console.log(`FAIL  installBonusGlobalMultiplier is now CALLED from ${refs.length} site(s):`);
  for (const r of refs) console.log(`        ${r.trim().slice(0, 100)}`);
  console.log('      If that is intentional, the CLAUDE.md entry calling it dead is now WRONG and');
  console.log('      must be updated -- and the fleet numbers it changes need re-validating.');
  failures++;
}

// ---- 2. is its harmless precondition intact? ---------------------------------------------------
// The whole reason a dead multiplier is survivable is that its input does not exist yet. If the gem
// store gains a per-GU level, the model acquires a real, silent gap.
const schema = fs.readFileSync(path.join(PUBLIC, 'storeSchema.js'), 'utf8');
const hasPerGuLevel = /\bpowerGU\d*Level\b|\bguLevels\b|\bperGuLevel\b/i.test(schema);
if (!hasPerGuLevel) {
  console.log('ok    the gem store still carries no per-GU level, so the multiplier reads 1 for every account');
} else {
  console.log('FAIL  the gem store now carries a per-GU level -- installBonusGlobalMultiplier would');
  console.log('      return a value other than 1, and NOTHING APPLIES IT. Every install bonus is');
  console.log('      now understated by a factor the game does apply. Wire it or state why not.');
  failures++;
}

// A dead function that cannot even be reached is worse than one that can: verify it parses and the
// level accessor it depends on still exists, so this tripwire is watching something real.
if (!/function powerGU1Level\s*\(/.test(src)) {
  console.log('FAIL  powerGU1Level() is gone -- this tripwire is watching a function that no longer');
  console.log('      has its input, so its "returns 1" guarantee is unverifiable.');
  failures++;
} else {
  console.log('ok    powerGU1Level() still exists, so the guarantee this watches is still meaningful');
}

console.log('');
if (failures) { console.log(`FAIL  ${failures} tripwire(s) fired`); process.exit(1); }
console.log('PASS  the unapplied install multiplier is still inert, and its precondition still holds');
