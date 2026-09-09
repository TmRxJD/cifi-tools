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

You should see **Fleet · Ships · Gear · Research · Badges** appear in their nav, and this in the
console:

```
[cifi-companion] active on https://cifi-tools.com
```

There is no popup and the toolbar icon does nothing — it works passively on the page.

---

## Layout

| Path | What it is |
|---|---|
| `manifest.json` | MV3. One content script, `storage` permission, no host permissions and no background worker — none are needed on their origin. |
| `companion.js` | Nav injection, router hook, and mounting our pages. |
| `companionStore.js` | `window.store` / `window.saveStore`, namespaced and mirrored. |
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
  generator re-roots every selector at `#cifi-companion-root` and verifies its own output — it has
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

---

## Status

Fleet, Ships, Gear, Research and Badges are mounted. The **hunter optimizer is not yet ported** —
it needs its Web Worker pool, which requires `web_accessible_resources` in the manifest.
