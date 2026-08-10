# HunterSim — working agreement

A from-scratch clone of cifi-tools.com's hunter simulator/optimizer for the game CIFI, built by
extracting the real game math (the actual `release.wasm` evaluator, the real upgrade cost
curves, the real save format) rather than approximating it.

Read this before changing anything. It exists so you don't have to guess where things live or
re-derive decisions that were already made and validated.

---

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

### Project history you need to know

This codebase went through a long stretch of AI-assisted development where fixes were layered
on fixes without cleanup — patches compensating for earlier patches, several parallel
implementations of the same logic, and "fixed" claims that weren't verified. Much of that has
been cleaned up (see the git log), but **assume nothing is correct because it looks
intentional**. If you find something odd, verify it against the original tool before preserving
or "fixing" it.

---

## Layout

| Path | What it is |
|---|---|
| `webapp/public/` | The shipped app. Vanilla HTML/CSS/JS, **no build step**, loaded via `<script>` tags in dependency order. |
| `webapp/server.js` | Tiny static file server with dev live-reload (`LIVE_RELOAD=0` disables). |
| `webapp/public/optimizer/` | The build optimizer — see below. |
| `tools/bench/` | The optimizer acceptance gate and schema tests. Runs under Node against the **shipped** browser files. |
| `compare-mcp/` | MCP server + fixtures for comparing the clone against the live cifi-tools.com site. |
| `bridge/` | `cifi-bridge`, published to npm separately: pulls a save off an Android device over ADB. |

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
| Upgrade unlock gates | `webapp/public/hunterDefs.js` (`UPGRADE_GATES`, `isUpgradeUnlocked`) |
| Full gem/gate reference (all 97) | `tools/reference/gem-gates.json`, `tools/reference/gem-trees.json` |
| Pulled APK / save / IL2CPP / captures | `tools/gamefiles/` (gitignored; see its README) |
| Headless IL2CPP dumper (metadata v39) | `tools/il2cpp-cli/` |
| Server-table capture | `tools/capture/` |
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
describe the same account state. **If you add an account-state field to one, add it to all
three in the same change.**

---

## Validated invariants

These are established facts, verified by direct experiment. Don't re-litigate them; if you
think one is wrong, disprove it with a test.

- **The evaluator is exactly deterministic.** A fresh WASM instance returns bit-identical output
  for identical arguments. Verified directly.
- **Determinism requires a fresh instance per call.** The RNG state lives in mutable wasm
  globals. Reusing an instance drifts (~0.05%); restoring linear memory alone leaves the
  instance in a state that *aborts* on the next call. Both verified — see
  `tools/bench/resetprobe.js`.
- **Because of that, memoization by (allocation, iterations) is exact and sound.** The optimizer
  relies on this; it typically halves real evaluation count.
- **Sampling the same allocation repeatedly is pointless.** Any code averaging N evaluations of
  one allocation is averaging N identical numbers. To reduce error, raise `iterations`.
- **100-iteration scores are a ranking surrogate, not a verdict.** ~0.9% mean deviation from
  1000-iteration scores, ~1.2% pairwise rank inversions. Fine for narrowing candidates, not for
  choosing the winner — which is why the search decides at `FINAL_ITERATIONS`.
- **Evaluation cost scales with how far a build progresses**, not just iteration count (~11ms at
  level 12, ~60ms at level 79, both at 100 iterations).
- **A share code does not fully determine a loot score.** Run
  `node tools/bench/params-report.js <hunter>` for the gap: Knox reads 91 sim params and its
  code carries 46, so a code-only evaluation and a score recorded on a real account are not
  measuring the same thing.
  **Do NOT assume the difference has a sign.** An earlier version of this document claimed a
  code-only evaluation "can never legitimately land above" a recorded score, and the full
  182-build sweep disproved it: three builds overcount (+4.7% to +7.2%) and three undercount
  (−5.4%), with the direction flipping between adjacent levels (72/73/74). They cluster at the
  stage-300 boss-kill boundary, where the metric is threshold-sensitive — a build that barely
  kills the boss swings hard either way. Treat a parity mismatch as "these two numbers describe
  different states", not as evidence about which side is wrong.
- **`upgrades.gems_nodes.attraction_lootKnox` reaches the wasm but changes the returned loot
  score by exactly nothing** (arg 0 vs 150 → bit-identical). Don't chase it as a cause.
- **Three relics reach the wasm and change nothing: Borge r7 and r19, Ozzy r7, Knox t2r5.**
  Same shape as `attraction_lootKnox`, and proven to be a real evaluator fact rather than a
  wiring gap on our side: `tools/bench/relic-arg-probe.js` shows each one moves exactly one
  argument, at the index `params.json` assigns it, and `tools/bench/relic-sweep.js` then finds
  every output bit-identical across real high-level fixtures. **Nothing may ever recommend
  spending fragments on them** — they cost real currency and buy nothing measurable. The relics
  that DO move the sim: Borge r4/r16/t2r7, Ozzy r4/r17/t2r7, Knox t2r7. Run the sweep against
  REAL fixtures, never a synthetic build — a build with no hunter stats scores ~20 loot/min and
  dies around stage 5, where nearly everything reads as "no effect".
- **Fragments are ACCOUNT-WIDE and the evaluator does not produce them.** There is one Relic #7;
  you buy it once. So the rate lives at `store.fragments`, never `store[hunter]`, and it is a
  user input rather than something the sim can infer (mat1/mat2/mat3 come out of a run;
  fragments come from campaign/boss content that isn't modelled). Stored per DAY, matching the
  live tool's own gadget planner (`tessarectsPerDay`, with the same timestamped accrual) and
  matching `collectionTimeMinutes`' existing `perDayRate` argument. **An unset rate must render
  as unknown, never as zero or instant** — the same silent-zero trap as the relic cost below.
- **An unknown relic id THROWS; it must never price at 0.** A silent zero makes an unmodeled
  relic look free, so it wins every cost-ranked comparison it enters. The table covers all 20
  tier-1 relics plus the tier-2 set, recovered from Ryther's Relic Optimizer and cross-checked
  three ways in `tools/bench/relic-cost-test.js`: against a verbatim copy of the previous
  implementation (identical at every level), against the caps `hunterDefs.js` declares, and for
  strict monotonicity. Tier-2 caps are NOT in that dataset — `relicMaxLevel` throws for them
  rather than guess; `hunterDefs.js` owns those.
- **The live tool genuinely does not price Knox relics or inscriptions, and neither do we.**
  Verified in the live bundle: Knox's resource table `LD` has no FRAGS entry at all, and its
  cost map `ND` contains only base stats plus the Anchor gadget — no relic or inscription rows,
  unlike Borge's `oD`/`sD` and Ozzy's `xD`/`_D`, which both carry FRAGS. Knox nonetheless HAS
  two relic sim params (t2r5, t2r7) and one inscription (i105). So `relicResource: null` for
  Knox faithfully mirrors the original rather than being our omission — but it does mean a Knox
  relic cannot be costed. Do not invent a currency for it; say "not modelled".
- **Share codes never encode level; it is INFERRED, from two lower bounds.** A code carries no
  `lvl` field, so `parseBuildCode` derives level from spend. The talent sum alone is not enough:
  it assumes the player spent every talent point, and real accounts sit on unspent ones. A real
  level-58 Borge code with 46 talents and 174 attributes decoded as level 46, whose 138-point
  attribute budget then made `trimAllocationToBudget` **refund 36 attribute points on import** --
  silently wrecking the build and handing the optimizer a budget 12 talent points short. Level is
  now `max(inverse(talentBudgetForLevel, talentSpend), inverse(attributeBudgetForLevel,
  attrSpend))`, both inverted by search so the formulas can stop being linear. Invariant, asserted
  over every fixture in `schema-test.js`: **an inferred level must be able to fund the allocation
  it was inferred from.** This was the actual cause of the reported "Optimize left 12 talent
  points unspent" -- not a weak search.
- **Timeless Mastery does not help kill a boss; it multiplies what the kill pays.** Measured: kill
  rate and remaining boss HP are bit-identical at Timeless 0 and 5, while loot moves 13.06M ->
  22.20M (linear, +1.83M/level). Call Me Lucky Loot is the same shape -- 0 -> 12 leaves kill rate
  and boss HP untouched, loot 2.22e7 -> 3.20e7. This is why the boss objectives are lexicographic
  and why `bossTimeless` pins Timeless rather than weighting it.
- **Boss kill rate is a real gradient, not a flag.** It falls 95.7 -> 85.7 -> 64.5 -> 43.8 -> 36.4
  -> 0 as Soul Of Ares is stripped, and hits 0 outright without Impeccable or Power Of Gaia. Below
  a kill, `bossHpPercent` is what still discriminates.
- **Most non-base-stat upgrades are GATED behind a gem tree level, and all 20 that apply to our
  Overrides panel are now mapped** in `UPGRADE_GATES` (hunterDefs.js), transcribed from the live
  bundle's own `unlock_gem`/`unlock_lvl` fields and asserted against it by
  `tools/bench/gate-coverage.js`. Gadgets need Exodus 4; tier-2 relics Power 3; CMs Power 2;
  researches Innovation 2-3; milestone #0 Attraction 3; `cms.milestoneCount` Exodus 1; trinkets
  Creation 4. **Missing gem state means LOCKED, never unlocked** — the optimistic default is how
  a planner ends up recommending something the account cannot buy. The Effective Path hard-filters
  locked candidates (not a ranking penalty: a locked upgrade is not a worse buy, it is not a buy)
  and reports what it excluded; the Overrides cards show the requirement but do NOT hard-disable
  the input, because our picture of gem levels comes from the Gem Planner the user may not have
  filled in.
- **The APK IS dumped.** CIFI 0.7.3.54 is Unity **6000.3.8f1** with IL2CPP metadata **v39**;
  Perfare's Il2CppDumper caps at v31, but AndnixSH's fork supports v39 and `tools/il2cpp-cli/`
  wraps it in a headless CLI (see its README). Output lives in
  `tools/gamefiles/apk-0.7.3.54/il2cpp-dump/`: `dump.cs` (813k lines — every type, field with
  offsets, method signature and enum) plus `DummyDll/` including `Assembly-CSharp.dll`.
  **Method BODIES are not recovered** — Il2CppDumper gives structure and addresses, not code — so
  constants computed in code still need Ghidra against `libil2cpp.so`. Serialized ScriptableObject
  data needs typetrees, which the build strips; `DummyDll/` is what AssetRipper would need to
  reconstruct them. Not done yet, and it is the remaining route to balance values.
- **Loop mods ("modules") are CLIENT-side, both levels and definitions.** An earlier claim in
  this file said the opposite; it was wrong and the reasoning was bad, so here is the correction
  and the trap that caused it.
  - **Levels are in the save**: `LM<N>Level` (295 entries, 223 non-zero on the reference account)
    and `LMOuro<N>Level` (39). The earlier search looked for `LoopMod` and found only aggregates
    -- the save abbreviates to **LM**.
  - **Definitions are in the client**: `LoopModifiers` (dump.cs) carries per-mod `StartCost`,
    `CostExponent`, `AdditiveCostIncrease`, `Bonus`, `BonusExponent` and `MaxLevel` for ~295 mods.
  - **The trap**: the "server-side" conclusion rested on `Stelzi` appearing zero times in the
    client. But `stelzi` is *cifi-tools' own internal id*, not a game string -- our own
    `hunterDefs.js` labels that same mod "Mutual Mining Agreement". Absence of a nickname the game
    never used proved nothing. **Do not conclude "not in the client" from a tool-side id.** Search
    for save field families (`LM<N>Level`) and dump.cs field names, not for cifi-tools slugs.
  - Still genuinely blocked: reading the *values* of those definition fields. They are serialized
    MonoBehaviour data and this build strips typetrees, so it needs AssetRipper with the
    `DummyDll/` the dumper produced. Display names are UI `Text` populated at runtime.
  - **Save diffing therefore DOES work** for mapping index -> mod: change one mod in-game,
    re-pull, diff, see which `LM<N>` moved. Slow, but it was never impossible.
- **The FULL gate/prereq map is extracted, not guessed** — 97 gated entries, every one resolved
  to a tree and level, in `tools/reference/gem-gates.json` (+ `gem-trees.json` for the tree
  structure itself). Regenerate with `tools/bench/extract-gates.js` / `extract-gem-trees.js`
  against a live bundle. Structure, confirmed against the GAME's own IL2CPP metadata (7 trees ×
  6 nodes, matching `<Tree>GemNode<N>Level` fields): tree max levels are exodus 5, attraction 4,
  creation 4, power 3, innovation 3, temporal 3, evolution 1; **nodes 4–6 of every tree require
  Exodus 5** (the cross-tree prereq); a `null` level cost means declared-but-unreleased and
  always sits strictly above that tree's maxLevel. `gem-tree-test.js` asserts every gate is
  SATISFIABLE — a gate above its tree's cap would make an upgrade permanently unreachable.
- **`getMaxValue` appears exactly ONCE in the live bundle** — Borge's Call Me Lucky Loot. Verified
  by counting, not assumed: the other four mentions are call sites. There is no second dynamic
  talent/attribute cap to find.
- **r5/r6/r9 have an unresolved cap chain and `relicMaxLevel` refuses for them.** Ryther's data
  says r5/r6 cap at 8 rising to 11 with Power Gem Node 1; the live bundle's fragment planner says
  r6 caps at 11 rising to 16 with Exodus node 2 (and r9 100 → 105). Probably a chain, but that
  ordering is inference. None are hunter sim params, so nothing consumes the number — refusing
  beats picking a side. Costs are still exact; use `relicPriceableLevels()` to walk them.
- **Legality is a state predicate, not a path predicate.** A node at level > 0 is legal iff it's
  within `maxLevel`, every dependency parent is > 0, and any `minValue` tier threshold is met by
  points spent in strictly-lower-threshold nodes. Order of purchase never matters. This is what
  makes exhaustive support enumeration valid.

---

## How the optimizer works

The structural insight: attribute trees have only **361 / 289 / 145** dependency-closed subsets
(Borge / Ozzy / Knox — measured, not estimated). Small enough to enumerate exhaustively, so no
heuristic ever guesses which part of the tree to fund.

1. **Enumerate** every dependency-closed, affordable support set (which nodes get funded at all).
2. **Screen** each at a canonical fill.
3. **Survey** the strongest with a coarse coordinate exchange, then **refine** the survivors to a
   fixpoint: on exit, no transfer of 8/4/2/1 points between any pair of nodes improves the score.
4. **Decide** among finalists at full fidelity — the same measurement the build card displays.

The user's current build competes as a finalist on identical terms, which is why the optimizer
cannot return a downgrade. Allocations leaving more than one point idle are never evaluated
(respeccing to spend them is essentially always better).

**What "evaluate every combination" honestly means:** the full space cannot be enumerated (two
attributes per hunter are uncapped). The *structural* choice is exhaustive; the *depth* choice is
a coordinate-exchange fixpoint. Say it that way — don't claim more.

### Objectives (`optimizer/objective.js`)

Four modes, all defined in one table that the search, the browser workers, the benchmark **and
the UI dropdown** read. Adding a mode is a one-file change; the dropdown cannot offer a mode the
optimizer does not implement, and a mode cannot ship without a label and help text (asserted).

| Mode | Maximizes |
|---|---|
| `loot` | loot per minute |
| `push` | average stage |
| `boss` | boss kill rate, then loot as a tiebreak |
| `bossTimeless` | same, with Timeless Mastery pinned to max |

The boss objectives are **lexicographic, not a weighted blend**, in three tiers: not killing yet
→ score on how little boss HP remains (loot deliberately contributes nothing, or the search would
trade kill progress for farm); killing → `1e6 + killRate * 1000`; equal kill rates → a
`log10(loot) * 5` tiebreak. Kill rate has 0.1 resolution, so one step is 100 units while the
whole loot term caps around 60 — **loot can never buy back even a tenth of a percent of kill
rate.** That ordering is what puts overflow points into Call Me Lucky Loot *only* once they cost
nothing in boss capability, with no special-casing of that talent.

`pinnedAttrs` is how `bossTimeless` differs from `boss`: the search holds those attributes at
maximum and optimizes the rest around them.

**The Effective Path scores through the same table.** `hunterStatPath.js`'s `marginalValue`
takes a mode and defers to `OptimizerObjective.scoreFor`, so "what should I buy to kill the
boss" and "what should Optimize allocate to kill the boss" cannot mean different things. In
`loot` it is still exactly a `lootPerMin` difference, so nothing about the existing path
changed. The path offers only `Objective.pathModes()` -- modes with `pinnedAttrs` are excluded
because the path never reallocates attributes, so `bossTimeless` there would be a choice that
silently does nothing; passing it throws. Measured divergence on a real level-79 Borge build:
loot buys `hp>atk>atk>hp`, boss buys `hp>hp>hp>atk` and takes evade over effect.

### Things the optimizer deliberately does NOT do any more
Removed because each was compensating for the previous one: random-mutation beam search, greedy
marginal seeding, epsilon exploration, stagnation restarts, multi-restart passes, a bespoke
"chain-unlock" move, a final `repairLegality` pass, and localStorage history seeding. **Do not
reintroduce any of them.** An unlock chain is just another enumerated support set. Legality is
guaranteed by construction and asserted at the end, not repaired.

---

## Validation — run these

**Run the SAMPLED gate per change; run the full sweep only after large or fundamental changes.**
The full sweep is 182 builds and takes hours (evaluation cost scales with how far a build
progresses, so the high-level Borge fixtures dominate). A gate too slow to run is a gate nobody
runs. `--sample=N` draws a *stratified* handful — one per level band per hunter, so every run
spans the whole level range instead of skewing to the cheap low-level builds where nothing
interesting happens. The seed varies per run (that is the point: repeated gates cover different
builds over time) but is always printed, and `--seed=` replays a handful exactly, so a failure is
never unreproducible. `--list` shows the selection without paying for the run.

**Sampling reduces how MUCH is checked, never how STRICTLY.** The pass criteria are identical in
sampled and full runs. Do not "speed up" this gate by loosening a threshold.

Run the full sweep after: any change to the search, the legality model, the objective table, or
cost/param resolution.

```bash
node tools/bench/schema-test.js        # store schema invariants (fast, run always)
node tools/bench/relic-cost-test.js    # relic cost table + fragment arithmetic (fast)
node tools/bench/relic-arg-probe.js    # every declared relic reaches the wasm (fast)
node tools/bench/path-relic-test.js    # effective path never recommends an inert relic
node tools/bench/relic-sweep.js        # which relics actually move the sim (slow)
node tools/bench/gem-coverage-test.js  # every gem param is reachable from the Gem Planner
node tools/bench/gem-tree-test.js      # tree shape + every unlock gate is satisfiable
node tools/bench/save-gate-test.js     # caps/gates vs a REAL save (skips if none pulled)
node tools/save/inspect.js <DATA.text> [regex]            # decode + inspect a real save
node tools/bench/gate-coverage.js <live-bundle.js>        # our gates vs the bundle's
node tools/bench/live-override-diff.js <live-bundle.js>   # gap check vs the original tool
node tools/bench/run.js --sample=12    # THE EVERYDAY GATE: stratified handful, ~minutes
node tools/bench/run.js --sample=12 --seed=1234   # replay one exactly
node tools/bench/run.js --sample=12 --list        # see the selection without running it
node tools/bench/run.js                # every known build, stops at first failure
node tools/bench/run.js --all          # full sweep, hours
node tools/bench/run.js borge 0 10     # a slice while iterating
node tools/bench/show.js               # pretty-print the last results.json
```

The optimizer gate replays every real build code in `compare-mcp/known-builds*.mjs` (182 of
them) through two checks:

- **Parity** — clone's loot score vs the score recorded for that code. Currently asymmetric
  (below = expected, above = hard failure). **This rule is known to be wrong and needs
  replacing** — see the parity invariant above; the sign assumption it rests on does not hold at
  high level. The 3 remaining gate failures are all this rule misfiring, not optimizer defects.
  The fix is to judge parity against what the ORIGINAL TOOL reports for the same code
  (`compare-mcp/batch-test.mjs` already drives the live site) rather than against a recorded
  number that may describe different account state.
- **Quality** — given exactly the budget the import spent, the optimizer matches or beats it on
  *that build's own objective* (loot builds on loot/min, push builds on average stage). The other
  metric is reported as a warning, never fatal — pushing deeper genuinely costs loot/min, and
  gating both would fail a push build for succeeding.

**Last full result (all 182 builds, all three hunters):**

| | builds | levels | met or beat | strictly beat | parity failures |
|---|---|---|---|---|---|
| Borge | 82 | 12–79 | 82/82 | 13 | 2 |
| Ozzy | 66 | 11–70 | 66/66 | 25 | 1 |
| Knox | 34 | 12–37 | 34/34 | 13 | 0 |

**Zero quality regressions.** Median delta 0.00% — the optimizer reproducing already-optimal
community builds exactly, which is the expected result, not a null one. The 3 parity failures are
the broken rule described above, not optimizer defects.

**The gate is resumable, and you will need that.** Long runs get killed part way through
(every hunter above took two attempts). Results are written after every batch and `--resume`
skips what is already done, so re-invoke the same command until it reports `0 build(s) to run`.
Use `--out=` to give each hunter its own file. Summarize any file, partial included, with
`node tools/bench/summarize.js <file...>`.

Supporting tools: `decode.js` (what a build code actually carries), `params-report.js` (which sim
params a code can/can't carry), `fuzz-space.js` (move generators vs their own legality
predicate), `capcheck.js`, `profile.js`, `ts-readiness.js`.

**Manual cross-check against the original tool** is the ultimate arbiter and is cheap: export the
build code, import it into cifi-tools.com as a guest, compare Loot Score / Ø Stage / Ø Time /
runs-per-day. Do this whenever a number is in question.

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

---

## TypeScript

Measured with `node tools/bench/ts-readiness.js`:

```
9,375 lines · 53 cross-file globals · 234 getElementById · 130 querySelector
86 innerHTML assignments · 13 JSDoc blocks
app.js (3,119) + shipsPage.js (2,317) = 58% of all code
```

**Assessment: a full `.ts` conversion is not currently worth it; JSDoc + `checkJs` is.**

The blocker isn't the logic — `optimizer/`, `storeSchema.js`, `hunterSimBrowser.js`,
`costFormulas.js` and `buildCode.js` are pure, well-bounded modules that would convert almost
mechanically (~2,000 lines, low risk, real payoff). The cost is concentrated in the two big
DOM files: 364 untyped element lookups each needing narrowing, 86 `innerHTML` string templates a
type checker can't see into, and 53 `window.*` globals that would need a declared global surface.
A full conversion also introduces a **build step**, which this project deliberately does not have
— that's a real property worth keeping, not an accident.

**Step 1 is already done** — `jsconfig.json` + `types/globals.d.ts` are in the repo, declaring
the core module contracts (`AllocSpace`, `HunterOptimizer`, `HunterSim`, `StoreSchema`,
`HUNTER_DEFS`, build codes, purchase paths) as both bare identifiers and `window.*` properties.
Zero runtime change, no build step.

```bash
npm install     # typescript is the only devDependency
npm run check   # tsc --noEmit -p jsconfig.json
```

**Current state: 38 errors across 8 files. This is NOT clean yet — do not assume it is.**

| Kind | Count | What it is |
|---|---|---|
| TS2339 property-does-not-exist | 18 | Modules whose IIFE takes `(window ?? globalThis)`; the `globalThis` branch has no declared properties. Fix with a JSDoc `@param` on the IIFE. |
| TS2322 / TS18047 null inference | 8 | The `let cached = null; … cached = realValue` lazy-init pattern. Fix with a JSDoc `@type`. |
| TS2349 not-callable | 4 | `wasmExports[name](...)` — the DOM lib types wasm exports as `ExportValue`. Needs a cast. |
| TS18048 possibly-undefined | 3 | `EvalResult.mat1/2/3` are genuinely optional; `incomeModel.js` assumes present. **Real finding** — worth a guard. |
| other | 5 | Inference artifacts around default parameters and `Array.from` element types. |

Almost all of it is annotation debt in untyped JS rather than defects, but the checker already
earned its keep: it found that `optimizer/worker.js` could invoke a null `evalFast` if a batch
ever arrived before init (now an explicit throw), and that `incomeModel.js` reads optional
fields unguarded.

**Remaining path:**

2. Drive `npm run check` to zero by adding JSDoc `@type`/`@param` annotations to the pure
   modules. Start with `storeSchema.js` (the shape is already declared, so the types nearly
   write themselves) and `optimizer/space.js`. Then add each newly-clean file to
   `jsconfig.json`'s `include`.
3. Only if that proves insufficient, convert the pure modules to real `.ts` with `esbuild`
   emitting into `webapp/public/`, leaving the DOM files as checked JS.

**Do not attempt a full `.ts` conversion of `app.js`/`shipsPage.js` as a first move.** They are
58% of the code, carry 364 untyped element lookups and 86 `innerHTML` templates, and converting
them forces a build step this project deliberately does not have. The payoff-to-risk ratio is
far worse than steps 2 and 3.
