# cifi-compare MCP server

Sanity-checks the local HunterSim clone's calculations against the live cifi-tools.com site,
without ever sending raw page content through the model. Both sides run the exact same
`release.wasm` binary (the clone's copy is extracted verbatim from the live bundle -- see
[webapp/public/hunterSimBrowser.js](../webapp/public/hunterSimBrowser.js)'s header comment),
so any mismatch always means the build/state we constructed differs, never a reimplemented
formula bug.

## How it works

1. **`get_clone_stats`** -- drives a headless Chromium page against the local webapp
   (auto-starts `webapp/server.js` if it isn't already running) and calls
   `window.HunterSim.evaluate()` in-page, the same function the real UI uses.
2. **`get_live_stats`** -- generates a real build-share code with
   [build-code.mjs](build-code.mjs) (a Node port of `webapp/public/buildCode.js`, byte-compatible
   with the live site's own format), imports it into a fresh guest session on
   `https://cifi-tools.com` via "Import with Upgrades", saves the build, and reads back the
   "Main Statistics" panel (Loot Score / Ø Stage / Ø Time / Runs per Day).
3. **`compare_builds`** -- runs both of the above for the same build and returns a small
   percent-delta summary, flagging anything outside ~2% (normal Monte Carlo sampling noise
   for a 1000-iteration run).
4. **`list_hunter_defs`** -- talent/attribute ids + maxLevels per hunter, so you know what's
   valid to put in a build without reading `hunterDefs.js` yourself.

## Build input shape

```js
{
  level: 41,
  talents: { impeccable: 10, pog: 15 },       // talentId -> level
  attributes: { ares: 1, spartan: 6 },        // attributeId -> level
  baseStats: { hp: 210, atk: 188, dr: 32, ... }, // forced on both sides -- see hunterDefs.js
                                                  // baseStatKeys per hunter
  globalUpgrades: { 'relics.r4': 13, 'inscryptions.i3': 8 }, // flat "category.field" -> level
}
```

`baseStats` and `globalUpgrades` are forced as explicit overrides on both sides (via the
build code's override fields on the live side, via `state.hunterStats`/`state.upgrades` on
the clone side) so a comparison never silently depends on either environment's ambient
default state.

## Manual test

```bash
node example-compare.mjs
```

## Known limitation: share codes can't carry every param (2026-07 finding)

Verified byte-for-byte against the live bundle (`cifi-tools.com/assets/evaluationWorker-*.js`
and `index-*.js`) that the local clone's `release.wasm` (SHA-256 match), `params.json`
(101-entry `EVAL_PARAMS` list, identical order) and `buildCode.js`'s `CODE_PARAMS` (74-entry
share-code field table, identical order) are all currently in sync with the live site --
base-value mirroring is confirmed, not assumed.

However, **share codes only encode 74 of the 101 real simulation params.** Seven params exist
in `EVAL_PARAMS`/the wasm signature but have no slot in `CODE_PARAMS`: `attraction_gem3`,
`attraction_lootBorge`, `evolution_gem2`, `exodus_gem1`, `exodus_temporalEvolutionCount`,
`innovation_gem5`, `creation_galvTrinketsCount` (Borge's set -- Ozzy/Knox differ slightly).
These are ambient, account-wide gem-tree investments that live only in a real account's
persistent state, never in a per-build share code.

Batch-testing ~80 of a user's real progression build codes (`known-builds.mjs`,
`batch-test.mjs`) showed **exact agreement (<0.3%, within Monte Carlo noise) through their
first ~48 levels**, then a growing divergence starting exactly at the build the user had
labeled "assume AttGN3/CreaGN3/InnoGN3 activated." Root cause: `get_live_stats`/`batch-test.mjs`
can only reach the live site via a guest-session share-code import (no login), so any of those
7 un-encodable params stay at their guest-default (0/off) on the live side while the user's
real logged-in account has them active. **This is a limitation of the guest-import test
method, not evidence of a clone calculation bug** -- confirmed by the wasm/params/CODE_PARAMS
hash matches above. Builds that don't depend on those 7 fields will always agree exactly;
builds that do will show a live-side reading that's an *undercount* relative to the user's
real account (never an overcount), growing with how much ambient gem investment the account
has.

Closing this gap fully would require driving the live site's actual Gems planner UI (toggling
those specific node checkboxes on a logged-in session) instead of a share code -- not yet
implemented here.

**Ozzy/Knox result (2026-07):** batch-tested all 66 of the user's real Ozzy build codes
(`known-builds-ozzy.mjs`) the same way, including several past the level where the user's
own notes say the same AttGN3/CreaGN3/InnoGN3 assumption kicks in -- **all 66 matched within
0.5% (Monte Carlo noise), zero flagged.** So the 7-param share-code gap exists for Ozzy too
(confirmed by diffing its `CODE_PARAMS`/`EVAL_PARAMS` the same way), but this particular
account's real values for those specific fields happened not to move the needle enough to
show up outside noise -- unlike the Borge account's higher-level builds, where they did.

Also note: on a fresh guest session, Ozzy/Knox's sidebar nav link is hidden (gated behind
Exodus-gem-level/account-level unlock conditions client-side, mirroring the real in-game
unlock), so a guest session can never click it into view. The route isn't actually gated
server-side though -- `live-eval.mjs` navigates directly to `/ozzy`/`/knox` rather than
clicking the (invisible) nav link.

## Real bug found and fixed: imported builds always got Level 1 (2026-07)

Batch-testing 34 real Knox build codes turned up a genuine product bug (not a test-harness
issue): every one of them showed a consistent -2% to -4% clone-vs-live gap even at trivial,
low-investment levels where the gem-param gap above couldn't be the cause. Traced to
`webapp/public/buildCode.js`'s `parseBuildCode()`: **no hunter's share-code param table
encodes "lvl" at all** (confirmed against the live bundle), so every import left `build.level`
stuck at its `newDraftBuild()` default of 1, regardless of the account's real level.

This barely affects Borge/Ozzy's loot formula (their computed stats already carry level's
effect, so the raw `lvl` wasm argument matters little) which is why it stayed hidden through
~150 build-code comparisons on those two hunters. Knox's formula reacts to it much more
directly (confirmed empirically: forcing the correct level on an otherwise-identical Knox
build closed the entire gap). It's a real bug in the actual webapp, not just this comparator
-- anyone using "Import Build"/"Import with Upgrades" on a Knox build was getting a silently
wrong Level and consequently wrong stats/loot score.

**Fix:** `parseBuildCode()` now infers level from the imported talents when no "lvl" param
exists, using `talentBudgetForLevel(level) = level` (1 talent point per level, confirmed in
`hunterDefs.js` and cross-checked against the live site's own displayed level after import)
in reverse: `level = sum(imported talent levels)`. Verified this matches the live site's own
displayed post-import level exactly (e.g. a Borge build whose talents summed to 41 shows
"Level 41" on import). After the fix, all 34 Knox builds matched within 0.2% (Monte Carlo
noise), zero flagged.

## Registration

Registered in the repo root's `.mcp.json` so Claude Code picks it up automatically for this
project. Run `npm install && npx playwright install chromium` once inside `compare-mcp/`
before first use.
