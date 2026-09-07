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

// POOL SIZE, so an experiment can share the machine with a running sweep instead of waiting hours
// for it. Oversubscribing cores does not corrupt anything -- the evaluator is deterministic and
// the pool is asserted bit-identical to serial -- but it slows BOTH jobs, so a background
// experiment should take the spare capacity rather than a full pool.
const POOL = (() => {
  const f = process.argv.find((a) => a.startsWith('--pool='));
  return f ? Number(f.slice('--pool='.length)) : undefined;
})();

const args = process.argv.slice(2);
const opt = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ONLY = opt('only', 'borge@73');
const SEEDS = Number(opt('seeds', 1));
const ARCHIVE_EVALS = Number(opt('archiveEvals', 9600));
const REFINE = Number(opt('refineSupports', 8));
// --fi=1 makes this the feasible/infeasible A/B instead.
const FI = opt('fi', null) !== null;
// --both turns on BOTH the descriptor axis and the feasible/infeasible archives in the ON arm.
// They compose rather than compete: the axis lets the archive SEE boss progress below a kill (on a
// degenerate archive every build collapses into one cell), and FI gives those cells breeding budget
// with no loot pressure. Preservation without development was already measured inert (MOME returned
// a bit-identical build), so seeing the difference is only useful if something then develops it.
const BOTH = args.includes('--both');

// The shipped archive seed, so arm-to-arm differences are the FLAG and not the stream.
//
// `--seedlist=0xc0ffee,0xbadf00d` overrides these. It exists so a threshold read FROM these three
// seeds can be validated on seeds it was not fitted to -- the FI warmup fraction was derived from
// a single seed once, and the value that looked right there cost 18% on another.
const SEEDLIST = opt('seedlist', null);
const BASE_SEEDS = SEEDLIST
  ? SEEDLIST.split(',').map((t) => { const n = Number(t.trim()); if (!Number.isFinite(n)) throw new Error(`bad seed ${t}`); return n; })
  : [0x9e3779b9, 0x1234, 0xa5a5a5a5];

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
    const primaryOf = (r) => ((fx.mode || 'loot') === 'push' ? r.stage : r.loot);

    // No incumbent: the search has to FIND the build, which is the property under test. With an
    // incumbent the reference survives Stage 3 unchanged and both arms return it, measuring
    // nothing.
    const bare = { ...cfg };
    delete bare.currentTalents;
    delete bare.currentAttrs;
    // POOLED: single-threaded node is hours per arm on a level-73 build. The pool is asserted
    // bit-identical to the serial scorer by eval-pool-check.js, including the boss metadata the
    // archive forms its cells from.
    const pooled = await H.makePooledScorer(bare, fx.mode || 'loot', undefined, POOL);
    const scorer = pooled.score;

    for (let s = 0; s < SEEDS; s++) {
      const seed = BASE_SEEDS[s % BASE_SEEDS.length];
      const arms = [false, true];
      for (const arm of arms) {
        // `on` drives bossDamageBands, `fi` drives the feasible/infeasible archives.
        const on = (BOTH || !FI) ? arm : false;
        const fi = (BOTH || FI) ? arm : false;
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(bare, {
          // THE FIXTURE'S OWN MODE. This said 'loot' while the scorer above was built with
          // `fx.mode` -- so on a push fixture the scorer ranked by stage while the optimizer
          // believed it was maximising loot. Incoherent, and it would have silently corrupted any
          // push measurement. Every result taken so far happens to be a loot fixture, so the FI
          // conclusions stand, but the bench was one push fixture away from lying.
          mode: fx.mode || 'loot',
          scorer,
          effort: {
            archiveEvals: ARCHIVE_EVALS, refineSupports: REFINE,
            structuralShare: 0.35, selection: 'curiosity',
            seeds: [seed], breakpointSpending: true, bossDamageBands: on, feasibleInfeasible: fi,
          },
        });
        const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc);
        // THE FLAG MUST BE CONFIRMED LIVE FROM THE RESULT, not from the argument we passed.
        // bossDamageBands reached three of four sites once already and was never actually applied.
        const recorded = res.diag && res.diag.archive && res.diag.archive.bossDamageBands;
        // ASSERT WIRING AGAINST THE REQUEST, REPORT ENGAGEMENT SEPARATELY. FI now engages only where
        // its premise holds (no seed build kills anything), so `feasibleInfeasible` in diag is what
        // ACTUALLY happened while `feasibleInfeasibleRequested` is what was asked for. Checking the
        // former would make a correct no-engagement look like an unwired flag -- the guard must
        // still catch a flag that never arrived, without flagging one that arrived and declined.
        const recordedFi = res.diag && res.diag.archive && res.diag.archive.feasibleInfeasibleRequested;
        const engagedFi = res.diag && res.diag.archive && res.diag.archive.feasibleInfeasible;
        if (recorded !== on || recordedFi !== fi) {
          throw new Error(`boss-damage-ab: asked for bossDamageBands=${on}/FI=${fi} but the run `
            + `recorded ${recorded}/${recordedFi}; a flag is not reaching the archive and the A/B `
            + 'would be a lie');
        }
        // LEGALITY, ASSERTED. A mechanism that reaches a boss by producing an allocation the game
        // would reject is not a win, and nothing else in this bench would notice -- the score would
        // simply be higher. Checked against the same space the optimizer is bound by.
        const legal = H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES,
          cfg.ATTRIBUTE_MIN_VALUE, res.best.attrAlloc, cfg.ATTRIBUTE_BUDGET);
        if (!legal) {
          throw new Error(`${name}: returned an ILLEGAL attribute allocation with FI=${fi} `
            + '-- the result is void, not a win');
        }
        const spentT = Object.values(res.best.talentAlloc).reduce((a, v) => a + (v || 0), 0);
        if (spentT > cfg.TALENT_BUDGET) {
          throw new Error(`${name}: talent spend ${spentT} exceeds budget ${cfg.TALENT_BUDGET}`);
        }
        const d = H.Objective.describeRun(got);
        rows.push({
          name, seed, on, fi, engagedFi, loot: got.loot,
          feasibleCells: res.diag.archive.feasibleCells,
          infeasibleCells: res.diag.archive.infeasibleCells,
          bestViolation: res.diag.archive.bestViolation,
          // Judged on the fixture's OWN objective. Reporting a push build's loot delta as its
          // result is the same wrong-objective error that made sweep-progress flag borge@12 push
          // as a failure when it had beaten its import on stage.
          pct: 100 * (primaryOf(got) - primaryOf(reference)) / primaryOf(reference),
          regime: d.regime, killPct: d.bossKillRatePct, hpLeft: d.bossHpRemainingPct,
          cells: res.diag.archive.cells, entries: res.diag.archive.entries,
          killBands: res.diag.archive.killBands,
          bestKill: res.diag.archive.bestKillReached,
          furthest: res.diag.archive.bestMaxStageReached,
          secs: Math.round((Date.now() - t0) / 1000),
        });
        const r = rows[rows.length - 1];
        console.log(`${name.padEnd(10)} seed ${seed.toString(16).padStart(8)}  `
          + (BOTH ? `axis+FI ${arm ? 'ON ' : 'off'}  ` : (FI ? `FI ${fi ? 'ON ' : 'off'}  ` : `bossDamageBands ${on ? 'ON ' : 'off'}  `))
          + `${(r.pct >= 0 ? '+' : '') + r.pct.toFixed(2)}%  `
          + `cells ${String(r.cells).padStart(4)} F/I ${String(r.feasibleCells).padStart(3)}/${String(r.infeasibleCells).padStart(3)}  `
          + `bestViolation ${String(Math.round(r.bestViolation)).padStart(3)}  `
          + (r.fi && !r.engagedFi ? 'FI-DECLINED(premise absent)  ' : '')
          + `furthest ${r.furthest.toFixed(1).padStart(6)}  ${r.regime}  ${r.secs}s`);
      }
    }
    // Each worker holds its own WASM module; leaking one per fixture is how the browser side hit
    // "Cannot allocate Wasm memory for new instance".
    await pooled.destroy();
  }

  console.log('');
  console.log('VERDICT (decided on returned loot, not on coverage)');
  let anyLoss = false;
  let anyWin = false;
  for (const name of names) {
    for (const seed of [...new Set(rows.filter((r) => r.name === name).map((r) => r.seed))]) {
      const pick = (want) => rows.find((r) => r.name === name && r.seed === seed
        && (BOTH ? (r.on === want && r.fi === want) : (FI ? r.fi === want : r.on === want)));
      const off = pick(false);
      const on = pick(true);
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
