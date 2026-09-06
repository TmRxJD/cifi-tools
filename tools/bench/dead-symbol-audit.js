'use strict';
// WHAT IN THE SHIPPED CODE IS DEAD, AND WHAT SILENTLY DEFAULTS?
//
//   node tools/bench/dead-symbol-audit.js
//
// Two project rules are enforced here rather than remembered:
//   "No legacy paths, no fallbacks. Dead code gets deleted, not commented out or left just in
//    case. Git history is the archive."
//   "Explicit over implicit. No silent defaults, no `|| {}` papering over a missing field."
//
// NO REGULAR EXPRESSIONS WITH ESCAPES IN THIS FILE. Four separate patches in this session had a
// backslash level eaten by the shell heredoc that wrote them -- turning an escaped word-boundary
// into a literal backspace, which matches nothing. The first version of this very audit reported
// saveStore(), switchHunter() and escapeHtml() as uncalled for exactly that reason. Character
// scanning needs no escapes and cannot acquire the bug.

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../webapp/public');

/** Strip comments without regex: block comments first, then line comments. */
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
    // A URL inside a string ('https://...') is not a comment. Treating it as one truncated real
    // code and made this audit report wireHunterTabs(), openStatsModal() and three other LIVE
    // functions as uncalled -- false positives in a tool whose whole job is finding dead code.
    let lc = line.indexOf('/' + '/');
    while (lc > 0 && line[lc - 1] === ':') lc = line.indexOf('/' + '/', lc + 2);
    if (lc >= 0) line = line.slice(0, lc);
    out.push(line);
  }
  return out.join('\n');
}

const IDENT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';
/** Count whole-word occurrences of `name`, by hand, so no escaping is involved. */
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
const raw = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  raw.set(f, text);
  code.set(f, stripComments(text));
}

// Function declarations, found without regex: scan for the keyword and read the name after it.
function declaredFunctions(src) {
  const names = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf('function ', i);
    if (at < 0) return names;
    i = at + 9;
    let j = i;
    while (j < src.length && IDENT.includes(src[j])) j++;
    const name = src.slice(i, j);
    if (name && !IDENT.includes(src[at - 1] || '')) names.push(name);
  }
}

let problems = 0;

console.log('FUNCTIONS DECLARED IN THE SHIPPED APP THAT NOTHING REFERENCES');
const deadFns = [];
for (const [f, src] of code) {
  for (const name of new Set(declaredFunctions(src))) {
    let uses = 0;
    for (const [, other] of code) uses += countWord(other, name);
    // CROSS-CHECK AGAINST RAW SOURCE, because the comment stripper is not a JS parser and a `/*`
    // inside a string or regex literal leaves it in block mode, blanking real code after it. That
    // made this audit report five LIVE app.js functions (wireHunterTabs, openStatsModal and three
    // more) as uncalled. Failing safe means under-reporting: a name that appears more than once in
    // the raw text is not claimed dead, even if the only extra mention turns out to be a comment.
    // A missed dead function costs nothing; a false accusation sends someone deleting live code.
    let rawUses = 0;
    for (const [, other] of raw) rawUses += countWord(other, name);
    if (uses <= 1 && rawUses <= 1) deadFns.push(`${f}: ${name}()`);
  }
}
if (deadFns.length) { deadFns.forEach((d) => console.log('  ' + d)); problems += deadFns.length; }
else console.log('  (none)');

console.log('');
console.log('SILENT OBJECT DEFAULTS (`|| {}`) -- the rule bans papering over a missing field');
const silent = [];
for (const [f, src] of code) {
  src.split('\n').forEach((line, i) => {
    if (line.includes('|| {}') || line.includes('||{}')) silent.push(`${f}:${i + 1}  ${line.trim().slice(0, 88)}`);
  });
}
if (silent.length) { silent.forEach((d) => console.log('  ' + d)); problems += silent.length; }
else console.log('  (none)');

console.log('');
console.log(`${files.length} shipped files audited, ${problems} finding(s)`);
// A REPORT, not a gate: some findings are legitimate (an entry point called only from HTML, a
// default that is genuinely optional). It lists them so each is a decision rather than an accident.
console.log('(report -- each finding needs a judgement, not an automatic deletion)');
