# HunterSim

A build simulator/optimizer for CIFI's Borge, Ozzy, and Knox hunters — a from-scratch clone
of cifi-tools.com's simulator, built by extracting and re-implementing the real game math
(WASM evaluator, upgrade cost curves, save-file format) rather than approximating it.

## Layout

- **`webapp/`** — the shipped product. A static site (no build step): vanilla HTML/CSS/JS
  plus the real `release.wasm` evaluator, served by a tiny Node static file server.
- **`bridge/`** — [`cifi-bridge`](https://www.npmjs.com/package/cifi-bridge), published to
  npm separately. A local CLI helper (`npx cifi-bridge`) that reads your CIFI save file off
  an Android device or emulator over ADB, so the webapp's "Import Save" feature doesn't
  require you to find/copy the file by hand.
- **`tools/`** — the original Node.js reverse-engineering/validation scripts used to extract
  and confirm the real game math against the live site (`hunterSim.js`, `optimizer.js`,
  `beamSearch.js`, the per-hunter `*Config.js` files, `validate*.js`, etc.), plus a root-level
  copy of `params.json`/`release.wasm` they were validated against. Not part of the shipped
  app — kept for reference/re-validation if the live site's math ever needs re-checking.

## Running the webapp

```bash
node webapp/server.js
```

Serves `webapp/public` at `http://localhost:5173` (override with `PORT=xxxx`).

## Running the bridge (save import helper)

```bash
npx cifi-bridge
```

Requires [Node.js](https://nodejs.org/). Leave it running, then use "Import Save" → "Pull
from Device" in the webapp. See the in-app Import Save modal for the manual (no-bridge)
save-file path if you'd rather copy it yourself.

## Status

No automated tests or CI yet — everything's been verified manually in-browser against
cifi-tools.com. See the "tools/" scripts for the validation methodology if extending the
simulation math.
