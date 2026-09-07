# HunterSim — working agreement

A from-scratch clone of cifi-tools.com's hunter simulator/optimizer for the game CIFI, built by
extracting the real game math (the actual `release.wasm` evaluator, the real upgrade cost
curves, the real save format) rather than approximating it.

Read this before changing anything. It exists so you don't have to guess where things live or
re-derive decisions that were already made and validated.

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
- **THE "THREE RELICS THAT DO NOTHING" CLAIM WAS WRONG, AND IT WAS TELLING PEOPLE NOT TO BUY THEM.**
  This file used to state that Borge r7/r19, Ozzy r7 and Knox t2r5 "reach the wasm and change
  nothing", and concluded: "Nothing may ever recommend spending fragments on them -- they cost real
  currency and buy nothing measurable." Measured at a real level-49 Borge, with every other input
  held identical:
  - **r7 = 0 -> 15 leaves lootPerMin BIT-IDENTICAL (46343.035479430124 both ways) and multiplies
    mat1, mat2, mat3 AND xp by 2.08.** Materials go 2,081,471 -> 4,327,229 per run.
  - **r19 = 0 -> 1 leaves loot, stage and materials identical and DOUBLES xp** (404,352 ->
    808,703).
  **The error was in the measurement, not the game.** `relic-sweep.js` compared `lootPerMin`,
  `avgStage` and `bossKillRate` and nothing else, so a relic that only moves materials or XP read
  as inert. It now compares every output the evaluator returns and prints which fields moved.
  **This still reaches the user.** `hunterStatPathBrowser.js` deliberately keeps no blocklist and
  ranks by measured marginal effect -- but it scores through `OptimizerObjective` in `loot` mode,
  which is `lootPerMin`, so a relic that doubles materials still scores exactly 0 and is never
  recommended. Whether loot/min alone is the right objective for a fragment purchase is a REAL
  design question and is deliberately left open here rather than silently changed.
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
- **The GAME's own definition data is extracted, and our numbers agree with it.**
  `tools/reference/scene-defs.json` holds 18 numbered families pulled from the scene —
  `Relic` (20), `RU` (116), `SU` (30), `TU` (24), `Badge` (23), `POM`/`POI`/`POK` (attribute
  costs + caps), `BorgeSkill`/`OzzySkill`/`KnoxSkill` (talent caps), `VexinSkill` (empty — see
  below), `MK`, `Project`, `ATU`, `UDU`, `TUQ`, `DU`. Counts are from 0.7.3.61; RU was 111 and
  Badge 16 in 0.7.3.54. `scene-defs-test.js` checks our data against it and **all 20 tier-1 relic start
  costs, and every talent and attribute cap, now match the game itself** — a stronger source than
  the cifi-tools bundle everything was originally transcribed from.
  Two things that came out of that check:
  - **r5/r6 now use the GAME's cost formulas, not Ryther's static tables.** For r5 the game's
    formula reproduces his table exactly (1, 120, 4400), which validates both; for r6 it does not
    — the game says StartCost 30 where his table starts at 3. Their CAPS remain unresolved: the
    scene declares no MaxLevel for either. Costs and caps are separate questions.
  - **Knox has a 9th talent in the game (cap 50, the Ultima signature) that we correctly do NOT
    model** — `params.json` exposes no `ultima` argument for Knox, so the evaluator has nowhere to
    put it. Adding it would be an input that reaches nothing. Do not "fix" this.
- **Crew and Rank are NOT the save's `Ship{n}CrewLevel` / `Ship{n}Rank`.** Those are only what the
  player bought. From the recovered C# (FleetManager):
  `FinalCradleCrew = LM.LM240Bonus + MM.Ship1CrewLevel + Market.FinalISFreeCradleCrew`, and
  `FinalCradleRank = LM.LM239Bonus1 + MM.Ship1Rank + Market.FinalISFreeCradleRanks +
  RL.FinalAllShipsRanksBonus`; MultiverseMarket sets `FinalISFreeCradleCrew = IS49Bonus *
  IS49Level` (8 crew per level; 1 rank per level via IS48), same shape per ship.
  **Crew multiplies every install node's bonus linearly, so importing the raw field understated
  every fleet number** -- on the reference save Cradle crew 600 -> 680 (~13% on all its install
  bonuses) and rank 106 -> 114. `shipSchema.js` now adds the free grants and records
  `purchasedCrewLevel`/`freeCrew` alongside the total. `unmodelledCrewRankTerms()` EXISTS to report the two
  terms still missing (LM239/LM240 -- loop-mods.json has their costs but not their per-level
  Bonus -- and `FinalAllShipsRanksBonus`) rather than dropping them silently.
- **Ship EVOLUTION is a HUGE production multiplier and the tool does not model it.** It does not
  change install-allocation ranking (it is independent of how points are spent), but it dominates
  any ABSOLUTE number, and `input.evo` is currently imported and displayed while contributing
  nothing to the math.
  `SetShip<n>EvoBonus(evoLevel)` switches over the authored `EvoBonus<Ship>1..7` and returns
  `Pow(thatValue, GemPerks.AttractionGU6BonusCalc)`, stored as `<Ship>EvolutionBonus`. That value
  is then a plain factor in the `MK1Production`/`MK2Production` multiply chain, sitting between
  `RUAuto1Bonus` and `RUGen4Bonus`. The authored values are enormous -- Cradle 5 / 50 / 850 /
  162,000 / 5e15 / 6e30 / 7e60 for evo 1-7 -- and the reference account is at Cradle evo 4, i.e. a
  x162,000 factor we ignore. Values are in `tools/reference/authored-values.json`.
  **HOW THIS WAS MISSED TWICE, because the method matters more than the fact.** A first pass
  concluded evolution was absent from the chain on two bad checks. (1) The original disassembly
  catalogued named getter CALLS; `<Ship>EvolutionBonus` is read as a raw FIELD, so it appeared only
  as a bare `op_Multiply` with no preceding call (0x1D727E9 in get_MK1Production) and was filed as
  noise. (2) The follow-up grepped the recovered C# for the string "Evo" -- but Cpp2IL renders an
  unresolved field read as `NoteDecompilerIssue("Unmanaged memory load: [... (FleetManager)+1C30]")`
  with the value replaced by `(BigDouble)0`, so the read is INVISIBLE to a name search. It was
  found by taking the backing-field offsets from dump.cs (0x1C28 etc.) and grepping for those
  offsets **+8** -- BigDouble is 16 bytes and the note names the exponent half.
  **When a Cpp2IL body multiplies by `(BigDouble)0`, that is a missing operand, not a zero.**
  Grep the offset, do not trust the absence of a name. `tools/il2cpp-cli/resolve-loads.py` now does
  that automatically -- it parses `(Type)+OFFSET` out of every note and resolves it against
  dump.cs's field offsets, handling the +8 case. **Run it over any method before concluding
  something is absent.**
  Running it over the chain the fleet tool models turned up the rest of what a name-grep had
  hidden. `MK1Production` alone carries 23 such reads, including `ShardMining.FinalMK1Bonus`,
  `TraitSpheres.FinalTS17/24/30/31Bonus`, `ConstructionProjects.FinalAllGensBonus`,
  `Inventory.TechSampleAllGensBonusBonus`, `GemPerks.FinalAllGensBonus` and
  `MultiverseMarket.FinalISAllGensBonus` -- so the tool's per-ship resource totals are one slice of
  a much longer multiply chain, and should never be read as absolute production.
  In the per-node bonus itself, `RUGen2Bonus` has exactly three: `FinalShip1InstallsBonus` (our
  Fleet Analysis 2 term), `GemPerks.FinalPowerGU1Bonus` and
  `ResearchLaboratory.FinalAllShipsInstallsBonus` (= `FinalRU83InstallsBonus *
  FinalRU96InstallsBonus`). The last two are uniform across a ship's nodes, so they cannot reorder
  the optimizer. **Their unowned case is now modelled exactly** -- `PowerGU1BonusCalc` returns a
  literal 1 when `PowerGU1Level <= 0`, and the research product is 1 at level 0, which is the
  reference account -- and `unmodelledInstallBonusTerms()` now reports when an account owns them (it did NOT until it was wired -- see below).
  **PowerGU1 is now fully modelled**, because the type-tree enum bug below was fixed and GemPerks
  became readable: `PowerGU1BonusCalc` = `Pow(Pow(1 + 0.0012*L, FinalCradleCrew) *
  Pow(1 + 0.02*L, FinalCradleRank), PowerQualityPower)`, using CRADLE's crew and rank even though
  the result multiplies every ship's nodes. `PowerQualityPower` is 1 below quality level 2. What
  remains unmodelled and reported: the quality-2+ exponent (an operand Cpp2IL could not resolve),
  the PowerGU1 LEVEL itself (the gem store carries a tree level, node booleans and named upgrades
  but not per-GU levels, so it reads 0 today), and any RU83/RU96 -> per-level installs mapping.
- **THE TYPE-TREE GENERATOR DROPS ENUM-TYPED FIELDS, and `typetree.py` patches them back.** Unity
  serialises an enum as a plain int, so every omitted enum leaves the reader 4 bytes short and the
  rest of the object is garbage -- an array length gets read out of the middle of a PPtr and the
  reader runs off the end thousands of bytes later. The symptom (`read___int64 out of bounds`)
  looks nothing like the cause, which is why `GemPerks`, `MultiverseMarket` and `Gear` were written
  off as "type tree does not match the serialized layout".
  `GemPerks` alone has 38 `GemRequirement` fields (an enum) plus Odin's
  `SerializationData.SerializedFormat` (enum `DataFormat`). `patch_missing_enums()` re-inserts them
  from dump.cs, which supplies both halves needed: which types are enums, and each class's fields
  in declaration order. **GemPerks and MultiverseMarket now read STRICTLY** (883 and 1127 fields,
  no `--relaxed`), and re-extracting `authored-values.json` afterwards produced ZERO value changes,
  so it is a pure fix rather than a re-interpretation.
  It immediately paid twice: `MultiverseMarket.IS48Bonus` = 1.0 and `IS49Bonus` = 8.0 independently
  confirm the free rank/crew-per-level constants that had been derived from this repo's own older
  grant table, and `GemPerks.AttractionGU6BonusExponent` = 1.01 completes the evolution exponent.
  Only enums are re-inserted -- the generator is RIGHT to omit `List<List<T>>` and
  `List<Dictionary<..>>` (Unity cannot serialise them) and Odin-serialised fields (they live in the
  `SerializationData` blob, not Unity's field stream). `Gear` still fails, now with a different
  error, so it has a second unrelated problem.
- **The loop-mod crew/rank terms ARE modelled.** `LM240Bonus` (crew) and `LM239Bonus1` (rank) are
  linear in the recovered C# -- `LM<n>Level * LM<n>BonusExponent1` -- and `loop-mods.json` already
  carried `BonusExponent1` for every mod, which is that same field. An earlier note in this file
  said that file had the costs but not the per-level bonus; **that was wrong**. LM240 gives 1 crew
  per level and LM239 gives 8 ranks per level, asserted against the extracted scene data by
  `tools/bench/crew-rank-check.js` so the constants in `shipSchema.js` cannot drift from it.
- **Ship install bonuses MULTIPLY as independent factors, and Meltdown exponentiates the whole
  product exactly ONCE.** Read out of `libil2cpp.so` and confirmed twice — by hand from capstone,
  then independently from Ghidra-decompiled C via `tools/il2cpp-cli/decompile.py`:
  - `GeneratorManager::get_MK1Production` (RVA 0x1D7249B) is one flat chain of
    `BigDouble::op_Multiply`. Every bonus is its own factor, including install nodes: `RUGen2Bonus`
    and `RUGen4Bonus` — both Cradle nodes boosting MK1 — are multiplied in SEPARATELY. **Nothing
    is ever summed into a shared per-tier pool.** One node's getter
    (`FleetManager::get_RUGen2Bonus`, 0x2134F20) tail-calls `op_Addition` onto a literal 1 over
    `coeff(+0x57C) * FinalCradleCrew * level(+0x4B0C) * badges * FinalShip1InstallsBonus`, i.e.
    exactly `1 + pct*crew*counter*mults*level`, referencing no other node.
  - Meltdown (`OuroborosResetter.FinalMeltdownPower`, +0x378 via `GeneratorManager+0x118`) is
    applied at exactly two `Pow` sites, both gated on `MasterManagerOuro.FirstOuroResetDone`
    (+0x178): `Pow(BaseOutput, m)` inside each `get_MKnProduction`, and `Pow(MK1Production, m)`
    inside `get_CellProduction` (0x1D72357). Since `(A*B)^m == A^m * B^m`, that second site gives
    **every** factor inside MK1Production — install nodes included — an effective exponent of `m`.
    `get_CellProductionTotalMult` is applied OUTSIDE that Pow, so direct "Cells gained" bonuses
    keep exponent 1. (The melted branch also carries a flat x0.8; constant, so it cannot affect
    allocation.)
  - **There is NO `m^tierCount`.** `MK2Gains` (0x1D8043E-region) adds `MK2Production` into the MK1
    count with a plain `op_Addition` and no Pow of its own, so a higher-tier bonus reaches Cells
    through the MK1 count and still picks up `m` exactly once. An older note in this repo asserted
    `meltdownValue^tierCount` (attributed to SirRed's tool); the binary does not do that, and the
    claim was never verified against SirRed's actual source. **Do not reintroduce it.**
  - What is NOT settled by the binary: how much an "All Gens" bonus compounds down the tier chain
    over a run (each tier feeds the next tier's count, so it is genuinely worth more than one
    application — but the magnitude is a time integral, not a formula). `nodeMarginalLogGain`
    deliberately applies it once and says so, rather than inventing a multiplier.
- **The gear piece -> install node mapping is CONFIRMED against the game, all 44 of it -- and we
  are missing an entire colour.** This is the mapping the optimizer is most sensitive to: every
  other multiplier found so far (badges, Fleet Analysis, PowerGU1, all-ships installs, evolution)
  is UNIFORM across a ship's nodes and so cannot reorder candidates, whereas gear applies to ONE
  node and is exponential in the piece's level. Point a piece at the wrong node and the optimizer
  confidently sends points to the wrong place.
  The game states the mapping directly -- each `RU<Category><n>Bonus` property multiplies in the
  specific `Gear.<Color>Item<N>Bonus<M>` that targets it, `Bonus1` being the piece's install1 and
  `Bonus2` its install2. Extracted by `tools/bench/extract-gear-installs.py` into
  `tools/reference/gear-install-map.json` and asserted by `tools/bench/gear-install-check.js`:
  **all 44 mappings we model match the game**, so the wiki was right here.
  **The WHITE set the wiki omits is now modelled** (see the White entry below). `WhiteItem1..5`
  buff ten nodes, five of them Cradle: Gen 4, 6, 8, 9 and 10 (the others are Auto 8/10, Loop 9,
  Shard 10, Academy 2). Until they were added, those ten nodes were missing an exponential
  per-node multiplier -- harmless on the reference account, where every White item is
  `Unlocked: false, Level: 0`, but silently wrong Cradle recommendations for any account that
  unlocks them. **Yellow and Black (Gem Of Power quality 4 and 6) are still unmodelled**, and
  deliberately so: their names and set-bonus values are extracted but their install targets are
  not in `gear-install-map.json`.
- **GEAR really does buff a specific install node, from inside that node's own factor, and it
  compounds as `base^level`.** Both halves verified in the binary, and both were previously only
  wiki-sourced assumptions:
  - `FleetManager::get_RUGen1Bonus` (0x2134C85) calls `Gear::get_GreenItem1Bonus1`, and
    `get_RUGen4Bonus` (0x21352AC) calls `Gear::get_WhiteItem1Bonus1`, while `get_RUGen2Bonus` —
    whose node no gear piece targets — has no gear call at all. So the per-piece "buffs install N"
    mapping in `GEAR_SETS` is real, and `computeGearNodeMultiplier` belongs exactly where it is:
    multiplied into that one node's increment, not applied globally.
  - `Gear::get_GreenItem1Bonus1` (0x200B1AD) is nine instructions ending in a TAIL CALL to
    `BigDouble::Pow`: it loads a per-piece BigDouble base (`this+0xA0`) and the piece's LEVEL
    (`this->[0x20]+0x4488`) and returns `base ^ level`. **Exponential, not linear.**
  - **And the base is now read, not assumed:** `Gear.GearBaseBonus1` = BigDouble 1.01 and
    `GearBaseBonus2` = 1.02, straight out of the authored MonoBehaviour (`typetree.py`). So
    `x1.01/level` on install1 and `x1.02/level` on install2 are confirmed, the wiki was right, and
    a level-913 piece really is worth 1.01^913 ~= 8819x on its target node — which is why one
    Cradle node can legitimately dwarf its neighbours. Shape from disassembly, value from authored
    data: the two halves of the rule at the top of this file, on one number.
    **Caveat, stated because it matters:** the `Gear` type tree does not fully match its serialized
    layout (it comes up 148 bytes short, and the AssetsTools backend fails outright), so this was
    read with UnityPy's `check_read=False`. The fields above are before the divergence and the
    surrounding ones (`GearUnlockBaseCost` 3.0, `GearUnlockCostExponent` 2.5, the PPtrs) all read
    sanely, but do NOT trust a late `Gear` field without checking it another way.
  - The full verified factor list for a Cradle node is: base coefficient (`FleetManager+0x57C`),
    crew, its own level (`MasterManager+0x4B08 + 4*(n-1)`), `Badges.FinalBadge2Bonus`,
    `ResearchLaboratory.FinalShip1InstallsBonus`, a `GemPerks` field (+0x22D8),
    `Badges.FinalDarkBadge1Bonus`, `ResearchLaboratory.FinalAllShipsInstallsBonus`, and a
    `Gear::get_*ItemNBonus*` term when a piece targets that node.
    **Both of the terms once listed here as unexplained modelling gaps are now IDENTIFIED, and both
    are exactly 1 until a specific upgrade is bought — so omitting them is exact for an account that
    has not bought them, not an approximation:**
    - The `GemPerks` factor is `FinalPowerGU<n>Bonus`, one per ship category (Gen=GU1, Tech=GU2,
      Loop=GU3, Auto=GU4, Shard=GU5, Research=GU6, Academy=GU7). **All seven `PowerGU<n>BonusCalc`
      getters open with `if (PowerGU<n>Level <= 0) return 1;`** — verified by reading all seven, not
      by generalising from GU1. The real gap is the missing INPUT: the gem store carries tree levels
      and node booleans but no per-GU level, so we read 0 and therefore 1.
    - `FinalShip<n>InstallsBonus` **is** Fleet Analysis 2: `ResearchLaboratory` assigns it from
      `FinalRU78Bonus<n>`, which confirms our identification rather than leaving it a guess. But the
      same expression also computes `FinalRU78Bonus<n> * FinalRU101Bonus<n>`, and Cpp2IL renders the
      store as taking only the RU78 half — a discarded product is the usual sign of a mis-rendered
      SSA store, so **treat RU101 as a real second factor**. It is inert until owned
      (`FinalRU101Bonus1` is `BigDouble result = 1; ... if (RU101Level > 0) {...}`) and costs 1e5850,
      so no realistic account has it yet.
    **All 11 of these terms are now asserted by `uniform-term-check.js`** (reference from
    `extract-uniform-terms.py`), because "the optimizer may omit it" rests entirely on "it is 1
    until bought", and that is a fact about the game's code which a future build can change.
    **The extractor disagreed with a hand-check for several rounds, and the cause is worth keeping.**
    Two separate mistakes stacked:
    - Its verdict was a bare true/false, so a getter shape it did not recognise came out as "NOT
      inert" — the opposite of the truth. `FinalRU78Bonus1` ends `return 1.0;` while the check only
      looked for `= 1;`, and four terms were mislabelled that way. The verdict is now three-state:
      no level gate found means `null` (undeterminable), never false, and the bench treats `null` as
      a failure demanding the check be updated.
    - The runs I was comparing were reading DIFFERENT BUILDS — my hand-check defaulted to 0.7.3.54
      while the extractor had `CIFI_APK=apk-0.7.3.61`. The tell was in plain sight and ignored:
      `csharp.py` printed 51,599 lines in one and 53,330 in the other. **When two runs of the same
      logic disagree, compare the INPUT SIZES before re-reading the logic.**
    Every term now traces its own per-term verdict to stderr, so a silent disagreement of this kind
    cannot recur unnoticed.
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
  - **The values ARE now extracted** into `tools/reference/loop-mods.json` — 295 loop mods and 39
    Ouroboros mods with `StartCost`, `AdditiveCostIncrease`, `CostExponent`, `CostGrowthExponent`,
    `BonusExponent`, `MaxLevel`. Regenerate with `tools/bench/extract-loopmods.js`. The pipeline
    that finally worked: dump with `tools/il2cpp-cli` → stage a **`*_Data`-named** folder (that
    naming is what makes AssetRipper recognise a Unity build) → `/Export/UnityProject`, **not**
    `/Export/PrimaryContent` (level0 is a SCENE, and scene contents never appear in primary
    content — that single distinction is why three earlier attempts exported zero).
  - **Names are mapped WITHOUT save diffing, via cost fingerprints.** cifi-tools' Loop Mod
    Overview publishes each mod's MP cost per level as a base-10 EXPONENT, and the scene stores
    the same costs as BigDoubles (`LM<N>StartCost: {mantissa, exponent}`) — so the exponents are
    directly comparable. `tools/bench/match-loopmods.js` joins them on (start-cost exponent,
    per-level step, max level) and currently pins **8 of the 39 published mods**, including
    `stelzi` = **LM279** (e3400, max 8 — which independently agrees with hunterDefs' own "Mutual
    Mining Agreement" label). Matches require EXACT cap agreement: being lenient there let a
    wrong match through wearing a confident label. Diffing is now a last resort for the
    remainder, not the primary method.
  - **The broader scene↔save INDEX MAPPING is still unresolved, so do NOT bulk-join them.** 31 of 223 owned
    mods sit above the MaxLevel their index claims (LM0 owned 26 vs cap 5, LM9 25 vs 4 …). Ruled
    out: field-merging across objects (each LM field occurs exactly once in the scene) and
    Ouro-raised caps (only 2 mods carry `MaxLevelPreOuro`/`PostOuro`). A ±1/+2 shift does not fix
    it either, so the two numbering schemes are probably different orderings, not an offset.
    `loopmod-test.js` reports this rather than failing. Save diffing is what pins it down.
    Display names are UI `Text` populated at runtime and are not in the table.
  - **Save diffing therefore DOES work** for mapping index -> mod: change one mod in-game,
    re-pull, diff, see which `LM<N>` moved. Slow, but it was never impossible.
- **THERE ARE TWO IMPORT PATHS, and any audit must probe both.** Hunter-side data goes through
  `saveImport.js`'s `mapSaveToStore`; fleet data goes through `shipSchema.js`
  (`mapSaveToShips`, `mapSaveToUnlockedGens`, `mapSaveToGearLevels`, `mapSaveToFleetBadges`, …)
  applied by `applyImportedShipData()`. An earlier version of `save-coverage.js` inspected only
  the first and reported ship ranks, gear levels, badges and fleet research as unmapped when all
  four were already done — which led to a duplicate gear/generator mapping being written and then
  deleted. The report now probes both paths.
- **Every hand-typed input the save can supply should be auto-filled, and
  `tools/bench/save-coverage.js` is the ledger.** It walks the tool's own input surface, runs the
  real importer over a real save, and prints filled vs missing with candidate save field families
  for the gaps. It is a REPORT, not a gate — a gap is a to-do. Current state: **39/63** global
  upgrade inputs auto-filled, plus gems, per-hunter level/talents/attributes, and fragment
  balance. Known remaining gaps and WHY each is blocked:
  - **hunter base stats now import.** `<Hunter>Upgrade<Stat>Level` — all 9 per hunter, 28 values
    in total. An earlier note here claimed these were unmappable "because the save stores upgrade
    LEVELS, not the displayed stat, and the level→stat formula isn't reverse-engineered". That was
    backwards: **the wasm takes the LEVEL and derives the stat itself**, so the level is exactly
    what is wanted and no formula is needed. Three non-obvious names: Ozzy's Multistrike
    Chance/Power are stored under the CRIT names; Knox's `reload` is `AtkSpeed`; Knox's `proj` is
    `SalvoSize`.
  - **The inscryption display-id → save-slot map is a BIJECTION, not an offset, and the old
    blanket `+12` was wrong for most ids.** `IS<slot>Level` holds "Inscryption #N", but slot ≠ N
    and the difference is not constant. The game's scene settles it: each shop row is a GameObject
    named `ChrystosEmporiumUpgrade<slot>`, and every row the devs renamed also carries the
    displayed id (`ChrystosEmporiumUpgrade72-ID60` = slot 72 shown as #60), cross-checked against
    MultiverseMarket's own `IS<slot>IDText` reference. That proves **#57-#62 → slots 69-74 (+12)**
    and **#75-#110 → slots 75-110 (+0)**. The remainder is pinned by exhaustion: there is exactly
    one 110-row shop family (so the fleet inscryptions #64/#65/#67/#68 that `shipsPage.js`
    consumes live in it), 110 slots carry 110 ids, and removing the proven pairs leaves displays
    {1-56, 63-74} for slots {1-56, 57-68} — two contiguous blocks. Net: **identity everywhere
    except the 57-74 block, which is permuted so #57-#62 sit AFTER #63-#74.**
    The `+12` rule was generalised from the one range where it holds. It was silently corrupting
    imports: **#103/#104/#105 resolved to IS115/116/117, which do not exist**, so they never
    imported at all; #80-#92 read a slot 12 too high; and slots 1-12 (leveled 5,10,8,6,3,7,10,3,
    6,9,3,5 on the reference account) were owned by **no displayed id whatsoever** — which is the
    structural contradiction that disproves it, independent of any value match.
    The account profile corroborates the replacement: slots 1-56 mean 7.05 (#1-#56 finished),
    69-74 mean 2.00 (#57-#62 in progress), 57-68 mean 0.33 (#63-#74 barely started), 75-110 all
    zero — and the fleet inscryptions read 8,10,8,7,7,5,4,5 instead of all zero, which is what an
    account with six ranked-up ships should look like.
    Regenerate with `tools/bench/extract-inscryption-slots.js`; `inscryption-slot-test.js` asserts
    the shipped resolver against it **and that the map is a bijection** — the property the old rule
    failed.
    Inscryption COSTS are a separate question from slots, and they are settled: all 36 entries in
    `INSCRYPTION_TABLE` match the original tool's own `mV` object exactly, checked by
    `tools/bench/inscryption-cost-check.js <live-bundle.js>` (verified with a negative control, so
    it does fail when a value is wrong). The scene does not carry `IS<N>StartCost` — inscryption
    costs are assigned in code — but per the sourcing rule above that does not matter here.
  - **`gadgets` now import**, and the index question is settled by direct confirmation: the player
    reported wrench 50 / zaptron 40 in game, and the save reads `Gadget5Level` 50 /
    `Gadget6Level` 40 — matching `costFormulas`' own `g5`/`g6`/`g15` aliases. Worth remembering
    why this waited: `Gadget7Level` is also exactly 90, which coincidentally matched a
    `wrench: 90` in an unrelated build code. A plausible coincidence nearly became a confident
    wrong mapping on a real sim param.
  - **`cms` now import** via `Milestone<N>Acquired`, whose numbering matches our ids directly
    (cm46 → Milestone46Acquired), plus `cms.milestoneCount` derived by counting acquired ones (19
    on the reference account). Identified by SHAPE, not name: the account owns milestones up to
    ~20 and the save reads Milestone1–19 true then all false — a clean "owned up to N" prefix.
    **The save's `CM<N>` boolean family is NOT this** — all 26 are false on an account that owns
    20 milestones, so it is a claim/notification flag and is deliberately unused. Shard milestones
    are a third, separate family again.
  - `loopmods` — **only FOUR are tool inputs**: `trample` (Borge, cap 1), `scavenger` (Borge,
    cap 25), `scavenger2` (Ozzy, cap 25) and `stelzi` (all three, cap 8). `stelzi` is already
    pinned to **LM279** by cost fingerprint. The other three need a save diff, and
    `tools/save/diff.js` is built for exactly that: change one known mod by a distinctive amount,
    re-pull, and an index that moved by that exact delta is identified unambiguously.
    **Deltas, not absolute values** — an idle game mutates hundreds of fields between pulls, so a
    unique delta survives the churn where a value match would not.
    Do NOT try to narrow candidates using the scene's MaxLevel: the scene↔save index alignment is
    unresolved (LM98 reads 35 and LM167 reads 27 against a scene cap of 25), so that filter is
    unsound. The diff works purely on save indices and does not depend on it.
  - **`diamondspecials` now import**, identified by EFFECT COEFFICIENT rather than position —
    which is what makes it a proof. The IL2CPP dump names the DiamondShop slots semantically
    (`DU21Hunt*`, `DU22Loot*`, `DU23Loot*`) and the scene carries their bonus values, and those
    match the coefficients `resolveParam` already uses: DU21 bonus **3** → `reviveboost`
    (`3 × value`), DU22 bonus **0.025** → `hunterloot` (`1 + 0.025 × value`). Both cap at 10 and
    read 10 on an account confirmed to have them maxed.
    **DU23 is a third loot booster (bonus 0.01, cap 10) that this tool does not model — and it
    also reads 10.** So "pick the slot whose level is 10" would have been a coin flip between
    three. The coefficient is what disambiguates.
    The rest of the family, cross-checked against player-reported in-game levels: DU9 Token (6),
    DU10 Cells (17), DU11 MP (25), DU12 Gens, DU13 Shards (10), DU14 RP (8), DU15 AP (15),
    DU16 OP (30); DU0 is the generator amplifier and DU1–8 are the MK1–8 gen boosters
    (`DU1MK1StartCost` in the dump confirms the MK numbering).
  - **`trinkets` are FOUND but deliberately not mapped, on a semantics question.** The save stores
    them as `T<N>FLevel` / `T<N>FTier` ("F-Trinkets", matching the `f-trinket-tier-bonus` gem
    upgrade) — confirmed exactly against player-reported in-game values: T1F 230/tier 14 (all-gen
    booster), T2F 197/tier 12 (mod booster), T3F 178/tier 11 (shard booster). Our three trinket
    ids are cifi-tools' lore names for these; `Handbook`, `Codex` and `Amplifier` appear nowhere
    in the game.
    **THE COUNT-VS-SUM QUESTION IS SETTLED: it is the SUM of levels, and the parameter's name is a
    misnomer.** `upgrades.gems_nodes.creation_galvTrinketsCount` is the only sim consumer, and the
    live bundle names it "Galvarium Trinkets **Count**" while deriving it as
    `Object.values(l.trinkets).reduce((e,t)=>e+(t||0),0)` — a sum over the VALUES. Its own
    Trinkets page agrees with the code rather than the name, displaying the total as
    `x${(1+.001*e).toFixed(3)}` over that same accumulated sum. So our `resolveParam` was right all
    along; what was missing was the proof. Sum-of-levels 605 against a count of 3 was a 200×
    exposure, so this mattered. (Per-trinket identity still does not need settling: whichever way
    round the three go, the consumer aggregates them.)
    **Read the BUNDLE, not the site's output, for a question like this.** The obvious experiment —
    three trinkets at level 1 against one at level 3, same sum, different count — cannot work: a
    trinket is +0.001 per level, so even at level 5000 the effect sits under the site's display
    rounding and every black-box probe returns "inert", which is not an answer. That is why the
    question stayed open through several passes of end-to-end comparison. `trinket-semantics-check.js`
    now pins both halves (the bundle's derivation when given a bundle path, and our resolver always),
    verified with a negative control.
    **Settling it exposed a REAL BUG that no output comparison could have found.** The gate helper
    was named for the exodus tree and hard-coded it, taking the node index as a separate argument.
    The trinkets caller named `upgrades.gems_nodes.creation_gem5` and was answered from **EXODUS**
    node 5 — so trinkets were gated on an unrelated tree and resolved to 0 for any real account.
    Nothing caught it because a wrong gate returns 0 rather than throwing, and the parameter is too
    small to move a displayed number. `gemNodeGateUnlocked` now parses BOTH the tree and the node
    out of the one key, so they cannot disagree; a key that is not a gem-node key throws. **Two
    arguments that must agree are a bug waiting to happen — derive the second from the first.**
  - `iap` — **absent from THIS save, which is not the same as never persisted.** Searched exhaustively by both our ids and the game's own labels ("Traversal
    Pack", "Hunter Loot Booster", "Revive Boost"), plus an inverted search: `tools/save/unclaimed.js`
    lists every field no importer reads, so nothing can hide behind an unexpected name. Zero hits.
    But the game clearly DOES persist purchases — 175 `*Purchased` booleans exist, and
    `DiamondUltimaLevel` is present and mapped — so the likeliest reading is that **the reference
    account simply does not own them**, exactly as CM46+ and Research81 are absent for content it
    has not reached. A save from an account that owns one would reveal the field name instantly.
    Do not conclude "server-side" from this account alone.
  - ships/fleet — **already fully mapped, in `shipSchema.js`, not here.** Ship ranks, research
    units, generator tiers (`MK<n>UnlockedBool`), gear piece LEVELS (`{Color}Item<N>Level`),
    fleet badges (`Badge2Acquired` → innovation, `DarkBadge1Acquired` → dark innovation) and
    fleet research (`RU68Level`/`RU78Level` → Fleet Analysis 1/2) all have verified mappings,
    applied through `applyImportedShipData()`.
- **Fragment BALANCE comes from the save; the RATE never can.** `RelicFragments` is a BigDouble
  ({mantissa, exponent}) holding the current balance — the importer fills `fragments.current` and
  stamps `currentAt` so accrual restarts from a real number. It deliberately does NOT touch
  `perDay`: the game does not persist an earn rate, and overwriting a rate the user supplied with
  an invented one would be worse than leaving it.
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
- **r5/r6/r9 caps are RESOLVED, from the original tool.** They used to refuse, because Ryther's
  data said r5/r6 cap at 8 rising to 11 with Power Gem Node 1 while the live fragment planner
  implied r6 at 11 rising to 16 with Exodus node 2 (and r9 100 → 105) — two sources, no way to
  pick. The sourcing rule settles it: cifi-tools' own relic list states
  `{id:"r5",…,maxLevel:8,canBeUpgraded:!0}`, the same for r6, and `maxLevel:100` for r9. That also
  reconciles the community table — Ryther's "8 rising to 11" was the base cap and the raise
  reported as one number.
  **We hold the BASE cap and deliberately do not model the raise**: the raised value depends on
  live gem state, and offering levels the account cannot buy is the same silent-optimism failure as
  defaulting a gate to unlocked. Costs were always exact; `relicPriceableLevels()` still walks
  further than the cap for callers that need it. The refusal mechanism stays (tier-2 caps are still
  not in the extracted dataset) and is still tested.
  **CONFIRMED AGAINST THE GAME, and the two community sources were BOTH right.** The game caps
  tier-1 relics in three bands — `Tier1LowRelicsMaxLevel` 200, `Medium` 100, `High` 8 (authored
  data) — and dispatches each relic to one of them in `CheckRelic<N>MaxLevelStatus()` (recovered
  C#). All 20 assignments match what we ship, r10 and r12 included; `tools/bench/relic-cap-check.js`
  asserts it against `tools/reference/relic-caps.json`.
  The raises are real and there are TWO of them, which is exactly why the sources appeared to
  disagree: `FinalTier1<Band>RelicsMaxLevel = base + GemNodes.FinalExodus3Bonus` for every band,
  and r5/r6/r14 additionally add `GemNodes.FinalPower1Bonus4`. Ryther was describing the Power
  raise on High-band relics; the fragment planner was describing the Exodus raise. Not modelling
  them is now a deliberate choice about a KNOWN mechanism rather than an unresolved disagreement.
- **TIER-2 RELIC CAPS ARE AUTHORED AFTER ALL, and the live site contradicts ITSELF on t2r7.** An
  earlier note here said tier-2 caps were not in the extracted dataset, so `relicMaxLevel` throws
  for them rather than guess. They were simply being looked for in the wrong place:
  `OuroRelics.CheckRelicMaxLevel()` compares the player's level against `Relic+0x50`, which dump.cs
  names as the exponent half of `Relic.baseMaxLevel` (the BigDouble +8 case again), and those
  `Relic` objects are SCRIPTABLEOBJECTS in `sharedassets0.assets` -- so `typetree.py --list` never
  showed them, because it lists MonoBehaviours. All ten are now in
  `tools/reference/relic-tier2.json`: t2r1 10, t2r2 100, t2r3 80, t2r4 25, t2r5 100, t2r6 40,
  t2r7 40, t2r8 21, t2r9 100, t2r10 5.
  **The bundle declares t2r7 twice with different caps** -- `maxLevel:40` in its relic planner,
  `maxLevel:100` in its Overrides panel -- and t2r7 is one of the few relics that genuinely moves
  the sim, so it is 60 levels of a real upgrade either offered or withheld. The standing
  "cifi-tools is authoritative" rule cannot arbitrate a source disagreeing with itself; the game
  can, and it says 40. **We keep 40 and deliberately do not mirror the panel's bug.** Every other
  tier-2 relic agrees across all three sources.
  **The offset parse is cross-validated, and that is the part worth copying**: the adjacent
  `bonusPerLevel1` reads 1.02 for T2_07 and 1.08 for T2_05, matching the bundle's own `value:` for
  those relics exactly. A BigDouble read at the wrong offset returns a real-looking number rather
  than an error, so a neighbouring field agreeing with an independent source is what tells you the
  offsets are right. Its zod schema bounds the cap for the same reason.
- **`unlock_node` is the SECOND HALF of every gate, and both the predicate and the bench used to
  ignore it.** The live bundle's own unlock predicate requires a specific gem NODE as well as a
  tree level on four entries (the three trinkets at creation/4/node5, `cms.milestoneCount` at
  exodus/1/node4). `isUpgradeUnlocked` now enforces it and `gate-coverage.js` now compares it.
  Related: the original HIDES a gated upgrade until it is unlocked rather than annotating it with
  its requirement, and ours now does the same -- `visibleUpgradeItems()` filters every list and the
  old amber "Requires X" note is gone. `gate-visibility-check.js` pins that behaviour.
  **A "maxed" gem fixture must set NODES as well as levels.** Two benches built one with levels
  only and started failing when the node half began to be enforced; that is an incomplete fixture,
  not a gate defect, and the fix belongs in the fixture.
- **TWO BENCHES SILENTLY PASSED ON NOTHING because a `` was written into them as a literal 0x08
  BACKSPACE byte.** The regex could then never match. `gate-coverage.js` reported our CORRECT node
  gates as WRONG (a broken bench failing good data -- the more dangerous direction, since the
  tempting fix is to change the data), and `inscryption-slot-test.js` parsed ZERO fleet slots, so
  its range check ran over an empty list and passed regardless of what it was given. Both fixed;
  all sources are now scanned for stray control bytes and these were the only two. **When a bench
  passes, confirm it actually compared something** -- print the count, and treat an empty
  comparison set as a failure.
- **`upgrade-item-parity.js` checks what each override IS, not just that it exists.**
  `live-override-diff.js` compares the KEY SETS; this compares each item's `maxLevel` and whether
  it is a boolean (checkbox) or a level (number input). Neither a wrong cap nor a wrong control
  type changes the key set, so neither was visible to the existing bench -- which is how the t2r7
  cap shipped. Verified with three negative controls (wrong cap, boolean-as-level, capping an
  uncapped item).
  **It only compares ids we expose, on purpose.** The same id can appear twice in the bundle
  describing two different surfaces, and `mats_exchange` is the trap: its PAGE lists three EDC
  items while the OVERRIDES panel offers the single key `upgrades.mats_exchange.tysconDrives`,
  which is what we mirror. Comparing our panel against its page reports three missing items and one
  invented one, all false -- the same code-split mistake that once produced a bogus "we expose 6
  extras" report. **Fetch the whole bundle (main + every `./Name-hash.js` chunk it references)
  before running any bundle comparison.**
- **THE GAME RAISES CAPS, AND EVERY RAISE IS NOW ENUMERATED AND CLASSIFIED.** An authored
  `MaxLevel` is frequently only the BASE, so a tool holding the base withholds levels the account
  can really buy, and one holding a raised value unconditionally offers levels it cannot -- both
  silent, because the optimizer simply allocates against the wrong ceiling.
  The game marks its own: a raisable cap has a computed `Final<X>MaxLevel` property beside the
  authored field, and the property body IS the raise formula. All **104** of them are extracted
  (`cap-raise-audit.py` -> `cap-raises.json`) and each is sorted into a bucket by
  `cap-raise-check.js`:
  - **92 modelled** -- 91 ship install caps, every one exactly `FinalShipRanksMaxLevelBonus *
    <authored base>` (verified for all of them, not generalised from one), plus
    `FinalBorgeSkill6MaxLevel` = `BorgeSkill6MaxLevel + FinalAttraction2Bonus2LuckyLooterLevel`,
    which is Call Me Lucky Loot 10 -> 12 on Attraction gem node 2. **That confirms our
    `dynamicMaxLevel` against the GAME, where it had only ever been matched to the live bundle's
    `getMaxValue`.**
  - **6 base-only by policy** -- the tier-1 relic bands (`FinalExodus3Bonus2`, plus
    `FinalPower1Bonus4` on r5/r6/r14). Unchanged decision, now a checked classification rather than
    a comment.
  - **6 belonging to a system we do not model** -- the Ouroboros ship's install caps.
  **An unrecognised raise operand FAILS.** That is the whole point: a new mechanism cannot arrive
  unexamined.
- **ABSENCE OF A `Final*MaxLevel` PROPERTY IS THE EVIDENCE THAT A CAP IS STATIC, and it is now
  asserted.** `cap-raise-check.js` fails if one ever appears for hunter ATTRIBUTE caps, TIER-2
  RELIC caps, or any talent other than Borge skill 6 -- so "attribute caps cannot be raised" is a
  checked claim rather than an assumption. It also fails if `FinalBorgeSkill6MaxLevel` DISAPPEARS,
  since our `dynamicMaxLevel` would then be raising a cap the game no longer raises.
- **THE GAME HAS ALREADY WIRED INSTALL NODES 12 AND 13 IN EVERY CATEGORY, AND THEY ARE UNRELEASED.**
  All 14 carry a `Requirement` and UI objects but `MaxLevel 0` and `BaseBonus 0`, so they cannot be
  bought and contribute nothing -- not modelling them is correct today, exactly like `POK11` and
  the Yellow/Black gear sets. They are recorded in `cap-raises.json` as a TRIPWIRE: the moment a
  build authors one, `cap-raise-check.js` fails, which is precisely when the fleet model gains a
  real gap. This is the check to look at first after any future APK pull.
  Verified with four negative controls: attribute caps becoming raisable, an unrecognised raise
  operand, install node 12 being authored, and the talent raise disappearing.
- **THE FLEET SIM CREDITED 11 OF 23 CHECKABLE NODES TO THE WRONG GENERATOR TIERS, and the
  displayed totals were out by up to ~31,000x in both directions.** A node's RESOURCE was the last
  field of the install catalog with no game verification -- name, coefficient, counter, cap and gate
  all had it -- and it was parsed out of the node's ENGLISH EFFECT TEXT by keyword. Four separate
  bugs, all found by comparing against the game rather than by reading the parser:
  - **`&` parsed as a RANGE.** `+0.02% MK1 & MK4 outputs` credited mk1,mk2,mk3,mk4. `&` is a list
    separator; the game reads that node in MK1Production and MK4Production only.
  - **Comma lists truncated to the first tier.** `+0.1% MK1, MK2, MK3 outputs` credited mk1 alone,
    because a single `String.match` stops at the first hit -- so three of the highest-percentage
    nodes in the fleet were credited with a third of what they boost.
  - **An EDITORIAL ASIDE inside a PARSED field.** Zagreus 7's effect string ended `(wiki text as-is
    -- possibly meant "all Generators")`. Those words made the tool credit all ten tiers, and
    because MK3 was also named, MK3 was pushed twice and its factor SQUARED. Two more nodes carried
    similar asides. **Never put commentary in a field something parses** -- uncertainty belongs in a
    code comment, where no regex can read it as data. `node-resource-check.js` now fails on any
    effect string containing one.
  - **The counter's own tier read as a boosted tier.** `+0.5% MK1 output, per manually purchased
    MK2 Generator` is MK1 boosted and MK2 counted. This one was INTRODUCED by the first attempt at
    fixing the others, which is exactly why the bench compares every node rather than the ones that
    were originally wrong.
  **The reference is the game's own consumer list**, not the prose: each `RU<Cat><n>Bonus` is read
  by exactly the `*Production` properties it feeds, so that list IS the node's resource set
  (`extract-node-resources.py`). Comparing our tags against the same text we parse would test the
  parser against itself.
  **Three effect strings were corrected against the game** -- Auxesia 4 to MK1, Hephaestus 7 and
  Zagreus 7 to MK5. Two of the three asides had guessed right years ago and were never acted on.
  **Scope of the fix, stated precisely: this changed the DISPLAYED totals, not the allocations.**
  Measured before/after across all 7 ships at budgets 75/150/300, every optimizer plan is
  byte-identical, because `nodeWeight` collapses every `mkN` tag into one resource bucket and the
  count of tiers does not change the weight. The Fleet page's per-tier multipliers, which did use
  the tags directly, moved a great deal -- Demeter MK4 40,856,318 -> 1,283 and Koios MK3 2,299 ->
  85,063 on the same fixture.
  **Known and reported, not silently truncated:** the game's production chain runs to **MK12**
  (`RU7AcademyBonus` is read by MK1..MK12Production) while `GEN_TIERS` stops at MK10, so an
  "All Gens" node really does feed two tiers this tool does not track. `node-resource-check.js`
  prints that rather than letting the tags quietly disagree.
- **`fleet-formula-check.js` checks the ARITHMETIC, which every other fleet bench takes for
  granted.** The coefficient, counter, badges, caps and factor-completeness each have their own
  check; none of them notices if the pieces are COMBINED wrongly. It rebuilds
  `1 + BaseBonus * crew * counter * level * badge * research * gear` from the AUTHORED coefficient
  (not the effect text the tool parses, or it would test the tool against itself) and compares
  against `nodeOwnBonusPct` over 228 node/state combinations, plus asserts the bonus is exactly
  linear in level and in crew.
  **Its tolerance is 1e-6 relative and that number is justified, not tuned.** The two sides read the
  same coefficient from different places: Unity stores it as a float32 (0.027% is held as
  0.0002699999895412475) while the effect text carries the clean decimal, so they agree to ~1e-8
  and no closer. Demanding more would be demanding the effect text carry float32 rounding error. A
  deliberate 0.5% error -- 5,000x smaller than any real composition bug -- still fails it.
- **THE TALENT SEED USED FOR SCREENING IS NOT COSMETIC, AND TREATING IT AS COSMETIC COST 16.7% ON A
  REAL BUILD.** Attribute supports have to be scored against SOME talent allocation, and Stage 0
  used a canonical round-robin fill -- justified in a comment reading "Stage 2 re-optimizes talents
  jointly anyway, so this only affects screening order, never the final answer". Screening order is
  precisely what decides which supports survive into refinement, so the final answer depends on it.
  Measured on a real level-11 Ozzy build: the round-robin seed spreads 11 points over 8 talents,
  giving Call Me Lucky Loot **1** where the right answer is **10**. Loot is dominated by that
  talent, so under the flat seed the support ranking **inverts** -- `{lotl,exo,timeless}` screens at
  45.0 against the true best's 38.5, while with tuned talents those same two are worth 57.4 and
  **68.9**. The good support was ranked out of the cut by a talent build nothing like the one it
  would be used with, and the optimizer returned 57.41 against an import of 68.92 that it was
  perfectly entitled to reproduce.
  **THE "SEED IS NOW TUNED" CLAIM THAT USED TO BE WRITTEN HERE WAS FALSE -- THE TUNING WAS NEVER
  IMPLEMENTED.** This file and the comment in `search.js` both stated that the seed was tuned once
  by a block optimization before screening, against the incumbent's attributes or the widest
  realizable support's fill, and reported measured results from it (`69.03`, `best 3.97%`). Commit
  `2a25628` added 22 lines to `search.js` that were **almost entirely comment**: the code was
  `let seedTalents = flatTalents;` and `seedTalents` was never reassigned anywhere in the file. The
  seed remained the flat round-robin fill the comment said had been replaced, so the quoted numbers
  cannot have come from that code.
  Read this as the standing warning in this file applied to this file: **a comment describing a fix,
  and a CLAUDE.md entry describing a fix, are not evidence the fix exists.** `grep` for the variable
  the prose claims is being computed and check that something assigns it.
  What the talent block actually needed was not a better seed but the same treatment attributes
  already get -- see the entry below.
- **WHERE THE IMPORT'S OWN SUPPORT RANKS IN SCREENING SAYS WHICH KIND OF PROBLEM A SHORTFALL IS.**
  Stage 1 screens every realizable support at its canonical fill, and only the top
  `SURVEY_SUPPORTS` are optimized at all. So if a real player's shape ranks below that cut, the
  optimizer never refines it and no amount of local-search work can match that build --
  a SCREENING problem, with a different fix from a search one. `support-rank-check.js` measures it,
  and it earned its place immediately: it exonerated screening on the level-31 Knox (rank 2 of 144,
  pointing at the talent block) and convicted it on the level-55 Ozzy (rank 63 of 234, pointing at
  the `openThreshold` bug above).
  **A bad rank is a RISK INDICATOR, not a defect.** The optimizer can still win from a different
  support, so the rank has to be joined to an actual measured shortfall before it means anything.
  Do not "fix" a rank.
  First sample of 10 random loot fixtures after the threshold fix: **8/10 screen inside the cut**,
  most at rank 1-4, and the two that do not are different from each other -- one at rank 9 (a
  one-place miss, which is a question about how tight `SURVEY_SUPPORTS` should be) and one at rank
  39 with no tier gates, no concentration and no boss wall, which is a genuinely unexplained case.
- **A FLAT FILL IS BIASED TOWARD NARROW SUPPORTS ON ANY THRESHOLD-SENSITIVE BUILD, AND THAT IS A
  THIRD, SEPARATE MECHANISM.** Found on `knox:KNOWN_KNOX_BUILDS#26` (level 33), whose own support
  screens at rank 39 of 144. It is NOT the two causes already recorded: the support has no
  tier-gated members (so the `openThreshold` bug cannot be it) and re-ranking against the import's
  OWN talents makes it WORSE, 39 -> 50 (so the flat talent seed cannot be it either).
  The numbers say what it is, with the import's own talents held fixed so only the fill varies:
      import talents + FLAT FILL of its own support ->     7,404
      flat talents   + import attributes            ->    84,008
      import talents + import attributes            ->   102,964
  The fill costs **14x**; the talent seed costs 18%. The import is `kraken:20 soul:13 dead:10 time:5
  sear:5 pct:4 spa:1 pl:1` -- concentrated, with two members funded at exactly 1 as gates -- while a
  round-robin over 8 members gives each about 5. The build kills its boss at `killRate 98.6`, so
  spreading below the depth that kill needs drops it off the same cliff as the boss-wall entry.
  **Generalised: concentration is what crosses a threshold, and a narrow support concentrates for
  free.** Every support ranked above the import's here is a 5-6 member SUBSET of it. So flat-fill
  screening does not measure "is this the right set of nodes", it measures "does an even split of
  this set happen to clear the wall", and wide supports lose that by construction.
  **WHETHER IT COSTS ANYTHING IS STILL OPEN, AND MUST BE MEASURED BEFORE ANYTHING IS CHANGED.**
  `Space.transfer` may grant points to a node currently at 0, so refinement CAN widen a narrow
  support back out -- the bias may be entirely harmless. A bad rank is a risk indicator, not a
  defect. Do not tune a cut or a fill to move a rank that is not attached to a measured shortfall.
- **BOSS-WALLING IS A POPULATION PROPERTY, NOT A CURIOSITY: 8 OF 10 SAMPLED IMPORTS DO NOT KILL THE
  BOSS THEY REACH.** Their loot therefore sits on the plateau where `lootPerMin` has no gradient
  (see the boss-wall entry). Two consequences worth stating plainly:
  - The cross-seed pass is broadly load-bearing rather than a fix for one odd build, so paying for
    it is justified.
  - **The gate on it will rarely fire**, because it skips only when the search's own answer already
    kills the boss, and on a walled build it does not. The 2.3x saving measured on one non-walled
    Borge is NOT the typical case, and claiming the gate makes the pass cheap in general would be
    wrong.
- **THE THRESHOLD FILL DUMPED THE WHOLE BUDGET INTO ONE ATTRIBUTE, AND IT COST 4.20% ON A REAL
  BUILD.** `canonicalFill`'s `openThreshold` -- the path that banks points to satisfy a tier gate --
  took `growable.find(...)`, the FIRST eligible member, on every iteration. Justified in its own
  comment as "cheapest first, so the fewest points are committed", which is simply not true:
  `pointsBelowThreshold` counts points in the SAME cost-weighted units as the budget, so reaching a
  threshold of 150 costs exactly 150 whatever the distribution. Concentrating buys nothing.
  What it does buy is a degenerate fill. On a real level-55 Ozzy, whose `scarab` needs 150 banked
  points, the fill came out `lotl:135 exo:2 scorp:2 timeless:2 ibu:2 exterm:2 medusa:1 dance:1
  scarab:1` -- **135 of 165 points in one attribute**, because `lotl` is cost 1, uncapped, and first
  in declaration order, so it never stopped being eligible.
  That is the exact degenerate corner `canonicalFill`'s header comment says it exists to avoid
  ("Round-robin rather than 'dump it all in the first node' because the screen should reflect what a
  support set can do when actually used, not a degenerate corner of it"). The threshold path never
  honoured it, and a comment asserting the right rule is not the rule.
  **Effect, measured:** the import's own support screened at **rank 63 of 234** -- outside the
  top-8 survey cut, so the shape the player actually used was never refined. Round-robin instead:
  **rank 2 of 234**, with a fill of `lotl:41 exo:39 scorp:5 timeless:5 ibu:5 exterm:5 medusa:5
  dance:4 scarab:4` against the import's `lotl:48 exo:38 scarab:7 scorp:5 timeless:5 ibu:5
  exterm:5 dance:4 medusa:1` -- nearly the same shape. Every support's screen score rose (top
  1.67M -> 1.83M), and the realizable counts are UNCHANGED (234/168/144/360), so no support was
  traded away for it.
  **How it hid:** it only fires for supports containing a tier-gated attribute, only bites when a
  cheap uncapped member sits early in declaration order, and it produces a legal, plausible-looking
  allocation. Nothing asserts that a canonical fill is REPRESENTATIVE, only that it is legal -- and
  the whole screening stage is built on the assumption that it is both.
- **DETERMINISM IS NOT PRECISION, AND THE DIFFERENCE BOUNDS WHAT EVERY QUALITY GATE MAY CLAIM.**
  The evaluator returns bit-identical output for identical (allocation, iterations) -- settled, and
  what makes memoization sound. It does NOT follow that a 1000-iteration score is the build's true
  value: it is a sample, so any gate reading a DIFFERENCE between two of them sees the real gap plus
  two sampling errors. Before treating a 4% shortfall as a search defect, that error has to be
  measured rather than assumed.
  Measured by `eval-precision-check.js`, which evaluates each fixture's OWN import allocation --
  a fixed build, so the search is not involved -- at 1000 through 16000 iterations:
  **mean absolute error 0.12%, worst 0.35%.** So `FINAL_ITERATIONS` is precise to roughly a tenth of
  a percent, a comparison of two scores carries about 0.2%, and anything above ~1% is a real
  difference. That is the number that licenses the other gates; it had never been measured.
  The corollary matters as much: a gate threshold set well above 1% is not "tolerant", it is blind.
- **AN IMPORT THE OPTIMIZER CANNOT LEGALLY PRODUCE WOULD MAKE EVERY QUALITY GATE MEASURE THE WRONG
  THING.** All of them compare against a recorded import and read a shortfall as a search defect,
  which is only valid if the import is inside our caps, legal under our dependency/threshold model,
  and affordable at the budget the bench hands over. `import-legality-check.js` checks that
  assumption -- nothing else did. All **182** fixtures pass, so the premise holds and a shortfall
  really is about the search.
- **THE 182-BUILD GATE CANNOT SEE SEARCH QUALITY AT ALL, AND THE OPTIMIZER WAS MUCH WEAKER THAN IT
  IMPLIED.** The gate hands the optimizer the user's own build as an incumbent; the incumbent
  competes as a finalist and is returned unchanged when nothing beats it. So "34/34 met or beat the
  import" is satisfied whenever the incumbent SURVIVES. It proves the optimizer does not DOWNGRADE
  a build -- a real property -- and says nothing about whether the search could FIND one.
  Remove the incumbent and give the search the import's own budget, so the import is exactly
  reachable, and `KNOWN_KNOX_BUILDS#22` (level 31) returns **6,916 against an import of 64,031 --
  89% short**. The gate scored that build as a pass. `search-quality-check.js` is that measurement;
  `--only=borge#16` re-checks one build without paying for a sweep.
  **ROOT CAUSE: the two blocks are treated asymmetrically, and the game is threshold-shaped.**
  Attribute STRUCTURE is enumerated exhaustively; talent structure and both blocks' DEPTH are found
  by pairwise coordinate exchange starting from `canonicalFill`, a flat round-robin. Thresholds
  (Power Of Gaia is worthless at 3 and decisive at 10; an attribute pays only once it is deep
  enough to change a stage outcome) create plateaus that pairwise transfers cannot cross. Localised
  on Knox#22, each step measured: the import's attribute support ranks **#2 of 144** in screening
  (screening is fine), the same support at its flat fill scores 4,293 against the import's 64,031
  (depth is the gap), attributes climb fine when talents are right (flat -> 44,348), and **talents
  cannot climb at all even with the import's exact attributes** (flat -> 6,473). The talent block
  is the broken half.
  **TWO MECHANISMS FIX IT, and both are the same idea -- stop starting from a flat fill, and
  enumerate the structure you were guessing:**
  - `greedyTopUp` fills idle budget by MEASURED MARGINAL VALUE instead of declaration order. As the
    incumbent's top-up it took a level-38 Borge from **-12.06% to 0.00%**; as a support's starting
    fill it moves the right support from -18.24% to **-0.51%** on a level-26 Borge (talents held at
    the import's, so the fill is the only variable).
  - `enumerateTalentSupports` does for talents what Stage 1 does for attributes. At most 511
    subsets for 9 talents -- FEWER than the 361 attribute supports already enumerated -- so the
    asymmetry was never justified by cost.
  Neither alone is enough and the pairing is not incidental: on the level-26 Borge, refining from
  the flat fill and from the measured fill converge to the SAME 1,290.48 because the talent block
  binds, and only doing both reaches **1,519.08, 0.60% ABOVE the import**, with no incumbent
  involved. On Knox#22 the greedy top-up alone leaves it at -89%; adding the enumeration reaches
  **-3.29%**. Every one of these is an additional FINALIST, never a replacement, so Stage 3 still
  takes the maximum and no build can come back worse.
  **THE COUPLING IS ONE-WAY, AND THAT DICTATES THE ORDER.** Attributes are learnable from a flat
  talent seed; talents are NOT learnable from a flat attribute fill. Knox#22's winning talent
  support ranks **152nd of 178** against a neutral attribute fill, **151st** against the RIGHT
  attribute support at its flat fill, and **1st** once the attributes carry real depth. So the
  talent enumeration has to be screened against a measured attribute allocation, never a canonical
  one -- screening it earlier is not a cheaper version of this, it is a different and wrong answer.
  **THINGS THAT DO NOT WORK -- measured, so they are not retried.** Talent-support enumeration
  against a neutral partner (-89%, unchanged). Alternating the two support enumerations to a
  fixpoint (converges to the same wrong answer in ONE round). Specialist seeds that max each talent
  in turn (refinement strips them immediately, because with flat attributes the talent really is
  worthless). Enumerating the full cross product is the only method guaranteed to find these, and
  it is 361 x 511 = 184k screens on a high-level Borge -- hours.
  **KNOX#22 IS A DIFFERENT PROBLEM AND I FIRST MISDIAGNOSED IT AS THIS ONE.** An earlier version of
  this entry called it "a genuine joint peak in (talent support, attribute depth) that no
  partner-free method reaches". That was wrong, and the correction is the useful part -- see the
  next entry. It is boss-gating, not search weakness, and the tell was in a field the harness was
  not printing.
  **Cost: 2,227 -> 6,483 evals on the level-26 Borge (2.9x).** The greedy fill dominates it, being
  O(idle points x members). The incumbent top-up is free on a fully-spent build -- the loop does not
  run -- but the per-support fill is not, and this is the number to watch on high-level builds.
- **THE BOSS-WALL FIX IS A CANDIDATE, NOT A SCORING CHANGE, AND THAT DISTINCTION IS THE PROJECT
  OWNER'S CALL RATHER THAN A STYLE PREFERENCE.** `MODES.loot.score` is still exactly `r.lootPerMin`.
  What changed is that `loot` and `push` declare `crossSeedFrom: 'boss'`, and Stage 2d runs a boss
  search, refines its answer under the CALLER's objective, and enters both the refined and
  unrefined versions as ordinary finalists. Stage 3 then decides on pure loot, so the answer is
  still the best build by the metric the player asked for -- it is the candidate POOL that got
  wider, not the question.
  Blending boss progress into the loot score would have been the smaller diff and it would have
  been wrong: the objectives exist so the player can say what they are going for, and a loot score
  that secretly rewards boss progress answers a different question than the one asked.
  **`scorerFor` is REQUIRED, not optional, for any mode that declares a cross-seed.** A scoring
  pool is bound to one objective at init, so the pass needs a factory for a second one; making it
  optional would mean the optimizer returned different answers depending on which caller invoked
  it. `optimize()` throws if it is missing, and asserts the cross-seeded mode does not itself
  cross-seed, which is what terminates the recursion. The browser builds the extra pool lazily and
  terminates it in `finally` -- a leaked pool is a leaked WASM module per worker, which is the
  thing `MAX_POOL_SIZE` exists to prevent.
- **`loot` MODE IS BLIND TO A BOSS WALL, AND THAT IS AN OBJECTIVE PROBLEM, NOT A SEARCH PROBLEM.**
  On `KNOWN_KNOX_BUILDS#22` every method tried -- coordinate exchange, support enumeration, greedy
  build-up, chunked greedy, joint greedy -- returned the same ~6,900 against an import of 64,031,
  and nine methods agreeing is itself the clue. The evaluator explains it in one line:
  `bossKillRate 93.5 / bossHpPercent 0.12` for the import against `bossKillRate 0 /
  bossHpPercent 85.24` for every candidate, with `avgStage` pinned at exactly 100.00. The whole
  9.26x gap is "kills the stage-100 boss" vs "does not".
  `MODES.loot.score` is `r.lootPerMin` and nothing else, so **every non-killing build scores the
  same no matter how close it came.** The search is not weak here, it is being asked to climb a
  flat surface. The proof is that the SAME optimizer, same budget, no incumbent, in `boss` mode --
  whose objective is lexicographic over `bossHpPercent` and therefore has a gradient -- returns a
  build with **39,072 loot against loot-mode's 6,978**, and refining that as a loot seed reaches
  **46,820** (-89.10% -> -26.88%).
  Two things this cost, both worth remembering:
  - **The harness hid it.** `evaluateAllocation` returned `{loot, stage, time}` and dropped
    `bossKillRate`, `bossHpPercent` and the materials. That is the SAME "the measurement could not
    see the field" failure this file already records three times (relic-sweep watching loot while
    r7 doubles materials; sim-gate-probe's first signature missing XP; "no wasm argument" read as
    inert). **When several independent methods agree on an answer that is obviously wrong, print
    every field the evaluator returns before theorising about the search.**
  - **A plausible mechanism is not a diagnosis.** The flat-fill/block-alternation story was real
    and does explain `borge#16` and `borge#24`, so it fit -- and it was still the wrong cause for
    this build. Two failures that look identical from the outside can have unrelated causes.
  `stage` ("Highest Stage Reached") is NOT the gap here -- it is a real wasm param for all three
  hunters, lives in `baseStatKeys`, is carried in `CODE_PARAMS`, and matches the live bundle's own
  label and `max: Infinity`. Knox#22 carries `stage: 101`, i.e. an account that had just cleared
  that boss, which is exactly why it sits on the knife edge. Builds whose code carries no value
  resolve to 0, which is correct for an account that has cleared nothing.
- **THE OBJECTIVES ARE A PLAYER'S CHOICE, NOT A RANKING OF BUILD QUALITY, AND THE TOOL SHOULD NOT
  QUIETLY OVERRIDE THAT.** Stated by the project owner: sometimes you want to die right after the
  boss, sometimes pushing further pays more, sometimes you are farming stages for the Spoils Of War
  mod, sometimes you only want to know your kill chance, sometimes you want the kill with Timeless
  maxed so it pays the most. So a loot search that silently spends double the runtime chasing a
  boss the player did not ask to fight is the wrong shape of fix, however much loot it finds.
- **`cifi.mysticdrew.net` is a third-party CIFI optimizer, and its methodology is worth knowing --
  including where it does NOT solve what it appears to.** Its bundle is a single unminified-ish
  `hunter/optimizer-app.js`.
  - It emits **one import code per hunter/objective pair** (`loot`, `boss`, `stage`, `ozzy300`)
    rather than trying to make one objective serve every goal -- the same design the owner
    describes above.
  - Its objectives are lexicographic TUPLES via `objectiveTuple()`; loot's is
    `[lootPerMin, bossKillRate, -bossHpPercent, maxStage, avgStage]`. **This does not actually
    solve the boss wall**, because `compareTuple` is a strict float comparison and `lootPerMin`
    always differs slightly between two allocations, so the later terms are effectively dead for
    the loot objective. Do not copy it expecting it to fix the plateau.
  - Its search is `randomNeighbor` -- move a random point between two random nodes -- driven by
    `samples`, `passes`, `heat`, `perturbSteps` and fresh restarts. That is randomized multi-start
    local search, i.e. exactly the family this repo deliberately removed. It crosses plateaus by
    volume and luck rather than by construction.
  - **The one idea there that we lack and probably want:**
    `BossTargetFromHighestLevelReached = floor(level / 100) * 100 + 100`. Its boss objective, when
    it knows that target, ranks `[reachedTargetBoss, cappedStage, bossKillRate, -bossHpPercent,
    maxStage, avgStage, lootPerMin]` -- aimed at the NEXT boss rather than at whatever boss the run
    happens to reach. Since rewards change on the first kill of a stage, "can I beat the next one"
    is a more useful question than "maximise kill rate", and ours is currently target-agnostic.
- **THE BOSS OBJECTIVE AIMS AT THE NEXT UNBEATEN BOSS, NOT AT WHATEVER BOSS THE RUN REACHES.**
  Bosses stand every 100 stages and the FIRST kill of one is what changes that stage's rewards, so
  the question a player is asking is always "can I beat the next one". The objective used to
  maximise the kill rate on whichever boss the run happened to meet -- for any account past stage
  100 that is a boss it has already killed, i.e. a build for a fight there is no reason to take.
  `bossTargetFor(stage) = floor(stage / 100) * 100 + 100`, so an account at 104 is aimed at the 200
  boss. Independently the same rule cifi.mysticdrew.net uses, which is worth noting because nothing
  in our own data pins it.
  **`stage` IS A POWER MULTIPLIER, NOT A BOSS SELECTOR, and that had to be measured before any of
  this could be designed.** Holding one Knox build fixed and varying only that input:
  `stage 0 -> killRate 0.0, loot 2,733`; `stage 101 -> killRate 93.5, loot 64,031`;
  `stage 300 -> killRate 99.4, loot 93,221` -- while the run still ends around stage 100-106
  throughout. So the evaluator has no target input to lean on and "am I fighting the target boss"
  has to be read off `maxStage`. A build that cannot reach the target is ranked purely on progress
  TOWARD it, which is what makes "give me the best shot at the 200 boss" answerable when the honest
  answer is "you cannot get there yet" -- the reported kill chance then says so. Entering a target
  the account cannot reach is the user's call to make; ours is to answer it legibly.
  `boss-target-check.js` pins the target arithmetic and the whole tier ordering.
- **THE LOOT CROSS-SEED IS DELIBERATELY TARGET-AGNOSTIC, AND CONFLATING THE TWO WOULD HAVE BROKEN
  IT.** The two uses of the boss objective want different bosses. A player selecting `boss` means
  "the next one I have not beaten". The loot cross-seed means "the boss wall capping THIS build's
  loot", which is whatever boss the run actually reaches. On the level-31 Knox those are different
  bosses -- target 200 (unreachable) versus the stage-100 wall it is really stuck on -- and seeding
  loot from a target-200 search yields a push build instead of the boss-killer worth 45,180. So the
  pass calls `scorerFor(crossMode, { bossTarget: null })`, and `bossScore` keeps its target-agnostic
  behaviour when no target is supplied. The Effective Path uses the same fallback, correctly: it
  never changes the account's stage.
- **THE CROSS-SEED GATE COSTS ONE EVALUATION AND SAVES A WHOLE SEARCH.** The pass is only justified
  while the objective is flat, i.e. while the boss is unkilled. Scoring the best build found so far
  under the boss objective answers that in one call, because that objective's tiers already encode
  "killed it" (`KILL_ACHIEVED_BASE`, exported so the comparison lives in one place rather than
  being a number copied into the search). Unconditional seeding measured 15,047 evaluations against
  6,483 on a build that was never boss-walled -- 2.3x for a candidate that could not win.
- **RESEARCH: WHY GREEDY FAILED HERE, AND WHAT THE LITERATURE SAYS TO USE INSTEAD.** Recorded
  because several plausible-looking methods were tried and measured worse, and the theory explains
  exactly why rather than leaving it as "it did not work".
  - **Marginal-greedy allocation is exact only for SEPARABLE CONCAVE problems.** Ours is neither:
    thresholds make it non-concave (Power Of Gaia is worthless at 3 and decisive at 10) and
    talent/attribute interaction makes it non-separable. Measured, with the other block held at the
    import's own values: greedy build-up over talents reached -90.4% and over attributes -96.5%.
    Adding chunked candidates (`+32/16/8/4/2/1` at once, so a threshold at depth 10 is visible to a
    method whose lookahead would otherwise be 1) DID discover `kraken:32` where nothing else could,
    but still lost overall. **Do not reach for greedy here again without re-reading this.**
  - **The family that fits a deceptive/plateau landscape is QUALITY-DIVERSITY, specifically
    MAP-Elites**: keep an archive of the best solution per cell of a BEHAVIOUR descriptor space,
    so a build that scores badly on the objective but is unusual on a descriptor survives as a
    stepping stone instead of being discarded. That is precisely the failure here -- a build that
    farms poorly but nearly kills the boss is the stepping stone to the 9x cliff, and a
    fitness-only search throws it away.
  - **The natural descriptors for this tool are already in the evaluator's output**: boss progress
    (`bossKillRate`, or reached-target) and depth (`avgStage`/`maxStage`), with `lootPerMin` as the
    fitness. An archive over those would make `loot` mode find boss-crossing builds INHERENTLY --
    the project owner's stated goal -- and would subsume the cross-seed pass, which is a targeted
    workaround for the same problem. **This is the strongest known candidate for replacing the
    cross-seed; it is NOT implemented.**
  - Known costs before anyone starts: MAP-Elites suffers a curse of dimensionality with regular
    grids, stagnates in unreachable regions of descriptor space, and is sample-inefficient with
    naive variation operators -- and sample cost is exactly this project's binding constraint at
    ~24ms per evaluation. It also would not be free of the determinism rules: the variation
    operator must not reintroduce randomness, which is why this needs designing rather than
    dropping in.
- **`boss` AND `bossTimeless` HAVE NEVER BEEN QUALITY-TESTED, because there is nothing to compare
  them against.** Of 182 fixtures, 168 are `loot` and 14 are `push`; two of the four modes the UI
  offers have no coverage at all. That is the worst place for a blind spot, since the boss objective
  is lexicographic over a kill rate that moves in visible steps -- exactly the threshold landscape
  where coordinate exchange was just measured failing on `loot`.
  `budget-monotonicity-check.js` covers it without fixtures: raising the budget cannot make the true
  optimum worse, so `optimize(budget + k)` scoring below `optimize(budget)` means the search failed
  on the larger problem. It works on any build in any mode. It deliberately does NOT assume the
  feasible sets are nested -- they are not, since every allocation must leave at most
  `MAX_IDLE_POINTS` idle -- and it prints both allocations rather than asserting a cause.
- **`underspend-test.js` is the gate that covers this, and NOTHING WAS RUNNING IT.** It was failing
  on 6 known builds, identically on clean HEAD, and appeared in no hand-picked bench list -- which
  is why `tools/bench/all.js` now exists. **It does NOT run everything, and believing it does is
  the same trap one level up** -- 63 of 137 bench files are named in it, and ~12 real gates are
  outside it (see the audit command in the Validation section). Its failure message says which
  KIND of failure it is: whether the import is even REACHABLE inside the level-derived budget. A
  share code does not encode level (it is inferred from spend), so an import can legitimately spend
  more than the optimizer is allowed to, and "beat the import" would then be asking it to beat an
  allocation it is forbidden to make. That is an inferred-level problem with a different fix, and
  conflating the two sends you looking for a search bug that is not there.
- **A BUILD SHARE CODE CARRIES ONLY `CODE_PARAMS`, AND COMPARING WITH ANYTHING ELSE IS NOT A
  COMPARISON.** The only transport to cifi-tools is a share code. Borge's carries relics r4, r16,
  r19 and t2r7 -- NOT r7, and not most inscryptions, trinkets or CMs. `compare_builds` applied the
  full override map to the CLONE and exported a code that silently dropped the rest, so a real
  level-49 Borge with `relics.r7: 15` reported the clone's materials as **98% too high** and
  flagged it as a clone bug. The site had simply evaluated r7 = 0.
  The tell was the returned `liveBuildCode` coming back BYTE-IDENTICAL to the no-override run's.
  `compare_builds` now names such keys in `notTransportedToLive` with a warning; `buildCode.js`
  exports `CODE_PARAMS` so the check reads the encoder's own table instead of a second copy.
  **What this means for validation: overrides outside CODE_PARAMS cannot be parity-tested this
  way at all** -- they have to be set by hand on the site's Overrides panel.
  **What IS confirmed, at the account's real levels rather than synthetic fixtures:** Borge 49 with
  real talents, attributes and base stats matches the live site on all 13 reported stats within
  0.37% with no overrides, and again within 0.37% with every override the code can carry
  (mat1PerRun 51,740,000 live vs 51,740,576 clone). The simulation is in parity; the earlier
  "discrepancy" was the harness.
  **Ozzy cannot be compared as a guest at all**: the live site gem-gates the Ozzy page, so a fresh
  guest session never renders it and the comparison times out waiting for "Main Statistics".
- **GADGETS ARE THE EASY CASE, AND THEY ARE CONFIRMED.** Each hunter exposes exactly one
  (Borge `wrench`, Ozzy `zaptron`, Knox `anchor`), every one is in that hunter's `CODE_PARAMS`, and
  every one has a real `params.json` slot -- so unlike relics they transport in a share code and can
  be compared against the live site directly.
  Verified at the account's real levels, each gadget isolated so nothing else could mask it:
  - **Borge wrench 50**: all 13 stats within **0.33%** of the site, nothing flagged, and clearly
    live (loot 46,340 -> 114,770 against the no-gadget baseline).
  - **Knox anchor 10**: all 13 stats within **1.17%** (min/maxStage are the noisy ones), nothing
    flagged.
  - **Ozzy zaptron 40**: cannot be compared against the site -- see the Ozzy gating note -- but is
    demonstrably live in the clone: 0 -> 40 moves loot 350,414 -> 730,665 (x2.08) and average stage
    +8.4, with materials doubling.
- **OZZY IS VALIDATED AGAINST THE LIVE SITE, and the block was one gem level.** The site gem-gates
  the Ozzy page, so a guest session never renders it and `compare_builds` timed out waiting for
  "Main Statistics". Setting **Exodus level 2** in the site's own `gemPlanner_store.gemStates`
  unlocks the page; `live-eval.mjs` can now seed that state per context, which is what made this
  reachable at all (each call opens a fresh browser context, so hand-setting it in one tab does not
  carry).
  Ozzy 55 with the account's real build then matches to displayed precision: loot 656.54k vs
  656,542.96, stage 178.5 vs 178.52, time 306m vs 306.04m, mat1 146.67m vs 146.673m, xp 37.36m vs
  37.359m.
- **THE SAVE IMPORTER PUT ATTRIBUTE LEVELS IN THE WRONG ATTRIBUTES -- 15 SLOTS ACROSS ALL THREE
  HUNTERS.** `HUNTER_ATTR_ORDER` mapped `PO?<n>Level` onto our ids positionally from a hand-built
  list, described in its own comment as "best-effort matched to HUNTER_DEFS order, then
  live-verified" by eyeballing caps and dependency chains. That caught Borge's two obvious
  reversals and quietly mis-assigned the rest: **Borge 2 wrong, Ozzy 8, Knox 5.**
  **A wrong positional mapping is SILENT** -- every value still lands in some attribute and the
  point total still looks plausible, which is why it survived every internal bench. It surfaced
  only by pushing the real save's Ozzy build through cifi-tools.com, which rejected it outright
  ("This Build is invalid. Please check the attributes.") and read the level as **86** with
  **256/258** attributes, because `POI12Level = 7` had been loaded into `sisters`, cap 1. POI12 is
  a Cost 2 / MaxLevel 20 slot; the 7 belongs to `scarab`.
  The order is now DERIVED from the game rather than matched by hand: each `PO?<n>` carries an
  authored Cost and MaxLevel and the dependency edges are recovered, so the index follows from
  (tree shape, cost, cap). After the fix the same build reads level **55, 55/55 talents, 165/165
  attributes** on the site with no warning -- identical to ours.
  `attr-save-order-check.js` derives the mapping and fails if the shipped list drifts;
  `--print` regenerates it.
- **GEM GATES ARE UI-ONLY. NO GATED CATEGORY IS GATED IN THE SIMULATOR, on the site or here.**
  Measured per category with `sim-gate-probe.mjs`, which sets one upgrade three ways -- off, on with
  no gems, on with the gate satisfied -- and reads the verdict off the site's own numbers. All five
  categories with a measurable effect (gadgets, tier-2 relics, shard milestones, researches, CMs)
  come back NOT GATED on both sides. Two more (`loopmods.roe`, `trinkets.last_handbook`) move
  nothing even unlocked, so they are reported INERT rather than counted as agreement.
- **A TIER-2 RELIC SIM GATE WAS BRIEFLY ADDED HERE ON STRONG-LOOKING EVIDENCE AND WAS WRONG. The
  way it went wrong is the reusable part.** Passing `relics.t2r7` through a BUILD CODE gives the
  site byte-identical output at 0, 5 and 40 -- three runs, no movement -- while this tool's numbers
  moved 70% (55.12m against the site's 16.54m at level 70). Setting Power gem 3 then made the two
  agree exactly, which read as confirmation of a Power-3 sim gate.
  It was not. Setting `t2r7 = 40` directly in the site's ACCOUNT state with Power gem **0** returns
  55.12m / stage 251.6 / mat1 3.74b -- identical to the Power-3 run. The site applies tier-2 relics
  at any gem level; what drops them is its IMPORT path, which does not bring gem-locked tier-2
  relics in from a pasted code, so its simulator never saw them.
  **"The site's output did not move" is a fact about the whole PIPELINE, not about the simulator.**
  Before concluding a gate exists, set the value through the ACCOUNT -- the path a real player uses
  -- rather than through an importer that may filter it. The same trap in a milder form is why
  `compare_builds` now reports `notTransportedToLive`.
- **`upgrades.loopmods.roe` WAS NOT INERT, AND "NO WASM ARGUMENT" IS NOT EVIDENCE THAT IT IS.**
  It has no slot in `params.json` for any hunter, and that alone had put it on
  `override-liveness-check`'s KNOWN_INERT list -- described there as inert in the ORIGINAL too. It
  is not. Measured against cifi-tools with the value set in its ACCOUNT state, XP per run goes
  **6,660,000 -> 49,220,000 at roe = 20000**: a factor of **7.3904** against the **7.3883** its own
  bundle declaration (`multiplicative, value 1.0001, "EXP Gained"`) predicts, a 0.03% match. Loot,
  stage and every material are untouched, and the result is identical with and without Temporal 4,
  so it is not gem-gated in the sim either.
  The site applies it OUTSIDE the evaluator, the same way it handles the diamondspecials
  multipliers. `hunterSimBrowser.js` now does too, via `POST_SIM_XP_MULTIPLIERS`.
  **This is the third time the same mistake has produced a false "inert" verdict**, and the pattern
  is always a measurement that cannot see the field in question: `relic-sweep.js` watched loot while
  r7 doubles MATERIALS; `sim-gate-probe.mjs`'s first signature was
  `lootScore|avgStage|mat1PerRun` while roe moves XP ONLY; and this list inferred "does nothing"
  from "owns no argument". Compare EVERY output before calling anything inert.
  `override-liveness-check` no longer takes a post-sim multiplier on trust: it evaluates with the
  value at 0 and at 20000 and requires the OUTPUT to move.
- **A modal that starts async work must cancel it on close, and `titledModal` fires `modal-close`
  so it can.** Closing used to just `remove()` the overlay, leaving the Effective Path walk
  running: invisible, uncancellable, and still competing for the main thread and for wasm
  instantiation, so every abandoned run made the next one slower. **This cost real debugging
  time** — a stack of abandoned runs made a 7.5s path look like it took ten minutes, and the
  slowdown was initially misdiagnosed as a regression in the walk itself. Reopening counts as
  closing (`titledModal` replaces a same-id overlay), and so does switching objective, so both
  abort the previous run. Cancellation is checked **per candidate, not per step** — a step is a
  whole candidate sweep, and step-only checking still burns 16 evaluations after the abort
  where per-candidate does 0. `path-abort-test.js` asserts on work done AFTER the abort for
  exactly that reason; it was verified to FAIL when the per-candidate check is removed.
- **An unknown hash route must normalise to `sim`, and `currentRoute()` is the only place that
  decides.** `render()` falls back to `renderSimPage()` for a route it does not recognise, but
  `renderSimPage` calls `switchHunter()`, whose "am I already on the sim page?" guard is
  `currentRoute() === 'sim'`. For an unknown route that guard was false while the sim page was
  being drawn anyway, so `switchHunter` called `render()` again -- **render -> sim page ->
  switchHunter -> render until the stack blew**. Any stale bookmark or mistyped hash hard-locked
  the app; `#/hunterstats` is what surfaced it. Pre-dated the boss-mode work (reproduced on an
  older commit before fixing). The fix normalises in `currentRoute()` so there is exactly one
  answer to "which route is this" -- do NOT instead add a second guard inside `switchHunter`,
  which is the same two-sources-of-truth bug wearing a different hat. `route-test.js` pins both
  directions: unknown routes normalise, AND every route `render()` dispatches on survives (a
  whitelist that is too aggressive would silently send real pages to the sim page).
- **Gear cost tier is a small enum, and the tier — not the base cost — picks the scalar.**
  `Gear.CostTier` is `Tier1..Tier6` (0..5), and every one of the 22 wiki-sourced pieces agrees
  exactly with `0→1.10, 1→1.11, 2→1.12, 3→1.13, 4→1.14`, with each piece's `costBase` equal to the
  game's own `BaseCost` (including the RedItem3 = 44 outlier, which is real). This **disproves the
  tempting `scalar = 1.1 + (base-3)*0.01` shortcut** — the Orange pieces all share base 4 while
  spanning tiers 0/3/4/1, so base cost does not determine the scalar and the coincidence only holds
  because the two happen to correlate over most of the table.
- **The White gear set is fully modelled and every field is sourced from the game** — installs from
  the `RU<Category><n>Bonus` dispatch (`gear-install-check.js` now verifies 54 mappings, was 44),
  `costBase 6` / `CostTier = Tier5 → 1.14` from the authored asset, and names and set bonuses as
  below. White sits behind **Gem Of Power quality 2**, per its own menu row name.
- **Gear piece NAMES and SET-BONUS RESOURCES are in the game, and finding them corrected three
  wiki names we had shipped for months.** Names live in the crafting menu at
  `AcademyCanvas/YourAcademyMenu/GearMenu/CraftingNewGearPiecePanel/ItemSelectionLayout/<row>/ReqBox/DescText`
  (`tools/reference/gear-names.json`, regenerate with `extract-gear-names.py`). The menu's **37
  rows** are exactly `Gear.GearIconImagePaths`' length: 22 ungated pieces at colour sizes
  **3/4/5/5/5** — our exact sizes in our exact order, 19 of 22 names matching character for
  character — then 15 gem-gated rows, five each for **White (Q2), Yellow (Q4) and Black (Q6)**.
  That block alignment is what pins a name to a piece. The three corrections: `Gamma Round` →
  **Gamma Rounds**, `Chrysis Suit` → **Crysis Suit**, `Cell Based Loop Tank` → **Cell Based
  Loop-Tank**. `GEAR_PIECE_RENAMES` migrates saved levels across the rename, since pieces are
  keyed by name.
- **AN EARLIER VERSION OF THIS FILE CLAIMED GEAR NAMES ARE NOT IN THE GAME AT ALL. That was wrong,
  and the three ways it went wrong are the reusable part.**
  1. **The names are stored UPPERCASE** ("MINING DRONE"). Every search used the wiki's title case,
     so `grep` returned a confident zero. One `grep -i` would have found them.
  2. **The single needle chosen first, "Cell Battery", is the one wiki name that is genuinely
     absent** (the game's row 12 label is CELL BATTERY, but the search was case-sensitive) — the
     worst possible probe, whose miss was then generalised to the whole table.
  3. **A raw `grep` over `level0` is not a search of the scene.** Parts are compressed, so strings
     plainly readable through UnityPy are invisible to grep. The "control" that seemed to validate
     the method (`grep Cradle` → 48 hits) only proved that *some* of the file is uncompressed.
     **Treat a grep miss on a Unity asset as "not proven", never as "not present".**
  Also note the labels contain NEWLINES ("FIELD\nHARD DRIVE"), so a printable-run scan splits them
  and picking the longest run yields half-names — "BATTERY", "GRAVITY", "HARD DRIVE". Parse Unity's
  length-prefixed string instead; `extract-gear-names.py` does.
- **Which RESOURCE a set bonus multiplies comes from `Gear.SetGearSetBonuses()`, and is NOT
  guessable from the text-refresh method.** That one aggregator walks the five totals
  (`TotalSetCellBonus`, `MP`, `Shard`, `RP`, `AP`) and multiplies each `<Color>SetBonus<N>` into
  one of them; `extract-gear-set-bonuses.py` parses it into `tools/reference/gear-set-bonus-map.json`
  together with the authored magnitudes, and `gear-name-check.js` asserts both (verified with a
  negative control). It reproduces all 22 wiki-sourced bonuses exactly, which is what licenses
  trusting it for White: **Cells x1e50 and x1e65, Academy Points x2.5, Shards x150, Mod Points x10.**
  **The trap:** `CheckWhiteSetBonusTexts()` refreshes the Cells, RP, Shards and AP labels, which
  reads exactly like the answer and is wrong — White touches **Mod Points and not Research
  Points**. That method is a stale UI refresher; the aggregator is the math. `OrangeSetBonus2`
  (3000) appears in neither total because it is a one-off **Diamonds** grant, not a multiplier —
  absence from the aggregator does not mean dead.
- **Yellow and Black are two more five-piece sets (Gem Of Power quality 4 and 6) that this build
  DISPLAYS but never APPLIES — so they cannot be modelled yet, and that is a finding, not a gap in
  our extraction.** Their names are in `gear-names.json` (rows 27-36) and their set-bonus values in
  `gear-set-bonus-map.json`'s `unusedBonuses`, so the data we can have, we have. What is missing is
  the only thing that would let the optimizer use them: an install target. Three independent checks,
  because "I could not find it" is not the same as "it is not there":
  1. `Gear.YellowItem1Bonus1`'s body is byte-for-byte the same shape as `WhiteItem1Bonus1`'s --
     `Pow(GearBaseBonus1, <Color>Item1Level)`, with the base confirmed as `Gear+0xA8` ->
     `GearBaseBonus1` (1.01) by `resolve-loads.py`. So these are implemented, not stubs, and all
     colours share the same x1.01 / x1.02 bases.
  2. Across the WHOLE decompiled assembly, the only consumers of `Gear.(Yellow|Black)Item<N>Bonus<M>`
     are `TextHandlerSpaceAcademy`'s label setters (`Yellow1Bonus1Text.text = "x" + ...`). No
     `RU<Category><n>Bonus` calls them, whereas White's getters are called from `FleetManager` ten
     times.
  3. `resolve-loads.py FleetManager` resolves 413 unnamed reads and **none** of them is a `Gear`
     field -- which is the check that matters, since the evolution-bonus miss proved a name-grep
     cannot see an unresolved field read.
  4. **Unresolved CALLS were the real hole in checks 2-3, and they are now closed too.** A gear
     getter is a call, and `resolve-loads.py` only names field reads -- so "no unresolved Gear
     field" said nothing about a call Cpp2IL could not resolve. FleetManager has 540 such notes,
     but only **8 distinct addresses**; resolving them through `dumpindex.py` gives runtime
     plumbing (`__Il2CppComDelegate$$Finalize`) or addresses that are not method starts at all.
     None is a gear getter. **When you conclude something is absent from a Cpp2IL body, account
     for BOTH note kinds** -- "Unmanaged memory load" (fields) and "Method not found" (calls).
  5. **The authored data agrees, via the exact mechanism the UI uses.** Each piece carries
     `<Color>Item<N>FleetIcon1/2`, the install-node indicators the gear screen shows. Populated
     counts: Purple 6/6, Orange 8/8, Red/Green/Blue/White 10/10 -- **54 in total, exactly the 54
     getters FleetManager calls** -- and **Yellow 0/10, Black 0/10, every reference a null
     `m_PathID: 0`**. The designers wired icons for precisely the colours whose bonuses are
     applied. (The icons resolve to a shared `GearBonusActive` indicator, so they mark THAT a
     piece buffs a node, not WHICH -- useful as presence evidence, not as a mapping.)
  Adding them would mean inventing install targets, which is precisely the failure this file exists
  to prevent. When a future build wires them, `extract-gear-installs.py` will start emitting Yellow
  and Black rows and `gear-install-check.js` will print SKIP lines for them -- that is the signal to
  add the sets.
  **CONFIRMED AGAINST A SECOND, NEWER BUILD.** The above was derived from 0.7.3.54; the live client
  was 0.7.3.61, so it was pulled (`tools/gamefiles/apk-0.7.3.61`) and every gear extraction re-run
  against it. **Everything is identical:** the same 37 menu names and gem gates, the same 26
  set-bonus -> resource mappings, and FleetManager still calls exactly **54** gear getters across
  the same six colours with **zero** Yellow or Black. The player also reports no Yellow or Black set
  in game, which agrees. So these are unreleased content in both builds, not a modelling gap.
  **The extractors are now build-switchable via `CIFI_APK`** (`csharp.py`, `extract-gear-names.py`,
  `extract-gear-installs.py`, `extract-gear-set-bonuses.py`), e.g.
  `CIFI_APK=apk-0.7.3.61 python tools/bench/extract-gear-installs.py`. Cpp2IL output is cached
  per-build so two versions cannot overwrite each other. **`typetree.py` and `dumpindex.py` honour
  it too**, now that the Il2CppDumper CLI has been rebuilt and run for 0.7.3.61 (29.7MB `dump.cs`,
  115 DummyDlls vs 113 for .54 -- see `tools/il2cpp-cli/README.md` for the build recipe; it takes
  about five seconds to compile). One variable switches DummyDlls, `dump.cs` and the scene
  together, which matters because mixing a newer scene with an older DummyDll misreads fields
  silently. `gear-set-bonus-map.json` still records `_mappingFrom` and `_valuesFrom` separately,
  and the label is derived from `typetree.py`'s own source, so it stays honest if the two halves
  ever come from different builds again.
- **EVERY authored-data reference re-extracted from 0.7.3.61 came back byte-identical to the 0.7.3.54
  version**: `authored-values.json` (244 values across 3 classes), `relic-caps.json` (20), the 54
  gear->install mappings, the 26 set-bonus mappings and their magnitudes, and all 37 gear names. The
  full reference bench suite passes against the regenerated files. That is a genuine cross-version
  check on the numbers this tool is built from, not a null result -- and it means a future "did this
  change?" question is now a two-command diff rather than an archaeology session.
  Keep the general rule regardless: **a conclusion about a specific build is not a conclusion about
  the game.** Comparing two builds is what turns "the game does not do this" into a claim you can
  actually support -- and re-pulling is cheap (`adb pull` the two APKs; MuMu's ADB is on port 16384
  once the instance is actually booted, which `MuMuManager.exe info -v 0` will tell you).
  **When reassembling `level0` from the APK's `level0.split*` parts, concatenate in NUMERIC order**
  -- a shell glob gives split0, split1, split10, split2 and silently produces a corrupt scene -- and
  extract `sharedassets0.assets` and `globalgamemanagers.assets` alongside it, or MonoScript
  references do not resolve and every `Text` component reads as an unknown type (which looks exactly
  like "the menu path changed").
- **`getGearSets()` reconciles the stored list against `REAL_GEAR_PIECES` by name; it used to
  return the stored list verbatim.** That meant the store, not the code, was authoritative for
  game-sourced data: **any piece added later never appeared for anyone who had ever opened the Ships
  page**, and a corrected install target or cost stayed frozen at whatever was saved. It had already
  been patched once for the narrow case (a costBase/costScalar backfill), which treated the symptom.
  Adding White exposed the general case — the five pieces were invisible while freshly-seeded
  defaults looked perfectly correct, so this fails *silently and only for real users*. The rule:
  `REAL_GEAR_PIECES` owns every game-sourced field, the store owns only `level`/`owned`. Same
  prune-and-merge shape as `getShipGear`; keep the two consistent.
  **The reconcile updates piece objects IN PLACE and must keep doing so.** Rebuilding the array
  each call detaches any reference a caller holds, so a `piece.level = n` written after some
  unrelated `getGearSets()` call lands on an orphan and vanishes. That is not hypothetical — the
  first test written against this function hit it, and read as a bug in the set-bonus math.
- **0.7.3.54 -> 0.7.3.61 build diff: the per-node install math is UNCHANGED, and the new late-game
  systems are inert.** This is the parity sweep to repeat after any future pull; all of it is now a
  couple of commands because every il2cpp tool honours `CIFI_APK`.
  - **All 83 `RU<Category><n>Bonus` getters have identical factor sets** — same named calls, same
    resolved field reads. The formula our optimizer models per node did not move, so no
    re-derivation is needed and no allocation can have shifted.
  - **`MK1Production` / `MK2Production` each gained `Badges.FinalBadge21Bonus` and lost
    `TraitSpheres.FinalTS17Bonus`.** Both are uniform across a ship's nodes, so neither can reorder
    the optimizer; they change absolute production, which this tool already does not claim to model
    (see the evolution note above). `CellProduction` is unchanged.
  - **New systems: Pulse Reactor / Void Upgrades, Space Academy Automation Center, Planet Missions.**
    Void Upgrades buff `Materials, MK1, MK2, MP, Shards` — squarely our territory — **but they are
    NOT live.** `Small_VoidUpgrades_Methods.SetBonuses(BonusType)` is a single `ret` at RVA
    0x25C222A, verified by disassembly rather than by trusting Cpp2IL's empty body; the cost
    formula, level array and UI all exist around it. None of `PulseReactor`, `VoidUpgrade` or
    `SpaceAcademyAutomationCenter` is referenced from `FleetManager` or `GeneratorManager` at all.
    **This is the thing to re-check on the next pull** — when `SetBonuses` stops being a `ret`, the
    fleet model gains a real gap, and `PulseReactor.smallMeltdownValues` suggests it will land near
    Meltdown, which we DO model.
  - Everything else that moved is a Unity IAP library upgrade and compiler state-machine
    renumbering — 995 "new types" of which ~420 are game-ish and almost all of those are billing.
    Filter that noise before reading a type diff, or the signal is unfindable.
  - `Gear.gearColor` enumerates only `purple, red, green, orange, blue` — no white despite White
    being fully wired, so that enum is partial/legacy and is NOT evidence about which sets exist.
- **The "our allocator is worse than SirRed's" gap was never the ALGORITHM — it was one invented
  constant in the objective.** Both are pure marginal-value greedy. Neutralising
  `RUN_LENGTH_BIAS.long` makes our allocator reproduce SirRed's greedy **exactly** at every tested
  budget (`sirred-algorithm-check.js`), and produce **identical plans** at every budget on real
  account data (`real-save-optimizer-check.js`). That exactness is the proof: a search defect would
  not vanish to zero difference, it would leave a residue.
  The old default was `{ cells: 0.7, gen: 1.35 }` — a **1.93x swing** toward generator nodes,
  described in its own comment as "a modest, clearly-flagged heuristic". It was not modest: it
  inverted the top of the ranking (Cradle node 1's raw log-gain 0.788 vs node 2's 0.470 became 0.552
  vs 0.635), so the default allocator systematically underfunded the single best node, costing
  13.6% / 14.5% / 35.7% / 17.5% at budgets 30 / 75 / 150 / 300.
  **`long` is now neutral `{1, 1}` and `short` stays the opt-in deviation.** Three reasons beyond
  the measurement:
  - The game gives exactly ONE structural reason to prefer generator nodes — the Meltdown exponent,
    because gen bonuses sit inside `Pow(MK1Production, m)` while Cells bonuses sit outside it — and
    `nodeMarginalLogGain` already applies that from the binary. A second invented preference
    double-counts a real effect with a fake number.
  - It contradicted a decision twenty lines below it in the same function, which refuses to invent a
    compounding multiplier for All-Gens nodes on "no invented constants" grounds ("undervaluing an
    All-Gens node is a smaller error than fabricating a factor of 8"). The long-run compounding
    argument is the SAME argument; it cannot be disqualifying there and load-bearing here.
  - Functional form: it multiplies a LOG gain, so a factor k ranks by `ratio^k` — it behaves as an
    exponent, not a value weight. Right for Meltdown (which IS an exponent), wrong for "I expect a
    long run", which is a statement about value.
  The tactic still does real work on realistic accounts (Cradle 150 points: node 1 goes 18 -> 26 on
  short), so this removed a silent default, not the feature.
- **`GROWTH_VALUE_BOOST` (1.5) IS REMOVED, and chasing it turned up a much worse bug.** It scaled
  nodes whose "per X" counter climbs during a run. Three findings, in increasing order of severity:
  - **Its classification was wrong in BOTH directions**, which is disqualifying for a multiplier —
    it was aimed at the wrong nodes, not merely imprecise. `missionsCompleted` was IN the growth set
    but imports from `MissionsCompletedAllTime` (7 of Zeus's 11 nodes boosted on a counter that
    barely moves in a run); `totalManualGens` was OUT of it but imports from `ManualGensThisLR`,
    which resets. The comment documenting these mappings was itself wrong, naming `ManualGensAllTime`
    and `NewSMOperationsAllTime` — neither is what `saveImport` reads.
  - **It could not fix the failure it appeared to address**: 1.5 x 0 is still 0.
  - **THE REAL BUG: a resetting counter reads 0 at the start of a run, and a node whose counter is 0
    scores EXACTLY zero — so it does not rank lower, it disappears from the plan.** Measured on
    Demeter at budget 150: counters zeroed gives `{1:5, 2:140, 8:5}` — 140 of 150 points in ONE node
    — against a spread over 10 nodes mid-run. This is a confidently wrong answer produced at exactly
    the moment a player is most likely to plan: just after a reset. `optimizeShipInstalls` now
    returns `warnings`, and the optimize modal shows the notice before you generate, naming the
    field to fix.
  The undervaluation of growth nodes is now explicit and deliberate rather than papered over with a
  guess. Restoring a multiplier needs a defensible number — derived from run dynamics or the
  counter's own growth rate — AND a correct classification.
  `growth-counter-check.js` covers all of it: classification parsed from `shipSchema.js`'s actual
  importer lines (so changing a mapping without revisiting the classification fails), a guard
  against reintroducing an invented multiplier, the zero-counter warning on all 5 growth ships, and
  a non-degenerate Demeter plan. Verified with a negative control.
- **The AOTC "max at 15" policy was WRONG, and the node was always scoreable.** Demeter slot 1
  ("Ahead of the Curve") does not multiply a resource -- it GRANTS operations, and operations are
  the counter 8 of Demeter's 11 nodes multiply by. The game says so plainly:
  `LoopModifiers.PerformLoop()` adds `FleetManager.RUShard1Bonus` into the run's operation count and
  stores it as `MasterManager.NewSMOpsFromAOTCThisRun`, and `RUShard1Bonus` is
  `RU1ShardBaseBonus(1.0) * FinalDemeterCrew * <gear/badge/research> * RU1ShardLevel` -- linear, one
  operation per crew member per level. So the old comment ("its payoff lands next loop, it can't be
  scored by the marginal-value engine") was mistaken about the mechanic, not just cautious.
  Measured against a brute-force optimum on the Demeter fixture, the binary rule was correct at
  budgets >= 15 and <= 6 but left **2.6% -> 47.5%** on the table across 7-14, where the true optimum
  ramps 1 -> 5 and a binary rule jumps 0 -> 5 at a single point.
  It is now **scored** (`aotcMarginalLogGain`) and, because the choice is COUPLED -- AOTC's value
  depends on how many operations-scaled nodes have levels, and theirs depends on the operations it
  grants -- all six levels are **enumerated** and the best-scoring plan wins. Both halves of the
  coupling matter: scoring AOTC alone still ran up to 24% behind until the ops-scaled nodes were
  also valued at the RAISED counter (`effectiveOpsFor`). With both, the allocator is **optimal at
  every tested budget**. `prepForLongRun` still forces the max, because that asserts a horizon the
  within-run objective genuinely cannot see.
  Consequences for the ship invariants: Demeter no longer takes a single greedy path, so
  `ship-test.js` exempts it from "greedy picks the single best node each step" and from prefix
  stability. Every other ship is still held to both exactly.
- **A node's weight is the SUM of the sliders it touches, not the strongest one.** This is the
  objective's own arithmetic -- maximising `prod(resource ^ weight)` means maximising
  `sum(weight * log(resource))`, so a node whose factor multiplies both Cells and Shards contributes
  to both. Five nodes are dual (`+X% A & B gained`: Koios 6, Zeus 4/5/6/7). The code took a `max`
  and the comment above it asserted that was intended; reverting to `max` costs **15-29% on Zeus**
  across budgets, so this is a measured fix, not a stylistic one.
- **Three bench bugs found while testing the above, each of which made a correct allocator look
  wrong.** They are the reusable part, because every one of them is a reference that quietly
  models a DIFFERENT objective than the thing under test:
  - `weightOf` returned `w || 1`, collapsing "no recognised bucket" (fallback 1) with "buckets the
    user set to zero" (genuinely 0). It valued Cells nodes at weight 1 in a Cells-off scenario and
    reported the tool as up to **99% worse** for correctly declining them. The silent-default trap
    this file bans elsewhere, in a bench.
  - The reference greedy SCORED with weights but PICKED without them, so it optimised the unweighted
    product. That made it too weak to detect a real weighting regression -- reverting the tool to
    `max` passed unnoticed until the reference's marginal carried the weight too.
  - `ship-test.js` duplicates the weight rule (nodeWeight is module-private) and was still on `max`
    after the tool moved to `sum`, reporting the allocator as wrong for preferring a dual-resource
    node. Known drift hazard, now flagged in place.
- **The hunter-side equivalent of the factor audit is `param-plumbing-check.js`: every sim parameter
  must be SETTABLE and must land in its OWN argument slot.** The fleet chain is the game's multiply
  chain; the hunter chain is the wasm's argument vector, 281 slots across the three hunters. Since
  `resolveParam` has a generic override path almost everything is settable, which is what makes the
  exceptions worth finding -- it flagged `exodus_gem3` (Ozzy) and `exodus_gem5` (Knox), whose
  branches ignored an explicit override entirely.
- **THE SITE IS CODE-SPLIT, AND `live-override-diff.js`'s "we additionally expose N" LINE WAS
  LYING.** It compares our upgrade tables against the live bundle's OVERRIDES panel table only.
  cifi-tools lazily loads several upgrade families as their own pages -- `assets/Trinkets-*.js`
  (`const $="trinkets"`, one card per trinket), `IAP-*.js` (`const U="iap"`), `Ultima-*.js`,
  `DiamondSpecials-*.js` -- whose keys are absent from that table while being fully present on the
  site. All six "extras" (`diamondspecials.hunterloot`, `iap.travpack`, `ultima.ulti` and the three
  trinkets) are in that category: **we are in parity, the controls just live on a different page.**
  The report now says so instead of listing them as extras. **A genuine extra would be a control the
  original offers NOWHERE, and there are none.**
  Read the chunk list before concluding the original lacks something: `grep -oE '"assets/[A-Za-z0-9_-]+\.js"'`
  over the main bundle prints every page it can load.
- **One real bug did come out of that detour: the three per-trinket overrides reached nothing.** The
  original's Trinkets page sets each trinket individually and they feed the summed
  `creation_galvTrinketsCount`; ours only summed `state.upgrades.trinkets`, so a value typed into
  our trinket control was silently discarded. Fixed, and `override-liveness-check.js` now asserts
  that every control the UI offers moves at least one wasm argument, with the 18 controls that are
  inert in the ORIGINAL too allow-listed by name.
- **THE HUNTER SIDE IS VALIDATED AGAINST THE LIVE cifi-tools BUNDLE, NOT THE APK, AND THAT
  DISTINCTION FOUND A REAL BUG THAT TWO ROUNDS OF INTERNAL REASONING MISSED.** The site was built
  with the game's devs, so for anything it models its bundle IS the verification -- fetch it from
  `cifi-tools.com/assets/index-*.js` (the filename is hashed; read it out of the served HTML).
  What the bundle settled, after our own reasoning had gone wrong twice:
  - Its gem-state map is `exodus: { nodes: { gem1..gem6, temporalEvolutionCount }, upgrades: {} }`,
    and the loop consuming it assigns `gems_nodes[gemN] = node ? 1 : 0`. So **`exodus_gem3` and
    `exodus_gem5` are 0/1 OWNED FLAGS**, exactly like `exodus_gem1`. Our resolver had special
    branches returning `sum(power)+sum(innovation)` and `sum(attraction)+sum(creation)` -- simply
    wrong, and wrong in a way no internal check could see.
  - **`exodus_powerInnovationCount` and `exodus_attractionCreationCount` are never derived at all.**
    They appear in neither half of that map and occur exactly ONCE each in the whole bundle (the
    parameter list), so the original tool treats them as plain override params defaulting to 0. We
    derived them from gem sums, which made our arguments differ from what the original would send
    for the same account.
  - Only `exodus_temporalEvolutionCount` is derived (gated on gem1, summing temporal+evolution),
    which our code already matched.
  **The lesson is about method, not gems.** Told two params "must" agree, I unified them and wrote a
  bench asserting it -- which would have frozen our own bug in as an expectation. The authoritative
  source said they were never related. When the original tool models something, read ITS code before
  reasoning about ours; `live-override-diff.js`, `gate-coverage.js`, `inscryption-cost-check.js` and
  `base-stat-cost-check.js` all take the bundle path for exactly this reason, and all four pass
  against a freshly fetched bundle.
- **`node-factor-check.js` is the general defence against another Badge12: EVERY term in every
  node's multiply chain must be accounted for by name.** `extract-node-factors.py` enumerates the
  whole chain per node -- named reads AND the operands inside Cpp2IL notes, resolved through
  `resolve-loads.py`, since the gem perks and installs researches are invisible to a name search --
  and the bench sorts each term into a bucket that says WHY it is safe: modelled (crew, gear, badge,
  Fleet Analysis 2), provably inert until bought (gem perks), or structurally part of the node (own
  level, authored coefficient, its counter). **A term matching no bucket FAILS.** Verified by
  injecting a fake `FinalSecretBoosterBonus`.
  It is scoped to the 7 modelled ships on purpose. Including Ouroboros WEAKENED it: its nodes read
  `RU83Level`, which the counter extractor had labelled a "counter", so an unmodelled term was waved
  through by a sibling reference instead of examined. **A bench that classifies things the tool does
  not model is not being thorough, it is laundering them.**
  Two results worth keeping from the first full run: `FinalShip7InstallsBonus` **does not exist** --
  no Academy node reads a per-ship installs research, which independently confirms
  `shipOrder: [1..6]` excluding Zeus -- and `Badge5` is read by exactly ONE Shard node, so it
  belongs to that node's own formula rather than being a ship multiplier.
- **EVERY data file is schema-enforced with zod, and zod is a DEV dependency only -- the shipped
  webapp still has no build step.** Two modules, split by where the data comes from:
  `reference-schemas.js` covers the 24 game-derived files under `tools/reference/`, and
  `app-schemas.js` covers the app's own data -- `params.json`, the persisted store, and the decoded
  save fixtures.
  The failure mode this prevents is specific and has happened repeatedly: an extractor changes
  shape, a consumer reads `undefined`, and the bench comparing it to the other side's `undefined`
  PASSES. A silently empty reference looks exactly like a clean run. Schemas are `.strict()`
  wherever the shape is fully known, so a NEW key fails too -- a new field usually means the
  extractor learned something no consumer has been taught to read.
  **The registry is completeness-checked against the DIRECTORY, not against itself.** Iterating the
  schema list can only validate files someone remembered to declare, so a reference added later is
  exactly as unprotected as one with no test at all -- and invisible. `reference-schema-test.js`
  now reads `tools/reference/` and FAILS on any `.json` with no schema.
  **The store schema is hand-written, because `StoreSchema.SCHEMA` declares factories rather than
  types -- so it is a duplicated rule, the kind this repo has watched drift before.** The guard is
  a key-set comparison between the two, which fails both ways: a field added to `SCHEMA` with no
  zod entry, and a zod entry for a field `SCHEMA` does not declare.
  **Shape and invariants are different checks and both are needed.** `validateStore()` checks
  RELATIONSHIPS ("an inferred level must be able to fund the allocation it was inferred from");
  the zod schema checks SHAPE (`gems.<tree>.nodes` is six booleans). Shape drift is the one that
  produces a silent `undefined` at a read site instead of a thrown error -- and `isUpgradeUnlocked`
  indexes `nodes[gate.node - 1]`, so a short array silently locks an upgrade the account owns.
  **The store is validated in three states, not just fresh.** A shape can be right when it is
  created and wrong once it has been used, so the bench checks `freshStore()`, a store carrying a
  build and gem state, and a store after a REAL save import -- which is where a mistake in
  `mapSaveToStore` would actually surface. The real-save case SKIPS rather than fabricating a save
  when none has been pulled; a synthetic one would only re-test the factory. (`harness.js` now
  loads `saveImport.js` so the hunter-side importer is reachable from a bench at all.)
  **Where a schema is loose, it says why.** Several payloads are genuinely heterogeneous -- loop
  mods declare v2/v3 tiers only sometimes, `scene-defs` families each have their own field set,
  `gem-trees` upgrade rows carry `weight` as a string, a number OR an empty object depending on the
  upgrade kind. Pinning a union of every observed shape would fail the moment the game adds a field,
  which is the change a reference should absorb rather than reject. So the envelope is strict, the
  collections must be non-empty, and the leaf VALUE types are pinned -- which is what a drifted read
  actually breaks.
  Two values that look like defects and are not: `authored-values.FleetManager.EvoBonusHephaestus5`
  stays an unflattened `{mantissa, exponent}` because 1e500 overflows a JS double, and a `null` cost
  on a gem quality level or node means declared-but-unreleased. Neither may be coerced -- a null
  cost turned into 0 reads as "free", which is the silent-zero trap this file bans elsewhere.
  **All of it is verified with negative controls**, because a schema that cannot fail is
  decoration: empty payload, wrong type, unexpected key, a short gem-nodes array, a duplicate wasm
  parameter name, a hunter stat arriving as a string, a gear piece persisted without its name, a
  negative fragment balance, an undeclared store field, and an unschemaed file appearing in
  `tools/reference/`.
- **A THIRD fleet badge was missing entirely: `Badge12` ("Innovation Badge #2"), x222 on Demeter,
  Koios and Zeus.** The tool modelled `Badge2` (x7) and `DarkBadge1` (x3) and stopped there. The
  game reads `FinalBadge2Bonus` in every Gen/Tech/Loop/Auto node and `FinalBadge12Bonus` in every
  Shard/Research/Academy node -- the two badges partition the seven ships, so the three the
  Innovation Badge does not cover had their totals understated by 222x for anyone who owned it.
  Every part is game-sourced: the ship mapping from the `RU<Cat><n>Bonus` bodies, the values from
  the authored `Badges` MonoBehaviour (`Badge2Bonus` 7, `Badge12Bonus1` 222, `DarkBadge1Bonus` 3 --
  the first and last confirming what we already shipped), and the NAME from the badge inventory,
  where `AcademyMilestone<N>` is `Badge<N>`: milestone 2 reads "INNOVATION BADGE" (matching our
  existing label) and milestone 12 "INNOVATION BADGE #2".
  **Why nothing caught it, which is the reusable part:** a badge is a per-SHIP uniform multiplier,
  so it cannot reorder an allocation, and the batch optimizer takes per-ship budgets from the user
  rather than splitting one budget across ships. Every allocator bench is therefore blind to it by
  construction. `badge-check.js` closes that: it derives each badge's ships and multiplier by
  probing `computeFleetBadgeMultipliers` one badge at a time (behaviour, not declaration) and
  compares against `badge-map.json`. It fails both ways -- a badge the game applies that we omit,
  and a badge we apply to a ship the game does not. Verified with two negative controls.
  `Badge5` is deliberately excluded from that map: only ONE Shard node reads it, so it belongs to
  that node's own formula rather than being a per-ship multiplier, and counting it would overstate
  the whole ship.
- **`allocator-check.js` is now the primary allocator gate: all 7 ships, 5 budgets, 35 combinations,
  scored against the GAME's authored coefficients rather than SirRed's tool.** The two SirRed
  benches remain but are Cradle-only — which is precisely why the growth-counter collapse went
  unnoticed — so read them as a community cross-check, not as coverage.
  Three things this bench had to get right, each of which it got WRONG first and each of which is a
  reusable lesson about scoring an allocator against a reference:
  - **Not every authored coefficient is a resource multiplier.** Demeter 1's number is a COUNT of
    operations, not a percentage, and feeding it into a product objective made it look like the best
    node on the ship — reporting our allocator as 96.87% behind for correctly declining it. The
    filter is the same one `node-coefficient-check.js` uses: no `%` in the effect text, not
    comparable.
  - **A deliberate POLICY must be held constant on both sides.** Demeter 1 is maxed outright once
    the budget is >= 15 because its payoff lands at the start of the NEXT loop reset, which no
    within-run objective can score. A reference that only knows the within-run product always
    declines it, charging us ~5 points and reporting a 7-21% "loss" that is a modelling decision,
    not a worse search. Whether that policy is CORRECT is a separate question this bench does not
    answer.
  - **Even focus weights only.** With uneven weights our objective stops being the flat product, and
    a reference would have to replicate our weighting rule to stay comparable — at which point it
    tests the model against itself. Uneven-weight behaviour remains uncovered, deliberately.
  Negative control: restoring the old `RUN_LENGTH_BIAS.long` makes it fail on Cradle with exactly
  the historical 13.59 / 14.50 / 35.70 / 17.53 percentages **and** on Auxesia, which the Cradle-only
  benches could never have seen.
- **EVERY ship install node is now GAME-VERIFIED on every machine-checkable field, and all 77 are
  marked `source: 'game'`.** The marker used to be `'confirmed'` (save-diffed) vs `'wiki'`, with 31
  nodes still on the wiki. Four benches now cover every node:
  `node-name-check.js` (fleet tooltip titles), `node-coefficient-check.js` (authored
  `baseBonusByCategory`), `node-counter-check.js` (the counter each getter reads) and
  `ship-node-gate-check.js` (requirement + base cap). The effect PROSE is transcribed word-for-word
  from each node's own in-game tooltip; descriptions are populated at runtime so the scene does not
  carry them, but reading the string off the screen and reading it out of an asset are the same
  claim about the same string, and its two machine-readable parts (the percentage and the counter)
  are checked against the code on top of that. The UI still flags anything not marked `'game'`, so
  a node added later cannot inherit that trust.
- **`node-effect-probe.js` proves every node actually MOVES the output — verified is not the same as
  live.** A node can have the right name, coefficient, gate, cap and counter and still be inert if
  its effect string does not parse or its resource tag routes nowhere. This is the fleet-side
  equivalent of `relic-arg-probe.js`, which on the hunter side found four relics that reach the
  evaluator and change nothing. All 77 move the output; a negative control (removing one `%`) fails
  it. Nodes with no percentage are AMPLIFIERS and are probed in combination: Demeter's Ahead Of The
  Curve grants the operations its neighbours scale with, so alone it would always read inert.
  Writing that probe exposed a real gap -- the optimizer priced AOTC's operations grant while
  `computeResourceBonuses` ignored it, so the Fleet page's displayed totals disagreed with the
  allocator. `nodeOwnBonusPct` now takes the whole allocation so both see the same coupling.
- **Node names live at `UpgradePanel-<Ship>/Tooltips/Tooltip<N>/Title`, and N is the ruId, NOT the
  install code.** Indexing by our slot reports 15 false mismatches -- every ship whose code->ruId
  mapping is not the identity. The key is proven, not assumed: Cradle's ruIds 9/10/11 carry three
  distinct authored coefficients, which pins each node independently of any name, and the titles
  agree with that pinning. Keyed correctly, 74 of 77 matched immediately; the three that did not
  were real:
  - Hephaestus 9 was `Factory Maintaining Drone`; the game says **Factory Maintainer Drone**.
  - **Zeus slots 10 and 11 carried each other's ruId.** Their ruIds (9 and 10) share a coefficient,
    a gate, a cap AND a counter, so no numeric bench can tell them apart -- the name mapping is the
    only evidence, and it is the game's own. The swap is numerically inert by construction; it was
    made so the catalog agrees with the game rather than leaving a known-wrong pairing in place.
- **The node COUNTER (`gearKey`) is extracted by ELIMINATION, and a keyword scan is not good
  enough.** `extract-node-counters.py` takes every member a `RU<Cat><n>Bonus` getter reads and
  removes the structural terms (own level, authored base bonus, crew, gear, badges, research/gem
  multipliers); whatever is left is the counter. Three traps, all of which produced confident wrong
  answers first:
  - A keyword list MISSES counters, and a miss looks exactly like "this node is flat".
    `LMAssist.LoopModLevelsCount` was missed because the list had "Mods" and not "Mod", making five
    Zagreus nodes look like catalog errors.
  - Operands hide in BOTH Cpp2IL note kinds. Koios 3's counter is inside a "Not implemented
    instruction" (`cvtsi2ss xmm0, dword ptr [rax+1B68h]` -> `FullyCompletedResearches`), not an
    "Unmanaged memory load", so parsing only the latter hid it -- and the body reads
    `0f * RU3ResearchBaseBonus`, which is the "a multiply by zero is a MISSING OPERAND" rule again.
  - A bare `dword ptr [reg+OFFSET]` does not say which object `reg` is, and resolving against the
    wrong type returns a real-looking field name rather than an error. Taking every dword read
    invented ten counters (`CellGeneratorsMK8`, `MK5FirstUnlockStat`, ...). **The conversion opcode
    disambiguates it:** a counter is an int (`cvtsi2ss`), while a node's authored base bonus is
    already a float (`cvtss2sd`). All 77 counters match once that filter is applied.
- **EVERY ship install prereq and base cap is now checked against the GAME, and four were wrong.**
  The game authors both per node: `RU<n><Category>Requirement` and `RU<n><Category>MaxLevel` on
  FleetManager. The semantics are stated by its own buy method rather than inferred --
  `BuyRU4Gen()` is `if (TotalInstallsCradle >= RU4GenRequirement) { cap =
  RL.FinalShipRanksMaxLevelBonus * RU4GenMaxLevel; if (MM.RU4GenLevel < cap && Ship1RankPoints > 0)
  ... }`. So `gateAtTotalInstalls` is installs spent on THAT ship, a requirement of 0 means open
  from the start, and `max` is the BASE cap that `nodeMaxLevel()` multiplies. Extract with
  `extract-ship-node-gates.py`, assert with `ship-node-gate-check.js` (77 nodes).
  The four corrections:
  - **Demeter 2 and 3 are OPEN FROM THE START.** A `gateAtTotalInstalls: 1` had been added to both
    from SirRed's tool; the game says `RU2ShardRequirement = RU3ShardRequirement = 0`, which is what
    this catalog said before that change. **That is the second time changing our data to match
    SirRed's tool introduced a wrong value** (the first was the 10x Demeter coefficients). Treat it
    as a prompt to go look at the authored data, never as the answer.
  - **Auxesia 6 and 7 cap at 15, not the wiki's 20.** Worth knowing why this survived: the catalog's
    `source: 'confirmed'` marker covers name/effect/GATE — it has never covered `max`, which was
    always wiki-transcribed. A "confirmed" node can still carry an unverified cap.
  This also **retires a long-standing to-do**: caps for the six non-Cradle ships had been flagged as
  never independently checked, and nodes 8-11 in particular. All 77 now match the game. And it
  **independently confirms the Cradle ruId swap** — the game caps RU9Gen at 40 and RU11Gen at 50,
  matching our codes 11 and 9 respectively.
- **`sirred-ship-check.js` is now a REPORT, not a gate.** It exits 0 even with divergences, because
  `ship-node-gate-check.js` checks the same two fields against the game itself; failing the SirRed
  comparison would mean failing for being right. It still earns its place — a divergence the
  authored data does NOT explain is a real signal — but the tool is a baseline, not an authority.
- **The AssetRipper scene export is SCRIPTED and build-aware: `tools/bench/export-scene.py`.** It
  restages `<...>_Data` straight out of `base.apk` for `CIFI_APK`, drives AssetRipper's headless web
  API, and reports the exported scene. Three things in it are load-bearing and each fails by
  producing a plausible-looking EMPTY export rather than an error: the staged folder must be named
  `*_Data` (that is what makes AssetRipper see a Unity build at all), the export must be
  `/Export/UnityProject` and not `/Export/PrimaryContent` (`level0` is a scene, and scene contents
  never appear in primary content), and `level0.split*` must be concatenated in NUMERIC order. The
  DummyDlls must come from the same build as the assets. AssetRipper itself is not vendored --
  drop the 1.3.14 win_x64 build in `<scratch>/assetripper/`.
- **Re-extracted from 0.7.3.61, the HUNTER side has not changed at all.** `scene-defs.json` now
  holds **18** families (an earlier count of 17 missed `VexinSkill`). Value diffs against 0.7.3.54:
  **zero** across `BorgeSkill`, `OzzySkill`, `KnoxSkill`, `VexinSkill`, `POM`, `POI`, `POK` and
  `Relic` -- every talent cap, attribute cost and cap, and all 20 relic start costs are identical,
  and `scene-defs-test.js` still passes against the new export. Nothing in the update touches
  hunter math.
  What DID change is endgame fleet content: **7 new badges (17-23)** and **5 new research units
  (RU111-115)**, all with astronomical values -- `Badge21` is `Bonus1 = 5e400`, and RU111-115 start
  at 1e10000 through 1e12600. `Badge21` is exactly the new `MK1Production` factor found in the code
  diff, so the two views agree. **One existing value was NERFED 10x: `RU91` Bonus5 0.01 -> 0.001 and
  Bonus6 0.012 -> 0.0012.** We do not model RU91 (our ship coefficients come from FleetManager's own
  `baseBonusByCategory`, a different numbering), and none of RU68/RU78/RU83/RU96 -- the ones we do
  reference -- changed.
- **`VexinSkill` is a FOURTH hunter in the scene, and it is empty: all 9 entries are
  `Level 0, MaxLevel 0`, in both builds.** Borge/Ozzy/Knox by contrast carry real caps and bonuses.
  So not modelling Vexin is correct, not an omission -- there is nothing authored to model. Do not
  "discover" this later and treat it as a gap.
- **`resolve-loads.py` offsets MUST come from the same build as the `dump.cs` they resolve against,
  and getting it wrong produces confident nonsense rather than an error.** Resolving 0.7.3.61
  offsets against 0.7.3.54's dump returned `ExpansionNextBonusText` where a bonus belonged and
  "+96 into" a 16-byte BigDouble field. The tell is a non-zero, non-8 "into it" value: BigDouble
  reads land at +0 or +8, so anything else means the field table does not match the body. It honours
  `CIFI_APK` now, but the hazard survives any tool that reads offsets from one place and names from
  another.
- **Legality is a state predicate, not a path predicate.** A node at level > 0 is legal iff it's
  within `maxLevel`, every dependency parent is > 0, and any `minValue` tier threshold is met by
  points spent in strictly-lower-threshold nodes. Order of purchase never matters. This is what
  makes exhaustive support enumeration valid.

---

## How the optimizer works

**THE STAGED-FILTER SEARCH IS GONE. It is now a quality-diversity archive (MAP-Elites).** If you
are reading a comment or a note that mentions a survey tier, a rung schedule, `SURVEY_SUPPORTS`,
or a cross-seed pass as live machinery, it is describing the old design.

The old pipeline enumerated supports, screened them at a canonical fill, tuned a few and refined
fewer -- and **every stage cut candidates permanently on a 100-iteration proxy**. That single
decision failed four ways: a level-62 Ozzy's best support screened 147th of 234 and was never
tuned; a 0.32% ridge ranks BACKWARDS by 1.7% at screening fidelity; boss capability is invisible
to screening because refinement is what CREATES it; and borge@54 came back 88% short at a level
that was never in the test set. Each patch fitted to one of those broke another hunter.

1. **Enumerate** every dependency-closed, affordable support set (unchanged, exact, cheap).
2. **Screen** each at a canonical fill -- now only to SEED the archive, not to cut anything.
3. **Illuminate**: vary from the archive under a seeded PRNG, keeping the best build PER BEHAVIOUR
   CELL. Cells are (boss-kill band, maxStage/5, concentration band). Nothing is ever discarded for
   scoring badly, so a build that farms poorly but has begun to engage a boss survives as a
   stepping stone.
4. **Refine** the strongest elites, stratified across kill bands so the archive's diversity is not
   thrown away at the selection step.
5. **Decide** among finalists at full fidelity, then polish the winner.

The objective is UNCHANGED -- `MODES.loot.score` is still exactly `lootPerMin`. Boss progress is a
DESCRIPTOR, never a target. That is what lets one search find boss-crossing builds without a
second objective, and it is why the cross-seed pass could be deleted rather than replaced.

**Determinism is preserved.** The ban is on `Math.random`, not on sampling: a fixed seed and a
fixed traversal order give identical output for identical input.

### Validated invariants of the new search

- **Variation must be DAG-NATIVE; point transfers cannot navigate a threshold tree.** From the
  same 4800 variations the archive filled **571 cells for Borge and 50 for Ozzy**. `Space.transfer`
  legalises by ZEROING stranded descendants, so a random transfer out of a structured build either
  fails or demolishes it and the child returns indistinguishable from its parent. Adding structural
  resampling (adopt an enumerated support, fill it with `gatePayingFill`) took ozzy@62 from
  **-66.27% to +15.34%** -- above the best build ANY previous method found, cross-seed included.
- **Stranding is caused by DEPENDENCY EDGES, not tier thresholds.** Knox has zero thresholds and
  strands MORE (6.6%) than Ozzy (4.8%). Thresholds amplify it; they are not the cause.
- **THE SEARCH VARIES ~7 PERCENTAGE POINTS ACROSS SEEDS, AND THIS IS THE MOST IMPORTANT THING TO
  KNOW BEFORE TRUSTING ANY COMPARISON.** It is deterministic -- one seed, one answer -- but that is
  ONE SAMPLE. Adding a single `rng()` call shifted the stream and the IDENTICAL configuration
  returned +15.34% and +8.24%. **Any single-run A/B narrower than ~7 points is noise.** Several of
  this file's own earlier conclusions were drawn that way before it was noticed; the tell had
  already appeared and been explained away (cell counts going 82 -> 94 -> 83 as a share rose
  monotonically are not measuring the share).
- **A flag that is off must be inert IN THE RANDOM STREAM.** A draw taken for a check that can
  never pass still shifts every later draw. That, and nothing else, was the +15.34%/+8.24% gap.
- **Use `effort.archiveOnly` to compare move sets. Full fidelity is for the winner only.**
  Refinement and polish are ~90% of wall clock and are identical across variation operators, so
  running the whole pipeline to compare two of them measures mostly the part that did not change:
  24s against 131s.
- **THINGS MEASURED AND REJECTED. Do not retry these without reading the numbers.**
  - *A boss-directed emitter* (draw parents from the elites nearest a kill). Made coverage WORSE
    on ozzy@62 (2 kill bands -> 1) and reached kill 0 across 4800 variations. When every elite has
    kill 0 and full boss HP, "nearest a kill" is not an ordering -- biasing parent selection cannot
    create a gradient the population does not contain.
  - *Replacing flat transfers with DAG-native depth moves.* Four seeds per arm, archive-only:
    ds 0.0 -> 81.8 cells / 9.384M; ds 0.3 -> 87.8 / 9.271M; ds 0.6 -> 92.5 / 9.170M; ds 1.0 ->
    84.7 / 9.015M. Coverage rises and survives averaging; champion quality does not, and the fully
    DAG-native arm is the WORST. `depthMove` is kept (proven non-stranding, 81.7% acceptance
    against 28%) but ships OFF. The hypothesis that flat transfers become harmful once structure is
    right is NOT supported.
  - *Merging several seeds into one archive* to kill the variance. At constant budget it is worse
    than two of three single streams and has the FEWEST cells: splitting 2400 variations three ways
    gives each 800 and none explores deep enough. It also destroyed the best boss reach measured
    (seed a5a5 alone hit 3 kill bands / kill 7). **Per-stream depth beats stream diversity**, and
    the variance costs 3x the archive budget to remove, not a redistribution of it.
- **Structure is verified against the GAME, so a search failure is not a data failure.**
  `attribute-tree-check.js` confirms every dependency edge and all 6 spend thresholds per hunter
  (Knox: 0), with 41 authored cost/cap pairs corroborating the mapping; `param-plumbing-check.js`
  confirms all 281 sim parameters land in their own slot; `wasm-arity-check.js` confirms 101/89/91
  arguments are all named. The DAG the move algebra reasons about is the game's own.

- **THE BOSS CLIFF ON borge@73 WAS A RESCALING BUG, NOT A SEARCH PROBLEM, AND SIX MECHANISMS WERE
  BUILT TO CROSS A BARRIER THAT ONLY EXISTED BECAUSE THE GOOD STARTING POINT HAD BEEN DISCARDED.**
  borge@73 sat at **-39.44%** through FI-MAP-Elites, bet-and-run, OCBA, a boss-damage descriptor
  axis, cross-seeding and corpus donors. It now returns **+2.37%**, killing the stage-300 boss more
  often than the reference build (32.4 against 31.7), deterministically, in 110 seconds.
  **The mechanic, as the project owner described it and as the game implements it:** nodes are
  filled to reach the UNLOCK THRESHOLD of a better node, and the allocation has to be reassessed at
  each of those stages. Borge's `atlas`/`weak`/`battle` need 75 COST-WEIGHTED points in
  strictly-lower-threshold nodes; `mino`/`hermes` 150; `athena` 180. Ozzy has 90/150/180. Knox has
  none -- which is the control: the fix leaves every Knox number untouched, as it must.
  **What was wrong.** Re-fitting a donor build to a different budget absorbed the whole difference
  into the donor's SINGLE LARGEST node. For a gated build that strips the sub-threshold points
  paying its gates, so `borge@74` -- the one donor at the right level with the right structure --
  came out ILLEGAL and was dropped. The pool then topped out at -39.27% with NOTHING killing a boss,
  and every search started outside the `kills-boss` regime.
  **Three of my own errors compounded to hide it**, and each is worth knowing separately:
  - `Space.isLegal` was called with `alloc`/`budget` SWAPPED, so it returned `true` for every input
    and the illegality was invisible. It now throws on a malformed call (`guard-liveness-check`).
  - A 250-iteration donor screen DISCARDED borge@74 even when legal. A cheap ruler that discards is
    deciding, and screening ~80 donors costs ~80 evaluations against ~1500 for the climb -- the SAIL
    lesson (do not optimise the cheap stage) repeated four hours after reading it.
  - `refitTiered`'s first version PROPORTIONALLY REBUILT the donor and lost `athena`: cost 15, donor
    value 1, so it sat at the back of a greedy refill queue and the budget ran out before reaching
    it. athena at 1 is worth kill 7.4 / 2.96B against kill 0.0 / 0.99B. **Preserve the donor's
    structure and TRIM to fit; never rebuild it** -- expensive low-count nodes are where the gates
    and the kills live.
  **THE BARRIER PROBE MEASURED FROM THE WRONG STARTING POINT AND I ACTED ON IT.** From the best
  NON-killing refit, reaching the import needs 82 coordinated moves through a valley 67% deep, and
  I concluded no local search could ever cross it. From a KILLING start the same climb closes
  -19.69% -> +2.37% in 1,554 evaluations. **A barrier is a property of the PAIR of endpoints, not of
  the build.** Local search was never the problem.
  `refit.js` owns both strategies so they can be compared rather than swapped on faith;
  `refit-check.js` gates the tiered one on legality, best score, and NOT LOSING FULLY-SPENT
  BOSS-KILLERS -- a criterion added after the first version passed on legality and loot while
  quietly destroying every killer.

- **ABLATED: WHAT ACTUALLY EARNS ITS KEEP.** `ablation-check.js`, each component removed in turn,
  judged at 1000 iterations against the community build, on the two hardest fixtures:

  | arm | borge@73 | knox@30 | verdict |
  |---|---|---|---|
  | full (donors + tiered refit + chunked VND, top3) | +2.37% / 2254 evals | +1.33% / 1879 | baseline |
  | **top1** | **+2.37% / 780 evals** | **+1.33% / 751** | **identical answer, 1/3 the cost -- top3 is WASTE** |
  | naive refit | +1.60% / 3009 | +1.33% | tiered is worth +0.77% AND 25% fewer evals on a gated hunter |
  | single-point moves only | -14.11% | +1.33% | chunked moves worth 16.5 points on Borge, nothing on Knox |
  | no climb (donors only) | -19.69% | -64.28% | the climb is essential |
  | flat start (no corpus) | -42.90%, kill 0.0 | -84.13%, kill 0.0 | **the corpus is essential** |

  The `flat start` arm is essentially what the shipped archive does, and it fails both builds
  without ever reaching a boss kill. Everything else in `search.js` -- the MAP-Elites archive,
  behaviour descriptors, curiosity selection, structural resampling, FI, bet-and-run, OCBA, damage
  bands, seed lists -- is measured UNNECESSARY on these builds.
  **The whole method is four steps**: best corpus donor -> gate-paying refit -> chunked ordered VND
  -> stop. 780 evals / 59s on the hardest Borge, 751 / 33s on Knox.
- **AND IT DOES NOT GENERALISE BEYOND A NEAR NEIGHBOUR -- MEASURED, and this is the binding
  limitation.** Excluding donors within 5 levels (`--band=5`):

  | build | band=0 | band=5 |
  |---|---|---|
  | borge@73 | +2.37% (kills boss) | **-41.09%** (kill 0.0) |
  | knox@30 | +1.33% (kills boss) | **-84.13%** (kill 0.0, exactly the shipped optimizer's number) |

  So this INTERPOLATES between adjacent community builds; it does not optimise. It has nothing to
  offer any level the corpus does not cover with a close neighbour -- every Knox above 40, the
  eight-level Ozzy gap at 34-42, and any account past the corpus ceiling.
  The mechanism is the same one measured everywhere else: at band=0 the climb STARTS from a
  boss-killing donor and finishes the job; at band=5 it starts outside the kills-boss regime and
  cannot cross. **The corpus is not magic -- it is a source of starting points that already pay the
  tier gates.** The open problem is therefore CONSTRUCTING a gate-paying killing structure rather
  than copying one, which is a far better-posed question than "which metaheuristic next".
  **CAVEAT ADDED 2026-09-06: THE band=5 NUMBER IS PARTLY A BUDGET ARTIFACT, NOT PURELY A
  CAPABILITY LIMIT.** Re-measured on borge@73 with the diagnostics printing: `-45.10%, 2176 evals,
  TRUNCATED at 2000, NOT converged`, with all 7 gains in N1, `lastImprove@2175` and a ONE-EVALUATION
  tail. The climb was still improving when the cap cut it off and never reached N2 or N8 at all --
  so "cannot cross" is not established by this run; "ran out of budget mid-ascent" fits it equally
  well. `maxevals` was sized (2000) from band=0 runs that converge in 381-781, and a far donor is a
  much longer climb. Re-run band=5 with a large cap before concluding anything about capability.

- **`maxevals: 2000` WAS OVERFIT TO FIVE BUILDS AND BINDS ON REAL ONES. The TRUNCATED flag tells
  you which shortfalls are budget and which are real -- use it before diagnosing anything.**
  The trim from 12000 was justified by five builds converging in 381-781 evaluations, recorded as
  "~2.5x the worst observed". Across all 195 fixtures the cap fires on 7 Borge builds, and
  re-running the shortfalls with it effectively removed splits them cleanly:

  | build | capped | uncapped | evals needed | verdict |
  |---|---|---|---|---|
  | borge@31 | -12.61% | **-0.33%** | 2880 | BUDGET |
  | ozzy@42 | -1.68% | **0.00%** | 3155 | BUDGET |
  | borge@35 | -2.89% | -2.89% | 750 | genuine (converged) |
  | borge@44 | -2.31% | -2.31% | 715 | genuine |
  | ozzy@11 | -2.02% | -2.02% | 281 | genuine |
  | ozzy@55 | -2.00% | -2.00% | 951 | genuine |
  | ozzy@46 | -1.44% | -1.44% | 1210 | genuine |
  | ozzy@51 | -1.37% | -1.37% | 1313 | genuine |
  | borge@45b | -1.22% | -1.22% | 948 | genuine |

  **Among the SHORTFALLS, exactly the TRUNCATED ones were budget; every converged one was unchanged
  to the decimal.** So for a build that came up short, the flag says which pile it is in without a
  re-run. The worst build in the whole sweep (-12.61%) was a cap, not a defect.
  **BUT THE FLAG IS NECESSARY, NOT SUFFICIENT, AND AN EARLIER VERSION OF THIS ENTRY OVERCLAIMED IT.**
  7 Borge builds truncated and only 2 of them came up short -- the other 5 hit the cap and still met
  or beat their reference. Truncation therefore does NOT predict a shortfall; it only classifies one
  that has already happened. Raising the cap is still right (it costs up to 12.3 points when it does
  bite), but do not read the truncation count as a count of damaged builds.
  **The general lesson, which this file has now recorded three times about three different dials:
  a budget sized from a five-build sample is a sample statistic, not a bound.** The same five builds
  also justified the neighborhood trim, which is therefore owed the same scepticism.

- **EVERY ELITE-SET METHOD IS INERT AFTER THE CLIMB CONVERGES, FOR ONE REASON: BY THEN OUR BUILD IS
  BETTER THAN EVERY DONOR. Do not try another one without first checking that precondition.**
  Three were implemented and measured on `ozzy@11` (the coupling reproducer), all in the
  post-convergence slot, all against a control of -2.02%:

  | method | what it does | result | cost |
  |---|---|---|---|
  | GOMEA Gene-pool Optimal Mixing (learned linkage) | copies a linkage SUBSET from a donor | **-2.02%** (inert) | 7x |
  | GOM standalone from best donor, no VND | mixing only | **-8.83%** | 3690 evals |
  | Path relinking toward top donors | walks TOWARD a guiding donor | **-2.02%** (inert) | 4x |
  | the hand-rolled cross-block joint pass | GENERATES candidates by search | **+0.16%** (+2.18 pts) | 2.8x |

  Post-climb our build is -2.02% and the best donor is **-9.92%**. GOM copies from donors,
  recombination crosses donors, relinking walks toward a donor -- all three borrow material from a
  set that is strictly worse than where the search already stands. Only the joint pass, which
  generates new candidates rather than borrowing them, can improve anything there.
  **This is also why recombination helps only at the DONOR STAGE**, where donors genuinely are better
  than the starting point, and does nothing afterwards.
  **THE LITERATURE IS SOUND; WE DO NOT MEET ITS PRECONDITION.** GOMEA's operator really is what the
  hand-rolled passes were converging on, and learned linkage really does beat predetermined models
  (Bosman & Thierens, GECCO 2012) -- our learned FOS found 44 sets, 13 crossing the talent/attribute
  boundary, confirming the assumed boundary is not where the interactions are. But GOMEA assumes an
  EVOLVING gene pool and ours is 65 fixed community builds. Path relinking assumes a guiding solution
  worth walking toward. Neither holds post-convergence.
  **NO EXACT METHOD APPLIES EITHER.** Dynamic programming for resource allocation requires a
  SEPARABLE objective; this project already measured ours as non-separable and non-concave (greedy
  build-up reached -90.4% on talents, -96.5% on attributes). Heuristics are necessary, not lazy.
  `--gom` and `--relink` ship OFF, kept so the measurement is not repeated.

- **DONOR RECOMBINATION -- TALENTS FROM ONE DONOR, ATTRIBUTES FROM ANOTHER -- HELPS ON SOME BUILDS,
  NEVER HURTS, AND ITS COST IS NOT FREE. It gets a cross-block move without searching for one.**
  Final-answer A/B, everything else held identical:

  | build | recombine=0 | recombine=12 | final | evals |
  |---|---|---|---|---|
  | ozzy@46 | -1.44% (1210) | **+0.41%** (1111) | **+1.85 pts** | fewer |
  | borge@44 | -2.31% (715) | **-1.81%** (1133) | **+0.50 pts** | **+58%** |
  | borge@35 | -2.89% (750) | -2.89% (745) | unchanged | same |
  | ozzy@11 | -2.02% (281) | -2.02% (413) | unchanged | +47% |

  **AN EARLIER VERSION OF THIS ENTRY CLAIMED IT IMPROVES QUALITY AND COST AT THE SAME TIME. That was
  written from the ozzy@46 row alone and is WRONG** -- borge@44 gained half a point for 58% more
  evaluations, and two builds gained nothing. The cheap-and-better case is the exception.
  **borge@35 IS THE ONE TO REMEMBER: its DONOR improved 1.18 points and its FINAL answer did not
  move at all.** Donor quality does not predict final quality here -- the same result this project
  already had from top-3 vs top-1 donors returning byte-identical builds. Never judge a donor-stage
  change by donor-stage numbers; the climb absorbs most of it.
  Compare the joint cross-block pass, which crosses the same coupling barrier by SEARCHING for the
  pair at 2.8x cost -- recombination simply starts on the far side of it when a good crossing
  happens to exist among the donors, and does nothing when it does not.
  Donor-quality gains over the best pure donor, before any climbing:

  | build | best pure donor | best recombined | gain | mixes level direction? |
  |---|---|---|---|---|
  | borge@44 | -5.20% | -4.79% | +0.43% | no |
  | borge@35 | -6.90% | -5.72% | +1.27% | **yes** |
  | ozzy@46 | -5.84% | **-2.12%** | **+3.95%** | **yes** |
  | knox@35b | -2.32% | -0.75% | +1.60% | no |

  **ON BOTH BUILDS WHERE THE WINNER MIXED DIRECTIONS IT TOOK TALENTS FROM BELOW AND ATTRIBUTES FROM
  ABOVE.** Plausible mechanism, not yet proven: talent budget is ~level while attributes are ~3x
  level, so talents saturate their caps early and a lower donor's talent shape fits a smaller budget
  cleanly, while a higher donor's attributes carry depth structure a lower donor has not grown into.
  Recombined candidates record `dir: 'mixed'`, so every future run reports how often this happens
  without needing a special test.
  **TOP-K, NEVER ALL PAIRS -- and this one nearly went unmeasured.** The first probe crossed all 86
  donors with each other: 7,482 full-fidelity evaluations on ONE build, none memoizable (every
  recombination is a distinct allocation), which is ~10x the work of the entire optimization run it
  exists to inform. It burned 46 CPU-minutes before being killed. Top-12 gives 132 combinations,
  tests the same hypothesis, and runs in about a minute.
  **Ranking by score is the RIGHT filter here and the WRONG one for the joint move pass** -- opposite
  rules, same file, so do not "unify" them. Recombination wants a strong pairing, so strong donors
  are what to cross. The joint pass wants two INDIVIDUALLY BAD halves that combine well, so ranking
  excludes exactly what it needs.

- **THE REMAINING SHORTFALLS ARE A TALENT/ATTRIBUTE COUPLING, PROVEN BY DIRECT MEASUREMENT, AND
  EVERY MOVE IN THE SET CHANGES ONE BLOCK ONLY.** This is the mechanism behind the converged
  (non-truncated) shortfalls, and it is measured on FIXED allocations with no search involved, so
  nothing about the search can confound it. On `ozzy@11` -- converged, fully spent, legal, 2.02%
  below its community build and only 8 point-differences from it:

  | allocation | loot | vs ours |
  |---|---|---|
  | ours | 67.52 | +0.00% |
  | import ATTRS + our talents | 62.28 | **-7.77%** |
  | our attrs + import TALENTS | 66.90 | **-0.92%** |
  | import (BOTH together) | 68.92 | **+2.07%** |

  **Both halves are downhill alone; the pair is uphill.** The attribute sweep holds talents fixed
  and the talent sweep holds attributes fixed, so no sequence of single-block moves crosses this --
  by construction, at any budget, from any donor. That is why every mechanism ever tried on this
  class returned a byte-identical build: they all searched a space in which the required move does
  not exist. It is the same one-way coupling recorded elsewhere in this file ("talents are NOT
  learnable from a flat attribute fill"), seen from the other side.
  **THE FIX NEEDS THREE PIECES AND ANY TWO OF THEM DO NOTHING** -- each was measured alone first:
  - *cross-block pairing* (`--joint=K`): +0.02%. It could not generate the attribute half it needed.
  - *plus one source -> TWO destinations*: still +0.02%. `exo -3` split across `lotl +1`/`exterm +1`
    is the attribute half, and every other move sends freed points to a SINGLE destination.
  - *plus a WIDE pairing*: **-2.02% -> +0.16%**, now beating the import. `joint=100` and `joint=400`
    return the same build, so 100 suffices.
  **RANKING THE CANDIDATE HALVES BY THEIR OWN SCORE IS ANTI-CORRELATED WITH FINDING THE PAIR, and
  that is why the first two attempts failed.** Top-K by individual score puts the needed halves at
  the BOTTOM -- the attribute half measures -7.77% -- so a narrow, "efficient" pairing excludes
  precisely the moves it exists to find. Do not re-optimise this by tightening K.
  **COST: 281 -> 2396 evals (8.5x), 22s at level 11.** The pass runs only AFTER the ordinary VND
  converges, so unstuck builds pay nothing -- but stuck builds skew expensive, and this is NOT yet
  measured on a high-level Borge where evaluation is ~60ms and the pairing space is larger.

- **MULTI-NODE MOVES *WITHIN* A BLOCK (K SOURCES, M-LEVEL RAISES) ARE IMPLEMENTED AND MEASURED NOT
  TO PAY -- THE COUPLING ABOVE IS THE AXIS THAT MATTERS. Do not re-derive this.** `corpus-donor-refine.js` takes `--sources` (how many nodes may fund one raise),
  `--raise` (levels the destination may gain), `--takecap` and `--movecap`. Defaults K=2/M=1
  reproduce the pair-only move set BYTE-IDENTICALLY (verified: borge@42 +0.07%, 436 evals, same
  allocation), so the generalisation is inert when off.

  | build | arm | result | evals | time | converged |
  |---|---|---|---|---|---|
  | borge@42 | K=2 M=1 | +0.07% | 436 | 57s | yes |
  | borge@42 | K=3 M=3 | **+0.07%** (identical alloc) | 2010 | 194s | **NO -- truncated** |
  | knox@38 | K=2 M=1 | +0.10% | 592 | 42s | yes |
  | knox@38 | K=2 M=4 | **+0.10%** (identical alloc) | 5734 | 379s | yes |

  The knox@38 arm is the real refutation: it CONVERGED, sweeping N1/N2/N8 with the enlarged move set
  and spending 2849 evaluations after its last gain proving nothing more existed, at **9.7x** cost.
  **The mechanism of the waste is worth knowing: the enlarged neighborhood STARVES the neighborhood
  escalation.** borge@42's rich arm reads `N1:2gain/1929ev` -- N1 ate the entire budget and N2/N8
  never ran. So a richer move set does not merely cost more, it deletes the ordered escalation that
  was separately measured doing the work.
  **SCOPE, STATED HONESTLY: both builds were ALREADY at or above parity (+0.07%, +0.10%), so neither
  could ever have shown a benefit.** These are cost measurements, not proof the idea is worthless.
  The untested case is a build with a REAL shortfall under the corpus method -- and note that
  knox@38 was chosen precisely because this file listed it at **-3.96%**, a PRE-CORPUS number that
  is stale. A stale figure in this file caused the wrong fixture to be picked; when the fresh sweep
  lands, correct the failing-build table rather than leaving numbers that describe a retired search.

- **EVERY BUDGET IN THE CORPUS METHOD IS NOW SIZED FROM MEASUREMENT, AND THE TUNING WAS WORTH 3.8x.**
  Each dial was instrumented before being changed -- evaluations spent per stage, the evaluation at
  which the answer LAST changed, and gains per neighborhood -- because a budget nobody has measured
  can only ever be raised.

  | change | evidence |
  |---|---|
  | `top` 3 -> 1 | ablation: IDENTICAL build on borge@73 (+2.37%) and knox@30 (+1.33%) at 1/3 the cost |
  | `maxevals` 12000 -> 2000 | **WRONG, AND MEASURED WRONG -- see below.** Actual usage on the five sampled builds was 381-781 evals, so the cap looked like 2.5x headroom. Across all 195 fixtures it BINDS, and costs up to 12.3 points. |
  | neighborhoods 10 -> `[1,2,8]` | N1/N2/N8 produced ALL 16 gains across 5 builds; N3/N4/N6/N12/N16/N24/N32 produced ZERO while costing 25-50% of every run |

  Result, verified byte-identical on all five builds (same scores, same improvement counts):
      borge@73  2254 evals/156s -> 586/48s      knox@30  1879/80s -> 488/23s
      knox@37   463/34s -> 314/24s   borge@32  489/20s -> 366/16s   borge@42  381/51s -> 252/30s

  **THE REMAINING TAIL IS NOT WASTE.** 110-171 evals (23-50%) are spent after the last improvement,
  and that is VND proving convergence: it must sweep the kept neighborhoods and find nothing before
  it may stop. Removing it removes the guarantee that the search stopped for a reason rather than
  because a counter ran out.

  **DO NOT MAKE THE BUDGET LEVEL-BASED.** Evaluation count is driven by the SEARCH SPACE (one VND
  sweep is O(n^2) in nodes -- Borge 15 attrs + 9 talents against Knox's 11 + 8), not by level.
  Level multiplies the COST PER evaluation (~11ms at level 12, ~60ms at 79) and therefore wall
  clock, but not how many evaluations convergence needs: **borge@73 and knox@30 converge within 30
  evaluations of each other across a 43-level gap.** A per-level table would fit the wrong variable.

  **THE DONOR SCREEN IS 5-20% AND IS DELIBERATELY LEFT ALONE** (35-77 evals against a 175-509 climb).
  It was once "optimised" to 250 iterations, which discarded borge@74 -- the only donor reaching the
  boss regime -- and reported the build at -38.26% when its own donor pool held a -19.69% killer.
  That is the SAIL finding from this file applied to the cheap stage, twice.

  **LIMIT: five builds is the evidence for the neighborhood trim.** A sixth build could need N4.
  `--neighborhoods=` overrides so the trim can be re-measured rather than argued about.

### Known open defects

- **THE BOSS-DAMAGE DESCRIPTOR AXIS IS REDUNDANT *GIVEN FI*, AND THE ORIGINAL DELETION WAS RIGHT FOR
  THE WRONG REASON.** knox@30, one seed, everything else identical:
      axis+FI off   -84.13%   cells   6   F/I  6/0    bestViolation 89   reaches-cannot-kill
      axis+FI ON     -1.75%   cells 133   F/I 82/51   bestViolation  6   KILLS-BOSS
  Against FI ALONE on the same build: -1.68% and -1.75%, at 96-105 cells. So the axis really does
  give the infeasible archive far more niches (51 infeasible cells against 5) and the returned build
  does not change. FI already produces the diversity by exploring deeper; the axis adds coverage
  that nothing needs.
  **The first deletion cited a null result on borge@73, which was the wrong evidence** -- that build
  fills 477 cells, so its descriptor was never the binding constraint and an extra axis could only
  fragment something already working. knox@30 fills SIX. The right justification is the one measured
  here, not that one, and the difference matters because the justification is what the next person
  inherits.

- **FI-MAP-ELITES ON knox@30 IS REPRODUCIBLE: -1.68%, -1.75%, -1.75% ACROSS THREE DIFFERENT RANDOM
  STREAMS** (fixed alternation, pfeas weighting, and pfeas+axis). Every run reports bestViolation
  falling from ~89 to 4-6 and the regime changing from `reaches-cannot-kill` to `kills-boss`, which
  is the mechanism's own claim rather than an outcome that could coincide. Against a baseline of
  -84.13% reproduced on every arm.
  **What is still NOT established**: knox@31 (+1.51% -> -0.87% / -2.72%) remains single-seed, and
  both figures sit inside the ~7-point seed variance, so they are neither evidence of harm nor of
  safety. The multi-seed run that would settle it was started and killed for CPU, twice. Until it
  lands, FI ships OFF.

- **BET-AND-RUN CANNOT HELP knox@30, AND THAT IS A FINDING ABOUT THE BUILD.** Three independent
  archives at the full budget:
      1234(cells 6, kill 0, viol 88)  9e3779b9(cells 6, kill 0, viol 89)  a5a5a5a5(cells 6, kill 0, viol 90)
  Identical. There is nothing for a portfolio to select between, so it returned +0.00 points for
  1.70x the time -- exactly what the theory predicts when there is no variance to exploit.
  **So knox@30's failure is SYSTEMATIC, not seed-dependent**, and no restart schedule, portfolio or
  re-run will ever fix it. It needs a mechanism, and FI is the one that moves it. Bet-and-run remains
  untested against the case it was built for -- the ozzy@62 bimodal failure (+15.34% / -66.27% from
  one configuration), which is not in the fixture set at that level.
  Cost note: k=3 measured **1.70x**, not the ~1.2x estimated from "illumination is ~10% of wall
  clock". That ratio holds for a level-60+ Borge and not for a cheap build where refinement is short.


- **BET-AND-RUN IS THE BACKUP IF NO MECHANISM FIXES THE BOSS CLIFF, AND IT IS CHEAP HERE.**
  Not implemented; recorded with the cost analysis so it can be picked up directly.
  The failure this repo keeps hitting on Ozzy is BIMODAL -- +15.34% on one seed, -66.27% on another,
  with nothing in between. That is a HEAVY-TAILED outcome distribution, and restart portfolios are
  the standard answer to heavy tails in stochastic search.
  **Bet-and-run** (Fischetti & Monaci; generic version, AAAI): run k short streams, then continue
  ONLY the most promising for the remaining budget. Our cost structure makes it unusually cheap --
  illumination is ~10% of wall clock and refinement ~87%, so three archives plus ONE refinement is
  about **1.2x**, against 3x for best-of-three full runs.
  **IT IS NOT THE MULTI-SEED MERGE THAT WAS ALREADY MEASURED AND LOST.** That split ONE budget three
  ways, leaving each stream too shallow -- the recorded conclusion was "per-stream depth beats
  stream diversity". Bet-and-run does not split: each stream gets the full archiveEvals and the
  choice is made BETWEEN them. The objection does not transfer.
  **THE DECISION MAKER MUST NOT BE ARCHIVE SCORE.** The literature notes a naive decision maker
  picks best-so-far, and better ones "discriminate between good and bad sample runs". Here archive
  score is known to be a bad proxy -- Borge's archive score varies 17.8% between seeds while its
  final build is identical every time. The signal that actually separates a winning Ozzy stream from
  a losing one is BOSS REACH (`bestKillReached`, or `bestViolation` from the FI archives), which is
  already recorded in diag. Select on that, tie-break on score.
  Expected effect, from the recorded Ozzy seeds: curiosity succeeds on 2 of 3 seeds, so selecting
  the best of three streams should convert a ~1-in-3 catastrophic failure into something far rarer,
  without changing the search mechanism at all -- which is its main advantage over every mechanism
  tried so far.

- **OCBA IN THE POLISH: FIRST MEASUREMENT, IDENTICAL BUILD AT 1.46x.**
      borge@35   off 0.00% 160s   OCBA 0.00% 109s   1.46x
                 polish verified 224/1291 -- 83% of full-fidelity polish work skipped
  The polish skipped 83% of its expensive evaluations and returned the SAME build. Overall speedup
  is 1.46x rather than 6x because polish is only part of a run; the archive and refinement stages are
  untouched. One build so far, with knox@35b and borge@32 in flight; quality is the gate and speed
  is the report, because a cheaper polish returning a worse build is not a win at any speed.


- **OCBA IS THE PRINCIPLED ANSWER TO "HOW MANY ITERATIONS PER CANDIDATE", AND IT IS THE STRONGEST
  UNEXPLORED LEVER FOR BOTH SPEED AND CONSISTENCY. Not implemented.**
  Optimal Computing Budget Allocation (Chen, mid-1990s) is the ranking-and-selection method for
  exactly our situation: choose the best of several designs whose values come from a stochastic
  simulation, under a fixed simulation budget. Reported to reach "the same simulation quality with
  only one-tenth of the computational effort compared to traditional methods".
  The rule, with `d` the gap from the apparent best and `s` that design's spread:
      N_i  proportional to  (s_i / d_i)^2
  Sequentially: sample everything cheaply, identify the leader, compute gaps, then spend the
  remaining budget where (s/d)^2 is largest, and repeat.
  **WHY IT FITS.** The polish evaluates EVERY candidate move in the neighbourhood at
  FINAL_ITERATIONS -- textbook EQUAL ALLOCATION, the thing OCBA exists to improve on. Most
  candidates are plainly worse and need very few samples to rule out; a handful sit on a 0.32% ridge
  and need many. Equal allocation overspends on the first group and underspends on the second, which
  is the worst possible split for both cost and correctness.
  **WHY IT IS NOT THE SHORTLIST THIS REPO ALREADY REJECTED.** That shortlist ranked the
  neighbourhood at SCREEN_ITERATIONS and DISCARDED all but the top few -- and a 100-iteration score
  was measured ordering a 0.32% ridge BACKWARDS by 1.7%, costing 1.64M on ozzy@62. The literature
  names the distinction: "top-K screening selects promising candidates early but lacks the
  principled reallocation mechanism". OCBA discards NOTHING; it spends less on candidates that are
  far behind and more where the decision is genuinely uncertain. A candidate that looks bad cheaply
  can still be sampled again if its gap is small relative to its spread.
  **IT ALSO TARGETS THE CONSISTENCY PROBLEM.** OCBA maximises the probability of CORRECT SELECTION,
  and the ~7-point seed variance recorded above is largely "which build got picked" -- so raising
  correct-selection probability attacks the variance directly rather than averaging it away, which
  is what merging seeds tried and lost at.
  **INPUTS WE ALREADY HAVE**: the spread is measurable from the precision ladder (error is ~c/sqrt(n)
  with c ~ 3.0 from the 250/500/1000/2000 measurements), and gaps come free from the scores already
  being computed. Variances are similar across candidates on one build, so with equal spreads the
  rule collapses to N_i proportional to 1/d_i^2 -- implementable without estimating per-candidate
  variance at all.

- **A GLOBAL FIDELITY CUT IS THE CRUDE VERSION OF THE SAME IDEA, AND IT IS BEING MEASURED.**
  finalIterations 1000 -> 250 on borge@35: identical result (0.00% both), 207s -> 125s, a 1.66x
  speedup. Not the 3x a naive reading of the cost model predicts, because archive evaluations run at
  SCREEN_ITERATIONS and are untouched -- only the full-fidelity portion shrinks. One build so far.
  If OCBA is implemented this dial becomes unnecessary: a global cut lowers fidelity for the close
  calls too, which is exactly where it must not be lowered.


- **FIVE MEASURED-DEAD SEARCH FLAGS ARE DELETED, AND THE DELETION IS VERIFIED BIT-IDENTICAL.**
  Each had a measurement behind it, so none was removed on taste:
      bossDamageBands (extra descriptor axis)   -39.44% -> -39.48%, cells 477 -> 455
      paretoDepth / MOME (per-cell Pareto)      bit-identical build on borge@73
      FRONTIER_SHARE + the frontier emitter     broke a working seed on ozzy@62
      DEPTH_SHARE + depthMove()                 coverage up, champion quality flat or worse
      clampToHeadroom                           superseded by break-point spending
  `illuminate()` drops from SIXTEEN positional parameters to twelve and the effort whitelist from
  15 keys to 11. The MEASUREMENTS stay in this file so nobody re-runs them; only the code went,
  which is what "git history is the archive" means.
  **VERIFIED, NOT ASSUMED.** `search-identity-probe.js` fingerprints the returned ALLOCATION (not
  just a score, which could coincide) before and after: ozzy@11 and knox@12 came back byte-for-byte
  identical -- same evals, same cells, same loot to six decimals. That check exists because "inert
  when off" is precisely the claim this repo has watched fail: one `rng()` call taken for a check
  that could never pass shifted every later draw and moved a result 7 points.
  The whitelist gate also earned its place during the deletion -- it FAILED the moment
  `effort-option-check` still named the deleted `bossDamageBands` as valid.

- **THE SEARCH RE-PROPOSES THE SAME ALLOCATION 54% OF THE TIME, AND THAT IS NOT OVER-PROVISIONING.**
  Across 103 builds: 1,821,830 evaluation REQUESTS, 986,746 served from the memo (54.2%), 835,084
  actually evaluated. Median duplicate rate 56.2%, worst 88.1%.
  Memoization is exact, so a duplicate costs a proposal, a legality check and a hash lookup -- not
  an evaluation, and evaluation is ~87% of wall clock. So this is NOT wasted time. What it does
  mean is that `archiveEvals: 9600` delivers roughly **4,400 distinct evaluations**: the budget
  number overstates exploration by about 2x, which matters when reading any archive-size result.
  **The obvious explanation is wrong and was tested**: archives under 100 cells duplicate 58.7%,
  archives over 300 cells duplicate 50.7%, and knox@28 with SIX cells duplicates only 19.1%. The
  rate is roughly constant across archive sizes, so it is inherent to the variation operators
  rather than a saturation effect. Do not go looking for a cheap win here.


- **THE WHOLE "HONEST REPORTING OF UNMODELLED TERMS" SYSTEM WAS DEAD, AND THIS FILE ASSERTED IT
  WORKED.** Three functions existed to tell a user which factors the fleet model cannot compute for
  their account -- `unmodelledCrewRankTerms()` (defined AND exported to `window`),
  `unmodelledInstallBonusTerms()` and `unmodelledEvolutionTerms()`. **None of them was ever
  called.** An account owning PowerGU1 quality 2+, RU83/RU96 or AttractionGU6 saw fleet numbers
  computed without those factors and was told nothing, while this document stated as fact that the
  gaps were reported "rather than dropping them silently". They were dropped silently.
  A dead honesty feature is worse than no honesty feature, because the documentation then makes a
  false claim about what the user has been shown. Two are now wired into the ship optimize modal
  beside the growth-counter warning -- the one warning that WAS wired -- so there is a single place
  a user looks for "what this page cannot compute".
  **`installBonusGlobalMultiplier()` IS STILL DEAD AND IS A DIFFERENT KIND OF PROBLEM.** It computes
  the PowerGU1 multiplier applied to every install node's bonus, and nothing calls it, so the model
  does not apply it. It returns a literal 1 whenever `powerGU1Level()` is 0 -- and the gem store
  carries no per-GU level, so it reads 0 for every account today, which is why nothing has been
  visibly wrong. It becomes a real modelling gap the moment that input exists. Wiring it changes
  NUMBERS rather than notes, so it is left as a decision rather than quietly switched on.
  Found by `dead-symbol-audit.js`, which is a REPORT: some findings are legitimate.


- **THE UNSPENT-POINT FIX CHANGED NONE OF THE FAILING BUILDS. Measured, so it is not retried.**
      knox@30   -84.13% -> -84.13%   spend  30/30   90/90   reaches-cannot-kill
      borge@32   -0.65% ->  -0.65%   spend  32/32   96/96   reaches-cannot-kill
      knox@35b   -0.69% ->  -0.69%   spend  35/35  105/105  kills-boss
  Identical to two decimal places, and the spend column says why: these builds were ALREADY fully
  spending at the shipped effort. The underspend bug was real and worth fixing -- it was a shipped
  CRASH on `fast` and genuinely underspent builds (ozzy@11, ozzy@12) -- but it was not the cause of
  any known shortfall.

- **THE SIX FAILING BUILDS ARE THREE DIFFERENT PROBLEMS, NOT ONE.** Reading the regime label alone
  got this wrong once already (borge@32 reports `reaches-cannot-kill`, which I read as "same as
  knox@30" -- but its REFERENCE does not kill either, and our build actually goes FURTHER while
  earning slightly less). Compare the stages, not the label:
      knox@30   -84.13%  ref 102.2 -> ours 100.0   STOPS EXACTLY ON THE BOSS BOUNDARY
      borge@32   -0.65%  ref 102.1 -> ours 102.3   ours goes FURTHER
      borge@42   -0.68%  ref 188.4 -> ours 188.7   ours goes FURTHER
      knox@35b   -0.69%  ref 103.3 -> ours 102.6   marginally shorter, and it KILLS its boss
      knox@37    -1.23%  ref 127.9 -> ours 103.7   24 stages shallower
      knox@38    -3.96%  ref 130.6 -> ours 119.8   11 stages shallower
  1. **knox@30 alone is a boss cliff.** It is the only build that stops on a boundary, and the only
     one FI-MAP-Elites addresses. One of six.
  2. **borge@32 / borge@42 / knox@35b are sub-1% residuals** with both sides in the same regime, at
     roughly 3x the measured 0.2% comparison noise floor. Ordinary search slack, not a mechanism.
  3. **knox@37 / knox@38 are DEPTH shortfalls** -- ours lands 11 and 24 stages shallower. That
     matches the recorded finding that Knox is a knapsack/depth problem (budget/capacity 0.20,
     `soul` alone costing 128% of the budget), not a structure-selection one. A boss mechanism will
     not touch these.
  **So "the boss problem" is one build of six, and the other five need two different answers.**
  Do not evaluate a boss fix on the aggregate shortfall count; it can only move one of them.


- **LOW EFFORT SETTINGS CAN HARD-FAIL, NOT DEGRADE, AND THAT CONSTRAINS EVERY "MAKE THE SWEEP
  CHEAPER" PLAN.** At `archiveEvals: 600` on ozzy@11 the optimizer THROWS:
  `Optimizer left 1 talent point(s) unspent while "revival" could still take one`. The invariant is
  correct -- returning an underspent build would be worse -- but the failure mode is a THROW, so a
  budget cut does not trade quality for speed, it can crash. `fast` (1200/3) has not been observed
  throwing, so the shipped levels are fine; what is NOT safe is assuming an arbitrary smaller budget
  degrades gracefully. Any archive-reduction experiment must treat a throw as a possible outcome and
  report it, not just compare scores.


- **FI-MAP-ELITES IS NOT SHIPPABLE YET AND THE knox@31 RESULT IS INCONCLUSIVE, NOT NEGATIVE.**
  State of the evidence, kept separate from the interpretation:
      knox@30  FI off -84.13% -> FI ON -1.68%  (fixed 50/50)   bestViolation 89 -> 5   kills-boss
      knox@30  FI off -84.13% -> FI ON -1.75%  (pfeas)         bestViolation 89 -> 4   kills-boss
      knox@31  FI off  +1.51% -> FI ON -0.87%  (fixed 50/50)
      knox@31  FI off  +1.51% -> FI ON -2.72%  (pfeas)
  The knox@30 win is reproduced on TWO different random streams (adding the pfeas draw shifts the
  stream, so the second run is an independent sample rather than a repeat), and `bestViolation`
  89 -> 4/5 says the infeasible archive genuinely walked to the constraint boundary -- the
  mechanism's own claim, and the thing that separates a result from a coincidence.
  **The knox@31 regressions are BOTH inside the ~7-point seed variance this repo has measured**, so
  a single seed cannot tell "FI harms this build" from "the extra draw shifted the stream". That is
  the same confusion that once turned a shifted stream into a fake +15.34%. It is therefore NOT
  evidence that FI is harmful -- and equally not evidence that it is safe, which is why it ships
  OFF. Multi-seed on knox@31 is what settles it; do not decide this from one seed in either
  direction.
  **A DOMAIN MISMATCH TO WEIGH IF THE REGRESSION SURVIVES MULTI-SEED.** In FI-2Pop's setting an
  infeasible solution is UNUSABLE, so losing its objective quality costs nothing. Here "infeasible"
  means "does not kill the boss it reaches" -- and 8 of 10 sampled imports do not kill their boss,
  so infeasible builds are frequently the RIGHT ANSWER. An infeasible cell that retains its
  lowest-violation build instead of its highest-loot one therefore discards a real candidate. If
  multi-seed confirms harm, the fix that follows is retaining BOTH in infeasible cells (paretoDepth
  applied to the infeasible archive), not abandoning the mechanism -- but do not build that until
  the regression is shown to be real.


- **THE ARCHIVE MAY NOT BE EARNING ITS COST, AND THREE INDEPENDENT MEASUREMENTS POINT THE SAME WAY.**
  Recorded as an open question with the evidence, not as a decision, because the answer determines
  whether most of this pipeline should exist.
  - knox@30's archive holds **SIX cells**. Every build lands in kill band 0 and stage band 100, so
    only concentration varies -- 9,600 variations feeding a 6-slot hill climber.
  - MOME retained **118 extra stepping stones** on borge@73 that the single-elite archive would have
    discarded, moved coverage 477 -> 329, and returned a **bit-identical build**.
  - This file's own older note: *"Borge's archive varies 17.8% between seeds and its FINAL answer is
    0.00% every time -- refinement recovers from any archive it is handed."*
  Together: archive CONTENTS demonstrably do not decide the answer on the builds measured, while
  illumination costs ~10% of wall clock and the enumeration feeding it is exact and cheap.
  **The QD literature treats this as a known failure mode rather than a local quirk.** MAP-Elites'
  "lack of directed search can cause slow convergence even in low-dimensional search spaces", and
  its overhead "may not always justify the computational cost, particularly in scenarios with
  limited diversity requirements" -- which is precisely what a six-cell archive is.
  **THE COUNTER-EXAMPLE THAT MUST NOT BE FORGOTTEN**: archiveEvals 4800 -> 9600 was REQUIRED for
  Ozzy boss reachability (-66.27% at 4800). So the archive is load-bearing for at least one build,
  and any simplification has to be tested against boss-critical builds, not just farm builds. A
  cheap-archive arm that looks clean on farm builds and quietly breaks boss builds is the specific
  failure to watch for.
  `effort-sufficiency-check.js` now carries `noarchive` (archiveEvals 400) and `shifted` (400 evals,
  refinement doubled) arms to answer it against the GATE'S VERDICT rather than against a score.


- **THE BOSS CLIFF HAS A NAME, A MECHANISM AND A FIRST CONFIRMED FIX -- FI-MAP-ELITES.**
  Read the four falsified attempts above first; this is what finally moved a build, and it moved it
  because of a property the others lacked rather than by luck.
  **The generalised problem is a CONJUNCTION.** On borge@73 the archive held 488 finalists of which
  **348 KILL a boss**, and the search still returned a non-killer -- those killers kill SHALLOWER
  bosses and farm less. What never exists is a build that is DEEP AND KILLING AT ONCE. Each half is
  easy alone and everything between is worse than both, which is why more exploration, richer
  descriptors and better retention all failed: none of them changes what the boss-progressing
  builds are SELECTED ON.
  **FI-2Pop (Kimbrough et al. 2008) supplies the missing half**: the infeasible population "is not
  evaluated by the objective function", so it "is free to explore boundary regions, where the
  optimum is likely to be found", and "selection on the infeasible population will drive the
  population to, and eventually over, the boundary". Khalifa et al.'s **Constrained MAP-Elites**
  combines that with MAP-Elites; the FI-MAP-Elites implementation states the rules exactly --
  feasible archive survives on FITNESS, infeasible on FEASIBILITY SCORE, selection ALTERNATES
  between them, and offspring route themselves by constraint satisfaction.
  Measured on knox@30, same seed, everything else identical:
      FI off   -84.13%   cells  6   F/I  6/0   bestViolation 89   stage 100.0  reaches-cannot-kill
      FI ON     -1.68%   cells 96   F/I 91/5   bestViolation  5   stage 110.0  KILLS-BOSS   (faster: 152s vs 197s)
  **`bestViolation` 89 -> 5 is the load-bearing number, not the loot.** It says the infeasible
  archive actually walked to the constraint boundary, which is the mechanism's own claim. Had loot
  moved while bestViolation stayed at 89, the cause would have been something else and the result
  would be a coincidence to investigate rather than a fix.
  **The control arm also produced a sharper diagnosis than borge@73 ever did: knox@30's archive
  holds SIX cells.** Every build lands in kill band 0 and stage band 100, so only concentration
  varies -- 9,600 variations feeding a 6-slot hill climber. The QD machinery was inert for that
  build. That is also why MOME could not help it: there was nothing to keep a Pareto front OF.
  **WHAT IS NOT ESTABLISHED.** One build, one seed. -1.68% is better, not beating the reference. It
  is untested on borge@73, where the archive is NOT degenerate (477 cells) -- so whether FI helps
  when diversity already exists is open, and that is the next measurement rather than an assumption.
  Regression on passing builds is in flight. Ships OFF until both land.
  **IF THE INFEASIBLE ARCHIVE COLLAPSES TO ONE SHAPE, the literature already has the next step**:
  Liapis's **Constrained Novelty Search** (FINS / FI2NS) keeps the same two populations but selects
  the infeasible one on NOVELTY rather than feasibility score, reporting larger and more diverse
  feasible sets. Its stated motivation matches ours exactly -- plain novelty search "does not
  distinguish between feasible and infeasible individuals and is likely to explore infeasible space
  when the feasible space is small", and our feasible space (boss killers) is very small. Do not
  reach for it until the infeasible archive is measured collapsing.

- **SURROGATE-ASSISTED ILLUMINATION (SAIL) IS NOT THE EFFICIENCY ANSWER HERE, AND THE REASON IS
  MEASURED.** Gaier, Asteroth & Mouret report better solutions per bin than MAP-Elites at "several
  orders of magnitude fewer evaluations", which makes it the obvious thing to reach for when a
  sweep costs hours. It would save almost nothing for us: `eval-cost-probe` shows per-evaluation
  cost is pure MARGINAL in iterations (fixed per-call overhead 1.2ms at level 12, ~0 at level 60,
  despite a fresh WASM instance per call), and the breakdown on borge@12 -- ~4,200 evaluations in
  276s, screening at 11.9ms accounting for ~50s -- puts **~87% of wall clock in FULL-FIDELITY
  refinement and polish**. Illumination is ~10%. A surrogate on the archive stage optimises the
  cheap tenth.
  Recorded so it is not attempted on reputation. The lever that matters is refinement width
  (`refineSupports`), which `effort-sufficiency-check.js` measures against the GATE'S VERDICT.


- **FOUR MECHANISMS HAVE NOW BEEN MEASURED ON borge@73 AND NONE OF THEM MOVES IT. The build is the
  standing open defect; the value is in what has been RULED OUT with numbers.**

  | mechanism | result on borge@73 | archive |
  |---|---|---|
  | baseline | -39.44% | 477 cells |
  | `bossDamageBands` (extra descriptor axis) | **-39.48%** | 455 cells |
  | `paretoDepth 2` (MOME, per-cell Pareto front) | **-39.44%** | 329 cells, 447 entries |
  | regime decomposition | machinery verified; see below | - |
  | frontier pushing (measured earlier, on Ozzy) | broke a working seed | - |

  **THE MOME RESULT IS THE INFORMATIVE ONE, BECAUSE THE MECHANISM DEMONSTRABLY WORKED.** The damage
  role fired (447 entries against 329 cells, so 118 stepping stones were retained that the
  single-elite archive would have discarded), coverage moved a great deal (477 -> 329), and the
  returned build was **bit-identical**. So on this build refinement converges to the same answer
  regardless of what the archive contains. That is consistent with the older note that Borge's
  archive score varies 17.8% between seeds while its final build is identical every time.
  **Conclusion: for borge@73 the archive is not the binding constraint.** Every remaining
  archive-side idea -- richer descriptors, better retention, better parent selection -- is aimed at
  a stage that has now been shown not to decide this build's answer. Stop proposing them without
  first disproving this measurement.

- **`bossHpPercent` READS 0 FOR TWO OPPOSITE SITUATIONS AND IT BIT AGAIN, IN NEW CODE, WITHIN AN
  HOUR OF THE ENTRY ABOVE BEING WRITTEN.** `constraintViolation` credited `(100 - hp)` as progress
  toward the target boss. For a build stalled AT a wall that is right. For one that CLEARED a wall
  and died in the open stages beyond it, hp is 0 because there is no fight in progress -- and
  crediting it gives progress 1.0, violation 0, i.e. **an unreachable regime scores FEASIBLE**.
  Caught by the decomposition smoke test on borge@35 (`maxStage 155.2, hp 0.00, kill 0`), which
  cleared the stage-100 boss and never came near 200. The `satisfied` column said no because it is
  computed independently from `regimeOf`; the SCORING path would have said yes.
  Progress is now credited only when the run ended ON a `BOSS_INTERVAL` boundary, which is what
  "stalled at a wall" means. Pinned by five cases in `describe-run-check.js` plus a separator
  assertion, and verified with a negative control (removing the guard fails exactly the past-a-wall
  case).
  **This is the fourth time this field has produced a wrong answer here.** It is not a subtle field
  and the failures are not subtle either; treat any new use of `bossHpPercent` as a defect until it
  states which of the two zeros it handles.


- **BORGE@73 IS A DESCRIPTOR HOLE, NOT A SEARCH FAILURE, AND THE FIRST TWO HYPOTHESES WERE BOTH
  WRONG.** Worth reading in order, because the wrong answers were each supported by a real number.
  - *Hypothesis 1, reachability: FALSIFIED.* The archive reaches the stage-300 boss, crosses 3 boss
    boundaries, reaches kill rate 99, and hands refinement 488 finalists of which **348 KILL a
    boss**. Illumination is not failing to find the boss region.
  - *Hypothesis 2, refinement or selection: FALSIFIED.* The ledger, every number at
    FINAL_ITERATIONS: archive 2,609,276,580 -> refined 3,032,202,766 (+16.21%) -> returned
    3,032,202,766 (+0.00%). Refinement works and selection picks its best finalist.
  - *What is actually missing is a build that is DEEP AND KILLING AT THE SAME TIME.* The returned
    build is `reaches-cannot-kill` at stage 300 with **67.44% of the boss HP left**; the community
    reference leaves **3.43%** and clears it 31.7% of the time, which is the whole 39.44% gap.
  **CAUSE: boss damage is not a descriptor. Only kill rate is, and kill rate is 0 across the entire
  approach to a cliff.** Measured, archive-only, 9600 variations -- kill-0 elites by stage band:
      stage 200-205   6 cells   boss HP left 35.5%-44.4%
      stage 205-300   5-6 each  boss HP left 0% (never engaged)
      stage 300-305   6 cells   boss HP left 63.1%-93.8%   <- a 30.6-point spread in ONE kill band
  So a build leaving 63% and one leaving 20% compete for a single cell, and the archive keeps
  whichever has more loot/min TODAY -- always the one that farms fastest and hits the boss weakest.
  The stepping stone is discarded every generation. That is precisely the failure MAP-Elites exists
  to prevent, occurring on the one axis the descriptor does not measure.
  **THE CONDITIONING IS WHAT MAKES THE FIX LEGITIMATE, AND objective.js ALREADY MEASURED IT.**
  `bossHpPercent` is NOT a gradient alone -- it reads 0 both for a build that never reached the wall
  and one already past it -- but the same measurement found it discriminating once depth is held
  fixed ("where stage ties at a wall the HP reading is precisely what discriminates, 74.0 vs 47.0").
  The archive key already carries a stage band, so the axis is only ever compared within one wall.
  The probe confirms it directly rather than by argument: bands 205-300 all read HP 0 and are
  separated from band 300+ by STAGE, not by this axis.
  **AND BANDING ON IT DOES NOT FIX THE BUILD -- MEASURED, HYPOTHESIS FALSIFIED.** Full pipeline,
  borge@73, seed 9e3779b9, everything else held identical:
      bossDamageBands off   -39.44%   cells 477   killBands 14   furthest stage 300.0
      bossDamageBands ON    -39.48%   cells 455   killBands 14   furthest stage 300.0
  A -0.07% arm-to-arm difference, far inside the ~7-point seed variance, and **cells went DOWN**.
  That is the tell: an extra axis splits the same variation budget across more potential niches, so
  each lineage gets less depth -- the identical shape as the depth-move result (coverage up,
  champion quality flat or worse). **Per-stream depth beats stream diversity**, for the second time.
  So the descriptor hole is a REAL measured property of the archive and is NOT the cause of this
  build's shortfall. The two claims are separate and only the first survived. `bossDamageBands`
  ships **OFF** -- kept rather than deleted so the measurement is not repeated. **Cell count is not
  the metric** -- this repo has already measured a variation operator that raised coverage and
  LOWERED champion quality (depth moves: 81.8 -> 92.5 cells, 9.384M -> 9.170M loot).
  `boss-parity-check.js` is the invariant the fix has to satisfy, and it is integer-valued so it has
  no threshold to soften: **the optimizer may never clear fewer bosses than the build it is handed.**
  Over 27 build-runs across 5 result files it isolates borge@73 as the only boss loss, and reports
  that the other sub-1% shortfalls have a different cause (two are the ozzy@54 overshoot already
  fixed by break-point spending).

- **`describeRun` LABELLED A STAGE-303 RUN "boss at 400", CONTRADICTING THE KILL RATE PRINTED BESIDE
  IT.** It computed the contested boss with `ceil`, so a build reaching 303.8 was reported as
  fighting the 400 boss -- one it cannot reach -- while the same line printed `kill rate 31.7%`,
  which is its rate against 300. `ceil` and `floor` agree for a build that dies ON a boundary and
  for one below the first boss; they disagree exactly for the BOSS-CLEARING build, i.e. the only
  case a boss investigation is looking at. It is now `floor`, and `describe-run-check.js` pins it
  with 24 assertions over 5 measured runs (the old rule fails 5 of them).
  This is the third defect found in the reporting layer rather than the search, which is the point
  of having one: a summary that restates a number wrongly starts an investigation into the wrong
  thing.

- **A FLAG CAN REACH THREE OF FOUR SITES AND STILL BE DEAD, AND AN A/B WILL RECORD THAT AS "NO
  EFFECT".** `bossDamageBands` was added to `cellOf`, to `illuminate`'s signature and to its diag
  record, and was **never passed at the call site** -- the surrounding argument list used
  `!== false` where the patch matched `=== true`, so the replacement silently did not apply. Every
  flag is read as `effortSpec.<name>`, so an unwired or misspelled one reads `undefined`, the
  feature stays off, and the ON arm returns the control's number.
  `EFFORT_SPEC_KEYS` now makes an unknown effort key THROW, and `effort-option-check.js` asserts
  BOTH directions -- a typo throws, and every whitelisted key is actually read by something. The
  second direction is not decoration: it immediately caught `frontierShare`, which was on the list
  while only ever being read as a module constant, so accepting it would have licensed a flag that
  does nothing. Benches that run an A/B should assert the flag from the RESULT
  (`diag.archive.bossDamageBands`), never from the argument they passed.


- **THE OZZY OUTCOME IS BIMODAL AND FAILS ABOUT A THIRD OF THE TIME. This is the top defect.**
  Measured on the full pipeline, level-62 Ozzy account, three seeds per arm:

  | selection  | seed 9e37 | seed 1234 | seed a5a5 |
  |---|---|---|---|
  | random     | +8.24%    | -66.27%   | -66.27%   |
  | curiosity  | +15.34%   | +4.77%    | -66.27%   |

  Every failure is EXACTLY -66.27% (11,854,311) -- the same non-boss-killing local optimum, not a
  spread. An earlier note in this file called this a "~7 point seed variance"; that was two lucky
  seeds being compared. **The +15.34% headline is the best of three seeds, not a typical result.**

  **ROOT CAUSE, ISOLATED: archive REACHABILITY, not refinement.** Archive-only at 4800 variations:
      seed a5a5   93 cells   1 kill band   best kill 0   -> final -66.27%
      seed 1234   95 cells   3 kill bands  best kill 7   -> final  +4.77%
  The correlation is perfect: if illumination lands ONE build in a kill>0 cell the run succeeds,
  otherwise it returns the local optimum. And almost no progress is needed -- an archive whose best
  is kill 7 refines into a build killing at 58. **Refinement is reliable; it just needs a foothold.**

  **FRONTIER PUSHING ON STAGE BOUNDARIES WAS TRIED AND IS A REGRESSION -- and it corrected the
  diagnosis above.** Preferentially developing elites nearest a stage boundary (bosses stand every
  100 stages, so maxStage 99 is one variation from engaging one) does move the archive: seed a5a5,
  which had never reached a boss cell under any configuration, reached 2 kill bands / best kill 1,
  and champion scores rose on all three seeds. End to end it LOST:
      seed 9e37   curiosity +15.34%  ->  curiosity + frontier  -66.27%
      seed a5a5   curiosity -66.27%  ->  curiosity + frontier  -66.27%
  It broke a seed that worked and rescued none.
  **So "touching a kill > 0 cell means the run succeeds" is FALSE -- it was generalised from two
  data points.** a5a5's archive reached kill 1 and the run still returned the local optimum, while
  the seed that succeeds reaches kill 7. Touching a boss cell is NECESSARY BUT NOT SUFFICIENT;
  there is a foothold threshold between kill 1 and kill 7. Reaching MORE boss-adjacent cells is not
  the same as reaching a DEEPER one, and that is the distinction the next attempt has to respect.
  `FRONTIER_SHARE` ships at 0 rather than deleted.

- **KNOX AT LEVEL 26 ALREADY KILLS ITS BOSS, so its flat archive is CORRECT and not a defect.** Its
  own build runs minStage 105.7 / avgStage 109.8 / maxStage 113.1 -- you cannot pass a boss without
  killing it. The `bossKillRate 0` in its output refers to the stage-200 boss, 87 stages out of
  reach. So every Knox build scores kill 0 against an unreachable boss, the kill-rate descriptor is
  DEGENERATE for that hunter, and 1 kill band is the right answer. Its 28 cells are not
  under-exploration either: maxStage spans only ~105-113, so the behaviour space really is that
  small.
  Confirmed by the project owner from the game side: Omen is the only Knox ATTRIBUTE that touches
  boss performance (reduced effect against bosses), so a Knox boss build is just a push build with
  overflow into Omen -- there is no separate boss basin to discover. Knox's -0.48% is therefore
  purely refinement depth, with no boss component.

- **THE FAILURE MODE IS A WRONG REGIME, NOT A BROKEN BUILD.** Per the project owner: you reach a
  boss several levels before you can kill it, and until then the best play is to die to it as fast
  as possible; once you can kill it, farming it beats Lucky Loot until you can push well past it.
  Those are three real regimes, and the -66.27% build is the optimum of the middle one -- kill 0,
  short runs, loot from volume. The optimizer is not returning garbage; it is returning the best
  build in whichever regime its archive populated. That also explains why the boss cell is hard to
  stumble into: die-fast is a broad easy basin, killing needs concentrated depth, and everything
  between (fight the boss and lose slowly) is WORSE THAN BOTH. It is a valley, not a slope.

- **THE KNOX "-0.48% DEFECT" NEVER EXISTED -- IT WAS THE WRONG HUNTER'S STATS.** `evalStateFor(build,
  iterations)` takes no hunter; it reads the `currentHunter` global, which is correct for the app
  and wrong for any bench or console script that loops over hunters. A Knox build scored with
  OZZY's stats (and Ozzy's stage 201 rather than Knox's 100) returned a perfectly plausible number
  -- foreign keys resolve to nothing, missing ones default, nothing throws -- and that number said
  the optimizer was 0.48% BELOW the account's build. Measured correctly it is **18.48% ABOVE**.
  An entire investigation into Knox refinement depth, archive coverage and richer move sets was
  chasing a measurement bug. `AccountState.build` now REJECTS hunterStats carrying another hunter's
  fields, at the one constructor every path funnels through, so it cannot be bypassed by writing a
  new caller; `evalStateForHunter(hunter, build, iterations)` is the explicit form.
- **`avgStage` IS NOT "HOW FAR THE BUILD GETS", AND READING IT AS SUCH PRODUCED TWO OPPOSITE WRONG
  ANSWERS ABOUT THE SAME RUN.** Knox returning `avgStage 96.1, maxStage 100, bossKillRate 0,
  bossHpPercent 99.996` was reported first as "already kills its stage-100 boss" and then as "does
  not reach stage 100 at all". Both wrong: it REACHES the boss, does no damage, and dies there --
  which was in `maxStage` and `bossHpPercent` all along. `Objective.describeRun()` now returns
  stated conclusions (`regime` of cannot-reach-boss / reaches-cannot-kill / kills-boss, plus
  `reachesBoss`, `killsBoss`, `stageMin/stageAvg/stageMax` and a one-line summary) so a report
  quotes a labelled fact instead of paraphrasing a number. A malformed result throws.
- **KNOX IS A DIFFERENT OPTIMIZATION PROBLEM FROM BORGE AND OZZY, AND THAT -- NOT A SEARCH DEFECT --
  IS WHY IT KEEPS BEHAVING DIFFERENTLY.** Measured from the resolved configs at the account's own
  levels:

  | | Borge | Ozzy | Knox |
  |---|---|---|---|
  | attributes | 15 | 15 | 11 |
  | tier thresholds | 75/150/180 | 90/150/180 | **none** |
  | dependency depth | 4 | 6 | 3 |
  | uncapped roots | 2 | 2 | 1 |
  | budget / total capped capacity | 0.71 | 0.78 | **0.20** |
  | nodes the budget could max | 11 of 13 | 11 of 13 | **4 of 10** |
  | biggest node cost-to-max / budget | 0.22 | 0.22 | **1.28** |

  Borge and Ozzy can fill roughly three quarters of their space and max 11 of 13 nodes, so DEPTH IS
  NEARLY FORCED -- most nodes end at or near cap and the real question is WHICH SUBSET to fund.
  Thresholds and a deep dependency tree make structure the dominant lever, which is exactly what
  support enumeration and structural resampling are built for.

  Knox can fill a FIFTH of its space, can max only 4 of 10 nodes, and its `soul` node (cap 100 at
  cost 1) costs 128% OF THE ENTIRE BUDGET on its own. With no thresholds and a depth-3 tree,
  structure barely discriminates: the question is HOW DEEP to go in a handful of nodes. It is a
  continuous depth/knapsack problem wearing the same interface as a subset-selection problem.

  This explains every Knox symptom at once, and they stop looking like defects:
  - the archive fills 26-29 cells against Borge's 500+, because the behaviour space genuinely IS
    that small (stage spans ~91-100, one kill band) -- not under-exploration;
  - structural resampling does nothing for it, because supports are not the lever;
  - its builds sit at strict local optima that differ from the import only in DEPTH (kraken 14 vs
    kraken 1, same support, same talents) -- 108 legal neighbours, best -0.015%;
  - knox#12 (L22) fails the gate at -0.44% with that same shape.

  **The search is currently tuned for structure selection** -- 35% structural resampling ON, depth
  moves OFF. And the depth-move default was set from a sweep run on OZZY, with the Knox arm judged
  on CELL COUNT, which is the wrong metric for a hunter whose behaviour space is small by nature.
  That is the same error as every other one recorded here: a measurement that could not see the
  thing being asked about.

  **The discriminator is MEASURABLE FROM THE CONFIG, not the hunter name** -- `budget / cappedCapacity`
  (0.20 against 0.71/0.78) or `biggestNode.costToMax / budget` (1.28 against 0.22). Any adaptation
  must key off that, never off `hunter === 'knox'`.

- **A FIXTURE MUST BE SCORED UNDER ITS OWN ACCOUNT STATE, NOT THE DEVELOPER'S -- AND DOING IT
  WRONG INFLATED A LEVEL-13 BORGE 13x.** `cfgFor(hunter, build)` reads the STORE: the current
  account's `hunterStats` and `globalUpgrades`. `cfgForImport(hunter, build)` (tools/bench) reads
  only the BUILD's own overrides, with empty gems. They are both correct, for different questions,
  and using the first on a community fixture answers neither.
  A console sweep did exactly that and reported borge@13 as **+237%** over its community build. The
  fixture's own recorded `expectedLootScore` is 119.91; that run measured its import at 1,575. The
  optimizer was not finding a build the community missed for two years -- it was allocating 13
  points optimally for a MAXED level-62 account's upgrades, which is a different problem with a
  different answer.
  **The fixtures also carry a `mode`**: 9 of 82 Borge and 5 of 66 Ozzy builds are `push`, not
  `loot`. Judging those on loot/min fails them for succeeding at what they were built for.
  `tools/bench/run.js` already handles both correctly (own-state config, per-build objective). The
  lesson is not "be careful with cfgFor" -- it is that a THIRD comparison path written in a console
  is the parallel-implementation trap this file bans, and the existing gate should have been used.
- **CURRENT BASELINE, all three hunters, explicit hunter, stat vocabulary confirmed per hunter,
  Complete effort (archiveEvals 9600):**

  | hunter | account build | optimizer | delta | time |
  |---|---|---|---|---|
  | borge@60 | 142,839,497 | 142,839,497 | 0.00% | 170s |
  | ozzy@62 | 35,148,029 | 40,538,505 | +15.34% | 261s |
  | knox@26 | 3,078 | 3,646 | +18.48% | 153s |

  **No quality defect remains on any hunter.** Ozzy is 3 of 3 seeds since the archive budget went
  4800 -> 9600 (see the reachability entry); the remaining open question is COST, not correctness.

- **Selection strategy is `curiosity` by default because it is strictly better, not because it
  works.** 2 of 3 seeds against random's 1 of 3, and higher on both seeds where both succeed.

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
node tools/bench/node-coefficient-check.js # ship node coefficients vs the GAME'S AUTHORED values
node tools/bench/ship-node-gate-check.js # install prereqs + base caps vs the GAME (77 nodes)
node tools/bench/node-counter-check.js  # each node's 'per X' counter vs the GAME (77 nodes)
node tools/bench/node-name-check.js     # node names vs the game's fleet tooltips (77 nodes)
node tools/bench/node-effect-probe.js  # every install node actually moves the output
node tools/bench/all.js                # the WIRED gates in one run; SKIP is reported, not hidden
# NOT every gate. Measured 2026-09-06: 137 bench files, 63 named in all.js. Most of the remainder
# are libraries, extractors, reporters or manual A/Bs -- but ~12 are real gates that nothing runs,
# `search-quality-check` among them (the one that asks whether the search can FIND a build rather
# than merely keep the incumbent it was handed). Audit with:
#   comm -23 <(ls tools/bench/*.js | xargs -n1 basename | sed 's/.js$//' | sort) \
#            <(grep -oE "'[a-z0-9][a-z0-9-]+'" tools/bench/all.js | tr -d "'" | sort -u)
# This is the exact shape of the underspend-test incident below: a gate outside every list fails
# invisibly. Claiming "EVERY gate" while a dozen sit unwired is worse than claiming nothing.
node tools/bench/all.js --bundle=<live-bundle.js> --strict
node tools/bench/node-resource-check.js # which RESOURCES each node boosts, vs the GAME
node tools/bench/fleet-formula-check.js # the per-node bonus COMPOSES as the game does
CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-resources.py --write
node tools/bench/uniform-term-check.js # omitted per-node terms are provably 1 until bought
node tools/bench/badge-check.js        # fleet badges: ships + multipliers vs the GAME
node tools/bench/node-factor-check.js  # EVERY factor in every node getter is accounted for
node tools/bench/param-plumbing-check.js # every sim param is settable into its own slot
node tools/bench/trinket-semantics-check.js [live-bundle.js] # galvTrinketsCount is a SUM, gated on creation node 5
node tools/bench/boss-target-check.js   # the boss objective aims at the NEXT unbeaten boss
node tools/bench/boss-parity-check.js  # optimizer never clears FEWER bosses than the reference
node tools/bench/describe-run-check.js # describeRun's regimes + which boss a run contests
node tools/bench/effort-option-check.js # a misspelled effort flag throws instead of no-oping
node tools/bench/boss-damage-ab.js --only=borge@73 # does banding by boss damage help, end to end
node tools/bench/eval-precision-check.js # how precise is a FINAL_ITERATIONS score (report)
node tools/bench/import-legality-check.js # every import is reproducible by the optimizer
node tools/bench/support-rank-check.js # where the import's own support ranks in screening
node tools/bench/override-liveness-check.js # every override the UI offers reaches the evaluator
node tools/bench/wasm-arity-check.js   # wasm argument count == params.json, per hunter
node tools/bench/reference-schema-test.js # zod: every reference file matches its schema
node tools/bench/app-schema-test.js    # zod: params.json, the store, the save fixture
node tools/bench/growth-counter-check.js # per-run counter classification + zero-counter warning
node tools/bench/allocator-check.js     # allocator vs a reference greedy, ALL 7 ships
python tools/il2cpp-cli/typetree.py --dump FleetManager --grep BaseBonus  # read authored data
node tools/bench/relic-arg-probe.js    # every declared relic reaches the wasm (fast)
node tools/bench/path-relic-test.js    # effective path never recommends an inert relic
node tools/bench/path-abort-test.js    # closing the Effective Path actually stops the work
node tools/bench/search-quality-check.js  # can the search FIND the import with no incumbent?
node tools/bench/budget-monotonicity-check.js # more budget never scores worse, in every mode
node tools/bench/underspend-diagnose.js <hunter> <index> # WHICH stage loses the value
node tools/bench/route-test.js         # unknown hash routes normalise instead of hard-locking
node tools/bench/relic-sweep.js        # which relics actually move the sim (slow)
node tools/bench/gem-coverage-test.js  # every gem param is reachable from the Gem Planner
node tools/bench/gem-tree-test.js      # tree shape + every unlock gate is satisfiable
node tools/bench/gear-install-check.js  # which install node each gear piece buffs, vs the GAME
node tools/bench/gear-name-check.js     # gear piece names + set-bonus resources, vs the GAME
node tools/bench/inscryption-slot-test.js # inscryption slot map vs the game; must be a bijection
node tools/bench/save-gate-test.js     # caps/gates vs a REAL save (skips if none pulled)
node tools/save/inspect.js <DATA.text> [regex]            # decode + inspect a real save
node tools/bench/save-coverage.js      # which tool inputs the save could auto-fill (report)
node tools/bench/loopmod-test.js       # loop-mod table vs a real save (report)
node tools/bench/scene-defs-test.js    # our caps/costs vs the GAME's own scene data
CIFI_APK=apk-0.7.3.61 python tools/bench/export-scene.py  # AssetRipper scene export for a build
node tools/bench/extract-scene-defs.js <MainScene.unity> --write  # -> scene-defs.json
node tools/bench/inscryption-cost-check.js <live-bundle.js> # inscryption costs vs the original
node tools/bench/gate-coverage.js <live-bundle.js>        # our gates vs the bundle's
node tools/bench/upgrade-item-parity.js <live-bundle.js>  # every item's cap + control type
node tools/bench/talent-attribute-parity.js <live-bundle.js> # talents/attrs/stat caps
node tools/bench/attribute-tree-check.js # the attribute DEPENDENCY tree vs the GAME
node tools/bench/cap-raise-check.js    # every cap the GAME can RAISE is accounted for
node tools/bench/real-account-optimizer-check.js # optimizer vs the REAL save build
node tools/bench/attr-save-order-check.js # save slot -> attribute, derived from the GAME
node tools/bench/sim-gate-probe.mjs    # which gated upgrades the SITE gates in the SIM
node tools/bench/save-mapping-check.js # every save field the importer reads, and its caps
CIFI_APK=apk-0.7.3.61 python tools/bench/cap-raise-audit.py --write
CIFI_APK=apk-0.7.3.61 python tools/bench/extract-attribute-tree.py --write
node tools/bench/relic-tier2-check.js [live-bundle.js]    # tier-2 relic caps vs the GAME
CIFI_APK=apk-0.7.3.61 python tools/bench/extract-relic-tier2.py --write  # -> relic-tier2.json
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

- **Parity** — clone's loot score vs the score recorded for that code. **FIXED 2026-09-06: parity
  is now a two-sided DIAGNOSTIC and fails nothing.** It used to fail any build scoring ABOVE its
  recorded number, on the premise that "nothing can make it land above one" — which the full
  182-build sweep disproved (three overcount +4.7% to +7.2%, three undercount −5.4%, the direction
  FLIPPING between adjacent levels 72/73/74, clustered at the stage-300 boss boundary where the
  metric is threshold-sensitive). A recorded score and a code-only evaluation describe DIFFERENT
  ACCOUNT STATES, so the sign of their difference carries no information, and all 3 remaining "gate
  failures" were this rule misfiring on correct builds.
  **The tool's purpose is to propose a sane structure, not to replicate cifi-tools, so a build
  scoring well is the goal rather than a defect.** What parity is still good for is NON-UNIFORM
  error: a constant bias cannot reorder candidates, but one that flips sign between neighbouring
  levels can — so the summary now prints the parity SPREAD (min..max, mean) instead of an overcount
  count. Judging against what the ORIGINAL TOOL reports for the same code
  (`compare-mcp/batch-test.mjs` drives the live site) remains the stronger check and is still not
  wired in.
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
# Pending CLAUDE.md entries (2026-09-07)

- **THE R-SPLINE GRADIENT STEP IS UNTESTED, NOT REFUTED, AND FOUR IMPLEMENTATIONS OF IT FAILED.**
  The framing is sound and worth keeping: this problem is integer-ordered Discrete Optimization via
  Simulation (noisy simulation objective, integer variables, local convergence), and R-SPLINE
  alternates NEIGHBORHOOD ENUMERATION -- our VND -- with a gradient step from piecewise-linear
  interpolation, which we have never had. A gradient direction moves EVERY variable at once without
  needing a linkage model, a donor or subset enumeration, which is structurally the move our set
  cannot express. The finite differences are also nearly free: a VND sweep already evaluates every
  single-variable move and discards all but the argmax, and the evaluator is deterministic so those
  differences are EXACT rather than noisy.
  Four attempts, all inert, each with a different cause:
    1. `slope > 0` filter -- empty BY DEFINITION at a local optimum, which is the only place the
       pass runs. Direction must come from RANKING (slope vs mean), not sign.
    2. Per-block direction -- rebuilt the exact cross-block limitation it existed to remove.
    3. A stray brace from a bad patch.
    4. Joint direction, still ~9-12 extra evaluations: the probe frees a point from the cheapest
       non-zero node, which on a threshold-constrained Borge breaks a tier gate, so most probes fail
       legality and are skipped.
  Measured: ozzy@11 -2.02% -> -2.02% (293 evals vs 281), borge@73 +2.37% -> +2.37% (1124 vs 1115).
  **borge@73 is also a poor test bed and ozzy@11 is worse**: a gradient needs resolution, and
  ozzy@11 funds 5 of 15 attributes. If retried, fix the probe to respect tier thresholds first.

- **GOM AND PATH RELINKING SHIP DELETED, NOT DISABLED.** Both measured inert post-convergence
  (see the elite-set entry): every donor-based method is bounded by a corpus that, after the climb,
  is worse than the build in hand. Their measurements are recorded; the code is gone.
