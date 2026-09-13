# HunterSim — working agreement

A from-scratch clone of cifi-tools.com's hunter simulator/optimizer for the game CIFI, built by
extracting the real game math (the actual `release.wasm` evaluator, the real upgrade cost
curves, the real save format) rather than approximating it.

Read this before changing anything. It exists so you don't have to guess where things live or
re-derive decisions that were already made and validated.

## Compact instructions

When compacting, keep: measured numbers with their file:line source, pass/fail verdicts for gates
run, and any open defect or decision still pending. Drop: raw tool/gate output already summarized
in this conversation, exploratory dead ends, and full file contents already re-derivable from disk.

---

## Read MEASUREMENT.md first

**Every wrong conclusion in this project's recent history came from a broken MEASUREMENT, not a
broken algorithm. Not one.** Wrong fixture, wrong objective, wrong test build, an unverified flag,
a stale results file, error bars wider than the effect being chased, and audit tools carrying the
defects they hunt.

`MEASUREMENT.md` is the contract, with each rule traced to the real failure that produced it.
`tools/bench/bench-integrity-check.js` enforces the statically checkable half and runs FIRST in
`all.js`, because every number the suite prints depends on it.

The meta-rule, learned three times over: **a new measurement tool is not trusted until it has been
shown to FAIL on a known-bad input.**

## Non-negotiable principles

These are the standard every change is held to. They are listed first because they are the
point, not decoration.

1. **Explicit over implicit.** No silent defaults, no `|| {}` papering over a missing field, no
   "it probably works". If a required input is absent, throw with a message naming the field.
2. **Deterministic.** The same input produces the same output, every time. The optimizer
   contains no `Math.random`. The evaluator is bit-reproducible. Anything that breaks
   reproducibility is a bug, not a tradeoff.
3. **One canonical method per concern.** If two places do the same job, one of them is wrong.
   Consolidate rather than sync. See the inventory below — everything has exactly one home.
4. **Schema-enforced and validated.** Shapes are declared once, derived everywhere, and checked
   by invariants that run automatically. See `webapp/public/storeSchema.js`.
5. **Validate, never assume.** Do not claim a fix works because it looks right. Run the gate.
   Compare against the original tool. If you assert a cause, prove it — and if you can't, say
   so plainly instead of guessing. (A prior explanation in this repo blamed a missing "Anchor
   40" for a score gap; decoding the build showed Anchor *was* present. Don't do that.)
6. **No legacy paths, no fallbacks.** Either it works or it fails loudly. Dead code gets
   deleted, not commented out or left "just in case". Git history is the archive.
7. **Comments explain WHY, especially for non-obvious decisions.** This codebase's comments
   carry hard-won empirical findings. Preserve that. When you remove a workaround, say what it
   was compensating for.

### Three questions, three tools. Using the wrong one costs days.

| Question | Tool | What it gives |
|---|---|---|
| What number did a designer type? | `tools/il2cpp-cli/typetree.py` | authored serialized data (`FleetManager.RU2GenBaseBonus = 0.05`) |
| What does this method DO? | `tools/il2cpp-cli/csharp.py` | **real C#**, with type/field/method names |
| Exact field offsets, or when C# recovery fails | `decompile.py` / `analyze.py` | x86_64 disassembly and Ghidra C |

**IL2CPP strips Unity's type trees**, which is the root cause behind a lot of this repo's
archaeology: serialized MonoBehaviour data becomes opaque bytes with no field names, so recovering
a designer number pushes you toward byte-offset scanning, or toward disassembling code to
reconstruct a value that was never computed — it was *authored*. `typetree.py` ends that.

**Method bodies ARE recoverable, and this repo believed otherwise for far too long.** The working
assumption — written into notes and acted on — was that il2cpp metadata v39 made C# recovery
impossible, so game logic had to be read as assembly. It is false. Cpp2IL's issue #223 is still
open and still says IL recovery is legacy-only, and #528 was closed as a duplicate of it; both
predate the work. The code disagrees with the issue tracker: `LibCpp2IL` accepts metadata 23–108,
`AsmResolverDllOutputFormatIlRecovery` really calls `methodContext.Analyze()` then
`IlGenerator.GenerateIl(...)`, and a full SSA pipeline landed June–August 2026 with x86_64 as the
*reference* architecture. **Measured on this build: 52,545 of 52,553 methods recovered (100%), in
41 seconds.** The lesson is the one this file keeps relearning — a search result and an open issue
are not primary sources; the code is.

Neither tool replaces the others. C# recovery still emits
`Cpp2ILHelpers.NoteDecompilerIssue("Unmanaged memory load: [... +5AF0]")` where a field load did
not resolve; that is an honest marker, and the offset it prints is exactly what `analyze.py` reads
and `typetree.py` names.

None of this is theoretical. The first full run of `tools/bench/node-coefficient-check.js` matched
74 of 76 ship-node coefficients and caught **two that were 10x wrong** — both introduced hours
earlier by "correcting" the wiki against a reading of SirRed's decompiled constants. Demeter's
On-Site Printing Vehicles had been set to 30% against an authored 3%, making it the ship's most
valuable node by an order of magnitude. Inference lost to authored data, in the same session,
twice.

### Where a value has to come from

**cifi-tools.com was built in collaboration with the game's developers. For anything that site
models, matching its bundle IS the verification — treat it as authoritative and stop there.** Do
not go digging through the APK to "confirm" a number the original tool already publishes; that is
effort spent re-deriving something already settled, and it invites disagreeing with a source that
is more trustworthy than the derivation.

**What genuinely needs independent proof is everything the site does NOT model.** Two categories,
and they are where the real risk lives:

- **Save-file mappings.** cifi-tools has no save importer, so no save field name, index or offset
  can be confirmed from it. These must be proven against the APK, the scene, or the account
  itself. The inscryption slot map is the cautionary tale: a plausible uniform offset, drawn from
  a real five-value match, was wrong for most ids and silently dropped three of them entirely.
- **Fleet / ship optimizer data.** Largely our own territory, so the bundle cannot arbitrate it.

When you record a fact, say which of these it is. "Matches the original tool" and "matches the
game" are different claims with different strengths, and conflating them is how an unverified
number acquires a verified-looking comment.

### Project history you need to know

This codebase went through a long stretch of AI-assisted development where fixes were layered
on fixes without cleanup — patches compensating for earlier patches, several parallel
implementations of the same logic, and "fixed" claims that weren't verified. Much of that has
been cleaned up (see the git log), but **assume nothing is correct because it looks
intentional**. If you find something odd, verify it against the original tool before preserving
or "fixing" it.

---

## Layout

**OPEN ITEM: this repo commits and serves third-party content -- cifi-tools' compiled
`release.wasm` and ~17MB of artwork extracted from the game APK. See `THIRD-PARTY.md` for
the full inventory, why hosting it elsewhere does not resolve it, and what happens on each
answer. The WASM is pending Vash's reply; do not add more of cifi-tools' own code.**

**The wasm half now has an implemented answer: `extension/` runs INSIDE cifi-tools.com, where their
engine is same-origin, so nothing of theirs is copied or hosted. It does NOT clear the repo --
`webapp/public/release.wasm` still ships for the website, which cannot run without it. The
redistribution ends only if the website is retired in favour of the extension.**

**The ARTWORK is a different question with a different owner: it is the GAME'S art, which
cifi-tools also uses and does not own, so Vash's reply cannot settle it. The project owner decided
on 2026-09-12 to keep shipping game art; extract it from the APK with `tools/assets/*.py` (never
from cifi-tools' copies) and record new files in `THIRD-PARTY.md` item 2.**

| Path | What it is |
|---|---|
| `webapp/public/` | The shipped app. Vanilla HTML/CSS/JS, **no build step**, loaded via `<script>` tags in dependency order. |
| `webapp/server.js` | Tiny static file server with dev live-reload (`LIVE_RELOAD=0` disables). |
| `webapp/public/optimizer/` | The build optimizer — see below. |
| `tools/bench/` | The optimizer acceptance gate and schema tests. Runs under Node against the **shipped** browser files. |
| `compare-mcp/` | MCP server + fixtures for comparing the clone against the live cifi-tools.com site. |
| `extension/` | The **companion extension**: a content script that adds the fleet/ship pages to cifi-tools.com itself. `companion.css` and `vendor/` are BUILD OUTPUT of `tools/build-companion.js` -- edit `webapp/public/`, never the copies. See `extension/README.md`. |
| `bridge/` | **SUPERSEDED.** The old single-game `cifi-bridge`. The shipped bridge is now `adb-bridge` (`C:\Users\jdion\Projects\adb-bridge`, npm `adb-bridge`, TmRxJD/adb-bridge) — one process serving many games from JSON profiles, with CIFI on port 43791. **Fix bridge bugs THERE, not here**; the site's own dialog tells users `npx adb-bridge cifi`. This directory's `waitForAndroidBoot` / `dedupeSameDevice` fixes were ported upstream in adb-bridge 0.2.4. |

Run it: `node webapp/server.js` → http://localhost:5173

---

## The canonical-method inventory

There is exactly one place for each of these. **Do not add a second.**

| Concern | Canonical home |
|---|---|
| Simulation / param resolution | `webapp/public/hunterSimBrowser.js` (`HunterSim`) |
| Game data (talents, attributes, costs, deps, caps) | `webapp/public/hunterDefs.js` (`HUNTER_DEFS`) |
| Allocation legality + enumeration + moves | `webapp/public/optimizer/space.js` (`AllocSpace`) |
| Search algorithm | `webapp/public/optimizer/search.js` (`HunterOptimizer`) |
| Optimizer parallelism (browser only) | `webapp/public/optimizer/runner.js` + `worker.js` |
| Persisted store shape + invariants | `webapp/public/storeSchema.js` (`StoreSchema`) |
| Evaluation state for a build | `app.js` → `evalStateFor(build, iterations)` |
| Optimizer config for a build | `app.js` → `cfgFor(hunter, build)` |
| Purchase-path config | `app.js` → `statPathCfgFor(hunter, baseline)` |
| Purchase-path walk (stats/inscriptions/relics) | `hunterStatPathBrowser.js` → `greedyPurchasePath()` |
| Relic + fragment costs | `webapp/public/costFormulas.js` (`RELIC_SPECS`, `fragmentsOnHand`) |
| Big-number (game notation) inputs | `webapp/public/bigNumberInput.js` (`attachBigNumberInput`) — lifted OUT of `app.js` so the extension can use it without loading 3,100 lines of routing and auth |
| Companion extension build | `tools/build-companion.js` (scoped CSS, `shell.js`, `vendor/`) |
| Upgrade unlock gates | `webapp/public/hunterDefs.js` (`UPGRADE_GATES`, `isUpgradeUnlocked`) |
| Full gem/gate reference (all 97) | `tools/reference/gem-gates.json`, `tools/reference/gem-trees.json` |
| Inscryption display-id -> save slot | `tools/reference/inscryption-slots.json` (+ the resolver in `saveImport.js`) |
| Game's own definition data (18 families) | `tools/reference/scene-defs.json` |
| Loop-mod definitions + name mapping | `tools/reference/loop-mods.json`, `loopmod-names.json` |
| Pulled APK / save / IL2CPP / captures | `tools/gamefiles/` (gitignored; see its README) |
| Headless IL2CPP dumper (metadata v39) | `tools/il2cpp-cli/` (build recipe in its README; `CIFI_APK` picks the build) |
| Method name -> RVA (replaces script.json) | `tools/il2cpp-cli/dumpindex.py` |
| Decompile named methods to readable C | `tools/il2cpp-cli/decompile.py` (Ghidra + PyGhidra) |
| **Read AUTHORED serialized data (values)** | `tools/il2cpp-cli/typetree.py` |
| **Read method BODIES as C# (logic)** | `tools/il2cpp-cli/csharp.py` (Cpp2IL + ilspycmd) |
| **Name the field reads Cpp2IL could not resolve** | `tools/il2cpp-cli/resolve-loads.py` |
| Authored ship-node coefficients | `tools/reference/ship-node-coefficients.json` |
| Ship install prereqs + base caps | `tools/reference/ship-node-gates.json` |
| Ship install node counters | `tools/reference/ship-node-counters.json` |
| Ship install node names | `tools/reference/ship-node-names.json` |
| Fleet badge -> ships + value | `tools/reference/badge-map.json` |
| Every factor per install node | `tools/reference/node-factors.json` |
| Which pools read each node's bonus | `tools/reference/node-resources.json` |
| Zod schemas for the references | `tools/bench/reference-schemas.js` |
| Zod schemas for the app's own data | `tools/bench/app-schemas.js` |
| Authored tier-2 relic caps/costs | `tools/reference/relic-tier2.json` |
| Attribute dependency tree (game) | `tools/reference/attribute-tree.json` |
| Which caps the game can raise | `tools/reference/cap-raises.json` |
| Omitted uniform per-node terms | `tools/reference/uniform-node-terms.json` |
| Gear piece names (the game's own) | `tools/reference/gear-names.json` |
| Gear set bonus -> resource + value | `tools/reference/gear-set-bonus-map.json` |
| Gear piece -> install node | `tools/reference/gear-install-map.json` |
| Server-table capture | `tools/capture/` |
| Per-hunter evaluation fidelity (UI) | `store[hunter].iterations` + `StoreSchema.ITERATIONS` / `clampIterations` |
| Cancellation of long sim work | `HunterSim.throwIfAborted` / `isAbort` / `ABORTED` |
| Coarse evaluation fidelity | `HunterOptimizer.SCREEN_ITERATIONS` (one value, shared) |
| Full evaluation fidelity | `HunterOptimizer.FINAL_ITERATIONS` |
| Build share-code encode/decode | `webapp/public/buildCode.js` |
| What each optimize mode maximizes | `webapp/public/optimizer/objective.js` (`OptimizerObjective.MODES`) |
| Optimizer acceptance gate | `tools/bench/run.js` |
| Store schema tests | `tools/bench/schema-test.js` |
| Clone-vs-live comparison | `compare-mcp/batch-test.mjs` |
| Gap check vs the original's override tables | `tools/bench/live-override-diff.js` |

**Three config builders exist and that is correct** — they feed three different APIs:
`evalStateFor` → `HunterSim.evaluate` (`overrides`/`upgrades`); `cfgFor` →
`HunterSim.compileEvaluator` (`baseOverrides`/`globalUpgrades` + node tables + budgets);
`statPathCfgFor` → `greedyPurchasePath` (talents/attributes pinned instead of varied). They must
describe the same account state.

**They no longer need to be edited together, and this entry used to say they did.** All three are
now thin projections of `accountStateFor()` → `window.AccountState`, so an account-state field is
**one line in `accountState.js`** that every consumer sees at once. The old rule ("add it to all
three in the same change") outlived the drift hazard it protected against, and a stale warning is
its own defect: it sends the next person editing three call sites that do not need editing.

---

## Where the rest of this file went

This file was ~3,100 lines (~100K tokens) -- expensive because Claude Code loads the FULL CLAUDE.md
hierarchy into every custom subagent's context on every dispatch, with no way to opt out (the
built-in Explore/Plan subagents are the only exception). Moved to skills, which load on demand
instead of every time:

| Skill | Covers |
|---|---|
| `hunter-game-mechanics` | Game mechanics, relics, gear, ships, save-import field mappings, gem gates -- the "Validated invariants" empirical log |
| `optimizer-search-design` | The optimizer's search algorithm, MAP-Elites/corpus-donor history, effort tuning, known open defects |
| `validation-gates` | Which bench/gate command to run and what it checks; TypeScript readiness |

Each loads automatically when its `description` matches, or invoke directly:
`/hunter-game-mechanics`, `/optimizer-search-design`, `/validation-gates`. When in doubt, load the
skill before calling a game-mechanics fact new or touching the optimizer search.

---

## Gotchas that will bite you

- **`index.html` script order matters.** No modules, no bundler — `window.X` globals are
  populated in tag order. `storeSchema.js` must load after `hunterDefs.js` and
  `optimizer/space.js`. Cross-file *calls* happen at runtime so definition order is looser, but
  don't rely on that.
- **Bump `?v=` on every changed asset in `index.html`**, and `WORKER_VERSION` in
  `optimizer/runner.js` when `optimizer/worker.js` changes. A Worker URL caches independently of
  the page; without the bump a worker silently keeps running the old code.
- **Web Workers resolve relative `fetch()` against their own directory.** `optimizer/worker.js`
  sets `HUNTERSIM_ASSET_BASE` before importing `hunterSimBrowser.js` for this reason.
- **The scoring worker pool is capped (`MAX_POOL_SIZE`).** Each worker holds its own WASM module
  and churns a fresh instance per evaluation; uncapped, high-level builds hit
  "Cannot allocate Wasm memory for new instance".
- **Never wipe localStorage or IndexedDB.** There is no backend. The store is mirrored to
  IndexedDB precisely because browsers bundle localStorage into "clear cache". Losing both is
  unrecoverable user data.
- **`shipsPage.js` BINDS FIVE MODALS AT TOP LEVEL, AND THAT FAILS AS SOMETHING ELSE ENTIRELY.**
  Its last ~1,200 lines include `document.getElementById('closeShipBuildModalBtn').onclick = …` for
  `shipBuildModal`, `newLoadoutModal`, `optimizeShipModal`, `zaglagChecklistModal` and
  `loadoutDetailModal` — markup that lives in `index.html`. Anywhere that markup is absent (the
  companion extension, a bench, a test harness) the FIRST of them throws, and because it is top
  level **the rest of the file never executes** — including `window.FleetStoreDefaults` at line
  3281. The symptom is `storeSchema: FleetStoreDefaults.shipGear is missing (shipsPage.js must load
  before storeSchema.js)` thrown 1,600 lines later, which reads as a load-ORDER bug and is not one.
  The extension supplies the markup from `extension/shell.js`, generated from `index.html` by
  `tools/build-companion.js` so it cannot drift. **Before diagnosing a missing global from
  `shipsPage.js`, check whether an earlier top-level line threw.**
- **THE EXTENSION'S LOAD ORDER IS DERIVED FROM `index.html`, NOT HAND-LISTED, BECAUSE THE HAND-LIST
  IS WHAT FAILED.** `companion-deps-check.js` originally asserted a hand-written list of ordering
  pairs. It checked `hunterDefs -> storeSchema` and `shipSchema -> shipsPage`, PASSED, and shipped a
  manifest with `storeSchema` before `shipsPage` — a pair nobody thought to list, and the one that
  broke boot. It now compares the manifest's relative order against `index.html` for every shared
  file, so no pair can be forgotten. A hand-kept copy of an ordering that already exists elsewhere
  is the duplicated-rule trap this file keeps recording.
- **Don't yield with `requestAnimationFrame` in a long computation** — it's paused in a
  background tab and the work stalls entirely. Use `setTimeout(…, 0)`.

---

## Adding things

- **A store field:** one line in `SCHEMA` in `storeSchema.js`. Nothing else. Never write
  `store.x = store.x || {}` at a call site.
- **A store invariant:** a check in `validateStore()`, plus a case in
  `tools/bench/schema-test.js`.
- **Game data (a talent, an attribute, a cost):** `hunterDefs.js` only. Confirm it against the
  live site first and note in a comment how it was confirmed.
- **An optimizer change:** run the gate before and after. A change that doesn't improve the gate
  and isn't a correctness fix isn't worth the risk.
