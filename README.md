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
- **`tools/bench/`** — the optimizer's acceptance gate (see below). Runs under Node but loads
  the shipped `webapp/public` files, so there is no second copy of the simulation math,
  the search, or the build-code format to drift out of sync.
- **`compare-mcp/`** — an MCP server that cross-checks the clone against the live
  cifi-tools.com site, plus the `known-builds*.mjs` fixtures the gate replays.

`tools/` previously also held a parallel Node implementation of the optimizer and its own copy
of `hunterSim.js`/`params.json`/`release.wasm`. Those are gone: that `hunterSim.js` had drifted
into a genuinely different param resolver (no gem handling, no `bossLootRate`), so validating
through it produced numbers the app would never produce. Anything that needs the simulation now
goes through `webapp/public/hunterSimBrowser.js`, in the browser and under Node alike.

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

## The optimizer

`webapp/public/optimizer/` holds the build optimizer. Three concerns, kept apart:

- **`space.js`** — the single definition of a legal talent/attribute allocation, and the only
  code that enumerates or moves through the allocation space. The build editor's +/- gating,
  the search, and the benchmark all call into this one module; there is no second copy of the
  rules anywhere.
- **`search.js`** — the algorithm. Deterministic, with no randomness anywhere in it.
- **`runner.js`** / **`worker.js`** — browser parallelism only. `search.js` emits batches of
  candidates and consumes scores; these fetch those scores across a Web Worker pool.

### How it searches

Evaluation is *exactly* deterministic: a fresh WASM instance returns bit-identical output for
identical arguments. That underpins everything — exact memoization is sound, the same build
always yields the same answer, and a benchmark failure is always a real failure rather than
sampling luck.

The full space cannot be enumerated (two attributes per hunter are uncapped). What *is*
enumerated exhaustively is the structural choice — which nodes get funded at all:

1. **Enumerate** every dependency-closed, affordable support set (Borge 361, Ozzy 289, Knox
   145). No heuristic picks which regions of the tree to explore, because all of them are.
2. **Survey** the strongest supports with a coarse coordinate exchange, then **refine** the
   survivors to a fixpoint: on exit, no transfer of 8, 4, 2 or 1 points between any pair of
   nodes improves the score.
3. **Decide** among finalists at full fidelity — the same measurement the build card shows, so
   the search cannot optimize one number and then be judged by another.

Allocations leaving more than one point idle are never evaluated: respeccing to spend them is
essentially always better, so they are pruned where allocations are created.

The build you started with competes as a finalist on identical terms, which is why the
optimizer cannot hand back a downgrade.

### The acceptance gate

```bash
node tools/bench/run.js
```

Replays every real build code in `compare-mcp/known-builds*.mjs` through two gates, in order:

1. **Parity** — the clone's loot score for the imported code matches what the original tool
   reported for it. If the two disagree about what a build is worth, nothing downstream means
   anything, so a parity failure short-circuits that build.
2. **Quality** — given exactly the budget that build spent, the optimizer matches or beats it
   on that build's own objective (loot builds on loot per minute, push builds on average
   stage). The other metric is reported but not fatal, because pushing deeper genuinely costs
   loot per minute.

Builds run in small parallel batches and the sweep stops at the first failure; pass `--all` to
run everything, or `borge 0 10` to take a slice. Detail lands in `tools/bench/results.json`
(`node tools/bench/show.js` prints it).

The harness loads the *shipped* browser files under Node via a small `fetch` shim, so the
search, legality rules, param resolver and build-code format under test are the ones that run
in the app — not a Node re-implementation that can drift out of sync.

## Status

The optimizer has the automated gate above. The rest of the app has no automated tests or CI —
verified manually in-browser against cifi-tools.com. See the `tools/` scripts for the
validation methodology if extending the simulation math.
