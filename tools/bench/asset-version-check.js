'use strict';
// A CHANGED ASSET MUST HAVE A BUMPED ?v=, OR USERS KEEP RUNNING THE OLD CODE.
//
//   node tools/bench/asset-version-check.js [--base=HEAD]
//
// WHY THIS EXISTS. `index.html` loads every shipped file with a `?v=` cache-buster, and a Worker
// URL caches independently of the page (hence WORKER_VERSION in optimizer/runner.js). If a file
// changes and its version does not, the browser serves the CACHED copy: the change is live in Node,
// every bench passes, and the app runs the old code. Nothing else in this repo checks it.
//
// That is not hypothetical. A full day of optimizer work -- a cross-block pass, donor
// recombination, a time cap and a new effort tier -- was verified entirely under Node while
// `search.js`'s `?v=` still pointed at the previous build. Every gate was green and the app would
// have shipped none of it. It was caught by reading the tag, not by a test.
//
// THE RULE: if a file referenced by index.html differs from the base revision, its `?v=` must
// differ too. Same for optimizer/worker.js and WORKER_VERSION, which is the same hazard with a
// different mechanism -- a stale worker silently keeps running old code in a thread nobody looks at.
//
// SKIPS rather than fails when git is unavailable or the base revision is missing: a check that
// cannot run must say so, never pass quietly.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const BASE = opt('base', 'HEAD');
const ROOT = path.join(__dirname, '../..');
const INDEX = path.join(ROOT, 'webapp/public/index.html');

function git(cmdArgs) {
  return execFileSync('git', cmdArgs, { cwd: ROOT, encoding: 'utf8' });
}

let changed;
try {
  // Working tree AND staged, against the base. A file changed in either is "changed" for shipping.
  changed = new Set(git(['diff', '--name-only', BASE, '--', 'webapp/public']).split('\n')
    .concat(git(['diff', '--name-only', '--cached', BASE, '--', 'webapp/public']).split('\n'))
    // UNTRACKED FILES COUNT AS CHANGED, and omitting them was a real blind spot in the first
    // version of this check: `git diff` cannot see a file that was never committed, so a NEW
    // shipped module -- optimizer/refit.js and optimizer/corpus.js are both untracked right
    // now -- was invisible here while being fully live in the browser. A gate that cannot see
    // the newest code is worse than none, because it reports PASS over it.
    .concat(git(['ls-files', '--others', '--exclude-standard', '--', 'webapp/public']).split('\n'))
    .map((l) => l.trim()).filter(Boolean));
} catch (e) {
  console.log(`SKIP  git unavailable or base "${BASE}" not found (${e.message.split('\n')[0]})`);
  console.log('      This check cannot run here. That is not a pass.');
  process.exit(0);
}

// Which changed paths are actually tracked -- an untracked file has no base revision to diff.
let tracked = new Set();
try {
  tracked = new Set(git(['ls-files', '--', 'webapp/public']).split('\n').map((l) => l.trim()).filter(Boolean));
} catch (e) { tracked = new Set(); }

const html = fs.readFileSync(INDEX, 'utf8');
let baseHtml = null;
try { baseHtml = git(['show', `${BASE}:webapp/public/index.html`]); } catch (e) { baseHtml = null; }

// Every versioned asset the page loads.
const tagOf = (src, file) => {
  const re = new RegExp(`${file.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\?v=([^"']+)`);
  const m = re.exec(src);
  return m ? m[1] : null;
};

const assets = [...html.matchAll(/(?:src|href)="([^"?]+)\?v=([^"']+)"/g)]
  .map((m) => ({ file: m[1], version: m[2] }));

let failures = 0;
let checkedAny = 0;

console.log(`base ${BASE}: ${changed.size} changed file(s) under webapp/public`);
console.log('');

for (const a of assets) {
  const repoPath = `webapp/public/${a.file}`.replace(/\/+/g, '/');
  if (!changed.has(repoPath)) continue;
  checkedAny++;
  const oldVersion = baseHtml ? tagOf(baseHtml, a.file) : null;
  // An untracked file has no base version, so "was it bumped" is the wrong question -- what matters
  // is that it HAS one. Reported separately so the output says which rule applied.
  const untracked = !tracked.has(repoPath);
  const bumped = untracked ? Boolean(a.version) : (oldVersion === null || oldVersion !== a.version);
  console.log(`  ${a.file.padEnd(28)} ${untracked ? 'NEW    ' : 'changed'}   ?v= ${untracked ? '(untracked)' : String(oldVersion)} -> ${a.version}`
    + (bumped ? '   ok' : '   *** NOT BUMPED -- browsers will serve the cached old file ***'));
  if (!bumped) failures++;
}

// The worker is versioned by a constant in runner.js, not by a tag in index.html.
if (changed.has('webapp/public/optimizer/worker.js')) {
  checkedAny++;
  const runner = fs.readFileSync(path.join(ROOT, 'webapp/public/optimizer/runner.js'), 'utf8');
  const now = /WORKER_VERSION\s*=\s*'([^']+)'/.exec(runner);
  let before = null;
  try { before = /WORKER_VERSION\s*=\s*'([^']+)'/.exec(git(['show', `${BASE}:webapp/public/optimizer/runner.js`])); } catch (e) { before = null; }
  const bumped = !before || !now || before[1] !== now[1];
  console.log(`  optimizer/worker.js          changed   WORKER_VERSION ${before ? before[1] : '?'} -> ${now ? now[1] : '?'}`
    + (bumped ? '   ok' : '   *** NOT BUMPED -- workers keep running the old code ***'));
  if (!bumped) failures++;
}

console.log('');
if (!checkedAny) {
  console.log('PASS  no shipped asset changed against the base -- nothing to bump');
  process.exit(0);
}
if (failures) {
  console.log(`FAIL  ${failures} changed asset(s) with a stale cache-buster`);
  process.exit(1);
}
console.log(`PASS  ${checkedAny} changed asset(s), every one with a bumped version`);
