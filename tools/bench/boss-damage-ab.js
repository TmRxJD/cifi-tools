'use strict';
// DOES BANDING THE ARCHIVE BY BOSS DAMAGE HELP, END TO END?
//
//   node tools/bench/boss-damage-ab.js --only=borge@73
//   node tools/bench/boss-damage-ab.js --only=borge@73,ozzy@54,borge@59 --seeds=2
//
// THE MEASUREMENT THIS DECIDES, STATED BEFORE IT IS RUN so the result cannot be reinterpreted
// afterwards to suit the change:
//
//   WIN      the ON arm returns more loot than the OFF arm on the target build, AND returns no
//            less on every other build tested.
//   NEUTRAL  no arm differs by more than the seed variance this repo has already measured
//            (~7 percentage points across seeds, so a single-run A/B narrower than that is noise).
//   LOSS     the ON arm returns less anywhere.
//
// CELL COUNT IS NOT THE METRIC AND MUST NOT BE QUOTED AS ONE. This repo has already measured a
// variation operator that raised archive coverage while LOWERING champion quality (depth moves:
// 81.8 -> 92.5 cells, 9.384M -> 9.170M loot, and the fully DAG-native arm was the worst). Coverage
// is reported here as context only; the verdict is decided on returned loot.
//
// WHY A BENCH RATHER THAN A CONSOLE RUN. The first attempt drove this from the browser, where the
// Browser pane's tab is HIDDEN -- and a hidden tab clamps setTimeout to ~1s, so a pipeline that
// yields per batch crawls. It also left the experiment unreproducible. This runs in node, takes a
// seed, and prints everything needed to repeat it.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ONLY = opt('only', 'borge@73');
const SEEDS = Number(opt('seeds', 1));
const ARCHIVE_EVALS = Number(opt('archiveEvals', 9600));
const REFINE = Number(opt('refineSupports', 8));

// The shipped archive seed, so arm-to-arm differences are the FLAG and not the stream.
const BASE_SEEDS = [0x9e3779b9, 0x1234, 0xa5a5a5a5];

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('boss-damage-ab: --only= named no builds');

  console.log(`archiveEvals ${ARCHIVE_EVALS}  refineSupports ${REFINE}  seeds ${SEEDS}`);
  console.log(`builds: ${names.join(' ')}`);
  console.log('');

  const rows = [];
  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const reference = await H.evaluateAllocation(cfg, build.talents, build.attributes);

    // No incumbent: the search has to FIND the build, which is the property under test. With an
    // incumbent the reference survives Stage 3 unchanged and both arms return it, measuring
    // nothing.
    const bare = { ...cfg };
    delete bare.currentTalents;
    delete bare.currentAttrs;
    const scorer = await H.makeScorer(bare, 'loot');

    for (let s = 0; s < SEEDS; s++) {
      const seed = BASE_SEEDS[s % BASE_SEEDS.length];
      for (const on of [false, true]) {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(bare, {
          mode: 'loot',
          scorer,
          effort: {
            archiveEvals: ARCHIVE_EVALS, refineSupports: REFINE,
            structuralShare: 0.35, depthShare: 0, selection: 'curiosity',
            seeds: [seed], breakpointSpending: true, bossDamageBands: on,
          },
        });
        const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc);
        // THE FLAG MUST BE CONFIRMED LIVE FROM THE RESULT, not from the argument we passed.
        // bossDamageBands reached three of four sites once already and was never actually applied.
        const recorded = res.diag && res.diag.archive && res.diag.archive.bossDamageBands;
        if (recorded !== on) {
          throw new Error(`boss-damage-ab: asked for bossDamageBands=${on} but the run recorded `
            + `${recorded}; the flag is not reaching the archive and the A/B would be a lie`);
        }
        const d = H.Objective.describeRun(got);
        rows.push({
          name, seed, on, loot: got.loot,
          pct: 100 * (got.loot - reference.loot) / reference.loot,
          regime: d.regime, killPct: d.bossKillRatePct, hpLeft: d.bossHpRemainingPct,
          cells: res.diag.archive.cells, killBands: res.diag.archive.killBands,
          bestKill: res.diag.archive.bestKillReached,
          furthest: res.diag.archive.bestMaxStageReached,
          secs: Math.round((Date.now() - t0) / 1000),
        });
        const r = rows[rows.length - 1];
        console.log(`${name.padEnd(10)} seed ${seed.toString(16).padStart(8)}  `
          + `bossDamageBands ${on ? 'ON ' : 'off'}  `
          + `${(r.pct >= 0 ? '+' : '') + r.pct.toFixed(2)}%  `
          + `cells ${String(r.cells).padStart(4)}  killBands ${String(r.killBands).padStart(2)}  `
          + `furthest ${r.furthest.toFixed(1).padStart(6)}  ${r.regime}  ${r.secs}s`);
      }
    }
  }

  console.log('');
  console.log('VERDICT (decided on returned loot, not on coverage)');
  let anyLoss = false;
  let anyWin = false;
  for (const name of names) {
    for (const seed of [...new Set(rows.filter((r) => r.name === name).map((r) => r.seed))]) {
      const off = rows.find((r) => r.name === name && r.seed === seed && !r.on);
      const on = rows.find((r) => r.name === name && r.seed === seed && r.on);
      if (!off || !on) continue;
      const delta = 100 * (on.loot - off.loot) / off.loot;
      const verdict = delta > 1 ? 'WIN ' : (delta < -1 ? 'LOSS' : 'same');
      if (delta < -1) anyLoss = true;
      if (delta > 1) anyWin = true;
      console.log(`  ${verdict}  ${name.padEnd(10)} seed ${seed.toString(16)}  `
        + `off ${off.pct.toFixed(2)}%  ->  on ${on.pct.toFixed(2)}%  `
        + `(${delta >= 0 ? '+' : ''}${delta.toFixed(2)}% arm-to-arm)`);
    }
  }
  console.log('');
  console.log(anyLoss ? 'RESULT: at least one LOSS -- do not enable.'
    : (anyWin ? 'RESULT: win(s) with no loss on the builds tested.'
      : 'RESULT: no arm-to-arm difference above 1% on the builds tested.'));
  console.log('NOTE: one seed is ONE SAMPLE. This repo has measured ~7 points of seed variance in');
  console.log('      the search, so a single-seed difference narrower than that is not evidence.');
})().catch((e) => { console.error('FAIL ' + (e && e.stack || e)); process.exit(1); });
