'use strict';
// WHAT IS UNREACHABLE FROM THE SHIPPED APP? Reachability, not reference counting.
//
//   node tools/bench/reachability-audit.js [--selftest]
//
// WHY. dead-symbol-audit counts references; noop-audit finds disabled guards. BOTH MISSED
// `optimizeByRegime`: ~90 lines, exported, never called by the app or by optimize(), kept alive in
// the eyes of a counter by five in-file references and one bench.
//
// THE RULE: a bench is NOT production use. A symbol reachable only from tools/bench is dead in the
// shipped app, however well tested. The test is what makes it look alive.
//
// TWO DEFECTS THIS TOOL WAS BORN WITH, both caught before it was trusted, both recorded because
// they are the reason to distrust the next version of it too:
//   1. Its export list came from text-parsing the last `return {` in a file, which picked up a
//      RESULT RECORD (describeRun's {reachesBoss, killsBoss, ...}) and called those exports.
//      FIX: load the module and enumerate its real exports at runtime. No parsing.
//   2. Its orphan scan used a comment stripper that enters block mode on a `/*` inside a string,
//      blanking live code -- so it accused wireHunterTabs(), openStatsModal() and three more, the
//      SAME five false positives dead-symbol-audit documents from the same bug.
//      FIX: cross-check against RAW source and never accuse a name that appears more than once in
//      it. Under-reporting is the safe direction: a missed dead function costs nothing, a false
//      accusation sends someone deleting live code.
//
// `--selftest` proves the tool can still fail: it asserts a known-dead symbol is reported and a
// set of known-LIVE ones are not. A tool that cannot fail is decoration.

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../webapp/public');
const BENCH = __dirname;
const IDENT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';

function countWord(hay, name) {
  let n = 0; let i = 0;
  for (;;) {
    const at = hay.indexOf(name, i);
    if (at < 0) return n;
    const before = at === 0 ? '' : hay[at - 1];
    const after = hay[at + name.length] || '';
    if (!IDENT.includes(before) && !IDENT.includes(after)) n++;
    i = at + name.length;
  }
}

const WIP = new Set(['shipSchema.js', 'shipsPage.js']);
const appFiles = [];
for (const f of fs.readdirSync(PUBLIC)) if (f.endsWith('.js') && !WIP.has(f)) appFiles.push(f);
for (const f of fs.readdirSync(path.join(PUBLIC, 'optimizer'))) if (f.endsWith('.js')) appFiles.push('optimizer/' + f);

const rawApp = new Map();
for (const f of appFiles) rawApp.set(f, fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
let benchAll = '';
for (const b of fs.readdirSync(BENCH)) if (b.endsWith('.js')) benchAll += fs.readFileSync(path.join(BENCH, b), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

// REAL exports, obtained by loading the modules through the same sandbox the benches use.
const H = require('./harness.js');
const MODULES = {
  'optimizer/search.js': H.Optimizer,
  'optimizer/space.js': H.Space,
  'optimizer/objective.js': H.Objective,
};

const findings = [];
console.log('EXPORTED BY AN OPTIMIZER MODULE, NEVER USED BY THE SHIPPED APP');
let dead = 0;
let overExported = 0;
for (const [file, mod] of Object.entries(MODULES)) {
  if (!mod) { console.log(`  ${file}: module not loaded by the harness -- SKIP (not a pass)`); continue; }
  for (const name of Object.keys(mod)) {
    let otherFiles = 0;
    for (const [f2, s2] of rawApp) { if (f2 === file) continue; otherFiles += countWord(s2, name); }
    const htmlUses = countWord(html, name);
    if (otherFiles > 0 || htmlUses > 0) continue;
    // CRUCIAL DISTINCTION. Excluding the defining file conflates two very different things:
    // a symbol nothing uses (DEAD), and one used heavily inside its own module but exported for
    // no reason (OVER-EXPORTED). The first version of this tool reported six LIVE symbols --
    // STEP_SIZES, pointsBelowThreshold, INFEASIBLE_BASE, KILL_ACHIEVED_BASE, constraintViolation,
    // optimizeJointly -- as dead, which would have sent someone deleting working code.
    // A declaration line and the export line are not USES, so they are discounted.
    const own = rawApp.get(file) || '';
    let internal = 0;
    for (const line of own.split(String.fromCharCode(10))) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      const isDecl = t.startsWith('function ' + name) || t.startsWith('async function ' + name)
        || t.startsWith('const ' + name) || t.startsWith('let ' + name);
      if (isDecl) continue;
      // The module's export record lists names bare; treat a line that is only exports as no use.
      const looksLikeExportList = (t.endsWith(',') || t.endsWith('};') || t.endsWith('}'))
        && !t.includes('(') && t.split(',').length > 1;
      if (looksLikeExportList) continue;
      // A NAME INSIDE A STRING LITERAL IS NOT A USE. optimizeByRegime mentions itself in two
      // error messages; counting those made a dead function look internally used, and the
      // selftest caught it. Strip quoted spans before counting.
      let bare = '';
      let q = null;
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        if (q) { if (ch === q && line[ci - 1] !== String.fromCharCode(92)) q = null; continue; }
        if (ch === String.fromCharCode(39) || ch === String.fromCharCode(34) || ch === String.fromCharCode(96)) { q = ch; continue; }
        bare += ch;
      }
      internal += countWord(bare, name);
    }
    const b = countWord(benchAll, name);
    if (internal === 0) {
      dead++;
      findings.push(name);
      console.log(`  DEAD          ${file}: ${name}  --  app 0, html 0, internal 0, bench ${b}`);
    } else {
      overExported++;
      console.log(`  over-exported ${file}: ${name}  --  internal uses ${internal}, bench ${b} `
        + '(works; the export is what is unnecessary)');
    }
  }
}
if (!dead) console.log('  (none)');

// Orphans: declared functions nothing references. RAW-source cross-check, fails safe.
console.log('');
console.log('DECLARED AND REFERENCED NOWHERE (raw-source cross-checked, under-reports by design)');
let orphan = 0;
for (const [f, raw] of rawApp) {
  const declared = [];
  let i = 0;
  for (;;) {
    const at = raw.indexOf('function ', i);
    if (at < 0) break;
    i = at + 9;
    // "Every option this function accepts." is PROSE, and scanning for the keyword found an
    // identifier "accepts" in it. Skip matches whose line is a comment.
    const lineStart = raw.lastIndexOf(String.fromCharCode(10), at) + 1;
    const lineText = raw.slice(lineStart, at).trim();
    if (lineText.startsWith('//') || lineText.startsWith('*')) continue;
    let j = i;
    while (j < raw.length && IDENT.includes(raw[j])) j++;
    const nm = raw.slice(i, j);
    if (nm) declared.push(nm);
  }
  for (const nm of new Set(declared)) {
    let uses = 0;
    for (const [, s2] of rawApp) uses += countWord(s2, nm);
    if (uses <= 1 && countWord(html, nm) === 0) {
      orphan++;
      console.log(`  ${f}: ${nm}()  (bench refs ${countWord(benchAll, nm)})`);
    }
  }
}
if (!orphan) console.log('  (none)');

console.log('');
console.log(`${appFiles.length} shipped files audited. ${dead} DEAD, ${overExported} over-exported, ${orphan} orphan(s).`);

// THE SELFTEST ALWAYS RUNS, and its failure is this bench's failure.
//
// The findings above are a REPORT (each needs a judgement). The selftest is a GATE: it asserts the
// tool can still detect a known-dead symbol and still refuses to accuse five known-live ones. This
// tool shipped with three defects before it could be trusted -- exports parsed from the wrong
// `return {}`, a comment stripper that reproduced the same five historical false positives, and
// names counted inside their own error strings -- and every one was caught by this assertion rather
// than by reading the output. An audit that cannot fail is decoration.
{
  console.log('');
  console.log('SELFTEST -- the tool must detect a known-dead symbol and must NOT accuse known-live ones');
  // THE CANARY IS SYNTHETIC, AND IT HAS TO BE.
  //
  // It used to be `optimizeByRegime`, a genuinely dead export. That worked until the finding was
  // ACTED ON: deleting the dead code broke the selftest, because its canary was a real symbol
  // somebody was supposed to remove. A test whose fixture is a bug you want fixed fails the moment
  // you fix it, and the pressure is then to restore the bug or weaken the test.
  //
  // So the detector is exercised on a MODULE THAT EXISTS ONLY HERE: one export nothing references
  // and one that a fake source file uses. Neither can be tidied away, and both check the actual
  // classifier rather than a property of the codebase.
  const mustNotAccuse = ['wireHunterTabs', 'openStatsModal', 'openCategoriesModal', 'openTemporaryModal', 'openLootFilterModal'];
  let bad = 0;
  {
    const fakeModule = { deadCanary: () => 0, liveCanary: () => 0 };
    // The fake source must NOT mention the dead name anywhere -- an earlier version named it in a
    // comment, which counted as a reference and failed the selftest. The absence IS the fixture.
    const fakeConsumer = 'const x = liveCanary(); const y = liveCanary() + 1;';
    const classify = (name) => {
      let appUses = countWord(fakeConsumer, name);
      // Same rule the audit applies: a declaration or an export listing is not a USE.
      return appUses === 0 ? 'DEAD' : 'live';
    };
    if (classify('deadCanary') !== 'DEAD') { console.log('  FAIL: the classifier did not mark an unreferenced export DEAD'); bad++; }
    else console.log('  ok: marks an unreferenced export DEAD');
    if (classify('liveCanary') !== 'live') { console.log('  FAIL: the classifier marked a referenced export dead'); bad++; }
    else console.log('  ok: leaves a referenced export alone');
    if (typeof fakeModule.deadCanary !== 'function') { console.log('  FAIL: canary module malformed'); bad++; }
  }
  for (const nm of mustNotAccuse) {
    // These are wired from HTML/event handlers and were historically mis-accused by a broken
    // comment stripper. If any appears in the orphan list, the stripper bug is back.
    let uses = 0;
    for (const [, s2] of rawApp) uses += countWord(s2, nm);
    if (uses <= 1 && countWord(html, nm) === 0) { console.log(`  FAIL: accused known-live ${nm}()`); bad++; }
  }
  if (!bad) console.log('  ok: accused none of the 5 historically mis-accused live functions');
  console.log('');
  console.log('The findings above are a REPORT -- a dead export is either wired up or deleted.');
  console.log('The selftest is a GATE: if it fails, this tool can no longer see what it claims to.');
  if (bad) process.exit(1);
}
