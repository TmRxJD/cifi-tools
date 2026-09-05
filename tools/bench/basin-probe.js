'use strict';
// IS THE MISSED BUILD REACHABLE FROM THE ONE WE RETURN, AND WHAT IS IN BETWEEN?
//
// The question every "the optimizer is N% short" investigation actually needs answered, and the
// one that separates the three causes that look identical from the outside:
//
//   A. The returned build is NOT a local optimum -> the search stopped early. Fixable by
//      searching harder from where it already is.
//   B. Both builds are local optima with a VALLEY between them -> a basin problem. Searching
//      harder from the returned build can never work; the search has to arrive in the other
//      basin by construction (structure move, different seed, different start).
//   C. The reference is not a local optimum either -> our scoring disagrees with whatever
//      produced the reference, and the gap is not a search failure at all.
//
// Guessing between these is what produced a day of wrong fixes. Every number here is at
// FINAL_ITERATIONS, and every conclusion is stated rather than left to be read off a column.
//
//   node tools/bench/basin-probe.js --fixture=ozzy@54
//   node tools/bench/basin-probe.js --results=results-qd.json      <- every row, tallied
//
// --results reads a gate output (which already carries importTalents/importAttributes and
// optimizedTalents/optimizedAttributes) and analyses every row WITHOUT re-running the optimizer.
// That is the difference between ~3 minutes and ~22 minutes per build, and it is what makes
// "what is the pattern across levels" answerable rather than theoretical.
//
// WHAT IT DOES
//   1. Neighbourhood test on the REFERENCE: does any single legal move improve it?
//   2. Neighbourhood test on the RETURNED build (from a fresh optimize, or a supplied allocation).
//   3. The straight-line path between them, one point at a time, scored at every step -- so a
//      valley is visible as a dip rather than inferred.

const path = require('path');
const fs = require('fs');
const H = require(path.join(__dirname, 'harness.js'));

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const STEPS = [1, 2, 4, 8];

async function neighbourhood(evalFast, cfg, talents, attrs, baseScore, iters) {
  const Space = H.Space;
  const A = cfg.ATTRIBUTES;
  const T = cfg.TALENTS;
  const deps = cfg.ATTRIBUTE_DEPENDENCIES;
  const minVal = cfg.ATTRIBUTE_MIN_VALUE;
  const seen = new Set();
  const cands = [];
  // Attribute moves.
  for (const f of A) {
    for (const t of A) {
      if (f.id === t.id) continue;
      for (const amt of STEPS) {
        const nx = Space.transfer(A, deps, minVal, cfg.ATTRIBUTE_BUDGET, attrs, f.id, t.id, amt);
        if (!nx) continue;
        const sig = 'a' + Space.signature(A, nx);
        if (seen.has(sig)) continue;
        seen.add(sig);
        cands.push({ kind: 'attr', from: f.id, to: t.id, amt, talents, attrs: nx });
      }
    }
  }
  // Talent moves.
  for (const f of T) {
    for (const t of T) {
      if (f.id === t.id) continue;
      for (const amt of STEPS) {
        const nx = Space.transfer(T, {}, {}, cfg.TALENT_BUDGET, talents, f.id, t.id, amt);
        if (!nx) continue;
        const sig = 't' + Space.signature(T, nx);
        if (seen.has(sig)) continue;
        seen.add(sig);
        cands.push({ kind: 'talent', from: f.id, to: t.id, amt, talents: nx, attrs });
      }
    }
  }
  let best = null;
  for (const c of cands) {
    const v = (await evalFast(c.talents, c.attrs, iters)).lootPerMin;
    if (!best || v > best.v) best = { ...c, v };
  }
  return {
    neighbours: cands.length,
    best,
    isLocalOptimum: !best || best.v <= baseScore,
    bestGainPct: best ? ((best.v - baseScore) / baseScore) * 100 : 0,
  };
}


// ONE implementation of the analysis, used by both entry modes. A second copy is how two callers
// come to disagree about what a verdict means.
async function analyse({ label, uid, level, hunter, cfg, evalFast, refT, refA, gotT, gotA, iters, verbose }) {
  const D = H.Objective.describeRun;
  const Space = H.Space;
  const A = cfg.ATTRIBUTES;
  const T = cfg.TALENTS;
  const deps = cfg.ATTRIBUTE_DEPENDENCIES;
  const minVal = cfg.ATTRIBUTE_MIN_VALUE;

  const refRun = await evalFast(refT, refA, iters);
  const gotRun = await evalFast(gotT, gotA, iters);
  const refScore = refRun.lootPerMin;
  const gotScore = gotRun.lootPerMin;

  const nRef = await neighbourhood(evalFast, cfg, refT, refA, refScore, iters);
  const nGot = await neighbourhood(evalFast, cfg, gotT, gotA, gotScore, iters);

  // Straight-line path, one point at a time, always toward the reference.
  let curT = { ...gotT };
  let curA = { ...gotA };
  const pathScores = [gotScore];
  let stepN = 0;
  while (stepN < 400) {
    const overA = A.filter((d) => (curA[d.id] || 0) > (refA[d.id] || 0));
    const shortA = A.filter((d) => (curA[d.id] || 0) < (refA[d.id] || 0));
    const overT = T.filter((d) => (curT[d.id] || 0) > (refT[d.id] || 0));
    const shortT = T.filter((d) => (curT[d.id] || 0) < (refT[d.id] || 0));
    // TRY EVERY over->short PAIR, not just the first. The first version tried overA[0]->shortA[0]
    // and gave up if that single transfer was illegal, which reported pathSteps 0 and a valley of
    // 0.00% for ozzy@54 -- read as "the path is flat" when in fact NO PATH WAS WALKED. A statistic
    // computed over an empty walk must not look like a measurement.
    let moved = false;
    for (const f of overA) {
      for (const t of shortA) {
        const nx = Space.transfer(A, deps, minVal, cfg.ATTRIBUTE_BUDGET, curA, f.id, t.id, 1);
        if (nx) { curA = nx; moved = true; break; }
      }
      if (moved) break;
    }
    if (!moved) {
      for (const f of overT) {
        for (const t of shortT) {
          const nx = Space.transfer(T, {}, {}, cfg.TALENT_BUDGET, curT, f.id, t.id, 1);
          if (nx) { curT = nx; moved = true; break; }
        }
        if (moved) break;
      }
    }
    if (!moved) break;
    stepN++;
    pathScores.push((await evalFast(curT, curA, iters)).lootPerMin);
    if (verbose && (stepN <= 3 || stepN % 10 === 0)) {
      const v = pathScores[pathScores.length - 1];
      console.log(`  step ${String(stepN).padStart(3)} ${Math.round(v).toString().padStart(12)}`
        + `  ${(((v - refScore) / refScore) * 100).toFixed(2)}% vs reference`);
    }
  }
  const minOnPath = Math.min(...pathScores);
  const pathReachedReference = stepN > 0
    && Math.abs(pathScores[pathScores.length - 1] - refScore) / refScore < 0.02;
  // An empty or truncated walk has no valley to report. Returning 0 makes "we could not walk it"
  // indistinguishable from "the route is flat", and those imply opposite fixes.
  const pathIsUsable = stepN > 0 && pathReachedReference;

  const valleyDepthPct = ((minOnPath - Math.min(gotScore, refScore)) / Math.min(gotScore, refScore)) * 100;
  const gapPct = ((gotScore - refScore) / refScore) * 100;
  const NOISE_PCT = 0.2;
  const refRegimeDiffers = D(refRun).regime !== D(gotRun).regime;

  let cause;
  let because;
  if (gapPct >= -NOISE_PCT) {
    cause = 'NO_GAP';
    because = `within measurement precision (${gapPct.toFixed(2)}%, noise floor ${NOISE_PCT}%)`;
  } else if (!nGot.isLocalOptimum) {
    cause = 'SEARCH_STOPPED_EARLY';
    because = `one legal move improves the returned build by ${nGot.bestGainPct.toFixed(3)}% `
      + `(${nGot.best.kind} ${nGot.best.from}->${nGot.best.to} x${nGot.best.amt})`;
  } else if (refRegimeDiffers) {
    // The largest gap measured so far is this one: the reference KILLS the boss and the returned
    // build only reaches it. That is a different regime, not a worse point in the same one, and it
    // is the mechanism behind every big Ozzy/Borge gap seen to date.
    cause = 'WRONG_REGIME';
    because = `the reference is "${D(refRun).regime}" and the returned build is `
      + `"${D(gotRun).regime}" -- different regimes, not a worse point in the same one`;
  } else if (!pathIsUsable) {
    // Say so instead of inventing a valley. This branch previously could not be reached because a
    // failed walk reported valley 0.00%, which read as a flat route.
    cause = 'PATH_NOT_WALKABLE';
    because = `no legal one-point path from the returned build to the reference was found `
      + `(${stepN} step(s) taken, reached reference: ${pathReachedReference}); the valley is unmeasured`;
  } else if (valleyDepthPct < -1) {
    cause = 'BASIN';
    because = `both are strict local optima; the path between them dips ${valleyDepthPct.toFixed(2)}%`;
  } else if (!nRef.isLocalOptimum && nRef.bestGainPct > NOISE_PCT) {
    cause = 'REFERENCE_BEATABLE_AND_AHEAD';
    because = `we converged to a strict local optimum while the reference -- itself improvable by `
      + `${nRef.bestGainPct.toFixed(3)}% -- is still ahead, so we are in a worse basin`;
  } else {
    cause = 'BASIN_SHALLOW';
    because = `both are effectively local optima; the path dips only ${valleyDepthPct.toFixed(2)}%`;
  }

  return {
    label, uid, level, hunter, iterations: iters,
    referenceScore: refScore, returnedScore: gotScore, gapPct,
    referenceIsLocalOptimum: nRef.isLocalOptimum, returnedIsLocalOptimum: nGot.isLocalOptimum,
    referenceBestNeighbourGainPct: nRef.bestGainPct, returnedBestNeighbourGainPct: nGot.bestGainPct,
    referenceNeighbours: nRef.neighbours, returnedNeighbours: nGot.neighbours,
    pathSteps: stepN, pathReachedReference, valleyDepthPct,
    referenceRegime: D(refRun).regime, returnedRegime: D(gotRun).regime,
    cause, because,
  };
}

function printVerdict(v) {
  console.log(`${String(v.label).padEnd(16)} lvl${String(v.level).padStart(3)}  `
    + `gap ${(v.gapPct >= 0 ? '+' : '') + v.gapPct.toFixed(2)}%`.padEnd(14)
    + `  refLocalOpt=${v.referenceIsLocalOptimum ? 'Y' : 'N'}`
    + `  retLocalOpt=${v.returnedIsLocalOptimum ? 'Y' : 'N'}`
    + `  valley ${v.valleyDepthPct.toFixed(2)}%`.padEnd(16)
    + `  ${v.cause}`);
}

(async () => {
  const iters = Number(flag('iters', '1000'));
  const resultsFile = flag('results', null);
  const verdicts = [];

  if (resultsFile) {
    // ANALYSE AN EXISTING GATE RUN. No optimizer invocations -- the allocations are already there.
    const rows = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    console.log(`basin-probe: ${rows.length} row(s) from ${resultsFile}   ALL SCORES AT ${iters} ITERATIONS`);
    console.log('');
    const all = H.loadKnownBuilds();
    for (const r of rows) {
      if (!r.optimizedTalents || !r.importTalents) {
        console.log(`${r.hunter}#${r.index} SKIP (no allocations recorded)`);
        continue;
      }
      const uid = `${r.hunter}:${r.set}#${r.index}`;
      const entry = (all[r.hunter] || []).find((e) => e.uid === uid);
      if (!entry) { console.log(`${uid} SKIP (fixture not found)`); continue; }
      const build = await H.parseBuildCode(entry.code, r.hunter);
      const cfg = H.cfgForImport(r.hunter, build);
      const evalFast = await H.browserSandbox().HunterSim.compileEvaluator(r.hunter, cfg);
      const v = await analyse({
        label: entry.name || uid, uid, level: r.level, hunter: r.hunter, cfg, evalFast,
        refT: r.importTalents, refA: r.importAttributes,
        gotT: r.optimizedTalents, gotA: r.optimizedAttributes, iters, verbose: false,
      });
      verdicts.push(v);
      printVerdict(v);
    }
  } else {
    const fixtureName = flag('fixture', null);
    if (!fixtureName) throw new Error('basin-probe: pass --fixture=<name> or --results=<file>');
    const fx = H.findFixture(H.loadKnownBuilds(), fixtureName);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build);
    const evalFast = await H.browserSandbox().HunterSim.compileEvaluator(fx.hunter, cfg);
    const scorer = await H.makeScorer(cfg, 'loot');
    const seed = parseInt(flag('seed', '9e3779b9'), 16);
    console.log(`basin-probe: ${fixtureName} (${fx.uid})   ALL SCORES AT ${iters} ITERATIONS`);
    const res = await H.Optimizer.optimize(cfg, {
      mode: 'loot', scorer, effort: { label: 'basin', seeds: [seed] },
    });
    if (res.diag && res.diag.ledgerText) {
      console.log('\nvalue ledger:');
      console.log(res.diag.ledgerText);
      console.log('');
    }
    const v = await analyse({
      label: fixtureName, uid: fx.uid, level: build.level, hunter: fx.hunter, cfg, evalFast,
      refT: build.talents, refA: build.attributes,
      gotT: res.best.talentAlloc, gotA: res.best.attrAlloc, iters, verbose: true,
    });
    verdicts.push(v);
    printVerdict(v);
  }

  // TALLY. The pattern across levels, stated -- not left to be eyeballed from a list.
  console.log('');
  console.log('=== CAUSE TALLY ===');
  const byCause = {};
  for (const v of verdicts) (byCause[v.cause] = byCause[v.cause] || []).push(v);
  for (const [c, list] of Object.entries(byCause).sort((a, b) => b[1].length - a[1].length)) {
    const levels = list.map((v) => v.level).sort((a, b) => a - b).join(',');
    console.log(`${String(list.length).padStart(3)}  ${c.padEnd(22)} levels ${levels}`);
  }
  const failing = verdicts.filter((v) => v.cause !== 'NO_GAP');
  console.log('');
  if (!failing.length) {
    console.log('CONCLUSION: no build in this set has a gap outside measurement precision.');
  } else {
    const counts = {};
    for (const v of failing) counts[v.cause] = (counts[v.cause] || 0) + 1;
    const [topCause, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    console.log(`CONCLUSION: ${failing.length} build(s) have a real gap; the dominant cause is `
      + `${topCause} (${topN} of ${failing.length}). Worst gap `
      + `${Math.min(...failing.map((v) => v.gapPct)).toFixed(2)}% at level `
      + `${failing.reduce((m, v) => (v.gapPct < m.gapPct ? v : m), failing[0]).level}.`);
  }
  const jsonOut = flag('json', null);
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(verdicts, null, 1));
    console.log(`verdicts written to ${jsonOut}`);
  }
})();
