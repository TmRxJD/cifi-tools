'use strict';
// SAME-ACCOUNT PARITY: this tool vs cifi-tools.com, seeded with the SAME account state.
//
//   node tools/bench/account-parity-check.js [--hunter=ozzy] [--build=0]
//
// THE QUESTION, and why every previous attempt at it was invalid.
//
// A user reported materials an order of magnitude too high. The comparison run at the time put
// 16.51t/run (original) against 46.83t/run (ours) and read as a clean ~2.8x materials-only
// discrepancy -- but the original was evaluating ONE account's state while the screenshot came
// from a DIFFERENT user's account. Materials scale hard with account-wide upgrades, so two
// accounts at the same hunter level legitimately differ by far more than that. The numbers were
// real and the inference from them was worthless.
//
// A build SHARE CODE cannot fix this on its own: it carries only CODE_PARAMS (Borge's carries r4,
// r16, r19, t2r7 -- not r7, not most inscryptions, trinkets or CMs), so importing a code into the
// original evaluates it against whatever account is loaded there, which for a guest is nothing.
// That is the "not transported to live" trap already recorded in compare_builds.
//
// SO BOTH SIDES ARE SEEDED FROM ONE REAL SAVE. The save is run through our own importer to produce
// the account state, and that SAME state is written into the live site's own localStorage keys
// (`hunter-data`, `gemPlanner_store`) via live-eval's seedAccountUpgrades -- which is how the site
// itself stores it, so this exercises the real path rather than a back door. The build is then
// imported BUILD-ONLY on both sides, so the account supplies the upgrades and the code supplies
// only talents and attributes.
//
// WHAT IS COMPARED: every individual resource the original reports, not just loot. That is the
// whole point -- this project has three recorded incidents of a measurement that could not see the
// field in question (relic r7 doubling MATERIALS while the probe watched loot; loopmods.roe moving
// XP only; a "no wasm argument" read as inert). Loot agreeing tells you nothing about mat3.
//
// THIS IS A REPORT, NOT A GATE. It needs a real save and network access to the live site, so it
// cannot be part of all.js -- and its verdict is about an account, which is the user's data, not a
// property of the code.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const HUNTER = opt('hunter', 'ozzy');


// The fields the live site reports. Compared field by field: a single "materials" number would
// hide mat2 being right while mat3 is 10x out, which is the shape of the actual report.
const FIELDS = [
  ['lootScore', 'Loot Score'],
  ['avgStage', 'Ø Stage'],
  ['avgTimeMinutes', 'Ø Time (min)'],
  ['mat1PerRun', 'Material 1 / run'],
  ['mat2PerRun', 'Material 2 / run'],
  ['mat3PerRun', 'Material 3 / run'],
  ['xpPerRun', 'XP / run'],
];

// THE NOISE FLOOR. The evaluator is deterministic, so this is NOT search variance -- no search runs
// here, and the ~7-point seed spread that governs optimizer comparisons does not apply. What
// remains is Monte Carlo sampling (~0.12% mean, 0.35% worst between two FINAL_ITERATIONS scores,
// per eval-precision-check) plus the site's own display rounding to 4-5 significant figures, which
// on a 3-significant-figure reading like "104" minutes is worth several tenths of a percent on its
// own. So anything under ~1% is presentation, not disagreement.
//
// 3% is therefore loose enough to never fire on rounding and far tighter than any real defect:
// the mistake this check exists to catch reads as ~100-900%, not as 3%.
const TOLERANCE_PCT = 3;

function findSave() {
  const dir = path.join(__dirname, '..', 'gamefiles', 'save');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.decoded.json'));
  if (!files.length) return null;
  // Newest by mtime -- an older pull describes an account state that has since moved on, and
  // comparing against it would reintroduce the very "two different states" error this exists to
  // remove.
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

(async () => {
  const savePath = findSave();
  if (!savePath) {
    console.log('SKIP  no decoded save in tools/gamefiles/save/.');
    console.log('      This check is meaningless without one: seeding both sides from the SAME');
    console.log('      account is the entire point, and a synthetic account would only re-test');
    console.log('      our own defaults. Pull a save and run tools/save/inspect.js first.');
    return;
  }
  const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  console.log(`save    ${path.basename(savePath)}`);

  const sb = H.browserSandbox();
  const store = sb.mapSaveToStore(save);
  const hunterState = (store.perHunter || {})[HUNTER];
  if (!hunterState) throw new Error(`importer produced no state for hunter "${HUNTER}"`);

  // THE SAVE'S OWN ALLOCATION IS THE BUILD. mapSaveToStore returns the account's live talents and
  // attributes rather than a builds list -- the app turns those into a "(Scanned)" build on import.
  // Comparing the account's ACTUAL allocation is what the question asks: it is the build the user
  // is looking at when they say the numbers are wrong.
  const build = {
    // LEVEL IS REQUIRED, and omitting it does not throw -- AccountState reads `build.level`, so an
    // absent one resolves the wasm's `lvl` argument to 0 and silently evaluates every build as if
    // it were level 0. The first version of this check omitted it and reported borge@61 as "50%
    // low against the site", which was this bug, not a product defect. It is asserted rather than
    // defaulted: a level of 0 is a legal-looking number that quietly changes the answer.
    level: hunterState.level,
    name: `${HUNTER}@${hunterState.level} (scanned)`,
    talents: hunterState.talents,
    attributes: hunterState.attributes,
    overrides: {},
  };
  if (!Number.isFinite(build.level) || build.level <= 0) {
    throw new Error(`importer gave no usable level for ${HUNTER} (got ${build.level}); refusing to `
      + 'evaluate, because a missing level resolves lvl to 0 and looks like a parity failure');
  }

  console.log(`hunter  ${HUNTER}  level ${hunterState.level}  highestStage ${hunterState.highestStage}`);
  console.log(`account ${Object.keys(store.globalUpgrades || {}).length} global upgrade(s), `
    + `${Object.keys(hunterState.hunterStats || {}).length} base stat(s)`);

  // ---- our side -------------------------------------------------------------------------------
  // THROUGH AccountState, which is the canonical constructor every app path funnels through --
  // including the guard that rejects one hunter's stats handed to another. Hand-rolling an eval
  // state here would be a fourth builder, and scoring a build with the wrong hunter's stats is a
  // mistake this project has already made once and spent an investigation on.
  const account = sb.AccountState.build({
    hunter: HUNTER,
    build,
    hunterStats: hunterState.hunterStats,
    globalUpgrades: store.globalUpgrades,
    gems: store.gems,
    showAdvancedTalents: true,
  });
  const ours = await sb.HunterSim.evaluate(HUNTER, sb.AccountState.simState(account, 1000));

  // ---- their side -----------------------------------------------------------------------------
  const { importCodeAndReadStats, shutdownLiveBrowser } = await import('../../compare-mcp/live-eval.mjs');
  // The code carries talents/attributes; the ACCOUNT supplies everything else on both sides, which
  // is what makes this a like-for-like comparison rather than a code-only one.
  const code = await H.generateBuildCode(HUNTER, build, hunterState.hunterStats, store.globalUpgrades, store.gems);
  let theirs;
  try {
    theirs = await importCodeAndReadStats(HUNTER, code, {
      accountUpgrades: store.globalUpgrades,
      hunterStats: hunterState.hunterStats,
      gemStates: store.gems,
    });
  } finally {
    await shutdownLiveBrowser();
  }

  // ---- compare ---------------------------------------------------------------------------------
  const OURS = {
    lootScore: ours.lootPerMin, avgStage: ours.avgStage, avgTimeMinutes: ours.avgTime,
    mat1PerRun: ours.mat1, mat2PerRun: ours.mat2, mat3PerRun: ours.mat3, xpPerRun: ours.xp,
  };

  console.log('');
  console.log('field                 ours              cifi-tools        delta');
  let worst = 0;
  let unreported = 0;
  const rows = [];
  for (const [key, label] of FIELDS) {
    const a = OURS[key];
    const b = theirs[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      // NOT counted as agreement. A field the site does not report is a field this check cannot
      // speak for, and printing it as a pass would be the "compared an empty set" failure.
      console.log(`${label.padEnd(20)} ${String(a ?? '-').padEnd(17)} ${String(b ?? '-').padEnd(17)} NOT REPORTED`);
      unreported++;
      continue;
    }
    const delta = b === 0 ? (a === 0 ? 0 : Infinity) : 100 * (a - b) / b;
    worst = Math.max(worst, Math.abs(delta));
    rows.push({ label, delta });
    const flag = Math.abs(delta) <= TOLERANCE_PCT ? '' : '   <-- MISMATCH';
    console.log(`${label.padEnd(20)} ${a.toPrecision(6).padEnd(17)} ${b.toPrecision(6).padEnd(17)}`
      + `${(delta >= 0 ? '+' : '') + delta.toFixed(2)}%${flag}`);
  }

  console.log('');
  const bad = rows.filter((r) => Math.abs(r.delta) > TOLERANCE_PCT);
  if (unreported) console.log(`${unreported} field(s) NOT REPORTED by the live site -- unverified, not agreed.`);
  if (!bad.length) {
    console.log(`PARITY: every compared field agrees within ${TOLERANCE_PCT}% (worst ${worst.toFixed(2)}%).`);
    console.log('Both sides were seeded from the SAME account, so this is a like-for-like result.');
  } else {
    console.log(`MISMATCH on ${bad.length} field(s): `
      + bad.map((r) => `${r.label} ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}%`).join(', '));
    console.log('Both sides carry the same account state, so this is a real disagreement rather');
    console.log('than the two-account artifact that invalidated the earlier comparison.');
  }
})().catch((e) => { console.error(e); process.exit(1); });
