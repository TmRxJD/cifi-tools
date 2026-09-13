# CIFI Tools Companion

A browser extension that adds this project's **fleet and ship-install tools** to
**cifi-tools.com**, running in your own browser.

It is not a copy of cifi-tools and does not host anything of theirs. Their page loads their
simulator from their own server, exactly as it always has; this adds pages beside it.

---

## Why it works this way

The simulator is cifi-tools' compiled `release.wasm` — their build output, not ours. The companion
website in `webapp/` has to serve a copy of it to function, which is redistribution however
carefully it is labelled.

Running **inside their page** removes the problem rather than relocating it:

- their engine is **same-origin** there, so it is fetched from the server that owns it;
- the **account state is already in the browser**, so there is nothing to import or sync;
- the user is **already signed in to their own cifi-tools account**, so this keeps no user records
  and runs no backend.

An earlier version of this extension did the opposite — a content script on *our* site relaying
their wasm across origins to defeat CORS. That was solving a problem that only existed because we
were on the wrong origin, and it left the local copy shipping anyway for anyone without the
extension. It is deleted, not disabled.

See `../THIRD-PARTY.md` (route 4) for what this resolves and what it does not.

---

## Install (unpacked)

1. `node tools/build-companion.js` from the repo root — generates `companion.css` and `vendor/`.
2. Chrome → `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select this `extension/` directory.
4. Open **https://cifi-tools.com** and reload the page.

The header has one **Hunters** destination and one **Fleet** destination. Hunters is the standalone
application's complete Hunter surface: Borge/Ozzy/Knox tabs, build cards and every card action,
Build Creator, Effective Path, import, overrides, filtering, categories and optimizer. Ship Setup,
Gear Sets, Research and Academy Badges are added to the site's own sidebar categories. Gems remains
the site's native `/upgrades/gems` page.

There is no popup and the toolbar icon does nothing — it works passively on the page.

---

## Layout

| Path | What it is |
|---|---|
| `manifest.json` | MV3. MAIN-world host adapters and isolated-world tool scripts, with `storage` permission. |
| `routes.js` | The single registry of genuinely added pages; contains no native route replacements. |
| `hostRouting.js` | Adds the six companion records to native Vue Router and integrates the original native sidebar component. |
| `companion.js` | Renders added tool contents only, in containers mounted/unmounted by Vue. |
| `hostStoreBridge.js` | Applies imported native fields to the site's actual Pinia stores. |
| `config.js` | Embedded runtime configuration; app.js owns private tool state. |
| `integration.css` | Minimal layout integration; native link/icon/gate styling stays native. |
| `shell.js` | **Generated** from `index.html`: the five modals `shipsPage.js` binds at load time. Must load before it. |
| `companion.css` | **Generated** from `webapp/public/tokens.css`, every selector scoped. |
| `vendor/` | **Generated** copies of `webapp/public/` files. Do not edit. |

**`companion.css` and `vendor/` are build output.** `webapp/public/` is the one canonical source;
`node tools/build-companion.js --check` fails if either has drifted, and
`tools/bench/companion-deps-check.js` runs that check as part of `tools/bench/all.js`.

---

## Four things that will bite you

- **`shipsPage.js` binds five modals at TOP LEVEL** against markup from `index.html`. Without it the
  first binding throws and the rest of the file — including `FleetStoreDefaults` — never runs, which
  surfaces 1,600 lines later as a `storeSchema` error that looks like a load-order bug. `shell.js`
  supplies that markup and must load first.


- **The stylesheet must stay scoped.** A content script's CSS applies to the whole document.
  `tokens.css` styles `body` and `:root`, so loading it unscoped would restyle *their* site. The
  generator re-roots every selector at `.cifi-companion` and verifies its own output — it has
  had two bugs that produced valid-looking CSS with rules silently deleted.

- **Every storage key is namespaced `cifi-companion:`.** We share their origin and therefore their
  localStorage, which already holds ~1,430 of their keys. The durable mirror is
  `chrome.storage.local`, not IndexedDB, because a user clearing *their* site data has no reason to
  expect it would destroy *our* store.

- **Nav entries are cloned from a live link, never authored.** Their site is Vue; nav links carry a
  scoped-style attribute (`data-v-…`) whose hash changes when they rebuild, and their Tailwind
  classes can be retuned at any deploy. Cloning is what makes our entries indistinguishable from
  theirs and what keeps them that way. For the same reason, Vue discarding our nodes on re-render
  is expected: a `MutationObserver` reinstates them.

## Routing contract and verification

The site's Vue Router is the only history owner. Native routes, redirects, lazy components and
store subscriptions remain native. The extension does not replace Gems, intercept native links,
write history directly, or move/hide native RouterView DOM children. Its complete six-page surface
mounts through Vue route records under `/companion/` (no hash router). The site's three individual
Hunter links are hidden from the header in favor of the one companion Hunters destination.

The persistent sidebar uses the site's **actual UpgradesSidebar component**, not a copied menu.
Its native Pinia subscriptions own progression filtering, icons and active-link state. The native
Settings sidebar toggle controls visibility. Route-local instances are suppressed so there is
exactly one sidebar, independent of the previously visited page.

This adapter depends on the production Vue app instance, exported native components and the root
layout shape. Those contracts are validated at startup and fail with an integration error if the
site changes; no replacement native-page renderer is used as a fallback.

Run `node tools/bench/all.js` for local gates. For routing release verification, install Playwright
and its Chromium runtime, then run `node tools/bench/companion-browser-check.js`. This launches the
actual unpacked extension against cifi-tools.com in a disposable profile and checks native Gems,
all six additions, the complete standalone Hunter feature contract, optimizer cancellation, reload,
back/forward, imported progression gates and the native sidebar toggle.
`--negative-control` deliberately hides native content and **must exit nonzero**. Browser tests
require network access; they are not replaced by the source/dependency checks in the local suite.

Also run `node tools/bench/companion-gems-browser-check.js`: it uses the actual save mapper's
populated, partial gem states. This reproduced the live blank Gems bug that an empty-account
routing test missed. The host-store boundary must merge this partial projection into a complete
native `{level,nodes,upgrades}` state, preserving GU values the importer does not model.
Version 2.3.1 repairs older states missing `upgrades`, retaining the original payload under
`cifi-companion:gem-store-before-upgrades-repair` before changing it.

---

## Status

Hunters, Fleet, Ships, Gear, Research, and Badges are mounted as added pages. The Hunter surface is
generated directly from the standalone app's canonical renderer. Its scoring adapter talks directly to the native same-origin
evaluation worker already published by cifi-tools.com; the extension does not package, proxy,
cache, or fall back to a copy of their engine or worker.
