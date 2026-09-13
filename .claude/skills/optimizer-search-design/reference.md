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
  `illuminate()` drops from SIXTEEN positional parameters to twelve. The MEASUREMENTS stay in this
  file so nobody re-runs them; only the code went, which is what "git history is the archive" means.
  **CORRECTED 2026-09-07: ONE OF THE FIVE IS BACK, AND THE KEY COUNT IN THIS ENTRY WAS STALE.**
  `bossDamageBands` was re-added to run the FI comparison two entries below (the `axis+FI off/ON`
  arms need the axis to exist), and it is still in the code today -- in `cellOf`, in `illuminate`,
  and in the whitelist. The whitelist is **18** keys, not 11. So this entry described a state the
  code left, in the file that is supposed to be the record of what the code does.
  That is the failure this file warns about in its own words -- "a comment describing a fix, and a
  CLAUDE.md entry describing a fix, are not evidence the fix exists" -- applied to itself, and the
  reason `tools/bench/effort-flag-audit.js` now derives the list from the source instead.
  The flag still ships OFF and is still measured redundant; what changed is only that the claim
  "it is deleted" stopped being true.
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
  **THE COUNTER-EXAMPLE THAT USED TO BE HERE NO LONGER HOLDS, AND THE REASON IS THE CORPUS.** This
  entry read: "archiveEvals 4800 -> 9600 was REQUIRED for Ozzy boss reachability (-66.27% at
  4800), so the archive is load-bearing for at least one build." That measurement was real and it
  is now STALE -- it predates corpus donors, which start the climb from a build that already pays
  the tier gates and already kills a boss, so the archive no longer has to discover that foothold.
  Measured after the corpus landed, `fast` (archiveEvals **1200**, an eighth of the budget the old
  note called insufficient) against `complete` (9600), solo, same build, both arms:

      borge@73  172s/13,983ev  vs  358s/37,228ev   2.08x faster   quality +0.00%
      ozzy@62   168s/ 9,542ev  vs  290s/21,728ev   1.73x faster   quality +0.00%
      knox@30    64s/ 7,970ev  vs  123s/20,027ev   1.92x faster   quality +0.00%

  ozzy@62 is the very build the old note was about, and at 1200 it now returns the SAME build as at
  9600. Across nine builds (levels 20-73) the median speedup is ~1.9x and the worst quality gap is
  -0.29%, inside the +-0.2% two-score sampling floor.

  **So `complete` currently buys 2.4x the evaluations and no measured quality**, on every build
  tested including the three hardest. That is a claim about the ARCHIVE, not about the search: the
  corpus donor and the VND climb decide these answers. Do not read it as licence to delete the
  archive -- it is what handles a build the corpus does not cover, and corpus coverage is known to
  be partial (borge 12-84, ozzy 11-75, knox only 12-40). Read it as: the archive budget stopped
  being the thing that decides boss reachability the moment donors did.

  The general lesson is the one this file keeps paying for: **a measurement is true of the system
  that produced it.** This one survived as a "must not be forgotten" counter-example through the
  change that invalidated it, and was still being cited to justify a budget nothing needed.
  `effort-value-check.js` is the standing measurement, so the next person re-runs it rather than
  quoting this paragraph.
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
