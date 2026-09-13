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
node tools/build-companion.js          # rebuild extension/ (scoped CSS, shell.js, vendor/)
node tools/build-companion.js --check  # fail if extension/ has drifted from webapp/public/
node tools/bench/companion-deps-check.js # the extension's script subset + LOAD ORDER is sound
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
