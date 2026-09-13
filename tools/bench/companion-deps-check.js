'use strict';
// EVERY GLOBAL THE COMPANION'S PAGES READ MUST BE PROVIDED BY SOMETHING THE MANIFEST LOADS.
//
//   node tools/bench/companion-deps-check.js
//
// WHY THIS EXISTS. The website loads 25 scripts from `index.html`; the extension deliberately loads
// 10, dropping app.js, cloudSync.js, the Appwrite SDK and the whole hunter UI. That subset is a
// JUDGEMENT, and the way it fails is nasty: a missing global is not a load error, it is
// `undefined is not a function` thrown from inside a click handler, on one page, for one user,
// after the extension has already been shipped. `attachBigNumberInput` was exactly such a case --
// it lived in app.js, which the extension does not load, and only a read of shipsPage.js's globals
// caught it before it shipped.
//
// So this reads the manifest (not a second hand-kept list -- that is the drift this repo keeps
// paying for), loads every file it declares, and checks that each `window.X` READ is matched by a
// `window.X =` WRITE somewhere in the same set, or is a browser builtin.
//
// It also asserts the LOAD ORDER, because these files populate globals in order with no module
// system: `storeSchema.js` must follow `hunterDefs.js` and `optimizer/space.js`.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const EXT = path.join(__dirname, '..', '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
// The host-store bridge is deliberately a separate MAIN-world content script. Select the
// isolated-world application entry by the file that makes it an application (`companion.js`), not
// by its array position: assuming index zero made this gate reject the correct two-world setup.
const appContentScript = manifest.content_scripts.find((entry) => entry.js?.includes('companion.js'));
const scripts = appContentScript?.js || [];
const hostStoreBridge = manifest.content_scripts.find((entry) => entry.js?.includes('hostStoreBridge.js'));
const hostStoreSource = fs.readFileSync(path.join(EXT, 'hostStoreBridge.js'), 'utf8');
check('host-store bridge runs in the site main world', hostStoreBridge?.world === 'MAIN',
  'native cifi-tools Pinia state is not visible to an isolated content script');
const webResources = manifest.web_accessible_resources?.flatMap((entry) => entry.resources || []) || [];
check('runtime params are web-accessible', webResources.includes('vendor/params.json'),
  'hunterSimBrowser fetches this extension resource at runtime');
check('extension does not publish a replacement evaluator host', !webResources.includes('workerHost.html'),
  'embedded optimization must use cifi-tools own same-origin worker');

// Globals the BROWSER provides, or that a content script legitimately reads from the host page.
// Listed explicitly rather than pattern-matched: a typo'd builtin should fail, not be waved through.
const BUILTIN = new Set([
  'location', 'document', 'navigator', 'console', 'prompt', 'alert', 'confirm', 'dispatchEvent',
  'localStorage', 'sessionStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'addEventListener', 'removeEventListener', 'getComputedStyle',
  'innerWidth', 'innerHeight', 'matchMedia', 'fetch', 'crypto', 'performance', 'Worker', 'URL',
  'devicePixelRatio', 'scrollTo', 'open', 'history', 'chrome', 'indexedDB',
  // app.js checks these optional integrations before use. The companion deliberately omits the
  // Appwrite account layer, while cifi-tools may provide html2canvas on the shared page.
  'CloudSync', 'html2canvas',
]);

const sources = new Map();
for (const rel of scripts) {
  const file = path.join(EXT, rel);
  if (!fs.existsSync(file)) { check(`declared file exists: ${rel}`, false, 'missing -- run tools/build-companion.js'); continue; }
  sources.set(rel, fs.readFileSync(file, 'utf8'));
}
check('every file the manifest declares is present', sources.size === scripts.length);

// The import modal is generated into shell.js because app.js binds it at top level. A previous
// shell drift omitted an import target, so a successful bridge pull reached the import pipeline
// and then failed trying to set `innerHTML` on null. Keep the contract at the generated boundary:
// these IDs must be present in the exact DOM the extension ships, not merely in index.html.
const shell = sources.get('shell.js') || '';
for (const id of ['importSaveModal', 'importSaveResult', 'importSaveBridgeText', 'importSaveBridgePullBtn']) {
  check(`generated modal shell includes #${id}`,
    shell.includes(`id=\\"${id}\\"`), 'run tools/build-companion.js to regenerate shell.js');
}

// ---- what each file PROVIDES -----------------------------------------------------------------
// `window.X =` and `window.X = function X`. Also plain `function X()` at top level does NOT count:
// in a content script each file shares one scope, but relying on that rather than on an explicit
// window assignment is exactly the implicit coupling this project bans.
// THE ROOT IS NOT ALWAYS SPELLED `window`, AND ASSUMING IT WAS MADE THIS BENCH FAIL CORRECT CODE.
// Several modules here are IIFEs taking `(window ?? globalThis)` and export as `global.X = ...`
// (storeSchema.js line 464, costFormulas.js line 781). Matching only `window.` reported
// `StoreSchema` and `CostFormulas` as unprovided while both were loaded and working -- a bench
// failing good data, which is the more dangerous direction because the tempting fix is to change
// the code. Match the aliases the codebase actually uses.
const ROOT_ALIAS = /\b(?:window|globalThis|global|self|root|win)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;

const provided = new Map();   // global -> file that assigns it
for (const [rel, src] of sources) {
  for (const m of src.matchAll(ROOT_ALIAS)) {
    if (!provided.has(m[1])) provided.set(m[1], rel);
  }
}

// ---- what each file NEEDS --------------------------------------------------------------------
const missing = [];
for (const [rel, src] of sources) {
  for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)/g)) {
    const name = m[1];
    // Skip the assignment sites themselves.
    if (src.slice(m.index).match(/^window\.[A-Za-z_$][\w$]*\s*=(?!=)/)) continue;
    if (BUILTIN.has(name) || provided.has(name)) continue;
    missing.push(`${rel} reads window.${name}`);
  }
}
const uniqueMissing = [...new Set(missing)];
check('every window.* read is provided by a loaded file',
  uniqueMissing.length === 0, uniqueMissing.join(' | '));

// ---- load order -------------------------------------------------------------------------------
// DERIVED FROM index.html, NOT HAND-LISTED, BECAUSE THE HAND-LIST IS WHAT FAILED.
//
// There is no module system: these files populate `window.*` in tag order, so order IS the
// dependency graph. An earlier version of this bench asserted a hand-written list of pairs -- it
// checked `hunterDefs -> storeSchema` and `shipSchema -> shipsPage` and PASSED, while the manifest
// had `storeSchema` before `shipsPage`. shipsPage.js assigns `window.FleetStoreDefaults` at line
// 3281 and storeSchema.js requires it, so the extension died at boot on a pair nobody thought to
// list. A hand-kept copy of an ordering that already exists elsewhere is the duplicated-rule trap
// this repo keeps paying for.
//
// index.html is the canonical order. For any two files the manifest shares with it, their relative
// order must match.
const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'webapp', 'public', 'index.html'), 'utf8');
const siteOrder = [...indexHtml.matchAll(/<script src="(?!https?:)([^"?]+)/g)].map((m) => m[1]);
check('index.html script order is readable', siteOrder.length > 5, `${siteOrder.length} local scripts`);

const vendored = scripts.filter((s) => s.startsWith('vendor/')).map((s) => s.slice('vendor/'.length));
let orderProblems = 0;
for (let a = 0; a < vendored.length; a++) {
  for (let b = a + 1; b < vendored.length; b++) {
    const ia = siteOrder.indexOf(vendored[a]);
    const ib = siteOrder.indexOf(vendored[b]);
    if (ia === -1 || ib === -1) continue;          // not in index.html: nothing to compare against
    if (ia > ib) {
      orderProblems++;
      check(`${vendored[b]} must load before ${vendored[a]} (index.html order)`, false,
        `manifest has ${vendored[a]} first`);
    }
  }
}
check('vendored files follow index.html load order', orderProblems === 0, `${orderProblems} inversion(s)`);

// Order constraints for files that exist only in the extension, so index.html cannot arbitrate.
const at = (frag) => scripts.findIndex((s) => s.endsWith(frag));
for (const [before, after, why] of [
  ['config.js', 'icons.js', 'embedded configuration must exist before any vendored file runs'],
  ['assetUrl.js', 'shipsPage.js', 'every visual asset must resolve before Fleet pages render'],
  ['shell.js', 'shipsPage.js', 'shipsPage binds five modals at top level'],
  ['app.js', 'companion.js', 'companion routes invoke app.js render()'],
]) {
  const i = at(before), j = at(after);
  check(`${before} loads before ${after}`, i !== -1 && j !== -1 && i < j, why);
}

// ---- the renderers the routes name ------------------------------------------------------------
// companion.js resolves these by NAME at navigation time, so a rename in shipsPage.js would surface
// as a broken page rather than a load error.
const companion = sources.get('companion.js') || '';
const runner = sources.get('vendor/optimizer/runner.js') || '';
const appSource = sources.get('vendor/app.js') || '';
check('embedded optimizer uses cifi-tools native parallel evaluator',
  runner.includes('class NativeEvaluationWorker')
    && runner.includes("this.rpc('evaluate'")
    && !runner.includes('HUNTERSIM_WORKER_HOST_URL')
    && !fs.existsSync(path.join(EXT, 'workerHost.html')),
  'do not recreate the native evaluator behind a throttled extension iframe');
// Routing behavior is exercised against the real site by companion-browser-check.js.
// This gate checks dependency contracts only; source spellings cannot prove Vue navigation.
check('host router adapter is declared in the MAIN world',
  manifest.content_scripts.some(entry => entry.world === 'MAIN' && entry.js.includes('hostRouting.js')));
check('native page content is not rendered by the companion client',
  !companion.includes('renderGemsPage') && !companion.includes('renderUpgradesPage'));
check('embedded Hunter evaluation reads the same canonical store as its visible controls',
  appSource.includes('hunterStats: store[hunter].hunterStats')
    && appSource.includes('globalUpgrades: store.globalUpgrades')
    && appSource.includes('gems: store.gems'),
  'do not revive the native-Pinia substitution that made embedded card scores diverge');
check('embedded mode persists through the expanded native Pinia store only',
  appSource.includes("new Event('cifi-companion:write-native-store')")
    && hostStoreSource.includes('hunter.$patch({cifiCompanion:extra})')
    && hostStoreSource.includes('hunter.$persist()')
    && !(sources.get('config.js') || '').includes('HUNTERSIM_STORAGE_KEY')
    && !(sources.get('config.js') || '').includes('HUNTERSIM_IDB_NAME'),
  'the extension must not configure a parallel companion persistence store');
check('embedded save import populates canonical Hunter calculation inputs',
  !appSource.includes("if (!EMBEDDED) applyUpgradesByPrefix")
    && !appSource.includes('if (cats.gems && !EMBEDDED)')
    && !appSource.includes('if (cats.hunterBuilds && !EMBEDDED)'),
  'embedded imports must not update only the native mirror while companion evaluation stays stale');
const routeContext = {window:{}};
require('vm').runInNewContext(fs.readFileSync(path.join(EXT,'routes.js'),'utf8'),routeContext);
const named = routeContext.window.CifiCompanionRoutes.map(page=>page.renderer);
check('companion declares the complete six-page surface, including Hunters', named.length === 6
  && named.includes('render'), 'the standalone Hunter renderer is part of the product contract');
for (const fn of named) check(`renderer ${fn}() is provided`,provided.has(fn));
for (const entry of manifest.content_scripts) {
  for (const rel of [...entry.js,...(entry.css || [])]) check(`declared asset exists: ${rel}`,fs.existsSync(path.join(EXT,rel)));
}
check('embedded import redraw is provided by the Companion',
  /window\.refreshEmbeddedCompanionPage\s*=/.test(companion)
    && /window\.refreshEmbeddedCompanionPage\(\)/.test(sources.get('vendor/app.js') || ''),
  'embedded save imports must redraw through Companion routing, not app.js\'s website-only #pageRoot');

// ---- the build output is current ---------------------------------------------------------------
// A stale vendor/ copy is the same defect wearing a different hat: the manifest loads a file that no
// longer matches the source it was generated from.
const { execFileSync } = require('child_process');
try {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'build-companion.js'), '--check'], { stdio: 'pipe' });
  check('extension/ is up to date with webapp/public/', true);
} catch (e) {
  check('extension/ is up to date with webapp/public/', false,
    String(e.stdout || e.stderr || e.message).trim().split('\n').join(' / '));
}

console.log('');
if (failures) {
  console.log(`FAIL  ${failures} problem(s): the companion would break at runtime.`);
  process.exit(1);
}
console.log(`PASS  ${scripts.length} declared files, ${provided.size} globals provided, order and renderers check out`);
