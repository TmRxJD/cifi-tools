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
//
// `render` NAMES the global rather than holding a reference, because these live in shipsPage.js and
// are assigned to `window` when that file runs -- capturing them at module scope would freeze
// whatever was defined at the time this array was evaluated, which for a content script is before
// anything has rendered. Resolved per navigation instead, and a missing one is reported rather than
// throwing an opaque "undefined is not a function" from inside a click handler.
const PAGES = [
  { id: 'fleet',    label: 'Fleet',    render: 'renderFleetPage',     icon: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-4' },
  { id: 'ships',    label: 'Ships',    render: 'renderShipSetupPage', icon: 'M4 18l-1-5h18l-2 4M5 13V7h8l4 6M7 7V4h6' },
  { id: 'gear',     label: 'Gear',     render: 'renderGearSetsPage',  icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4' },
  { id: 'research', label: 'Research', render: 'renderResearchPage',  icon: 'M9 3v6l-5 9a2 2 0 002 3h12a2 2 0 002-3l-5-9V3M9 3h6' },
  { id: 'badges',   label: 'Badges',   render: 'renderBadgesPage',    icon: 'M12 15l-3.5 2 1-4-3-2.5 4-.3L12 6l1.5 4.2 4 .3-3 2.5 1 4z' },
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
  // The scoped stylesheet keys off this CLASS, not the id, because the modal host in shell.js must
  // carry the same styling and cannot share an id with us. See ROOT in tools/build-companion.js.
  root.className = 'cifi-companion';
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
  el.innerHTML = '<div class="p-4 sm:p-6 max-w-[1440px] mx-auto"></div>';
  const host = el.firstElementChild;

  const render = window[page.render];
  if (typeof render !== 'function') {
    // NAMED, NOT SILENT. A missing renderer means the vendored copy of shipsPage.js is stale or
    // failed to parse, and an empty page gives no hint of that.
    host.textContent = `Companion: ${page.render}() is not available -- re-run tools/build-companion.js.`;
    return log('missing renderer', page.render);
  }
  try {
    render(host);
  } catch (err) {
    // One page throwing must not take out the nav or strand the user on a blank screen with their
    // own site hidden behind it.
    console.error('[cifi-companion]', page.render, 'threw:', err);
    host.textContent = `Companion: the ${page.label} page failed to render -- see the console.`;
  }
}

// ---- boot ------------------------------------------------------------------------------------
(async function boot() {
  log('active on', location.origin);

  // THE STORE IS AWAITED BEFORE ANYTHING RENDERS. `shipsPage.js` reads `window.store` at the top of
  // every render, and the durable mirror in `chrome.storage.local` is async to read -- so rendering
  // first would show a fresh empty store and then, worse, SAVE over the real one on the user's
  // first edit. Ordering here is data safety, not tidiness.
  try {
    await window.CompanionStore.init();
  } catch (err) {
    // Without a store there is nothing safe to draw, and drawing anyway risks overwriting real data.
    return console.error('[cifi-companion] store failed to initialise; not mounting.', err);
  }

  const desktopNav = await waitFor('header nav');
  if (desktopNav) keepMounted(desktopNav);
  else log('desktop nav not found within timeout');

  installRouterHook(renderRoute);
  renderRoute();
})();
