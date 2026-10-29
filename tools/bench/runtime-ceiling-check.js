'use strict';
// THE SHIPPED DEFAULT MUST FINISH INSIDE THE STATED RUNTIME CEILING, ON THE HEAVIEST BUILD.
//
//   node tools/bench/runtime-ceiling-check.js [--ceiling=300] [--only=borge@84]
//
// THE CEILING IS THE PROJECT OWNER'S, STATED DIRECTLY: "I would allow for a max of 5 mins for the
// highest level builds, if it's taking longer that's a serious problem in efficiency, do NOT let a
// sim run that long." It was being checked by eye, which is how it drifted -- and eyeballing it is
// also how a sweep timing got misread as a violation when it was not.
//
// MEASURE SOLO, NOT FROM A SWEEP. The gate runs 7 builds per batch in parallel, so a per-build
// figure there is inflated several-fold by contention: the same sweep that showed 1785s per build
// is not evidence any single run takes 1785s. A ceiling has to be measured the way a user
// experiences it -- one build, alone.
//
// DEFAULT EFFORT ONLY. `exhaustive` is deliberately and honestly slower (measured 564s on the
// CHEAPEST fixture) and is an opt-in the user chooses when they would rather wait; holding it to
// the same ceiling would fail it for doing exactly what it advertises.
//
// GATE: the default effort on the heaviest fixture must finish within the ceiling.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const CEILING = Number(opt('ceiling', 300));
const ONLY = opt('only', null);
const OUT = opt('out', null);

(async () => {
  if (!Number.isFinite(CEILING) || CEILING <= 0) throw new Error('runtime ceiling must be a positive finite number');
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();

  // The heaviest build in the set, unless one is named. Evaluation cost scales with how far a build
  // progresses, so the highest level is the worst case by construction.
  let picks;
  if (ONLY) picks = ONLY.split(',').map((s) => H.findFixture(known, s.trim()));
  else {
    const byLevel = flat.slice().sort((a, b) => (b.level || 0) - (a.level || 0));
    picks = [byLevel[0]];
  }

  let failures = 0;
  for (const fx of picks) {
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const t0 = performance.now();
    // Match the six-worker browser configuration measured on this host, including readiness.
    // A serial scorer times a different execution path and cannot enforce the app's ceiling.
    const pooled = await H.makePooledScorer(cfg, mode,
      (mode === 'boss' || mode === 'bossTimeless') && Number.isFinite(fx.bossStage)
        ? { bossTarget: fx.bossStage } : undefined, 6);
    let res, secs, cleanupSecs;
    try {
      if (pooled.workers !== 6) throw new Error('runtime ceiling: expected six ready scoring workers');
      res = await H.Optimizer.optimize(cfg, {
        mode, scorer: pooled.score, effort: H.Optimizer.DEFAULT_EFFORT,
      });
      secs = (performance.now() - t0) / 1000;
      if (!res.best || res.diag?.profile?.settings?.effort !== H.Optimizer.DEFAULT_EFFORT) {
        throw new Error('runtime ceiling: no build or wrong effort in result');
      }
    } finally {
      // The app retains its ready pool after returning the result. Fixture teardown is
      // mandatory but is not time the player waits for that result; report it separately.
      const cleanupStarted = performance.now();
      await pooled.destroy();
      cleanupSecs = (performance.now() - cleanupStarted) / 1000;
    }
    if (OUT) require('node:fs').writeFileSync(OUT, JSON.stringify({fixture:fx.name,workers:pooled.workers,
      seconds:secs,cleanupSeconds:cleanupSecs,ceiling:CEILING,evals:res.evals,best:res.best,ranked:res.ranked,diag:res.diag},null,2));
    const over = secs > CEILING;
    if (over) failures++;
    console.log(`${String(fx.name).padEnd(11)} lvl${String(fx.level).padEnd(3)} ${mode.padEnd(12)}`
      + ` effort=${H.Optimizer.DEFAULT_EFFORT} workers=${pooled.workers} ${secs.toFixed(0)}s  ${res.evals} evals`
      + ` cleanup=${cleanupSecs.toFixed(2)}s`
      + `  ceiling ${CEILING}s`
      + (over ? `   *** OVER BY ${(secs - CEILING).toFixed(0)}s ***` : '   ok'));
  }

  console.log('');
  if (failures) {
    console.log(`FAIL  ${failures} build(s) exceed the ${CEILING}s ceiling at the shipped default effort.`);
    console.log('      Do not raise the ceiling to make this pass -- it is the stated requirement.');
    process.exit(1);
  }
  console.log(`PASS  the shipped default finishes the selected highest-level fixture inside ${CEILING}s`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
