'use strict';
// An unrecognised hash route must resolve to the sim page, not hard-lock the app.
//
// render() falls back to renderSimPage() for a route it does not know, but renderSimPage calls
// switchHunter(), whose "am I already on the sim page?" guard is `currentRoute() === 'sim'`.
// With an unknown route that guard was false while the sim page was nonetheless being rendered,
// so switchHunter called render() again: render -> sim page -> switchHunter -> render, until
// "Maximum call stack size exceeded". Any stale bookmark or mistyped hash hard-locked the page
// (`#/hunterstats` is the one that surfaced it during a route sweep).
//
// The fix normalises in currentRoute() so there is exactly one answer to "which route is this".
// This test pins BOTH halves of that: unknown routes normalise, and known ones do not get
// swallowed by the normalisation -- a whitelist that is too aggressive would silently send real
// pages to the sim page instead, which is the obvious way to "fix" this and be wrong.
//
//   node tools/bench/route-test.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../webapp/public/app.js'), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.message}`);
    failures++;
  }
}

// Extract the shipped implementation rather than re-typing it: app.js is a DOM file that cannot
// be loaded under Node, but currentRoute is pure apart from `location`.
const known = /const KNOWN_ROUTES = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
const fnSrc = /function currentRoute\(\) \{([\s\S]*?)\n\}/.exec(SRC);
if (!known || !fnSrc) {
  console.log('FAIL  could not locate KNOWN_ROUTES / currentRoute in app.js');
  process.exit(1);
}
const KNOWN_ROUTES = new Set(eval(`[${known[1]}]`)); // eslint-disable-line no-eval
const location = { hash: '' };
const currentRoute = new Function('location', 'KNOWN_ROUTES', `${fnSrc[0]}; return currentRoute;`)(location, KNOWN_ROUTES);
const routeOf = (hash) => { location.hash = hash; return currentRoute(); };

// Which routes render() actually dispatches on -- read from the source so this test cannot drift
// away from the dispatch it is guarding.
const dispatched = [...SRC.matchAll(/if \(route === '([a-z]+)'\)/g)].map((m) => m[1]);

check('every route render() dispatches on survives normalisation', () => {
  const swallowed = dispatched.filter((r) => routeOf(`#/${r}`) !== r);
  return swallowed.length
    ? `these real routes now resolve to something else (they would render the sim page): ${swallowed.join(', ')}`
    : null;
});

check('KNOWN_ROUTES covers the dispatch, with no stale entries', () => {
  const missing = dispatched.filter((r) => !KNOWN_ROUTES.has(r));
  if (missing.length) return `dispatched but not in KNOWN_ROUTES: ${missing.join(', ')}`;
  // 'sim' is the fallback and has no `if (route === ...)` line, so allow exactly that one extra.
  const extra = [...KNOWN_ROUTES].filter((r) => r !== 'sim' && !dispatched.includes(r));
  return extra.length ? `in KNOWN_ROUTES but never dispatched: ${extra.join(', ')}` : null;
});

check('upgrades sub-routes are preserved', () => {
  for (const sub of ['relics', 'inscryptions', 'loopmods', 'iap', 'ultima', 'anything-new']) {
    const got = routeOf(`#/upgrades/${sub}`);
    if (got !== `upgrades/${sub}`) return `#/upgrades/${sub} resolved to "${got}"`;
  }
  return null;
});

check('unknown, empty and malformed routes resolve to the sim page', () => {
  const cases = ['', '#', '#/', '#/hunterstats', '#/nonsense', '#/upgrades', '#/UPGRADES/relics',
    '#/sim/../x', '#//', '#/gems/extra'];
  const bad = cases.filter((h) => routeOf(h) !== 'sim');
  return bad.length ? `did not normalise: ${bad.map((h) => `"${h}" -> "${routeOf(h)}"`).join(', ')}` : null;
});

check('the guard switchHunter relies on now agrees with what render() will draw', () => {
  // This is the actual invariant the crash violated: if render() is going to draw the sim page,
  // currentRoute() must say 'sim', or switchHunter re-enters render forever.
  const drawsSimPage = (route) => !dispatched.includes(route) && !route.startsWith('upgrades/');
  for (const h of ['#/hunterstats', '#/nonsense', '#/', '#/sim']) {
    const route = routeOf(h);
    if (drawsSimPage(route) && route !== 'sim') {
      return `${h} -> "${route}": render() would draw the sim page while currentRoute() says "${route}"`;
    }
  }
  return null;
});

console.log(`\n${failures ? `${failures} FAILED` : 'route normalisation holds'}`);
process.exit(failures ? 1 : 0);
