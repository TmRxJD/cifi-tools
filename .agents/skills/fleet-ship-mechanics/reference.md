# Fleet & ship mechanics

Split out of hunter-game-mechanics/reference.md -- crew/rank, evolution, install-node
math (coefficients, counters, gear multipliers, badges, Meltdown), gear sets, and the
fleet allocator. See hunter-sim-mechanics for the per-hunter evaluator/relic/optimizer half.

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
