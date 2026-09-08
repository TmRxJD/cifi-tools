'use strict';
// GAME NOTATION IN, GAME NOTATION OUT -- and the two must agree.
//
//   node tools/bench/big-number-io-check.js
//
// Progression counters run past 2e17 ("Operations Completed" reads 227254992551159000 on a real
// account), so the inputs accept and display the game's own notation instead of an 18-digit
// number. That makes `parseBig` the inverse of `fmtBig`, and an inverse that disagrees with its
// forward function corrupts data SILENTLY: the user sees a plausible number, and the stored value
// is wrong by a factor of 1000.
//
// The one rule that matters: ANYTHING fmtBig CAN PRINT, parseBig MUST READ BACK. They share one
// suffix ladder in one file for that reason, and this check would fail the moment someone gave
// either its own copy.
const H = require('./harness.js');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const sb = H.browserSandbox();
const CF = sb.CostFormulas;
if (!CF || typeof CF.fmtBig !== 'function' || typeof CF.parseBig !== 'function') {
  console.log('FAIL  CostFormulas does not export both fmtBig and parseBig');
  process.exit(1);
}

// 1. ROUND TRIP across the whole ladder. The tolerance is 1% because fmtBig prints two decimals,
// so "227.25qa" genuinely cannot carry more precision than that -- the check is that the MAGNITUDE
// survives, which is the failure that matters (a wrong suffix is a 1000x error, not a 1% one).
const LADDER = [1, 999, 1000, 1500, 999999, 1e6, 2.5e9, 7.17e12, 1e15, 2.2725e17, 5e20, 1e24, 3e30];
for (const n of LADDER) {
  const printed = CF.fmtBig(n);
  const back = CF.parseBig(printed);
  const ok = back !== null && Math.abs(back - n) / Math.max(1, Math.abs(n)) < 0.01;
  check(`round trip ${n.toExponential(2)} -> "${printed}" -> ${back}`, ok);
}

// 2. THE REAL VALUE FROM THE SCREENSHOT, end to end.
const OPS = 227254992551159000;
const opsPrinted = CF.fmtBig(OPS);
check(`227254992551159000 displays as "${opsPrinted}"`, /^227\.25/.test(opsPrinted), opsPrinted);
check('and reads back within 1%', Math.abs(CF.parseBig(opsPrinted) - OPS) / OPS < 0.01);

// 3. WHAT A USER MIGHT ACTUALLY TYPE. Case, spacing, commas and scientific notation all appear in
// pasted values; none may be rejected, and none may silently become something else.
const ACCEPT = [
  ['227.25qa', 2.2725e17], ['227.25QA', 2.2725e17], [' 1.5m ', 1.5e6],
  ['1,234,567', 1234567], ['3e12', 3e12], ['3E12', 3e12], ['0', 0], ['42', 42],
  ['1k', 1000], ['2.5b', 2.5e9], ['1.5t', 1.5e12],
];
for (const [text, want] of ACCEPT) {
  const got = CF.parseBig(text);
  check(`parse ${JSON.stringify(text)} -> ${want}`, got !== null && Math.abs(got - want) < Math.max(1e-9, Math.abs(want) * 1e-12), `got ${got}`);
}

// 4. GARBAGE RETURNS null, NEVER 0. A silent zero is this project's standing trap: it makes an
// unparsed value look like a deliberate one, and here it would wipe a real counter on a typo.
const REJECT = ['', '   ', 'abc', 'qa', '1.2.3', '5zz', 'e12', '--3', 'NaN', null, undefined, {}, []];
for (const bad of REJECT) {
  const got = CF.parseBig(bad);
  check(`reject ${JSON.stringify(bad)}`, got === null, `got ${got}`);
}

// 5. THE LADDERS ARE THE SAME ONE. Checked by behaviour rather than by reading the source: every
// suffix fmtBig emits must be one parseBig accepts. A second copy of the ladder in either function
// is the drift this file exists to catch.
let suffixes = 0;
for (let mag = 1; mag < 12; mag++) {
  const n = Math.pow(10, 3 * mag) * 1.5;
  const printed = CF.fmtBig(n);
  const suffix = printed.replace(/^[\d.]+/, '');
  if (!suffix || /e/.test(printed)) continue;   // past the ladder, fmtBig switches to exponential
  suffixes++;
  check(`suffix "${suffix}" (1e${3 * mag}) is readable`, CF.parseBig(printed) !== null, printed);
}
check('the ladder was actually exercised', suffixes >= 8, `only ${suffixes} suffix(es) seen`);

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s): big-number input and display do not agree.`);
  process.exit(1);
}
console.log('PASS  parseBig is the inverse of fmtBig across the whole ladder, and rejects garbage');
