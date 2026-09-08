// THE COMPANION, RUNNING INSIDE cifi-tools.com.
//
// WHY THIS SHAPE. The simulator is cifi-tools' own compiled `release.wasm` and the account data is
// in the user's own cifi-tools session. Running our tools as a content script on THEIR origin means
// neither ever has to be copied: the engine is fetched same-origin from the server that owns it,
// and the account state is read from the browser that already holds it. We ship only our own code.
//
// This replaces the earlier "bridge" extension, which put a content script on OUR site and relayed
// cifi-tools' wasm across origins. That existed solely to defeat CORS -- and CORS was only ever a
// problem because we were on the wrong origin. Here `fetch('/wasm/release.wasm')` is SAME-ORIGIN,
// so the entire relay, its background worker and its base64 round-trip are unnecessary. Deleted
// rather than disabled.
//
// ============================================================================================
// THEIR SITE IS VUE, AND EVERY ASSUMPTION ABOUT ITS MARKUP MUST BE READ AT RUNTIME.
//
// Nav links carry a scoped-style attribute (`data-v-c23983a9`) whose hash changes whenever they
// rebuild that component, and their Tailwind utility classes can be retuned at any deploy. So we
// never hard-code markup: we CLONE an existing link and retarget it. Whatever classes and scoped
// attributes their current build uses, our entry inherits them -- which is both why it looks
// native and why a redeploy cannot leave us styled like a stranger.
//
// The same reasoning is why Vue re-rendering is treated as normal rather than exceptional: Vue owns
// these nodes and will discard ours whenever it patches. `keepMounted` reinstates them. Do NOT
// "fix" that by mounting into a node Vue does not manage -- that trades a self-healing overlay for
// one that silently drifts out of their layout.
// ============================================================================================
'use strict';

const ROUTE_PREFIX = '/companion';

// Our pages. `icon` is a tabler-icon path, matching the set their nav already uses, so a cloned
// link's <svg> can be repointed rather than restyled.
const PAGES = [
  { id: 'fleet', label: 'Fleet', icon: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-4' },
  { id: 'ships', label: 'Ships', icon: 'M2 20a2.4 2.4 0 002 1 2.4 2.4 0 002-1 2.4 2.4 0 012-1 2.4 2.4 0 012 1 2.4 2.4 0 002 1 2.4 2.4 0 002-1 2.4 2.4 0 012-1 2.4 2.4 0 012 1 2.4 2.4 0 002 1 2.4 2.4 0 002-1M4 18l-1-5h18l-2 4M5 13V7h8l4 6M7 7V4h6' },
];

const log = (...a) => console.info('[cifi-companion]', ...a);

/** Resolve once the selector matches, or null after `timeout`. Their app boots asynchronously. */
function waitFor(selector, timeout = 15000) {
  const found = document.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

// ---- routing -------------------------------------------------------------------------------
// Their router is history-based (`/home`, `/upgrades/gems`), so navigation produces no event of its
// own -- `pushState` is silent by design. We wrap it to emit one. Wrapping rather than polling
// because a poll either lags the paint or burns a timer forever.
function installRouterHook(onChange) {
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      // Async so their router finishes its own render before we decide what to show.
      setTimeout(onChange, 0);
      return result;
    };
  }
  window.addEventListener('popstate', onChange);
}

const onCompanionRoute = () => location.pathname.startsWith(ROUTE_PREFIX);
const currentPageId = () => location.pathname.slice(ROUTE_PREFIX.length + 1) || PAGES[0].id;

function navigate(href) {
  history.pushState({}, '', href);
}

// ---- nav injection -------------------------------------------------------------------------
/**
 * Build one nav entry by cloning `template` -- see the header comment for why this is a clone and
 * not authored markup.
 */
function buildNavLink(template, page) {
  const link = template.cloneNode(true);
  link.setAttribute('href', `${ROUTE_PREFIX}/${page.id}`);
  link.dataset.cifiCompanionNav = page.id;

  const svg = link.querySelector('svg');
  if (svg) svg.innerHTML = `<path d="${page.icon}"></path>`;

  // Their links wrap the caption in a <span>; fall back to the link itself if that changes.
  const caption = link.querySelector('span') || link;
  caption.textContent = page.label;

  link.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(link.getAttribute('href'));
  });
  return link;
}

/**
 * Insert our entries and KEEP them inserted. Vue discards nodes it does not know about whenever it
 * patches this subtree, so re-attachment is the steady state rather than error handling.
 *
 * THEIR NAV IS FOUR ROUNDED "PILL" GROUPS, NOT A FLAT LIST OF LINKS -- measured: gems / the three
 * hunters + upgrades / tools / settings + donate. Appending our links into whichever group happens
 * to hold the template would drop them inside an unrelated pill. So we clone a GROUP, empty it, and
 * fill it with our own entries -- which is also what makes us read as a peer section of their nav
 * rather than an afterthought bolted onto one.
 */
function keepMounted(nav) {
  // Clone the group with the MOST links: a multi-link group already carries the flex classes that
  // lay siblings out in a row, which a single-link group does not.
  const groups = [...nav.children];
  const templateGroup = groups.reduce((best, g) =>
    g.querySelectorAll('a').length > best.querySelectorAll('a').length ? g : best, groups[0]);
  const templateLink = templateGroup.querySelector('a');
  if (!templateLink) return log('nav has no link to clone -- skipping');

  const attach = () => {
    let group = nav.querySelector('[data-cifi-companion-group]');
    if (!group) {
      group = templateGroup.cloneNode(false);   // shallow: their classes, none of their links
      group.dataset.cifiCompanionGroup = '1';
      // Before the last group so we sit with the tools rather than after settings/donate.
      nav.insertBefore(group, groups[groups.length - 1] || null);
    }
    for (const page of PAGES) {
      if (group.querySelector(`[data-cifi-companion-nav="${page.id}"]`)) continue;
      group.appendChild(buildNavLink(templateLink, page));
    }
  };
  attach();
  new MutationObserver(attach).observe(nav, { childList: true, subtree: true });
}

// ---- our page surface ----------------------------------------------------------------------
/**
 * Find the element their router renders into, so our pages sit exactly where theirs do and inherit
 * the surrounding layout. Falls back to <body> and SAYS SO -- a silently wrong mount would look
 * like a styling bug rather than a failed lookup.
 */
function resolveContentRoot() {
  for (const sel of ['main', '.app-container > div:not(header):not(nav)', '.app-container']) {
    const el = document.querySelector(sel);
    if (el) return { el, sel };
  }
  return { el: document.body, sel: 'body (FALLBACK -- layout will not match)' };
}

let root = null;
let theirView = null;

function ensureRoot() {
  if (root && root.isConnected) return root;
  const { el: content, sel } = resolveContentRoot();
  log('mounting into', sel);
  root = document.createElement('div');
  root.id = 'cifi-companion-root';
  root.hidden = true;
  content.appendChild(root);
  theirView = content;
  return root;
}

function renderRoute() {
  const el = ensureRoot();
  const active = onCompanionRoute();
  el.hidden = !active;

  // Hide THEIR content while ours is up, without unmounting it -- unmounting would make their
  // router re-fetch and re-render on the way back.
  for (const child of theirView.children) {
    if (child !== el) child.style.display = active ? 'none' : '';
  }
  if (!active) return;

  const page = PAGES.find((p) => p.id === currentPageId()) || PAGES[0];
  // These classes are THEIR inner <main>'s, read from the live page: `main > main` is the real
  // content box and the outer <main class="flex-1"> is only the flex row. Mounting beside the inner
  // one and copying its padding/width is what puts our pages on their exact content grid.
  el.innerHTML = `
    <div class="p-4 sm:p-6 max-w-[1440px] mx-auto">
      <h1 class="text-2xl font-bold text-white mb-2">${page.label}</h1>
      <p class="text-gray-400">Companion page mounted. Port target: <code>${page.id}Page.js</code>.</p>
    </div>`;
}

// ---- boot ------------------------------------------------------------------------------------
(async function boot() {
  log('active on', location.origin);

  const desktopNav = await waitFor('header nav');
  if (desktopNav) keepMounted(desktopNav);
  else log('desktop nav not found within timeout');

  installRouterHook(renderRoute);
  renderRoute();
})();
