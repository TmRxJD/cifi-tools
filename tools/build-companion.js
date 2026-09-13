'use strict';
// GENERATE THE EXTENSION'S STYLESHEET FROM tokens.css BY SCOPING EVERY SELECTOR.
//
//   node tools/build-companion-css.js          # write extension/companion.css
//   node tools/build-companion-css.js --check  # fail if it is stale (for benches/CI)
//
// WHY THIS EXISTS. The companion runs INSIDE cifi-tools.com, sharing one document with their app.
// A content script's CSS is not sandboxed -- it applies to the whole page. `tokens.css` styles
// `body` (font, background, colour) and defines its palette on `:root`, so loading it unscoped
// would restyle THEIR site: their background, their typography, their spacing. That is both a
// visible defect and exactly the kind of uninvited change that would make a rights-holder
// conversation go badly.
//
// So every rule is re-rooted at `#cifi-companion-root`:
//   :root { --x: … }   ->  #cifi-companion-root { --x: … }
//   body { … }         ->  #cifi-companion-root { … }
//   .btn { … }         ->  #cifi-companion-root .btn { … }
// Custom properties defined on our root are inherited by everything inside it, so the palette keeps
// working while being invisible outside.
//
// DERIVED, NOT FORKED. tokens.css remains the one canonical stylesheet -- a hand-maintained second
// copy is precisely the parallel-implementation drift this project has been bitten by repeatedly.
// `--check` is what keeps them honest.
const fs = require('fs');
const path = require('path');

// A CLASS, NOT AN ID, AND THAT IS FORCED BY THE MODALS. shipsPage.js wires five modals at TOP
// LEVEL against markup that lives in index.html, so the extension must supply them (see shellIds)
// -- and they cannot live inside the page container, which is hidden whenever the user is on one of
// cifi-tools' own routes. So there are TWO scoped containers, the page root and the modal host, and
// an id cannot style both. Everything scoped here is styled by carrying `.cifi-companion`.
const ROOT = '.cifi-companion';
const SRC = path.join(__dirname, '..', 'webapp', 'public', 'tokens.css');
const OUT = path.join(__dirname, '..', 'extension', 'companion.css');

/**
 * Prefix one selector list. `:root` and `body` BECOME our root rather than being nested under it --
 * nesting them would produce `#cifi-companion-root body`, which matches nothing, silently dropping
 * the entire palette. That failure looks like "the extension has no styling" and gives no clue why.
 */
function scopeSelector(selectorList) {
  return selectorList.split(',').map((raw) => {
    const sel = raw.trim();
    if (!sel) return sel;
    if (sel === ':root' || sel === 'html' || sel === 'body') return ROOT;
    // `html.dark body`, `body.foo` and similar: replace the leading element, keep the rest.
    const lead = sel.match(/^(?::root|html|body)\b/);
    if (lead) return ROOT + sel.slice(lead[0].length);
    return `${ROOT} ${sel}`;
  }).join(', ');
}

/**
 * Walk the stylesheet block by block. A real parser is overkill, but naive line-based rewriting is
 * wrong -- at-rules nest, and `@keyframes`' inner blocks are percentages (`from`, `50%`) which must
 * NOT be scoped or the animation stops matching.
 */
function scope(css) {
  let out = '';
  let i = 0;
  const readBlock = (start) => {
    // Returns the index just past the matching '}', respecting nesting.
    let depth = 0;
    for (let j = start; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) return j + 1; }
    }
    return css.length;
  };

  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace === -1) { out += css.slice(i); break; }

    const prelude = css.slice(i, brace);
    const end = readBlock(brace);
    const body = css.slice(brace + 1, end - 1);

    // COMMENTS COME OUT OF THE PRELUDE BEFORE ANY DECISION IS MADE ABOUT IT, and two separate bugs
    // came from not doing that. tokens.css documents itself heavily, so a rule's prelude is
    // typically a long comment block followed by the selector or at-rule.
    //   1. Treating the whole prelude as a selector emitted `#cifi-companion-root /* ... */`, and
    //      since `scopeSelector` splits on commas -- which prose contains -- a `:root` preceded by
    //      a comment came out UNSCOPED. Three did.
    //   2. Worse, the at-rule test read the comment rather than the rule, so a commented `@media`
    //      was scoped AS A SELECTOR (`#cifi-companion-root @media (max-width: 767px)`), which
    //      matches nothing -- silently deleting an entire responsive block.
    // Both produced output that still looked like a stylesheet, which is why the check below counts
    // survivors rather than trusting the transform.
    const comments = [];
    const selectorText = prelude.replace(/\/\*[\s\S]*?\*\//g, (m) => { comments.push(m); return ''; });
    const head = selectorText.trim();
    const keptComments = comments.join('\n') + (comments.length ? '\n' : '');
    const lead = selectorText.slice(0, selectorText.length - selectorText.trimStart().length);

    if (head.startsWith('@keyframes') || head.startsWith('@-webkit-keyframes')) {
      // Verbatim: its children are keyframe selectors (`from`, `50%`), not element selectors.
      out += lead + keptComments + head + ' {' + body + '}';
    } else if (head.startsWith('@')) {
      // @media / @supports / @layer: the WRAPPER is kept and its contents scoped recursively.
      out += lead + keptComments + head + ' {' + scope(body) + '}';
    } else {
      out += lead + keptComments + scopeSelector(head) + ' {' + body + '}';
    }
    i = end;
  }
  return out;
}

const source = fs.readFileSync(SRC, 'utf8');
const banner = `/* GENERATED by tools/build-companion-css.js from webapp/public/tokens.css -- DO NOT EDIT.
   Every selector is scoped to ${ROOT} because this stylesheet is injected into
   cifi-tools.com's own document; unscoped, its \`body\` and \`:root\` rules would restyle their site.
   Edit tokens.css and re-run the generator. */\n`;
const generated = banner + scope(source);

// THE TRANSFORM CHECKS ITSELF, because both bugs it has already had produced output that still
// parsed as CSS and still looked right in a diff. A generator nobody can see fail is decoration.
function verify(css) {
  const problems = [];
  // Strip comments first, or prose mentioning "body" reads as a rule.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const unscoped = bare.match(/(^|\})\s*(body|html|:root)\s*[,{]/g);
  if (unscoped) problems.push(`${unscoped.length} unscoped global selector(s): ${unscoped.map((s) => s.trim()).join(' | ')}`);
  const scopedAtRule = bare.match(new RegExp(`${ROOT}\\s+@[a-z-]+`, 'g'));
  if (scopedAtRule) problems.push(`${scopedAtRule.length} at-rule(s) scoped as selectors: ${[...new Set(scopedAtRule)].join(' | ')}`);
  // A rule count that collapses means blocks were eaten rather than rewritten.
  const srcRules = (source.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{/g) || []).length;
  const outRules = (bare.match(/\{/g) || []).length;
  if (outRules !== srcRules) problems.push(`block count changed: ${srcRules} -> ${outRules}`);
  return problems;
}

const problems = verify(generated);
if (problems.length) {
  console.error('FAIL  the scoping transform is wrong:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

// ---- the app files themselves ----------------------------------------------------------------
// Chrome resolves a content script's `js` entries against the EXTENSION ROOT, so it cannot reach
// `webapp/public/`. These are COPIES, and `webapp/public/` remains the one canonical source -- the
// extension directory is a build output, which is why `--check` exists and why `extension/vendor/`
// is generated rather than edited.
//
// THE ORDER IS THE LOAD ORDER AND IT IS LOad-BEARING: these files populate `window.*` globals in
// tag order exactly as `index.html` does, so `storeSchema.js` must follow `hunterDefs.js` and
// `optimizer/space.js`. This list is deliberately MUCH shorter than index.html's -- no app.js, no
// cloudSync, no Appwrite, no hunter UI -- because the fleet pages need only these.
const VENDOR = path.join(__dirname, '..', 'extension', 'vendor');
const COPY = [
  // Mirrors index.html's own order exactly, minus cloudSync.js and the Appwrite SDK: the account
  // system is dropped entirely (embedded, the user is already signed in to their own cifi-tools
  // account) and a remote SDK script is forbidden by MV3 anyway.
  'icons.js',
  'assetUrl.js',
  'hunterDefs.js',
  'shipSchema.js',
  'accountState.js',
  'shipsPage.js',
  'upgradeEffects.js',
  'hunterSimBrowser.js',
  'optimizer/space.js',
  'optimizer/objective.js',
  'storeSchema.js',
  'optimizer/refit.js',
  'optimizer/corpus.js',
  'optimizer/search.js',
  'optimizer/runner.js',
  'saveImport.js',
  'buildCode.js',
  'costFormulas.js',
  'bigNumberInput.js',
  'incomeModel.js',
  'hunterStatPath.js',
  'hunterStatPathBrowser.js',
  'hunterStatPathPage.js',
  'app.js',
  // NOT content scripts -- loaded by the worker and by fetch at runtime, so they ship as
  // web_accessible_resources instead. params.json is fetched relative to HUNTERSIM_ASSET_BASE.
  'params.json',
];

// ---- the static markup shipsPage.js binds at load time ----------------------------------------
// THIS IS THE BUG THAT ONLY APPEARS ON THEIR ORIGIN, AND IT FAILED AS SOMETHING ELSE ENTIRELY.
// shipsPage.js ends with top-level `document.getElementById('closeShipBuildModalBtn').onclick = …`
// for five modals whose markup is in index.html. On cifi-tools.com those elements do not exist, so
// the very first one throws -- and because it is top-level, the REST OF THE FILE never runs. The
// visible symptom was `FleetStoreDefaults.shipGear is missing` from storeSchema.js 1,600 lines
// later, which reads as a load-ORDER problem and is not one.
//
// So the modals are extracted from index.html and injected before shipsPage.js runs. Extracted
// rather than hand-copied: they are real UI (ship build, optimize, loadouts, checklist) that must
// not drift from the website's copy.
// DERIVED, NOT LISTED. index.html's body has exactly three kinds of top-level element: the site
// header, the layout column (sidebar + #pageRoot), and then every modal/popover as its own id'd
// <div>. The first two are cifi-tools' own chrome's job on their page; the modals are ours to
// bring. Selecting "top-level div with an id" captures all of them and cannot go stale when a
// modal is added -- a hand-list would silently miss the new one, and the failure is a top-level
// throw that kills a whole file (see the FleetStoreDefaults incident).
function shellIds(html) {
  const body = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'));
  const ids = [];
  let depth = 0;
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'path', 'hr', 'use', 'circle']);
  for (let m; (m = tagRe.exec(body));) {
    const [, close, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (VOID.has(tag) || attrs.trimEnd().endsWith('/')) continue;
    if (close) { depth--; continue; }
    if (depth === 0 && tag === 'div') {
      const id = attrs.match(/id="([^"]+)"/);
      if (id) ids.push(id[1]);
    }
    depth++;
  }
  return ids;
}

/** Pull one element out of the HTML by id, matching tag depth so nested divs do not truncate it. */
function extractById(html, id) {
  const at = html.search(new RegExp(`<(\\w+)[^>]*\\bid="${id}"`));
  if (at === -1) throw new Error(`index.html has no element with id="${id}"`);
  const tag = html.slice(at).match(/^<(\w+)/)[1];
  const open = new RegExp(`<${tag}\\b`, 'g');
  const close = new RegExp(`</${tag}>`, 'g');
  let depth = 0, i = at;
  while (i < html.length) {
    open.lastIndex = close.lastIndex = i;
    const o = open.exec(html); const c = close.exec(html);
    if (!c) throw new Error(`unterminated <${tag}> for id="${id}"`);
    if (o && o.index < c.index) { depth++; i = o.index + 1; }
    else { depth--; i = c.index + 1; if (depth === 0) return html.slice(at, c.index + c[0].length); }
  }
  throw new Error(`unterminated <${tag}> for id="${id}"`);
}

function buildShell() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'public', 'index.html'), 'utf8');
  const ids = shellIds(html);
  if (ids.length < 5) throw new Error(`shell extraction found only ${ids.length} modals -- index.html's structure changed`);
  const markup = ids.map((id) => extractById(html, id)).join('\n');
  // JSON.stringify handles every quote, backslash and newline in the markup -- a template literal
  // would break on the first backtick or ${ in their HTML.
  return `// GENERATED by tools/build-companion.js from webapp/public/index.html -- DO NOT EDIT.
//
// The five modals shipsPage.js binds AT TOP LEVEL. Without them in the DOM its first
// getElementById(...).onclick throws and the rest of the file -- including FleetStoreDefaults --
// never executes. Must load BEFORE shipsPage.js.
//
// They are hosted OUTSIDE the page container because that container is hidden whenever the user is
// on one of cifi-tools' own routes, and a modal inside a hidden parent cannot be shown.
'use strict';
(function () {
  if (document.getElementById('cifi-companion-modals')) return;
  const host = document.createElement('div');
  host.id = 'cifi-companion-modals';
  host.className = 'cifi-companion';   // carries the scoped stylesheet; see ROOT in the build script
  host.innerHTML = ${JSON.stringify(markup)};
  document.body.appendChild(host);
})();
`;
}

function syncVendor(check) {
  const stale = [];
  for (const rel of COPY) {
    const from = path.join(__dirname, '..', 'webapp', 'public', rel);
    const to = path.join(VENDOR, rel);
    const want = fs.readFileSync(from);
    const have = fs.existsSync(to) ? fs.readFileSync(to) : null;
    if (have && have.equals(want)) continue;
    if (check) { stale.push(rel); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, want);
  }
  return stale;
}

const SHELL_OUT = path.join(__dirname, '..', 'extension', 'shell.js');
const shell = buildShell();

if (process.argv.includes('--check')) {
  const cssStale = !fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== generated;
  const shellStale = !fs.existsSync(SHELL_OUT) || fs.readFileSync(SHELL_OUT, 'utf8') !== shell;
  const jsStale = syncVendor(true);
  if (cssStale || shellStale || jsStale.length) {
    console.error('FAIL  extension/ is STALE -- run: node tools/build-companion.js');
    if (cssStale) console.error('  - companion.css does not match tokens.css');
    if (shellStale) console.error('  - shell.js does not match index.html');
    for (const f of jsStale) console.error(`  - vendor/${f} does not match webapp/public/${f}`);
    process.exit(1);
  }
  console.log(`ok    extension/ is current (companion.css, shell.js, ${COPY.length} vendored files)`);
} else {
  fs.writeFileSync(OUT, generated);
  fs.writeFileSync(SHELL_OUT, shell);
  syncVendor(false);
  const scoped = (generated.match(/\.cifi-companion\b/g) || []).length;
  console.log(`wrote ${path.relative(process.cwd(), OUT)}  (${scoped} scoped selectors)`);
  console.log(`wrote extension/shell.js  (${shellIds(fs.readFileSync(path.join(__dirname,'..','webapp','public','index.html'),'utf8')).length} modals, ${shell.length} bytes)`);
  console.log(`synced ${COPY.length} file(s) into extension/vendor/`);
}
