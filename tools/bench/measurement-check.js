'use strict';
// DOES THE MEASUREMENT MODULE ACTUALLY REFUSE WHAT IT CLAIMS TO REFUSE?
//
//   node tools/bench/measurement-check.js
//
// Every case here is a REAL failure from this project, replayed as a negative control. A checking
// module that cannot fail is decoration -- this repo has shipped three audit tools that carried the
// defect they hunted, and two benches that passed on zero comparisons.
//
// The meta-rule: a new measurement tool is not trusted until it has been shown to FAIL on a
// known-bad input. Each case below asserts a THROW or a specific verdict, never just "it ran".

const H = require('./harness.js');
const M = require('./measurement.js');

let pass = 0;
let fail = 0;
function ok(name) { pass++; console.log(`  ok    ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }

async function mustThrow(name, fn, expectFragment) {
  try {
    await fn();
    bad(name, 'it did NOT throw');
  } catch (e) {
    if (expectFragment && !String(e.message).includes(expectFragment)) {
      bad(name, `threw the wrong error: ${e.message}`);
    } else ok(name);
  }
}

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, 'knox@30');
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
  const mode = fx.mode || 'loot';
  const base = { H, cfg, mode, fidelity: 1000 };

  console.log('MEASUREMENT MODULE -- negative controls, each a real failure from this project');

  // 1. THE ILLEGAL BUILD THAT SCORED +7.50%. `time 2` with its ancestors at 0. Caps, budget, an
  //    independent re-measurement and a determinism test all passed it.
  const illegal = { kraken: 37, soul: 17, dead: 10, spa: 0, pl: 0, time: 2, sear: 5, pct: 0, kot: 0, fe: 0, sop: 0 };
  const mIllegal = await M.measure({ ...base, talents: build.talents, attrs: illegal, label: 'illegal' });
  if (mIllegal.legality.ok) bad('detects the dependency-illegal build');
  else if (!mIllegal.legality.problems.some((p) => p.includes('pl'))) {
    bad('detects the dependency-illegal build', `named the wrong problem: ${mIllegal.legality.problems.join('; ')}`);
  } else ok('detects the dependency-illegal build (time funded under pl=0)');

  const mImport = await M.measure({ ...base, talents: build.talents, attrs: build.attributes, label: 'import' });
  if (!mImport.legality.ok) bad('the real import measures as LEGAL', mImport.legality.problems.join('; '));
  else ok('the real import measures as legal');

  // 1b. THE TIER-THRESHOLD VIOLATION. Borge's atlas/weak/battle need 75 cost-weighted points below
  //     them, mino/hermes 150, athena 180. A donor refit funded all of them without paying the
  //     gates, scored -0.02% against the import, and produced a confident "borge@73 has no
  //     barrier". It must be named explicitly, not surfaced as a disagreement with isLegal.
  {
    const bfx = H.findFixture(known, 'borge@73');
    const bbuild = await H.parseBuildCode(bfx.code, bfx.hunter);
    const bcfg = H.cfgForImport(bfx.hunter, bbuild, { budgetMode: 'spend' });
    const violator = { ares: 46, ylith: 1, spartan: 6, timeless: 1, baal: 3, sensors: 6, htb: 1, lfin: 0, exp: 6, atlas: 6, weak: 6, battle: 3, mino: 20, hermes: 8, athena: 1 };
    const m = await M.measure({ H, cfg: bcfg, mode: 'loot', fidelity: 1000, talents: bbuild.talents, attrs: violator, label: 'threshold-violator' });
    if (m.legality.ok) bad('detects a tier-threshold violation');
    else if (!m.legality.problems.some((p) => p.includes('tier threshold'))) {
      bad('detects a tier-threshold violation', `named it as: ${m.legality.problems.join('; ')}`);
    } else ok('detects a tier-threshold violation (atlas/mino/athena funded without the gates)');
    const bimp = await M.measure({ H, cfg: bcfg, mode: 'loot', fidelity: 1000, talents: bbuild.talents, attrs: bbuild.attributes, label: 'borge-import' });
    if (!bimp.legality.ok) bad('the real borge@73 import is legal', bimp.legality.problems.join('; '));
    else ok('the real borge@73 import is legal');
  }

  const goodProv = { converged: true, deterministic: true, explorationFidelity: 1000, evals: 100 };

  // 2. An illegal candidate must not yield a percentage at all.
  await mustThrow('refuses to compare an ILLEGAL candidate',
    async () => M.compare(mIllegal, mImport, goodProv), 'ILLEGAL');

  // 3. Two arms judged at different fidelities -- the cheap arm scored on its own ruler.
  const mCheap = await M.measure({ ...base, fidelity: 250, talents: build.talents, attrs: build.attributes, label: 'cheap' });
  await mustThrow('refuses a comparison across different fidelities',
    async () => M.compare(mCheap, mImport, goodProv), 'fidelity mismatch');

  // 4. Provenance is mandatory: "converged", "truncated" and "non-deterministic" all print as the
  //    same percentage otherwise. This is the +78.80%/+62.72% failure.
  await mustThrow('refuses a comparison with no provenance',
    async () => M.compare(mImport, mImport, null), 'provenance is required');
  await mustThrow('refuses provenance missing a field',
    async () => M.compare(mImport, mImport, { converged: true, deterministic: true, evals: 1 }),
    'explorationFidelity');

  // 5. No silent defaults on measure() itself.
  await mustThrow('measure() refuses a missing fidelity',
    async () => M.measure({ H, cfg, mode, talents: build.talents, attrs: build.attributes, label: 'x' }), 'fidelity');
  await mustThrow('measure() refuses an unknown mode',
    async () => M.measure({ ...base, mode: 'sideways', talents: build.talents, attrs: build.attributes, label: 'x' }), 'unknown mode');

  // 6. A sub-noise delta is PARITY, not a win. Reporting +0.12% as a win turned two ties into
  //    "four for four" earlier in this session.
  const same = M.compare(mImport, mImport, goodProv);
  if (same.verdict !== 'parity') bad('a zero delta is parity', `got ${same.verdict}`);
  else ok('a zero delta reports as parity, not a win');

  // 7. The one-line report cannot omit its caveats.
  const truncated = M.compare(mImport, mImport, { converged: false, deterministic: false, explorationFidelity: 250, evals: 5 });
  const l = M.line(truncated);
  const missing = ['TRUNCATED', 'NON-DETERMINISTIC', 'explored-at-250'].filter((s) => !l.includes(s));
  if (missing.length) bad('the report line carries every caveat', `missing ${missing.join(', ')}`);
  else ok('the report line carries TRUNCATED, NON-DETERMINISTIC and the exploration fidelity');

  // 8. It must show the regime, so a farming gain is never read as a boss crossing.
  if (!l.includes(mImport.regime)) bad('the report line states the regime');
  else ok('the report line states the regime');

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAIL  the measurement module does not refuse what it claims to'); process.exit(1); }
  console.log('PASS  every known-bad input is refused');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
