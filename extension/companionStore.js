// THE COMPANION'S STORE, living on someone else's origin.
//
// `shipsPage.js` reads `window.store` and calls `window.saveStore()` 79 and 27 times respectively,
// and both are defined in `app.js` -- 3,100 lines of routing, hunter UI and auth the extension does
// not load. This provides exactly those two, over the same `StoreSchema` the site uses, so the
// ported pages need no changes at all.
//
// ============================================================================================
// TWO THINGS ARE DIFFERENT HERE FROM THE WEBSITE, AND BOTH ARE ABOUT BEING A GUEST.
//
// 1. EVERY KEY IS NAMESPACED. We share cifi-tools' origin, and therefore their localStorage --
//    which already holds ~1,430 keys of theirs. An unprefixed `huntersim_clone_v2` would sit in
//    their storage looking like their data, and a generic name like `gems_showOnlySimRelevant`
//    could collide outright, today or after any future deploy of theirs. Everything we write is
//    under `cifi-companion:`, so their keys and ours can never meet and a user can identify and
//    remove ours precisely.
//
// 2. THE DURABLE MIRROR IS `chrome.storage.local`, NOT IndexedDB. The website mirrors to IndexedDB
//    because browsers bundle localStorage into "clear cache" and there is no backend to restore
//    from. That reasoning holds here and gets WORSE: on their origin, a user clearing cifi-tools'
//    site data would take our store with it -- and they have every reason to clear THEIR site
//    without expecting to lose OUR data. `chrome.storage.local` belongs to the extension, survives
//    site-data clearing, and is not theirs to lose.
//
// Consequence, stated because it shapes the boot: reading the mirror is ASYNC, so `init()` must be
// awaited before any page renders. The website's `loadStore()` is synchronous and this deliberately
// is not -- do not "simplify" it back, the mirror is the point.
// ============================================================================================
'use strict';

const PREFIX = 'cifi-companion:';
const STORAGE_KEY = PREFIX + 'store';

/** Namespaced localStorage, for the store and for any per-view UI preference a ported page keeps. */
const local = {
  get(key) { try { return localStorage.getItem(PREFIX + key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(PREFIX + key, value); } catch { /* quota */ } },
};

function mirrorWrite(json) {
  // Fire-and-forget: a failed mirror must never block the working copy that was already written.
  try { chrome.storage.local.set({ [STORAGE_KEY]: json }); } catch { /* extension context gone */ }
}

function mirrorRead() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(STORAGE_KEY, (got) => resolve((got && got[STORAGE_KEY]) || null));
    } catch { resolve(null); }
  });
}

/**
 * Parse, migrate and validate one serialized store. Shared by both sources so the mirror cannot
 * take a different path from the working copy -- a second, subtly different load path is how a
 * "backup" ends up being the thing that corrupts you.
 */
function adopt(raw) {
  const parsed = JSON.parse(raw);
  const migration = window.StoreSchema.migrateStore(parsed);
  const problems = window.StoreSchema.validateStore(parsed);
  if (problems.length) {
    // Logged loudly, never thrown: a validation bug must not lock someone out of their own data,
    // and there is no backend to restore from. The benches treat these as hard failures instead.
    console.error(`[cifi-companion] ${problems.length} store invariant violation(s):\n  ${problems.join('\n  ')}`);
  }
  return { store: parsed, changed: migration.changed };
}

async function init() {
  let store = null;

  const raw = local.get('store');
  if (raw) {
    try {
      const adopted = adopt(raw);
      store = adopted.store;
      if (adopted.changed) local.set('store', JSON.stringify(store));
    } catch (err) {
      console.error('[cifi-companion] working copy unreadable, trying the mirror:', err);
    }
  }

  if (!store) {
    const mirrored = await mirrorRead();
    if (mirrored) {
      try {
        store = adopt(mirrored).store;
        // Restore the working copy so the next load is synchronous again.
        local.set('store', JSON.stringify(store));
        console.info('[cifi-companion] store restored from the extension mirror');
      } catch (err) {
        console.error('[cifi-companion] mirror unreadable:', err);
      }
    }
  }

  if (!store) store = window.StoreSchema.freshStore();

  window.store = store;
  window.saveStore = function saveStore() {
    const json = JSON.stringify(window.store);
    local.set('store', json);
    mirrorWrite(json);
  };
  return store;
}

window.CompanionStore = { init, local, PREFIX, STORAGE_KEY };
