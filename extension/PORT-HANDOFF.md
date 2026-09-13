# Hunter optimizer companion architecture

Read `AGENTS.md`, `MEASUREMENT.md`, and `extension/README.md` before changing this integration.

## Parity contract

The standalone clone is the authoritative product specification for Hunters. The extension mounts
that canonical renderer as one Hunters destination with Borge/Ozzy/Knox tabs and every standalone
feature. The live site supplies the surrounding visual language, Vue Router, native sidebar and
same-origin evaluator worker. Do not reduce the product to the live site's older Hunter feature set.

There must still be only one extension Hunter renderer, sidebar integration, and evaluator path.
Do not layer independently authored partial Hunter cards or worker hosts over it.

## Canonical boundaries

- `hostRouting.js` registers the single Hunters route, hides the three native Hunter header links,
  and clones the live header treatment for Hunters and Fleet.
- `app.js` owns the complete Hunter renderer and its one canonical optimizer controller.
- `optimizer/runner.js` discovers cifi-tools' deployed `/assets/evaluationWorker-*.js` from its
  loaded application bundle and talks to that worker using its native Comlink wire format. Search,
  allocation legality, objectives and progress remain this project's canonical code.
- `companion.css`, `shell.js`, and `vendor/` are generated. Edit `webapp/public/`, then run
  `node tools/build-companion.js`.

There is no extension-origin worker iframe and no vendored evaluator worker. The native worker owns
the same-origin WASM lifecycle it was designed for, avoiding cross-origin worker restrictions and
throttled hidden-frame timers.

## Verified failure modes

1. Native `importStats` silently ignores keys that have not been initialized. Always await
   `initHunterStats(hunterId)` first.
2. Native `hunterStats[hunter]` combines base stats with talent and attribute fields. Project the
   declared `baseStatKeys` before passing it to the optimizer.
3. A hidden extension iframe running the whole search was materially slower and cancellation could
   not interrupt an in-flight WASM batch. Do not restore it.
4. Selectively augmenting native cards drops standalone features. Mount the canonical standalone
   Hunter surface and scope its canonical stylesheet; do not reimplement individual controls.

## Verification

After every source change:

```text
node tools/build-companion.js
node tools/build-companion.js --check
node tools/bench/companion-deps-check.js
node tools/bench/optimizer-worker-liveness-check.js
node tools/bench/companion-browser-check.js
node tools/bench/all.js
node tools/bench/run.js
```

The browser check loads the real unpacked extension against cifi-tools.com and asserts the single
Hunters header destination, all three in-page tabs, the full page toolbar, all twelve build-card
actions, editable level, Build Creator footer optimizer, and bounded cancellation. Source-only
checks do not replace that test.

The extension version gate is part of the suite. Any shipped extension change requires a manifest
version bump; do not bypass or disable the gate.
