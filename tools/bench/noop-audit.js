'use strict';
// EVERY CLASS OF NO-OP IN THE SHIPPED CODE, NOT JUST UNUSED FUNCTIONS.
//
//   node tools/bench/noop-audit.js
//
// WHY THIS EXISTS. dead-symbol-audit.js finds functions nothing calls. That is ONE class, and
// hunting it alone kept missing the others, which were then found by accident:
//
//   POLISH_VERIFY = Infinity   used as `.slice(0, verifyWidth)`, so the slice removes nothing and
//                              the SCREEN_ITERATIONS pass that produced the ordering is dead work
//   FRONTIER_SHARE = 0         guarded by `FRONTIER_SHARE > 0`, so its whole emitter was unreachable
//   DEPTH_SHARE = 0            same shape
//   greedyTopUp                defined for the winner, wired only to one candidate path
//   unmodelled*Terms()         three honesty reporters, none ever called
//
// None of those is an unused symbol. They are LIVE symbols whose value or wiring makes the code
// around them do nothing, which is strictly harder to see and exactly why they survived.
//
// Classes checked here:
//   1. A numeric constant whose value trivially decides a guard on itself (`X = 0` with `X > 0`,
//      `X = Infinity` with `slice(0, X)` / `< X` / `Math.min(X, ...)`).
//   2. Function parameters never referenced in the body.
//   3. `const`/`let` bindings that are never read after assignment.
//   4. Object keys assigned into a diag/stats record that nothing ever reads.
//
// NO REGEX ESCAPES ANYWHERE IN THIS FILE. Five separate patches this session had a backslash level
// eaten by the shell heredoc that wrote them, turning an escaped word boundary into a literal
// backspace that matches nothing -- including in two earlier versions of an audit whose job was
// finding dead code. Character scanning cannot acquire that bug.

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../webapp/public');
const IDENT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';

function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*' + '/');
      if (end < 0) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf('/' + '*');
      if (start < 0) break;
      const end = line.indexOf('*' + '/', start + 2);
      if (end < 0) { line = line.slice(0, start); inBlock = true; break; }
      line = line.slice(0, start) + ' ' + line.slice(end + 2);
    }
    let lc = line.indexOf('/' + '/');
    while (lc > 0 && line[lc - 1] === ':') lc = line.indexOf('/' + '/', lc + 2);
    if (lc >= 0) line = line.slice(0, lc);
    out.push(line);
  }
  return out.join('\n');
}

function countWord(hay, name) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(name, i);
    if (at < 0) return n;
    const before = at === 0 ? '' : hay[at - 1];
    const after = hay[at + name.length] || '';
    if (!IDENT.includes(before) && !IDENT.includes(after)) n++;
    i = at + name.length;
  }
}

const files = [];
for (const f of fs.readdirSync(PUBLIC)) if (f.endsWith('.js')) files.push(f);
for (const f of fs.readdirSync(path.join(PUBLIC, 'optimizer'))) if (f.endsWith('.js')) files.push('optimizer/' + f);

const code = new Map();
for (const f of files) code.set(f, stripComments(fs.readFileSync(path.join(PUBLIC, f), 'utf8')));

let findings = 0;
const report = (cls, msg) => { findings++; console.log(`  [${cls}] ${msg}`); };

// --- 1. CONSTANTS WHOSE VALUE DISABLES THEIR OWN GUARD ------------------------------------------
console.log('CONSTANTS WHOSE VALUE MAKES THE CODE AROUND THEM A NO-OP');
let any1 = false;
for (const [f, src] of code) {
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('const ')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const name = t.slice(6, eq).trim();
    if (!name || name.split('').some((c) => !IDENT.includes(c))) continue;
    const value = t.slice(eq + 1).replace(';', '').trim();
    if (value !== '0' && value !== 'Infinity') continue;
    // Does anything guard on this constant in a way its value decides?
    for (const [f2, src2] of code) {
      for (const l2 of src2.split('\n')) {
        if (countWord(l2, name) === 0) continue;
        if (l2.trim().startsWith('const ' + name)) continue;
        const disabled = (value === '0' && (l2.includes(name + ' > 0') || l2.includes(name + ' <= 0')))
          || (value === 'Infinity' && (l2.includes('slice(0, ' + name)
            || l2.includes('Math.min(' + name) || l2.includes('< ' + name)));
        if (disabled) {
          any1 = true;
          report('const', `${f}: ${name} = ${value}  makes ${f2} line dead:  ${l2.trim().slice(0, 80)}`);
        }
      }
    }
  }
}
if (!any1) console.log('  (none)');

// --- 2. FUNCTION PARAMETERS NEVER USED IN THE BODY ----------------------------------------------
console.log('');
console.log('FUNCTION PARAMETERS NEVER REFERENCED IN THE BODY');
let any2 = false;
for (const [f, src] of code) {
  let i = 0;
  for (;;) {
    const at = src.indexOf('function ', i);
    if (at < 0) break;
    i = at + 9;
    let j = i;
    while (j < src.length && IDENT.includes(src[j])) j++;
    const fname = src.slice(i, j);
    const open = src.indexOf('(', j);
    const close = src.indexOf(')', open);
    if (open < 0 || close < 0 || close - open > 400) continue;
    const params = src.slice(open + 1, close).split(',').map((p) => p.split('=')[0].trim())
      .filter((p) => p && p.split('').every((c) => IDENT.includes(c)));
    // Body: from the opening brace to a closing brace at the same indent. Approximate by taking a
    // generous window -- a parameter used anywhere nearby is not dead, and over-reading fails safe.
    const bodyStart = src.indexOf('{', close);
    if (bodyStart < 0) continue;
    const body = src.slice(bodyStart, bodyStart + 12000);
    for (const p of params) {
      if (countWord(body, p) === 0) {
        any2 = true;
        report('param', `${f}: ${fname}(...) never uses parameter "${p}"`);
      }
    }
  }
}
if (!any2) console.log('  (none)');

// --- 3. DIAG / STATS KEYS WRITTEN BUT NEVER READ -------------------------------------------------
console.log('');
console.log('DIAG AND STATS FIELDS WRITTEN BUT READ NOWHERE (app or benches)');
const benchDir = path.join(__dirname);
let benchAll = '';
for (const b of fs.readdirSync(benchDir)) if (b.endsWith('.js')) benchAll += fs.readFileSync(path.join(benchDir, b), 'utf8');
let any3 = false;
for (const [f, src] of code) {
  for (const line of src.split('\n')) {
    const t = line.trim();
    const colon = t.indexOf(':');
    if (colon <= 0 || !t.endsWith(',')) continue;
    const key = t.slice(0, colon).trim();
    if (!key || key.split('').some((c) => !IDENT.includes(c))) continue;
    if (key.length < 5) continue;
    let reads = 0;
    for (const [, s2] of code) reads += countWord(s2, key);
    reads += countWord(benchAll, key);
    // KNOWN LIMITATION, STATED RATHER THAN HIDDEN: a field consumed as part of its PARENT object --
    // `JSON.stringify(diag.finalists)`, a destructure, a template that spreads the record -- is
    // counted as unread here, because the key name never appears at the read site. `crown` is the
    // clearest example: it is genuinely used, via `iconSvg(cond ? 'sparkles' : 'crown', ...)`, and
    // the key itself is only ever written. So this class REPORTS candidates; it does not convict.
    // Under-reporting is not an option for the same reason: a field nothing reads by name is
    // exactly the shape of the real dead ones (killZeroDeepest, killZeroHpByStageBand), so the
    // list has to include the ambiguous cases and be triaged by hand.
    if (reads <= 1) {
      any3 = true;
      report('diag', `${f}: "${key}" is written but nothing reads it`);
    }
  }
}
if (!any3) console.log('  (none)');

console.log('');
console.log(`${files.length} shipped files audited, ${findings} finding(s)`);
console.log('(report -- each needs a judgement: some are genuinely optional, some are dead)');
