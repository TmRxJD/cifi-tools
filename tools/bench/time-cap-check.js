'use strict';
// THE WALL-CLOCK CAP: FIRES WHEN IT SHOULD, INERT WHEN IT SHOULD NOT, AND ALWAYS LEGAL.
//
//   node tools/bench/time-cap-check.js
//
// The cap is a SAFETY VALVE, not a budget. A budget decides how much searching happens, always
// binds, and destroys determinism -- measured here as borge@42 returning +78.80% then +62.72% at an
// identical configuration. A cap sized generously never fires and changes nothing.
//
// THREE PROPERTIES, and a check of fewer than three would pass on a broken cap:
//   1. INERT at the default 600s on a build that finishes well inside it -- same score as no cap.
//      A cap that binds routinely has become a budget.
//   2. FIRES under an absurdly small cap, and SAYS SO (`truncated`). A silent truncation is
//      indistinguishable from a converged run, which is how the original wall-clock bug hid.
//   3. The truncated build is still LEGAL and FULLY SPENT. This is the one that matters: the cap is
//      checked at stage boundaries precisely so it can never return a partial allocation, and
//      "returns something" is worthless if that something is malformed.

const H = require('./harness.js');

const ITERS = 1000;
const NAMES = (process.argv[2] || 'knox@12,ozzy@11').split(',');
const capOf = (d) => (d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel);

(async () => {
  const known = H.loadKnownBuilds();
  let failures = 0;
  let checked = 0;

  for (const name of NAMES.map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const pooled = await H.makePooledScorer(cfg, mode);
    try {
      const run = async (maxSeconds) => {
        const o = {
          mode, scorer: pooled.score,
          effort: { archiveEvals: 1200, refineSupports: 3, seeds: [0x9e3779b9] },
        };
        if (maxSeconds !== undefined) o.maxSeconds = maxSeconds;
        const res = await H.Optimizer.optimize(cfg, o);
        const r = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, ITERS);
        return {
          score: mode === 'push' ? r.stage : r.loot,
          truncated: !!res.truncated,
          tSpend: H.Space.costOf(cfg.TALENTS, res.best.talentAlloc),
          aSpend: H.Space.costOf(cfg.ATTRIBUTES, res.best.attrAlloc),
          legal: cfg.ATTRIBUTES.every((d) => (res.best.attrAlloc[d.id] || 0) <= capOf(d))
            && H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES || {}, minVal,
              res.best.attrAlloc, cfg.ATTRIBUTE_BUDGET),
        };
      };

      const uncapped = await run(0);          // 0 disables the cap entirely
      const dflt = await run(undefined);      // the shipped 600s default
      const tiny = await run(0.001);          // absurd cap: must fire
      checked++;

      const inert = !dflt.truncated && Math.abs(dflt.score - uncapped.score) < 1e-6;
      const fires = tiny.truncated;
      const wellFormed = tiny.legal
        && tiny.tSpend === cfg.TALENT_BUDGET && tiny.aSpend === cfg.ATTRIBUTE_BUDGET;

      console.log(`${name.padEnd(10)} default truncated=${dflt.truncated} score ${dflt.score.toFixed(0)}`
        + `   uncapped ${uncapped.score.toFixed(0)}`
        + `   tiny-cap truncated=${tiny.truncated} legal=${tiny.legal}`
        + ` spend ${tiny.tSpend}/${cfg.TALENT_BUDGET},${tiny.aSpend}/${cfg.ATTRIBUTE_BUDGET}`);
      if (!inert) { console.log('   *** THE DEFAULT CAP CHANGED THE ANSWER -- it is acting as a budget ***'); failures++; }
      if (!fires) { console.log('   *** A 1ms CAP DID NOT TRUNCATE -- the cap is dead ***'); failures++; }
      if (!wellFormed) { console.log('   *** TRUNCATED BUILD IS ILLEGAL OR UNDER-SPENT ***'); failures++; }
    } finally { await pooled.destroy(); }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures} problem(s) with the time cap`); process.exit(1); }
  console.log(`PASS  ${checked} build(s): cap inert at the default, fires when tiny, always legal`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
