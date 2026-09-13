'use strict';
// THE COMPANION MUST HAVE A NEW VERSION WHEN ITS SHIPPED SURFACE CHANGES.
//
// Chrome keeps an unpacked extension's old content script until it is reloaded. If its manifest
// version did not move, a report that says "reload the extension" gives the user no trustworthy
// way to tell the new build from the old one. Compare the worktree against HEAD, not against a
// second hand-maintained version file: Git is the one record of what changed.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const manifestPath = path.join(ROOT, 'extension', 'manifest.json');

function versionParts(version) {
  if (!/^\d+(?:\.\d+)*$/.test(version)) throw new Error(`extension version must be numeric dot-separated, got ${JSON.stringify(version)}`);
  return version.split('.').map(Number);
}

function isBumped(current, previous) {
  const a = versionParts(current);
  const b = versionParts(previous);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

function git(...args) {
  return execFileSync('git', ['-c', `safe.directory=${ROOT.replace(/\\/g, '/')}`, ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Negative controls: a gate that accepts either is not enforcing a version bump.
if (isBumped('2.2.0', '2.2.0') || isBumped('2.1.9', '2.2.0') || !isBumped('2.2.1', '2.2.0')) {
  throw new Error('extension-version-check self-test failed: version comparison cannot distinguish a bump');
}

const changed = git('diff', '--name-only', 'HEAD', '--').trim().split(/\r?\n/).filter(Boolean);
// Source files copied into extension/vendor/ and the generator that creates them are part of the
// extension's shipped surface even though their canonical home is webapp/public/.
const extensionChanged = changed.filter((file) =>
  file === 'tools/build-companion.js' || file.startsWith('extension/') || file.startsWith('webapp/public/'));

if (extensionChanged.length === 0) {
  console.log('PASS  no extension-affecting worktree changes; version gate not applicable');
  process.exit(0);
}

const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
const previous = JSON.parse(git('show', 'HEAD:extension/manifest.json')).version;
if (!isBumped(current, previous)) {
  console.error(`FAIL  extension-affecting changes require manifest version > ${previous}; found ${current}`);
  for (const file of extensionChanged) console.error(`  - ${file}`);
  process.exit(1);
}

console.log(`PASS  extension version ${previous} -> ${current} covers ${extensionChanged.length} changed file(s)`);
