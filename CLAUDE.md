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
    **Known modelling gaps, both uniform-per-ship so they shift magnitude more than ranking:** the
    `GemPerks` factor is not modelled at all, and we model `FinalShip1InstallsBonus` only as Fleet
    Analysis 2 (`computeFleetResearchShipMultipliers`, correctly empty when FA2 is 0 — FA1 grants
    only the 5x CAP, not an effect multiplier).
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
- **`GROWTH_VALUE_BOOST = 1.5` is the remaining invented constant, and NOTHING TESTS IT.** It scales
  nodes whose gear counter grows during a run, and it applies to **5 of 7 ships** — Zagreus 3/11,
  Hephaestus 4/11, Demeter 8/11, Koios 7/11, Zeus 7/11 — but to **zero Cradle nodes**, and Cradle is
  the only ship `sirred-algorithm-check.js` and `real-save-optimizer-check.js` cover. So the two
  benches that just certified the allocator cannot see it at all. The effect it models is real and
  directional (a counter that climbs during a run does deliver more than its snapshot); the
  magnitude is a guess, and on Demeter it reorders 8 nodes against 3. **Do not "fix" it by
  substituting another invented number** — either extend the allocator benches to a growth-heavy
  ship, or derive the multiplier from run dynamics.
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
