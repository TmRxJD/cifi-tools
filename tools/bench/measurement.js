'use strict';
// THE CANONICAL WAY TO MEASURE A BUILD, AND THE ONLY WAY A DELTA MAY BE PRINTED.
//
//   const M = require('./measurement.js');
//   const m = await M.measure({ H, cfg, mode, talents, attrs, label: 'ours', fidelity: 1000 });
//   const c = M.compare(m, importMeasurement);   // throws if either side is not valid
//   console.log(M.line(c));
//
// WHY THIS EXISTS -- every entry is a real failure from one session, not a hypothetical:
//
//   +7.50%   was an ILLEGAL build (`time 2` under `pl 0`). Caps, budget, an independent
//            re-measurement and a two-run determinism test all passed it, because none of them
//            walked the dependency edges.
//   +78.80%  then +62.72% from IDENTICAL settings -- a wall-clock stopping rule made a
//            PRNG-free method non-deterministic, and the number was reported as if converged.
//   -38.26%  was a build whose winning donor had been discarded by a 250-iteration screen; the
//            score was real, the search that produced it was crippled, and nothing said so.
//   "solved" was claimed for a build whose gain turned out to be faster farming, not the boss
//            crossing assumed, because the report printed loot and not the regime.
//
// The pattern: A MEASUREMENT MISSING A QUALIFIER LOOKS EXACTLY LIKE ONE THAT ISN'T. So a
// Measurement here carries its own validity, and `compare()` REFUSES rather than returning a
// number that would be read as comparable.
//
// This module contains no PRNG and no defaults that could paper over a missing input. Every field
// it needs is required; a missing one throws with the field named.

/** A node's cap. The field is `maxLevel`; reading `d.max` yields undefined, which silently means
 *  "uncapped" and produced a build with dead=31 against a cap of 10, reported as +103.60%. */
function capOf(d) {
  return d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel;
}

/**
 * Every reason a build can be illegal, as a LIST rather than a boolean.
 *
 * A boolean tells you an allocation failed; it does not tell you the caps check passed while the
 * dependency check was never run. `Space.isLegal` returned `true` for every input for a whole
 * session because it was called with alloc/budget swapped, and a boolean could not express that.
 */
function legalityOf(H, cfg, talents, attrs) {
  const problems = [];
  const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};

  for (const d of cfg.ATTRIBUTES) {
    const v = attrs[d.id] || 0;
    if (v < 0) problems.push(`attr ${d.id} is negative (${v})`);
    if (v > capOf(d)) problems.push(`attr ${d.id}=${v} exceeds cap ${capOf(d)}`);
  }
  for (const d of cfg.TALENTS) {
    const v = talents[d.id] || 0;
    if (v < 0) problems.push(`talent ${d.id} is negative (${v})`);
    if (v > capOf(d)) problems.push(`talent ${d.id}=${v} exceeds cap ${capOf(d)}`);
  }

  // Dependency edges, walked directly. NOT delegated: the delegate has waved through two different
  // illegal builds in one day, and this is the check that both of them evaded.
  for (const child of Object.keys(deps)) {
    if ((attrs[child] || 0) <= 0) continue;
    for (const parent of deps[child]) {
      if ((attrs[parent] || 0) <= 0) problems.push(`attr ${child} is funded but its parent ${parent} is 0`);
    }
  }

  // TIER THRESHOLDS. Borge's atlas/weak/battle need 75 COST-WEIGHTED points spent in
  // strictly-lower-threshold nodes, mino/hermes 150, athena 180; Ozzy has 90/150/180; Knox has
  // none. Omitting this check is how a donor refit that funded atlas/mino/athena without paying
  // their gates was accepted, scored -0.02% against the import, and produced a confident
  // "there is no barrier on borge@73" -- the fourth illegal-build artifact in one session.
  const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
  for (const d of cfg.ATTRIBUTES) {
    const threshold = minVal[d.id] || 0;
    if (threshold <= 0 || (attrs[d.id] || 0) <= 0) continue;
    let below = 0;
    for (const o of cfg.ATTRIBUTES) {
      if ((minVal[o.id] || 0) < threshold) below += (attrs[o.id] || 0) * (o.cost || 1);
    }
    if (below < threshold) {
      problems.push(`attr ${d.id} is funded but only ${below} cost-weighted points sit below its `
        + `tier threshold of ${threshold}`);
    }
  }

  const attrSpend = H.Space.costOf(cfg.ATTRIBUTES, attrs);
  const talentSpend = H.Space.costOf(cfg.TALENTS, talents);
  if (attrSpend > cfg.ATTRIBUTE_BUDGET) problems.push(`attribute spend ${attrSpend} exceeds budget ${cfg.ATTRIBUTE_BUDGET}`);
  if (talentSpend > cfg.TALENT_BUDGET) problems.push(`talent spend ${talentSpend} exceeds budget ${cfg.TALENT_BUDGET}`);

  // Cross-check against the shipped predicate, with the arguments in the order it actually declares
  // -- (defs, deps, minVal, alloc, budget). A DISAGREEMENT is reported rather than resolved: if the
  // two ever differ, one of them is wrong and that is a finding, not something to silently prefer.
  let shipped = null;
  try {
    shipped = H.Space.isLegal(cfg.ATTRIBUTES, deps, cfg.ATTRIBUTE_MIN_VALUE, attrs, cfg.ATTRIBUTE_BUDGET);
  } catch (e) {
    problems.push(`Space.isLegal threw: ${e.message}`);
  }
  if (shipped === false && !problems.length) {
    problems.push('Space.isLegal says illegal but no explicit rule here was violated -- one of the two is wrong');
  }

  return {
    ok: problems.length === 0,
    problems,
    attrSpend,
    talentSpend,
    attrBudget: cfg.ATTRIBUTE_BUDGET,
    talentBudget: cfg.TALENT_BUDGET,
    fullySpent: attrSpend === cfg.ATTRIBUTE_BUDGET && talentSpend === cfg.TALENT_BUDGET,
    shippedPredicate: shipped,
  };
}

/**
 * Measure one build, completely. Returns a record that carries its own validity.
 *
 * Required: H, cfg, mode, talents, attrs, label, fidelity. Nothing is defaulted -- a defaulted
 * fidelity is how two arms end up judged on different rulers.
 */
async function measure(opts) {
  for (const k of ['H', 'cfg', 'mode', 'talents', 'attrs', 'label', 'fidelity']) {
    if (opts[k] === undefined || opts[k] === null) {
      throw new Error(`measure(): "${k}" is required -- no defaults, because a defaulted field is `
        + 'exactly how a measurement loses the qualifier that made it meaningful');
    }
  }
  const { H, cfg, mode, talents, attrs, label, fidelity } = opts;
  if (!Number.isFinite(fidelity) || fidelity <= 0) throw new Error(`measure(): fidelity must be a positive number, got ${fidelity}`);
  if (mode !== 'loot' && mode !== 'push' && mode !== 'boss' && mode !== 'bossTimeless') {
    throw new Error(`measure(): unknown mode "${mode}"`);
  }

  const legality = legalityOf(H, cfg, talents, attrs);
  const result = await H.evaluateAllocation(cfg, talents, attrs, fidelity);

  // The PRIMARY metric is the one this build's own objective is judged on. Judging a push build on
  // loot fails it for succeeding at what it was built for.
  const primary = mode === 'push' ? result.stage : result.loot;
  if (!Number.isFinite(primary)) {
    throw new Error(`measure(): the evaluator returned no finite ${mode === 'push' ? 'stage' : 'loot'} for ${label}`);
  }

  // EVERY evaluator field is retained. Four wrong conclusions in this project came from a report
  // that could not see the deciding field (materials, XP, bossKillRate).
  let described = null;
  try { described = H.Objective.describeRun(result); } catch (e) { described = { regime: `describeRun threw: ${e.message}` }; }

  return {
    kind: 'Measurement',
    label,
    mode,
    fidelity,
    primary,
    legality,
    regime: described.regime,
    killsBoss: !!described.killsBoss,
    bossKillRate: result.bossKillRate,
    bossHpPercent: result.bossHpPercent,
    maxStage: result.maxStage,
    avgStage: result.avgStage,
    talents: { ...talents },
    attrs: { ...attrs },
    raw: result,
  };
}

// Measured: FINAL_ITERATIONS carries ~0.12% mean error (worst 0.35%), so a comparison of two
// scores carries ~0.2-0.3%. A difference under this is NOT a difference, and calling one a win is
// how sub-noise numbers got reported as improvements.
const NOISE_FLOOR_PCT = 0.3;

/**
 * Compare two Measurements. REFUSES rather than returning a misleading number.
 *
 * `provenance` states how the candidate was produced and is REQUIRED, because "converged",
 * "truncated", "screened cheaply" and "non-deterministic" all print as the same percentage.
 */
function compare(candidate, baseline, provenance) {
  for (const [n, m] of [['candidate', candidate], ['baseline', baseline]]) {
    if (!m || m.kind !== 'Measurement') throw new Error(`compare(): ${n} is not a Measurement from measure()`);
  }
  if (candidate.mode !== baseline.mode) {
    throw new Error(`compare(): mode mismatch (${candidate.mode} vs ${baseline.mode}) -- these judge different things`);
  }
  if (candidate.fidelity !== baseline.fidelity) {
    throw new Error(`compare(): fidelity mismatch (${candidate.fidelity} vs ${baseline.fidelity}) -- `
      + 'scoring one arm on its own cheaper ruler flatters it');
  }
  if (!provenance || typeof provenance !== 'object') {
    throw new Error('compare(): provenance is required -- state { converged, deterministic, explorationFidelity, evals }');
  }
  for (const k of ['converged', 'deterministic', 'explorationFidelity', 'evals']) {
    if (provenance[k] === undefined) throw new Error(`compare(): provenance.${k} is required`);
  }
  if (!candidate.legality.ok) {
    throw new Error(`compare(): the candidate is ILLEGAL and has no comparable score -- `
      + candidate.legality.problems.join('; '));
  }
  if (!baseline.legality.ok) {
    throw new Error(`compare(): the baseline is ILLEGAL -- ${baseline.legality.problems.join('; ')}`);
  }

  const deltaPct = 100 * (candidate.primary - baseline.primary) / baseline.primary;
  const significant = Math.abs(deltaPct) >= NOISE_FLOOR_PCT;
  return {
    kind: 'Comparison',
    candidate,
    baseline,
    provenance,
    deltaPct,
    significant,
    // A sub-noise delta is PARITY, never a win or a loss. Reporting +0.12% as a win is what turned
    // two ties into "four for four" earlier in this session.
    verdict: !significant ? 'parity'
      : (deltaPct > 0 ? 'better' : 'worse'),
    regimeChanged: candidate.regime !== baseline.regime,
  };
}

/** One line that cannot omit a qualifier, because they are interpolated unconditionally. */
function line(c) {
  if (!c || c.kind !== 'Comparison') throw new Error('line(): expects a Comparison from compare()');
  const p = c.provenance;
  const caveats = [];
  if (!p.converged) caveats.push('TRUNCATED-not-converged');
  if (!p.deterministic) caveats.push('NON-DETERMINISTIC');
  if (p.explorationFidelity !== c.candidate.fidelity) caveats.push(`explored-at-${p.explorationFidelity}`);
  return `${c.candidate.label.padEnd(12)} ${c.verdict.padEnd(7)} ${c.deltaPct.toFixed(2).padStart(8)}%`
    + `  ${c.significant ? '' : '(within the ' + NOISE_FLOOR_PCT + '% noise floor) '}`
    + `spend ${c.candidate.legality.talentSpend}/${c.candidate.legality.talentBudget}`
    + `,${c.candidate.legality.attrSpend}/${c.candidate.legality.attrBudget}`
    + `  ${c.baseline.regime} -> ${c.candidate.regime}`
    + `  kill ${(c.baseline.bossKillRate || 0).toFixed(1)} -> ${(c.candidate.bossKillRate || 0).toFixed(1)}`
    + `  evals ${p.evals}`
    + (caveats.length ? `  [${caveats.join(' ')}]` : '');
}

module.exports = { measure, compare, line, legalityOf, capOf, NOISE_FLOOR_PCT };
