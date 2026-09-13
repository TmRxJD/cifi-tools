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
- **THE EFFECTIVE PATH DECIDED AT 100 ITERATIONS AND WAS RANKING NOISE -- the "recommends a 2-year
  wait when a 2-day upgrade exists" report.** A path step compares candidates whose real gains are
  ~0.5-2% of loot. On a real level-64 Ozzy at one mat2 decision: at 100 iterations effect->45
  -1.56%, evade->37 -8.72%, dr->57 -2.94% (ALL negative); at 5000 all three are real gains, +1.96 /
  +1.38 / +0.65%. The path picked the least-bad noise -- a 233-day purchase -- over a 6.9-day one
  worth ~24x the gain per cost. It now decides at FINAL_ITERATIONS (`PATH_ITERATIONS`), at ~10x the
  evaluation cost (357ms vs 36.5ms per eval on that account). **Most of the resulting slowness was
  the worker pool, not the fidelity:** `ScoringPool.score` placed item i on worker `i % n`, so the
  path's concurrent per-currency batches ALL started at worker 0 while the rest idled. A shared
  queue took the level-63 Ozzy build-card path 40.9s -> 20.1s and the stats path 18.8s -> 11.4s,
  identical order in every column. The stats path is now at its floor: 30 sequential steps x one
  ~360ms evaluation. **Lazy (CELF-style) re-scoring was tried and REJECTED:** no faster (39.9s,
  because the pile-up, not eval count, was the bound) and it changed the inscription order at
  step 4 -- a candidate's gain can RISE after another purchase, so stale gains are not bounds. Time-to-afford
  is cost / income within one currency, so gain-per-cost ALREADY is gain-per-day: the horizon
  discount added alongside changed nothing at its 30-day default on that build. The fix was
  fidelity, not a formula.
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
- **ABSENCE OF A `Final*MaxLevel` PROPERTY IS THE EVIDENCE THAT A CAP IS STATIC, and it is now
  asserted.** `cap-raise-check.js` fails if one ever appears for hunter ATTRIBUTE caps, TIER-2
  RELIC caps, or any talent other than Borge skill 6 -- so "attribute caps cannot be raised" is a
  checked claim rather than an assumption. It also fails if `FinalBorgeSkill6MaxLevel` DISAPPEARS,
  since our `dynamicMaxLevel` would then be raising a cap the game no longer raises.
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


