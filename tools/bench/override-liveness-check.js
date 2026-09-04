'use strict';
// Every override our UI offers must actually REACH the evaluator.
//
// Our Overrides panel is built from HUNTER_DEFS[hunter].globalUpgrades, so every item there is a
// control a user can type into. If setting one changes no argument, the input is dead: the tool
// silently discards it and shows no sign of doing so. That is the failure mode this project treats
// as unacceptable, and it was live -- the three trinket overrides fed nothing at all, because
// creation_galvTrinketsCount summed only `state.upgrades.trinkets` and ignored per-trinket
// overrides. The live-vs-clone diff could not see it: it compares which KEYS each tool exposes, not
// whether ours do anything.
//
// GATES ARE HELD OPEN. Several overrides only reach a parameter once a gem node is owned (trinkets
// need Creation 5). Probing with a default gem state would report those as dead and teach us to
// ignore the report, so the probe runs with every gem tree maxed.
//
//   node tools/bench/override-liveness-check.js [--verbose]

const H = require('./harness.js');

const sb = H.browserSandbox();
const verbose = process.argv.includes('--verbose');

function maxedGemState() {
  const st = sb.defaultGemState();
  for (const [key, tree] of Object.entries(sb.GEM_TREES)) {
    st[key].level = 20;
    st[key].nodes = new Array(tree.nodeCount).fill(true);
    for (const u of Object.keys(st[key].upgrades)) st[key].upgrades[u] = 10;
  }
  return st;
}

// Controls that reach nothing IN THE ORIGINAL TOO. Every one of these is a key the live bundle's
// own Overrides table exposes (live-override-diff.js confirms our tables match it) for which the
// evaluator declares no parameter -- newer content the wasm has not been taught, most likely. We
// mirror the original deliberately, so they are expected rather than broken, and they are listed
// individually so a NEW dead control cannot hide among them.
//
// This is an allow-list and not a rule like "no own parameter means it is fine to be dead", because
// that rule would have excused the bug this bench was written for: the trinket overrides have no
// parameter of their own either -- they feed the derived creation_galvTrinketsCount -- and they
// were silently discarded for real accounts.
// `upgrades.loopmods.roe` WAS on this list and should never have been. It has no slot in
// params.json, and that was taken as proof it does nothing -- the exact inference the comment
// above warns against. Measured against the site with the value in its account state, XP per run
// goes 6,660,000 -> 49,220,000 at roe = 20000 (x7.3904 against the x7.3883 its own 1.0001-per-level
// declaration predicts). The site applies it OUTSIDE the evaluator; hunterSimBrowser.js now does
// the same, so it is live here and no longer belongs on an inert list.
// Applied to the evaluator's OUTPUT rather than passed in as an argument, so "changed no argument"
// is the wrong test for these -- they are live, just by a different mechanism. Read from HunterSim
// itself rather than restated, so adding one there cannot leave this list stale.
const POST_SIM = new Set(
  (sb.HunterSim.POST_SIM_XP_MULTIPLIERS || []).map((m) => m.key),
);

const KNOWN_INERT = new Set([
  'upgrades.cms.cm58',
  'upgrades.cms.cm_ultima',
  'upgrades.cms.cm_ultimas',
  'upgrades.mats_exchange.tysconDrives',
  'upgrades.inscryptions.i114',
  'upgrades.inscryptions.i115',
  'upgrades.researches.res112',
]);

(async () => {
  let failures = 0;
  let checked = 0;
  let inert = 0;

  for (const hunter of ['borge', 'ozzy', 'knox']) {
    const defs = sb.HUNTER_DEFS[hunter];
    const base = {
      hunterStats: {}, talents: {}, attributes: {}, upgrades: {}, overrides: {},
      level: 60, gemPlannerStore: { gemStates: maxedGemState() },
    };
    const a0 = await sb.HunterSim.buildArgs(hunter, base);

    for (const [group, def] of Object.entries(defs.globalUpgrades || {})) {
      for (const item of def.items || []) {
        const key = `upgrades.${group}.${item.id}`;
        checked++;
        const args = await sb.HunterSim.buildArgs(hunter, { ...base, overrides: { [key]: 5 } });
        let moved = 0;
        for (let i = 0; i < args.length; i++) if (args[i] !== a0[i]) moved++;
        if (moved === 0 && POST_SIM.has(key)) {
          // Live, but applied to the OUTPUT rather than to an argument -- so prove it moves the
          // output instead of accepting it on the strength of being on a list.
          const off = await sb.HunterSim.evaluate(hunter, { ...base, overrides: { [key]: 0 } });
          const on = await sb.HunterSim.evaluate(hunter, { ...base, overrides: { [key]: 20000 } });
          if (off.xp === on.xp) {
            failures++;
            console.log(`FAIL ${hunter} ${key}: declared a post-sim multiplier but the output does `
              + 'not move');
          } else if (verbose) {
            console.log(`ok   ${hunter} ${key} -> post-sim, xp ${off.xp} -> ${on.xp}`);
          }
        } else if (moved === 0 && KNOWN_INERT.has(key)) {
          inert++;
          if (verbose) console.log(`inert ${hunter} ${key} (no parameter in the original either)`);
        } else if (moved === 0) {
          failures++;
          console.log(`FAIL ${hunter} ${key}: our Overrides panel offers this, but setting it `
            + 'changes no argument -- the value is silently discarded');
        } else if (verbose) {
          console.log(`ok   ${hunter} ${key} -> ${moved} arg(s)`);
        }
      }
    }
  }

  console.log(`\nprobed ${checked} override control(s) across 3 hunters`);
  if (failures) { console.log(`${failures} dead override(s)`); process.exit(1); }
  console.log('every override our UI offers reaches the evaluator');
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
