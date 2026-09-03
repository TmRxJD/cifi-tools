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
  `purchasedCrewLevel`/`freeCrew` alongside the total. `unmodelledCrewRankTerms()` reports the two
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
  reference account -- and `unmodelledInstallBonusTerms()` reports when an account owns them.
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
    **What blocks the mapping:** the only sim consumer is
    `upgrades.gems_nodes.creation_galvTrinketsCount`, which the live bundle names "Galvarium
    Trinkets **Count**" while our `resolveParam` **sums** `state.upgrades.trinkets`. Sum-of-levels
    is 605; a count of owned trinkets is 3. A 200× error on a sim parameter is not worth guessing,
    and it is currently moot anyway — the param is gated at Creation gem 4 and the reference
    account is at Creation 1, so it resolves to 0 either way. Settle the Count-vs-sum question
    before wiring this up. (Per-trinket identity does NOT need settling: whichever way round the
    three go, the consumer aggregates them.)
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
node tools/bench/node-coefficient-check.js # ship node coefficients vs the GAME'S AUTHORED values
node tools/bench/ship-node-gate-check.js # install prereqs + base caps vs the GAME (77 nodes)
node tools/bench/node-counter-check.js  # each node's 'per X' counter vs the GAME (77 nodes)
node tools/bench/node-name-check.js     # node names vs the game's fleet tooltips (77 nodes)
node tools/bench/node-effect-probe.js  # every install node actually moves the output
node tools/bench/node-resource-check.js # which RESOURCES each node boosts, vs the GAME
node tools/bench/fleet-formula-check.js # the per-node bonus COMPOSES as the game does
CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-resources.py --write
node tools/bench/uniform-term-check.js # omitted per-node terms are provably 1 until bought
node tools/bench/badge-check.js        # fleet badges: ships + multipliers vs the GAME
node tools/bench/node-factor-check.js  # EVERY factor in every node getter is accounted for
node tools/bench/param-plumbing-check.js # every sim param is settable into its own slot
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
