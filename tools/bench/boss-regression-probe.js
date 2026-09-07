'use strict';
// WHY DOES ozzy@34b LOSE KILL RATE IN BOSS MODE? 22.7% -> 19.6% against its own import.
//
//   node tools/bench/boss-regression-probe.js [--only=ozzy@34b] [--iters=1000,4000]
//
// This is the FIRST measured boss-mode quality failure. Until the six boss builds were relabelled
// (their boss status had been sitting in free-text `note` while `mode` said push) the `boss`
// objective had zero fixture coverage, so nothing could have found it.
//
// THE FIRST QUESTION IS WHETHER IT IS REAL, and there is a specific reason to doubt it. Kill rate
// is a PROPORTION estimated from N simulated runs: at p ~= 0.2 over 1000 iterations the standard
// error is sqrt(0.2*0.8/1000) ~= 1.3 points, so a 3.1-point gap is about 2.5 SE. The evaluator is
// deterministic, so both numbers are exact FOR THEIR ALLOCATIONS -- but "exact" is not "precise":
// each is one sample of a stochastic quantity, and the ordering can flip with more samples.
// eval-precision-check measured ~0.12% mean error on LOOT at 1000 iterations; a threshold outcome
// like a kill is far coarser, and this project has already been burned reading a threshold-shaped
// field as if it were smooth.
//
// So: re-measure both allocations at rising fidelity and see whether the ORDERING is stable. A gap
// that survives 4x the iterations is a real defect worth chasing; one that flips is a gate reading
// noise, and the fix is the gate's threshold rather than the search.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'ozzy@34b');
const LADDER = (opt('iters', '1000,4000')).split(',').map(Number);

(async () => {
  const known = H.loadKnownBuilds();
  const fs = require('fs');

  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    console.log(`${name}  mode=${fx.mode}  bossStage=${fx.bossStage}  note="${fx.note || ''}"`);

    // The SAME build the gate judged, from its result file -- re-optimising might produce a
    // different one and would then be diagnosing a different failure.
    let opt2 = null;
    for (const f of ['overnight-sample.json']) {
      if (!fs.existsSync(f)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const rows = Array.isArray(raw) ? raw : Object.values(raw);
        // Result files written before `uid` was carried match on hunter+set+index instead.
        opt2 = rows.find((r) => r && r.optimizedTalents
          && (r.uid === fx.uid
            || (r.hunter === fx.hunter && r.set === fx.set && r.index === fx.index))) || null;
      } catch (e) { /* partial */ }
    }
    if (!opt2) { console.log('  (no stored optimizer build found -- cannot compare)'); continue; }

    console.log('');
    console.log('  iters   import kill%   ours kill%    import obj        ours obj        ordering');
    for (const it of LADDER) {
      const ri = await H.evaluateAllocation(cfg, build.talents, build.attributes, it);
      const ro = await H.evaluateAllocation(cfg, opt2.optimizedTalents, opt2.optimizedAttributes, it);
      const ctx = { bossTarget: fx.bossStage };
      const si = H.Objective.MODES.boss.score(ri, ctx);
      const so = H.Objective.MODES.boss.score(ro, ctx);
      const verdict = so < si ? 'IMPORT WINS (regression holds)' : 'ours >= import (regression GONE)';
      console.log(`  ${String(it).padStart(5)}   ${(ri.bossKillRate ?? -1).toFixed(2).padStart(11)}`
        + `   ${(ro.bossKillRate ?? -1).toFixed(2).padStart(10)}`
        + `   ${si.toExponential(4)}   ${so.toExponential(4)}   ${verdict}`);
    }

    // What actually differs between the two builds? A kill-rate gap with identical structure is a
    // different problem from one where the optimizer picked a different shape.
    const diff = [];
    for (const d of cfg.ATTRIBUTES) {
      const a = build.attributes[d.id] || 0;
      const b = opt2.optimizedAttributes[d.id] || 0;
      if (a !== b) diff.push(`${d.id} ${a}->${b}`);
    }
    for (const d of cfg.TALENTS) {
      const a = build.talents[d.id] || 0;
      const b = opt2.optimizedTalents[d.id] || 0;
      if (a !== b) diff.push(`${d.id} ${a}->${b}`);
    }
    console.log('');
    console.log(`  ${diff.length} node(s) differ: ${diff.join(', ') || '(identical)'}`);
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
