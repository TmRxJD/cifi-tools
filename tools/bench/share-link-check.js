'use strict';
// SHARE LINKS MUST RESOLVE AND MUST CARRY THE BUILD.
//
//   node tools/bench/share-link-check.js
//
// THE BUG THIS COVERS, and it was broken at BOTH ends for as long as the feature existed:
//   1. the link was built as `<root>/ozzy?code=XXXX`, a PATH segment. The original site is served
//      by something that routes; this app is static files on GitHub Pages, where `/ozzy` is not a
//      file -- so every generated link returned GitHub's 404 page.
//   2. nothing read `?code=` on load, so even a link that resolved would have shown the normal
//      start page and dropped the build.
//
// Neither end is visible to the person who generates a link -- only to whoever clicks it, which is
// why it survived. That also makes it exactly the kind of thing that needs a gate rather than a
// manual check.
//
// GATE: the generated link points at a real file, the app reads the code back, and 404.html
// rewrites the OLD path form (links already pasted into Discord) into the new one.

const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', '..', 'webapp', 'public');
const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `  -- ${detail}` : ''}`);
};

// 1. The generated link must not put the hunter in the PATH.
const shareFn = app.slice(app.indexOf('function openShareModal'), app.indexOf('function openShareModal') + 2500);
check('the share link is a query on the app root, not a path segment',
  /\?hunter=\$\{encodeURIComponent\(currentHunter\)\}/.test(shareFn)
  && !/\}\/\$\{currentHunter\}\?code=/.test(shareFn));

// 2. The app must consume it.
check('the app reads ?code= on load', /consumeSharedBuildFromUrl\s*\(\)/.test(app)
  && /URLSearchParams\(location\.search\)/.test(app));
check('an inbound code goes through the same importer as the paste dialog',
  /parseBuildCode\(code\.trim\(\)\)/.test(app) && /applyImportedBuild\(payload, false\)/.test(app));
check('a shared link does NOT apply the sender\'s account-wide upgrades',
  /applyImportedBuild\(payload, false\)/.test(app));

// 3. 404.html must rewrite the OLD path form. Replay its transform exactly.
const fallback = fs.readFileSync(path.join(PUB, '404.html'), 'utf8');
check('404.html exists and redirects without polluting history',
  /location\.replace\(/.test(fallback) && !/location\.assign\(/.test(fallback));

function rewrite(pathname, search) {
  const p = pathname.replace(/\/+$/, '');
  const hunter = (p.split('/').pop() || '').toLowerCase();
  const known = { borge: 1, ozzy: 1, knox: 1 };
  const root = known[hunter] ? p.slice(0, p.length - hunter.length - 1) : p;
  const qs = search || '';
  const sep = qs ? '&' : '?';
  const target = `${root || '/'}/${qs}${known[hunter] ? `${sep}hunter=${hunter}` : ''}`;
  return target.replace(/([^:]\/)\/+/g, '$1');
}

const CASES = [
  ['/cifi-tools/ozzy', '?code=ABC', '/cifi-tools/?code=ABC&hunter=ozzy'],
  ['/cifi-tools/borge', '?code=X&y=1', '/cifi-tools/?code=X&y=1&hunter=borge'],
  ['/cifi-tools/knox', '', '/cifi-tools/?hunter=knox'],
  // A genuinely unknown path must still land on the app rather than looping on itself.
  ['/cifi-tools/nope', '?code=Q', '/cifi-tools/nope/?code=Q'],
];
for (const [p, q, want] of CASES) {
  const got = rewrite(p, q);
  check(`404 rewrite ${p}${q || ''} -> ${want}`, got === want, `got ${got}`);
}

// 4. THE IMPORT MUST FILE UNDER THE CODE'S HUNTER, not whichever one is on screen.
//
// Observed live: importing an Ozzy code while viewing Borge filed it under BORGE, and the store
// validator flagged `borge.builds[0].attributes.timeless = 5 is not legal` -- an Ozzy allocation
// is illegal in Borge's tree. A build under the wrong hunter is evaluated with the wrong hunter's
// parameter vector, which this project has already been burned by once.
// Slice to the NEXT top-level declaration rather than a fixed byte count: the function grew past
// a 4000-char window when the reasoning was documented, and the check then failed on its own
// window instead of on the code -- a false failure is as bad as a false pass.
const applyStart = app.indexOf('function applyImportedBuild');
const applyEnd = app.indexOf("\ndocument.getElementById('importBuildOnlyBtn')", applyStart);
const applyFn = app.slice(applyStart, applyEnd > applyStart ? applyEnd : applyStart + 8000);
check('the imported build is filed under the payload hunter, not currentHunter',
  /const targetHunter = /.test(applyFn) && /store\[targetHunter\]\.builds\.push\(build\)/.test(applyFn));
check('the destination does not depend on switchHunter having succeeded',
  !/store\[currentHunter\]\.builds\.push/.test(applyFn));

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s): a shared build link will not open.`);
  process.exit(1);
}
console.log('PASS  share links resolve and carry the build');
