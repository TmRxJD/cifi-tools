# Academy mechanics — extracted from the game (CIFI 0.7.3.61)

Source of every fact here: the game build itself, not the wiki and not cifi-tools. cifi-tools does
not publicly model missions or projects (its Mission Planner is unreleased and gated), so under
CLAUDE.md's rules this is **our territory: APK proof required**. Each line says where it came from:

- `tt:<Class>.<field>` — authored serialized value, `CIFI_APK=apk-0.7.3.61 python tools/il2cpp-cli/typetree.py --dump <Class>`
  (Missions, ConstructionProjects, SpaceAcademyMain need `--backend AssetStudio --relaxed`).
- `cs:<Class>.<member>` — recovered C# (`B:\huntersim-re\full-0.7.3.61.cs`, or `csharp.py`).
- `rl:` — a field load named by `resolve-loads.py` (Cpp2IL printed `(BigDouble)0` there — a MISSING
  OPERAND, not a zero).

Status column: **proven** = read directly; **shape** = formula shape read, some operand still needs
`resolve-loads`/`analyze.py`; **todo** = not yet extracted.

## Naming

Mission getters are hand-written per mission: `<P><T>M<Mission><n>`, where P = planet
(`W` Wasta, `C` Cryton, `E` Egetuar, `S` Sekhur), T = `C` campaign (1..12) or `F` farm (1..4), plus
`WFMAdvancedMission1..3` etc. (advanced farms, no Sekhur). Save fields use the full planet name
(`WastaFarm1Personnel1OnMission`, `WastaCampaignProgress`). The save also has `Delmakiar` and
`KarsonKrax` planet fields that no current Missions getter reads — **todo: confirm unreleased.**

## Personnel (proven, tt:Personnel)

| Type | BaseOutput | EvoExponent | MaxEvo | EvoRequirement | StartCost | CostExponent |
|---|---|---|---|---|---|---|
| Mining Pod (T1) | 1 | 0.5 | 5 | 50 | 1e995 | 1e5 |
| Fireteam Carrier (T2) | 3 | 1 | 5 | 50 | 1e1250 | 1e10 |
| Titan Hauler (T3) | 8 | 2 | 5 | 50 | 1e1750 | 1e25 |
| Combat Corvette (T4) | 16 | **4** | 5 | 50 | 1e3000 | 1e50 |

The wiki says the corvette gains +3 per evolution. The authored value is 4.

`cs:Personnel.<Type>IndividualOutput` = `BaseOutput (+ evo term, shape) + LM.Personnel<n>MPBonus
+ GN.FinalPower<n>Bonus3 + MultiverseMarket(+0x2970..0x29A0)`; corvette also `+ Badges.FinalBadge20Bonus`.
Evo term: the `cvtsi2sd/mulsd/addsd` notes are `EvoExponent * evoLevel` added to base — **shape, verify.**
`LM.Personnel<n>MPBonus = LM182BonusExponent1*x + LM178BonusExponent1*y + LM236Bonus2` (loop mods).

## Mission time (shape, cs:Missions.WFMMission1SecondsCalculation)

```
power    = Σ_type  assigned[type] * IndividualOutput[type]
seconds  = SecondsPerMP * MPRequirement / power / MissionTimeDivision
seconds  = max(seconds, 2)            # clamps at 2s; sets <mission>Maxed
```
`tt:Missions.SecondsPerMP = 3600`. MPRequirement per mission is authored (below).
Personnel beyond `MaxPersonnel` cannot be assigned (tt `<m>MaxPersonnel`, campaigns also
`Final<m>MaxPersonnel` getters — relic 11 "Campaign Max Crew" — **todo**).

`cs:Missions.MissionTimeDivision = 2*Badge6Bonus1 * LM.TotalMissionSpeedReduction
* RL.FinalMissionSpeedBonus * ORelics.FinalRelic3Bonus` — the `badge6+badge6` is how Cpp2IL printed
it; **verify with analyze.py before trusting the factor 2.**
- `LM.TotalMissionSpeedReduction = LM225BonusExponent1 * LM219BonusExponent2` (cs, operands via
  cvtsi2ss of LM levels — shape).
- `RL.FinalMissionSpeedBonus = FinalRU70Bonus5 * FinalRU58Bonus * FinalRU80Bonus5` (cs:ResearchLaboratory
  setter block ~line 1316798).

## Mission rewards (proven shape)

Per completed mission: `Final<m><Mat>Reward = <m><Mat>BaseReward * TotalMaterialBonus * TS7`.
AP/XP analogous (AP out of scope). Per-minute getters divide by `seconds/60`.

`cs:Missions.TotalMaterialBonus` (after the first Ouroboros reset; rl names the loads):
```
RUAcademy3 * RUAcademy6 * 0.13(?) * RL.FinalMissionMaterialsBonus * LM.TotalMissionMaterialsBonus
* SM.FinalMissionMaterialBonus * ConstructionProjects.FinalMatsBonus * DS.FinalMissionMatsBonus
* IAP.TotalMatsBonus * TS.FinalTS24Bonus * FM.RUOuro4Bonus * GN.Temporal3Bonus2 * GN.Creation3Bonus1
* OR.FinalMeltdownPower * 0.53(?) * ORelics.FinalRelic20Bonus * NE.FinalExchangeOutput * LMOuro25Bonus3
* ZN.Gadget8Bonus1 * LMOuro31Bonus * LMOuro32Bonus2 * ConstructionMilestones.FinalMatsBonus
* (+0x2250 of type @76179368, todo) * GN.Innovation4B1 * Innovation5B1 * Innovation5B2 * Creation4B4
* ORelics.FinalT2Relic2Bonus * Exodus2Bonus1 * Inventory(+0x798, todo)
```
Before the first Ouroboros reset it is the short chain
`RUAcademy3*RUAcademy6*1.08(?)*RL*LM*SM*CP*DS.DU16*IAP*TS24*RUOuro4`.
The `0.13`/`1.08`/`0.53` literals are how Cpp2IL printed an operand — **verify with analyze.py.**
The Meltdown factor in the Ouroboros chain means ship Meltdown matters for materials.

- `LM.TotalMissionMaterialsBonus = LM168*LM200*LM217B2*LM219B5*LM221B2*LM225B3*LM227B4*LM246B3*LM284` (cs).

## Fragments (proven shape, cs:OuroRelics)

```
farmFragsPerCompletion     = (BaseFragmentsGainedFromFarmMissions + AdditiveFarmFragmentsBoost) * FarmFragmentsMult * <m>FragmentsExponent
campaignFragsPerCompletion = (BaseFragmentsGainedFromCampaignMissions + AdditiveCampaignFragmentsBoost) * CampaignFragmentsMult * <m>FragmentsExponent
AdditiveFarmFragmentsBoost     = Relic5 + GN.Power3Bonus4 + Market(+0x2900) + ZN.Gadget12Bonus1 + RL(+0x5EE0)
AdditiveCampaignFragmentsBoost = Relic6 (bonus 1)
FarmFragmentsMult     = TS7 * DarkBadge5 * RL(+0x5F10) * RL(+0x5EF0) * GN.Attraction4B1 * GN.Power4B4 * Market(+0x2910)
                        * LM264B1 * LMOuro42 * T2Relic8 * Exodus2B2 * (+0x230 todo) * Creation5B2 * (+0x638 todo) * TS18 * (+0x700 todo)
CampaignFragmentsMult = Relic6Bonus2 * SM.SU0Bonus4 * GN.Attraction1B1 * … (todo: rest)
```
**Who pays fragments (cs:Missions.CompleteFarmMission / CompleteWCMMission<n>):** EVERY farm
completion pays `FinalFragmentsGainedFromFarmMissions` (the generic `CompleteFarmMission` handler),
and EVERY campaign-mission completion pays `FinalFragmentsGainedFromCampaignMissions` — both gated
on `OuroResetsPerformed > 0 && Ship7OuroUnlock`. Fragment income therefore scales with completions
per hour, which the 2-second mission floor caps at 1800/hour per mission slot.
Authored (tt:OuroRelics): base farm 0.001, base campaign 2.5; per level r3 0.03 (speed ×(1+0.03L)),
r5 +0.001 farm, r6 +2.75 campaign and ×1.05^L, r10 +2 (project time ÷(1+2L)), r11 +0.5 (campaign
crew), r20 ×8^L (`Pow(Relic20BonusPerLevel, level)`). These match cifi-tools' relic descriptions.
On top of the per-completion amount, the fragment farm (mission 4) and campaign mission 12 carry a FragmentsExponent:
farm 4 = W 1 / C 5 / E 50 / S 200; campaign 12 = W 1 / C 2 / E 12 / S 18 (tt).
Research feeds fragments through `FinalFarmFragmentsBonus (RU82+RU93)`, `FinalFarmFragmentsMultBonus (RU104)`,
`FinalCampaignFragmentsBonus (RU89)`, `FinalAllFragsBonus (RU97)` (cs, ~line 1316815).

## Zeus rank (proven, cs:Missions.Ship7OnMissionCompletion)

Each completion adds `(advanced ? 10 : 1) * TS7` to `Ship7RankProgress` and to the
`MissionsCompleted*` counters. Offline completions use the same rule times the offline multiplier.
**This is the Zeus Rank mechanic that makes short farm missions worth running.**
Zeus rank → install capacity → Zeus academy nodes (`RUAcademy*`), modelled in `shipSchema.js`.

## Construction projects (proven, tt:ConstructionProjects + cs)

```
cost_i(level)  = floor( round(BaseCost_i * (CostExponent + ExtraExponent)^level) / ProjectCostDivision
                         * [post-Ouro, level>=100] 1.1^(level-99) * 1.1^(level-199) * … per 100 levels to 1000 )
seconds(level) = max(0.1, (BaseSeconds + level*SecondsIncreasePerLevel) / ProjectTimeDivision)
                 (projects 10/11: SecondsIncreasePerLevel*10, and capped — todo)
ProjectTimeDivision = RL.FinalProjectsTimeDivision * LM.TotalConstProjectDivider * Relic10 * GN.Power3Bonus1
ProjectCostDivision = RL.FinalProjectsCostDivision * GN.Power3Bonus2
RL.FinalProjectsTimeDivision = RU72Bonus1 * RU62Bonus1
RL.FinalProjectsCostDivision = RU72Bonus2 * RU62Bonus2  (RU94 computed alongside — verify whether applied)
LM.TotalConstProjectDivider  = 1 + LM221BonusExponent1 * level
```
Post-Ouroboros surcharge: the decompile shows a `1.1^(level-k)` multiplier stacking at every 100
levels from 100 to 1000 — **shape, verify.** `ExtraExponent` loops over `min(level/100, 600)` — todo.

| # | BaseSec | +Sec/lvl | CostExp | Base costs | Bonus |
|---|---|---|---|---|---|
| 1 | 180 | 60 | 1.25 | 600, 200 | ×4 |
| 2 | 320 | 120 | 1.4 | 2750, 1500, 500 | ×2 |
| 3 | 840 | 180 | 1.7 | 2400, 1000, 500 | ×2 |
| 4 | 1680 | 240 | 1.4 | 7000, 5000, 1500, 1000 | ×2 |
| 5 | 2700 | 300 | 1.6 | 1000, 200 | ×2 |
| 6 | 3600 | 360 | 2 | 2.6e5, 1.2e5, 2.8e4, 5e3 | ×1.25 |
| 7 | 24400 | 3600 | 3 | 1e38, 4e37, 7e36 | ×3, ×2.5, ×1.6 |
| 8 | 38800 | 7200 | 3.2 | 2e45, 5e44 | ×2.3, ×2.1, ×1.9 |
| 9 | 64400 | 14400 | 18 | 3e55, 6e55, 8e54 | ×7, ×1.75 (mission mats) |
| 10 | 4.566e7 | 4e7 | 33 (exp2 1.3) | 5e950, 5e930, 2400, 210 | 1e100, 0.02 |
| 11 | 2.56e7 | 6e7 | 43 (exp2 1.3) | 5e1020, 5e1015, 8000, 830 | 15, 1e10, 0.02, 10 |

Which materials each `Cost_i` consumes: **todo** (read `BeginProject<n>`).
`cs:ConstructionProjects.ProjectsCompleted = Project5Level + Project9Level + Project10Level + Project11Level`
as printed — clearly a partial sum from SIMD `phaddd`; **the real sum covers all 11, verify.**
Innovation core every `InnovationCoreRequirement = 4` completions (tt). Expansion requirement
`(ProjectsMainPageLevel+1) * 10` projects, 7 expansions (tt).

## Construction milestones (proven, tt:ConstructionMilestones)

60 milestones. Requirement (blueprints) and bonuses are authored; `tt` has the full table
(Milestone1..60 Requirement/BonusN/Ship<k>Points). Which resource each `BonusN` targets: **todo**
(read `ConstructionMilestones.SetBonuses`); the wiki table for 1–33 is a lead only.

## Verified against an independent source

`MissionTimeDivision` starts at `Badge6Bonus1 + Badge6Bonus1` — 2 without the badge
(tt:Badges.Badge6Bonus1 = 2 when acquired). With that factor, cifi-tools' published farm table falls
out exactly as `MPRequirement × 60 / 2` minutes: F1-3 80 → 2400, F2-1 5 → 150, F2-4 4400 → 132000,
and every maxCrew equals our authored MaxPersonnel. Two independent readings, one number.

## Badges read by the academy (tt:Badges)

Badge6Bonus1 = 2 (mission speed), Badge20Bonus1 = 30 (flat corvette power), DarkBadge5Bonus = 1.25
(farm fragment multiplier).

## Resets (inferred — callers are Unity-event wired and cannot be traced statically)

- `FleetManager.ResetVariables` zeroes every `Ship{n}Rank/RankPoints/RankProgress`, the
  `RU1/5/9/13Academy` installs, and rolls `MissionsCompletedThisLoop → LastLoop` — the LOOP reset.
  So Zeus rank restarts every loop.
- `SpaceAcademyMain.ResetVariables` zeroes personnel, projects, milestones, blueprints, badges and
  campaign progress — the Ouroboros traversal.

## Zeus rank (shape, cs:FleetManager.Ship7RankRequirement / Ship7RankUp)

Rank-up consumes `Ship7RankRequirement` progress and grants +1 rank and +1 rank point.
Requirement starts from `Ship7StartRankRequirement = 4` with `Ship7RankExponent = 4` over
`floor(rank/3)+1`, then ×1.25 for each of rank ≥ 10, 20, …, 100 — **shape; verify with analyze.py.**

## Project cost materials (cs:ConstructionProjects.BeginProject<n>)

1 Difar, Kento · 2 Difar, Kento, Chromium · 3 Chromium, Exon, Organium · 4 Kento, Chromium, Exon,
Organium · 5 Adamorphium, Moskom · 6 Organium, Adamorphium, Moskom, Darkseid · 7 Difar, Exon, Moskom
· 8 Kento, Organium · 9 Chromium, Adamorphium, Darkseid · 10 Kento, Exon, Torkinstone, Pytoxene
· 11 Organium, Moskom, Pytoxene, Gigantium. (Wiki agrees for 1–9.)

## Bonus routing (cs)

Projects (`SetBonuses`): Mats = P9Bonus2 × P11Bonus4; FarmFrags = P11Bonus3; each `Project<n>Bonus`
= `(BaseBonus + gem terms)^level`. Milestones (`SetAllBonuses`): Mats = M46B1 × M52B1 × M55B1 ×
M59B1 × MU1B1 (each category product is then raised to an Ultima exponent). The full routing is
generated into academy-data.json by tools/bench/extract-academy.py.

## Save fields (proven against DATA-20260907)

Personnel `MiningPodLevel`/`…Evo` (and T2–T4), `currentRetainedPersonnel`; materials `<Mat>New`
(BigDouble) + `Claimable<Mat>`; `Project<n>Level/Active/Automated/SecondsProgress`; `Blueprints`,
`Milestone<n>Acquired/Progress`; `<Planet>CampaignProgress`, `<Planet>Farm<k>Active`,
`<Planet>{Farm<k>|Campaign}Personnel<t>OnMission`; `Ship7Rank/RankProgress/RankPoints`;
`RelicFragments`, `FragmentsThisTRFromFarm/Campaigns`; all 20 tier-1 relics as `AOR<n>Level`.

## Research (partly in repo)

`tools/reference/research.json` → `Academy` category (13 entries: MaxLevel/BaseBonus/Requirement)
and RU StartCost/GrowthExponent/Bonus. RU numbers feeding the academy:
mission speed RU58/70/80; project time RU62/72; project cost RU62/72(+94?); mission materials
RU55/60/67/70/77/80/87/99/106/113 chain; mission XP RU43/55/67/77; frags RU82/89/93/97/104.
