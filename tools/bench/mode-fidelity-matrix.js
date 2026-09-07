'use strict';
// ALL FOUR OBJECTIVE MODES AGAINST BOTH FIDELITIES. 8 combinations, checked rather than assumed.
//
//   node tools/bench/mode-fidelity-matrix.js [--only=knox@12,ozzy@11]
//
// WHY THIS GAP EXISTS. Of 195 fixtures, 168 are `loot` and 14 are `push`; `boss` and `bossTimeless`
// have NO coverage at all -- this file's own notes say they "have never been quality-tested,
// because there is nothing to compare them against". That is the worst place for a blind spot: the
// boss objective is LEXICOGRAPHIC over a kill rate that moves in visible steps, which is exactly
// the threshold landscape where a coarse ruler misranks.
//
// FOUR PROPERTIES PER COMBINATION. Each catches a different way a mode can be broken while looking
// wired, and this project has shipped every one of these failures at least once:
//   1. FINITE -- a NaN/undefined score sorts unpredictably and silently picks an arbitrary build.
//   2. DISCRIMINATING -- a mode returning one constant value for different allocations is inert.
//      `loot` was measured flat across an entire boss plateau, so this is not hypothetical.
//   3. ORDER-AGREEING -- does the cheap fidelity rank the same way the expensive one does? A
//      0.32% ridge was once ranked BACKWARDS by 1.7% at 100 iterations.
//   4. OPTIMIZES -- optimize() actually completes in that mode and returns a legal, fully-spent
//      build. A mode can score fine and still fail end to end.
//
// This is a REPORT for agreement quality and a GATE for the rest: a non-finite score, an inert
// mode, or a failed optimize is a defect. Rank disagreement is printed, not failed, because low
// fidelity is EXPECTED to disagree sometimes -- that is what it is for.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'knox@12,ozzy@11');
const MODES = ['loot', 'push', 'boss', 'bossTimeless'];
const capOf = (d) => (d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel);

(async () => {
  const known = H.loadKnownBuilds();
  const SCREEN = H.Optimizer.SCREEN_ITERATIONS;
  const FINAL = H.Optimizer.FINAL_ITERATIONS;
  console.log(`fidelities: SCREEN=${SCREEN}  FINAL=${FINAL}`);
  console.log('');
  let failures = 0;
  let checked = 0;

  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const legal = (a) => cfg.ATTRIBUTES.every((d) => (a[d.id] || 0) <= capOf(d))
      && H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES || {}, minVal, a, cfg.ATTRIBUTE_BUDGET);

    // A spread of real neighbours, so "discriminating" is tested on builds a search would compare
    // rather than on wildly different ones any objective could separate.
    const variants = [{ t: build.talents, a: build.attributes }];
    for (const from of cfg.ATTRIBUTES) {
      if (variants.length >= 8) break;
      if ((build.attributes[from.id] || 0) < 1) continue;
      for (const to of cfg.ATTRIBUTES) {
        if (variants.length >= 8 || to.id === from.id) continue;
        const alt = { ...build.attributes };
        alt[from.id] -= 1;
        const room = Math.floor((cfg.ATTRIBUTE_BUDGET - H.Space.costOf(cfg.ATTRIBUTES, alt)) / (to.cost || 1));
        const add = Math.min(room, capOf(to) - (alt[to.id] || 0));
        if (add < 1) continue;
        alt[to.id] = (alt[to.id] || 0) + add;
        if (legal(alt)) variants.push({ t: build.talents, a: alt });
      }
    }
    if (variants.length < 4) { console.log(`${name}: only ${variants.length} variants -- SKIP`); continue; }

    for (const mode of MODES) {
      const pooled = await H.makePooledScorer(cfg, mode);
      try {
        const payload = variants.map((v) => ({ talentAlloc: v.t, attrAlloc: v.a }));
        const lo = await pooled.score(payload, SCREEN);
        const hi = await pooled.score(payload, FINAL);
        checked++;

        const finite = lo.every(Number.isFinite) && hi.every(Number.isFinite);
        const distinctHi = new Set(hi.map((x) => x.toFixed(6))).size;
        const discriminating = distinctHi > 1;

        // Pairwise rank agreement between the two fidelities.
        let pairs = 0; let agree = 0;
        for (let i = 0; i < hi.length; i++) {
          for (let j = i + 1; j < hi.length; j++) {
            if (Math.abs(hi[i] - hi[j]) < 1e-9) continue;   // a true tie cannot be got wrong
            pairs++;
            if ((lo[i] - lo[j] >= 0) === (hi[i] - hi[j] >= 0)) agree++;
          }
        }

        let optimizeOk = false; let optNote = '';
        try {
          const res = await H.Optimizer.optimize(cfg, {
            mode, scorer: pooled.score,
            effort: { archiveEvals: 600, refineSupports: 2, seeds: [0x9e3779b9] },
          });
          const tS = H.Space.costOf(cfg.TALENTS, res.best.talentAlloc);
          const aS = H.Space.costOf(cfg.ATTRIBUTES, res.best.attrAlloc);
          optimizeOk = legal(res.best.attrAlloc) && tS === cfg.TALENT_BUDGET && aS === cfg.ATTRIBUTE_BUDGET;
          if (!optimizeOk) optNote = ` (spend ${tS}/${cfg.TALENT_BUDGET},${aS}/${cfg.ATTRIBUTE_BUDGET})`;
        } catch (e) { optNote = ` (threw: ${e.message.slice(0, 60)})`; }

        const bad = !finite || !discriminating || !optimizeOk;
        if (bad) failures++;
        console.log(`${name.padEnd(10)} ${mode.padEnd(13)}`
          + ` finite=${finite ? 'y' : 'N'}`
          + ` distinct=${String(distinctHi).padStart(2)}/${hi.length}`
          + ` rankAgree=${pairs ? `${((100 * agree) / pairs).toFixed(0)}%` : 'n/a'}`
          + ` optimize=${optimizeOk ? 'ok' : 'FAIL'}${optNote}`
          + (bad ? '   ***' : ''));
      } finally { await pooled.destroy(); }
    }
  }

  console.log('');
  if (!checked) { console.log('NOTHING MEASURED -- zero comparisons is a failure'); process.exit(1); }
  if (failures) { console.log(`FAIL  ${failures}/${checked} mode-fidelity combination(s) defective`); process.exit(1); }
  console.log(`PASS  ${checked} combination(s): every mode scores finitely, discriminates, and optimizes`);
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
