# CIFI Tools Companion Bridge

A ~90-line browser extension whose entire job is to fetch **cifi-tools.com's simulation engine into
your own browser**, so this companion site never hosts or redistributes a copy of it.

## Why it exists

The companion site is our own work — save import, fleet and ship-install optimization, the hunter
UI. The simulator itself is cifi-tools.com's compiled `release.wasm`, and that is **theirs**.
Serving a copy of it from our GitHub Pages site is redistribution however it is framed, so this
moves the fetch to where it belongs: your browser, talking to the origin that owns the file,
exactly as if you had opened cifi-tools.com yourself.

Nothing is copied to a server of ours, nothing is cached anywhere but your own browser, and if
cifi-tools goes away the tool fails cleanly rather than serving a stale unauthorised copy.

## Why it has to be an extension

Because a web page physically cannot do this. cifi-tools.com sends **no
`Access-Control-Allow-Origin` header on any path** — measured on GET and on OPTIONS preflight,
against `/`, `/wasm/release.wasm` and `/assets/`. So a page on our origin is blocked by CORS before
its JavaScript ever sees the bytes. That is a browser rule, not a policy choice, and no amount of
page-side cleverness works around it.

An extension with `host_permissions` is exempt, because **you** installed it and granted that
access.

## Install

Not yet published to a store. To load it unpacked:

**Chrome / Edge**
1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` folder

**Firefox** (including Firefox for Android)
1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on** → select `manifest.json`

Then open the companion site. If the bridge is active the page uses it automatically; there is no
setting and no UI.

## Mobile

| platform | works? |
|---|---|
| **Firefox for Android** | yes — the practical mobile path |
| **Chrome for Android** | no. Chrome on Android does not support extensions at all |
| **Safari on iOS** | possible in principle, but an extension must ship inside a native app through the App Store |
| **Samsung Internet** | content blockers only |

This is the honest cost of the approach: CIFI is a mobile game, and most of its players are on
Chrome for Android where extensions do not exist.

## What it can and cannot reach

Deliberately narrow:

- **one origin**: `https://cifi-tools.com` and nothing else
- **`.wasm` paths only**
- only on pages matching the content script's `matches` (the companion site, and localhost for
  development)

The **page** chooses which `.wasm` file; the **extension** pins the origin. That is why a rename on
cifi-tools' side is a one-line site deploy rather than an extension update. Accepting an arbitrary
URL from the page would turn this into an open cross-origin proxy for anything running on our
origin, which is exactly the capability the same-origin policy exists to withhold.

## It stays dumb, on purpose

It relays bytes. No game logic, no optimizer, no UI, no knowledge of what the engine does — all of
that lives on the website and deploys independently, so iterating on the tool never needs an
extension update.

**It must never fetch and run code.** Eliminating remotely-hosted code is the whole point of
Manifest V3; the Chrome Web Store and AMO both reject or remove extensions that execute code
fetched at runtime. "Serve the extension's logic from a server so users never have to update" is
precisely the pattern that policy forbids — and it solves a problem that does not exist, because a
store-published extension auto-updates within hours anyway.

## How the page uses it

`webapp/public/hunterSimBrowser.js` → `engineFromExtension()`:

1. The content script sets `document.documentElement.dataset.cifiCompanionBridge = '1'` at
   `document_start`, so presence is detectable synchronously. (A `window` property would NOT work —
   a content script runs in an isolated world, so anything it assigns to `window` is invisible to
   the page. That is the classic way this pattern silently does nothing.)
2. The page posts a request; the bridge relays it to the service worker, which fetches and returns
   the bytes base64-encoded (`chrome.runtime.sendMessage` serializes as JSON and would deliver an
   ArrayBuffer as `{}` — silently, as a zero-length engine).
3. A 15s timeout falls back rather than hanging, because an installed-but-asleep worker or a
   revoked permission otherwise produces a reply that never arrives.

**Workers get the compiled module, not a URL.** A Worker has no `document`, so it can never reach a
content script; left alone it would fetch `release.wasm` from our origin — the exact copy this
exists to avoid. So the main thread resolves the engine once and posts the compiled
`WebAssembly.Module` (which is structured-cloneable) to every worker, which is also cheaper than N
fetches and N compiles. `HunterSim.expectInjectedWasm()` parks the loader on a promise the
injection settles, so a worker that is promised an engine and never given one **waits visibly**
instead of quietly downloading its own.

## Current status

The hosted site still ships `release.wasm` directly, and the loader falls back to it when the
extension is absent. Removing that fallback is a separate decision — see `THIRD-PARTY.md` for the
inventory and the options.
