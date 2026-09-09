# Handoff: porting the hunter optimizer into the companion extension

**Branch: `companion-optimizer-port`. Do not merge to `master` until the "Verification" section
passes — `pages.yml` deploys `webapp/public` from `master` to the live site on every push.**

Read `CLAUDE.md` first (it is the project contract), then `extension/README.md`, then this.

---

## The goal

Put this project's **hunter optimizer** onto **cifi-tools.com** itself, as a browser extension,
alongside their own tools — the same UI the website at `webapp/public/` provides.

**Why the extension exists at all.** The simulator is cifi-tools' compiled `release.wasm` — their
build output, not ours. The website has to serve a copy of it to work, which is redistribution.
Running *inside* their page removes the problem instead of relocating it: their engine is
**same-origin** there, so it is fetched from the server that owns it and no copy is hosted,
cached, or transmitted by us. See `THIRD-PARTY.md` route 4.

**Do not "simplify" this back into hosting the wasm, proxying it, or bundling it in the
extension.** All three were considered and rejected; the reasoning is in `THIRD-PARTY.md`.

---

## Where things stand

`master` is clean, deployed and working. Everything below is on this branch only.

### Done

| | |
|---|---|
| Fleet pages mount on their site | `Fleet · Ships · Gear · Research · Badges` inject into cifi-tools' own nav and render into their layout |
| `app.js` is loadable as a library | Six bootstrap side effects gated on `window.HUNTERSIM_EMBEDDED` (already on `master`) |
| All 25 app files vendored | `extension/vendor/`, mirroring `index.html`'s load order minus `cloudSync.js` and the Appwrite SDK |
| Shell markup derived | `shell.js` extracts the 13 modal/popover divs from `index.html` automatically |
| Scoped stylesheet | `companion.css` generated from `tokens.css`, every selector re-rooted at `.cifi-companion` |
| Worker URL override | `HUNTERSIM_WORKER_URL` in `optimizer/runner.js` |
| Engine URL override | `HUNTERSIM_ENGINE_URL` in `hunterSimBrowser.js`; the dead postMessage bridge is deleted |
| Dependency gate | `tools/bench/companion-deps-check.js`, wired into `tools/bench/all.js` |

### Not done

1. **`extension/config.js`** — must load **first** in `content_scripts.js`, before any vendored
   file. Sets, on `window`:
   - `HUNTERSIM_EMBEDDED = true`
   - `HUNTERSIM_STORAGE_KEY = 'cifi-companion:store'`
   - `HUNTERSIM_IDB_NAME = 'cifi-companion-backup'`
   - `HUNTERSIM_ASSET_BASE = chrome.runtime.getURL('vendor/')` — so `params.json` resolves
   - `HUNTERSIM_WORKER_URL = chrome.runtime.getURL('vendor/optimizer/worker.js')`
   - `HUNTERSIM_ENGINE_URL = 'https://cifi-tools.com/wasm/release.wasm'` — same-origin there

2. **`manifest.json`** — add every vendored file to `content_scripts.js` in `index.html`'s order
   (`companion-deps-check.js` enforces this), and add `web_accessible_resources` for
   `vendor/optimizer/worker.js` and `vendor/params.json`. Those two are **not** content scripts:
   the worker is constructed by URL, and `params.json` is fetched at runtime.

3. **`companion.js`** — create `<div id="pageRoot">` inside the companion root and call `app.js`'s
   `render()` for hunter routes. `render()` reads the hash (`#/sim`), so either set the hash or
   call `renderSimPage(root)` directly. It already tolerates the website's sidebar being absent:
   `milestoneSidebarLabel` is null-guarded and the `.sidebar-link` / `[data-nav]` loops are
   no-ops on empty NodeLists — but `updateNavGating()` and `applyInterfacePrefs()` are **not
   audited**; check them before assuming.

4. **Delete `extension/companionStore.js`.** Once `app.js` is vendored it owns `window.store` and
   `window.saveStore`, keyed by `HUNTERSIM_STORAGE_KEY`. Two store implementations is exactly the
   parallel-implementation trap `CLAUDE.md` bans. Note this **loses the `chrome.storage.local`
   mirror**; `app.js` mirrors to IndexedDB instead, which on their origin dies if the user clears
   cifi-tools' site data. Decide deliberately, don't drift into it.

5. **The worker's engine.** A `Worker` has no `document` and runs on the **extension origin**, so
   it cannot fetch their wasm. It does not need to: `runner.js` already resolves the engine once on
   the main thread and `postMessage`s the compiled `WebAssembly.Module` to every worker
   (`HunterSim.setWasmModule` / `expectInjectedWasm`). Confirm `worker.js` still calls
   `expectInjectedWasm()` at the top so it never falls back to fetching.

---

## Traps that have already bitten, each costing real time

These are not hypothetical. Every one happened during this work.

1. **`shipsPage.js` binds five modals at TOP LEVEL** against `index.html` markup. Where that markup
   is absent the first binding throws and **the rest of the file never runs** — including
   `window.FleetStoreDefaults` at line 3281. The symptom surfaced as
   `storeSchema: FleetStoreDefaults.shipGear is missing (shipsPage.js must load before
   storeSchema.js)` 1,600 lines later, which reads as a load-order bug and is not one.
   `shell.js` supplies the markup. **`app.js` has 22 more such top-level bindings** — if any id it
   needs is missing, expect the same shape of failure.

2. **Load order is the dependency graph** — no modules, `window.*` globals populated in tag order.
   A hand-written list of ordering pairs shipped a wrong manifest; `companion-deps-check.js` now
   derives the order from `index.html`. Keep it that way.

3. **CSS is not sandboxed in a content script.** `tokens.css` styles `body` and `:root`; unscoped it
   would restyle *their* site. The generator re-roots everything at `.cifi-companion` and verifies
   its own output — it has had two bugs producing valid-looking CSS with rules silently deleted.

4. **Their site is Vue.** Nav links carry a `data-v-…` scoped-style attribute whose hash changes
   when they rebuild. **Clone a live link; never author nav markup.** Vue discarding our injected
   nodes on re-render is normal — a `MutationObserver` reinstates them.

5. **Deploys are not atomic across `index.html` and the JS files.** No build step, so they are
   cached independently, and `?v=` is only a cache-buster — the server returns the current file
   whatever the query says. A visitor with a cached `index.html` gets **new JS against old
   markup**. This took the live site down: new `shipsPage.js` required `#loadoutDetailFooter`,
   which the cached shell lacked, and one null `.classList` killed every button.
   **A JS file may not require markup a cached `index.html` might lack.** `reloadIfShellIsStale()`
   narrows the window and cannot close it — it fired and still lost.

6. **`bossHpPercent` reads 0 for two opposite situations** and has produced four wrong answers in
   this repo. Unrelated to the port, but you will meet it in the optimizer code.

---

## Verification

Run from the repo root. **`node tools/build-companion.js` must be run after any change to
`webapp/public/`** — `extension/vendor/`, `companion.css` and `shell.js` are build output.

```bash
node tools/build-companion.js            # regenerate; self-verifies the CSS transform
node tools/build-companion.js --check    # fails if extension/ has drifted
node tools/bench/companion-deps-check.js # globals + load order + renderers + freshness
node tools/bench/engine-source-check.js  # NEW, never run green yet -- see below
node tools/bench/all.js                  # the wired gate
node tools/bench/run.js --sample=12      # optimizer quality, stratified
```

**`engine-source-check.js` was written but never executed.** It replaces the deleted
`engine-bridge-check.js` and is still named in `tools/bench/all.js` under the OLD name — fix that
list. Per `MEASUREMENT.md`, a new measurement tool is not trusted until it has been shown to
**fail on a known-bad input**; do that before believing it.

**The rewritten engine loader in `hunterSimBrowser.js` has NOT been exercised in a browser.** It is
on the website's critical path (`loadWasmModule`), so verify the site still works before merging:

```bash
node webapp/server.js    # then open the sim page and run an optimize
```

### What cannot be verified without the user

Loading an unpacked extension needs a human at the browser. **Both previous extension attempts
looked correct and failed at runtime** — once from a `document_start` null, once from a manifest
that omitted a needed file. Do not report this working until it has actually been loaded:

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`
2. Open `https://cifi-tools.com`, reload, and check the console for
   `[cifi-companion] active on https://cifi-tools.com` **with no errors before it**
3. The engine line must say it came from **cifi-tools.com's own copy** — if it says "this site's
   own copy", `HUNTERSIM_ENGINE_URL` did not reach `hunterSimBrowser.js`

---

## Ground rules for this codebase

From `CLAUDE.md`, and they are enforced by benches:

- **No silent defaults, no `|| {}`.** A missing required input throws with the field named.
- **One canonical implementation per concern.** Do not copy a renderer into the extension —
  vendor it. `extension/vendor/` is generated; edit `webapp/public/`.
- **No fallbacks or legacy paths.** Dead code is deleted; git history is the archive. The two
  exceptions here are deliberate and documented in place: the embedded-mode guards (a *mode*, not
  a fallback) and the stale-shell footer lookup (a cache-skew defence).
- **Validate, don't assert.** Run the gate. If you claim a cause, prove it.
- **Comments explain WHY.** The comments in this repo carry hard-won findings — preserve them.

Two things remain open and are **not** part of this port: the ~17MB of game artwork in
`THIRD-PARTY.md` (different rights holder), and the website still shipping `release.wasm`.
