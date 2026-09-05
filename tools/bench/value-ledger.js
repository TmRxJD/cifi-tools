'use strict';
// WHERE DOES THE SEARCH LOSE THE VALUE? One table, one fidelity, conclusions stated.
//
// WHY THIS EXISTS. That question was answered wrongly three times in one session, every time by
// comparing numbers that were not comparable:
//
//   * an archive champion at SCREEN_ITERATIONS (779,420) against an import at FINAL_ITERATIONS
//     (1,004,599), concluding "the archive never finds anything close" -- the two differ by ~10x
//     in sampling cost and measure different things;
//   * `avgStage` read as "how far the build gets" when `maxStage` is that number, producing
//     "neither build reaches the stage-200 boss" about a build whose maxStage is exactly 200;
//   * a Fast-effort gate result compared against a Complete-effort recheck, with the difference
//     attributed to archive budget when the seed was what differed.
//
// So this bench prints ONE column, at ONE fidelity, with the reference build in the same table as
// the stages, and every row carrying its own regime label from Objective.describeRun rather than
// raw stage numbers for the reader to interpret.
//
//   node tools/bench/value-ledger.js --fixture=ozzy@54
//   node tools/bench/value-ledger.js --fixture=ozzy@54 --seeds=9e3779b9,12345678
//   node tools/bench/value-ledger.js --hunter=ozzy            # the real account from the save
//
// READ IT LIKE THIS. Each row is a stage champion re-scored at FINAL_ITERATIONS:
//   reference  -- the build being compared against (import, or the account's own)
//   archive    -- best elite illumination produced
//   refined    -- best after refinement
//   returned   -- what the optimizer actually hands back
// The stage where `vs reference` stops improving is the stage that is failing. If `archive` is
// already close to `reference`, illumination is fine and the loss is downstream. If `archive` is
// far below and `refined` closes the gap, illumination is weak but refinement compensates. If
// `returned` is far below `reference` and no stage closes it, the search never saw the build.

const path = require('path');
const H = require(path.join(__dirname, 'harness.js'));

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

(async () => {
  const fixtureName = flag('fixture', null);
  const hunterFlag = flag('hunter', null);
  if (!fixtureName && !hunterFlag) {
    throw new Error('value-ledger: pass --fixture=<name> or --hunter=<borge|ozzy|knox>');
  }
  const seeds = flag('seeds', '9e3779b9').split(',').map((x) => parseInt(x, 16));

  let cfg;
  let label;
  let refTalents;
  let refAttrs;
  let hunter;

  if (fixtureName) {
    const fx = H.findFixture(H.loadKnownBuilds(), fixtureName);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    hunter = fx.hunter;
    cfg = H.cfgForImport(hunter, build);
    label = `${fixtureName} (${fx.uid}, mode=${fx.mode})`;
    refTalents = build.talents;
    refAttrs = build.attributes;
  } else {
    const save = H.latestDecodedSave();
    if (!save) throw new Error('value-ledger: no decoded save; use --fixture=');
    hunter = hunterFlag;
    const real = (H.browserSandbox().mapSaveToStore(save).perHunter || {})[hunter];
    if (!real) throw new Error(`value-ledger: no ${hunter} in the decoded save`);
    cfg = H.cfgForImport(hunter, {
      level: real.level, talents: real.talents, attributes: real.attributes, overrides: {},
    });
    cfg.hunterStats = real.hunterStats;
    label = `${hunter}@${real.level} (account build)`;
    refTalents = real.talents;
    refAttrs = real.attributes;
  }

  const sb = H.browserSandbox();
  const evalFast = await sb.HunterSim.compileEvaluator(hunter, cfg);
  const D = H.Objective.describeRun;
  const FINAL = H.Optimizer.FINAL_ITERATIONS;

  const refRun = await evalFast(refTalents, refAttrs, FINAL);
  const refScore = refRun.lootPerMin;

  console.log(`value-ledger: ${label}`);
  console.log(`ALL SCORES AT ${FINAL} ITERATIONS. No number below is a SCREEN_ITERATIONS score.`);
  console.log(`budgets: talent ${cfg.TALENT_BUDGET}, attribute ${cfg.ATTRIBUTE_BUDGET}`);
  console.log(`reference spend: talent ${H.Space.costOf(cfg.TALENTS, refTalents)}, `
    + `attribute ${H.Space.costOf(cfg.ATTRIBUTES, refAttrs)}`);
  console.log(`reference legal: ${H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES,
    cfg.ATTRIBUTE_MIN_VALUE, refAttrs, cfg.ATTRIBUTE_BUDGET)}`);
  console.log(`reference regime: ${D(refRun).summary}`);
  console.log('');

  const scorer = await H.makeScorer(cfg, 'loot');
  for (const seed of seeds) {
    const t0 = Date.now();
    const res = await H.Optimizer.optimize(cfg, {
      mode: 'loot',
      scorer,
      effort: { label: 'ledger', seeds: [seed], ...JSON.parse(flag('effort', '{}')) },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const a = (res.diag && res.diag.archive) || {};

    console.log(`--- seed ${seed.toString(16)}  (${secs}s, ${res.evals} evals) ---`);
    const pad = (v, n) => String(v).padStart(n);
    console.log(`${'stage'.padEnd(10)} ${pad('loot/min', 12)} ${pad('vs reference', 13)}`
      + ` ${pad('vs prev stage', 14)}  regime`);
    const row = (name, score, prevScore, meta) => {
      const vsRef = ((score - refScore) / refScore) * 100;
      const vsPrev = prevScore === null ? null : ((score - prevScore) / prevScore) * 100;
      console.log(`${name.padEnd(10)} ${pad(Math.round(score), 12)} ${pad(`${vsRef >= 0 ? '+' : ''}${vsRef.toFixed(2)}%`, 13)}`
        + ` ${pad(vsPrev === null ? '-' : `${vsPrev >= 0 ? '+' : ''}${vsPrev.toFixed(2)}%`, 14)}  ${meta}`);
    };
    row('reference', refScore, null, D(refRun).regime);

    const led = (res.diag && res.diag.ledger) || [];
    if (!led.length) throw new Error('value-ledger: optimize() returned no diag.ledger');
    let prev = null;
    for (const e of led) {
      row(e.stage, e.scoreAtFinalIterations, prev,
        `kill ${e.killRatePct}%  maxStage ${e.maxStageReached}`);
      prev = e.scoreAtFinalIterations;
    }

    console.log(`archive: ${a.cells} cells, ${a.killBands} kill bands, best kill reached `
      + `${a.bestKillReached}%  (its champion at SCREEN(100) was `
      + `${Math.round(a.bestScoreAtScreenIterations)} -- NOT comparable to the column above)`);

    // State the conclusion rather than leaving it to be inferred.
    const returned = led[led.length - 1].scoreAtFinalIterations;
    const archiveScore = led[0].scoreAtFinalIterations;
    const gap = ((returned - refScore) / refScore) * 100;
    let verdict;
    if (gap >= -0.2) {
      verdict = 'MATCHES OR BEATS the reference (within measurement precision of ~0.2%)';
    } else if (archiveScore >= refScore) {
      verdict = 'ILLUMINATION FOUND IT, LATER STAGES LOST IT -- the archive champion already '
        + 'beats the reference, so refinement or selection is discarding value';
    } else if (returned > archiveScore * 1.02) {
      verdict = 'REFINEMENT IS WORKING BUT STARTED TOO LOW -- it improved on the archive and '
        + 'still fell short, so illumination did not supply a good enough starting point';
    } else {
      verdict = 'NEITHER STAGE GOT THERE -- the archive was short and refinement did not close '
        + 'it; the search never located this build';
    }
    console.log(`VERDICT: ${verdict}`);
    console.log('');
  }
})();
