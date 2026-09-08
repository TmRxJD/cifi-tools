'use strict';
// DOES OCBA ALLOCATION IN THE POLISH KEEP THE ANSWER WHILE COSTING LESS?
//
//   node tools/bench/ocba-polish-check.js --only=borge@35,knox@27 [--pool=4]
//
// The polish evaluates EVERY candidate move at FINAL_ITERATIONS -- textbook equal allocation. Most
// moves are plainly worse and need a handful of samples to rule out; a few sit on a 0.32% ridge and
// need many. Optimal Computing Budget Allocation (Chen) gives design i replications proportional to
// (spread_i / gap_i)^2, concentrating effort where the decision is actually open.
//
// NOT the top-K shortlist this repo measured and rejected. That ranked at SCREEN_ITERATIONS and
// DISCARDED the rest, and a 100-iteration score has been measured ordering a 0.32% ridge BACKWARDS
// by 1.7%, costing 1.64M on ozzy@62. Nothing is discarded here: a move outside the uncertainty band
// keeps its cheap estimate and can still win, it just is not re-sampled while it sits far behind.
//
// THE VERDICT IS ON QUALITY FIRST, SPEED SECOND. A cheaper polish that returns a worse build is not
// a win at any speed, so quality is the gate and the time saving is reported alongside.
//
// Both arms are judged at 1000 iterations regardless of what the search decided at, so the cheaper
// arm is never scored on its own noisier ruler.

const H = require('./harness.js');
const { makeBudget } = require('./budget.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@35,knox@27');
const POOL = opt('pool', null) ? Number(opt('pool', null)) : undefined;
const JUDGE_ITERS = 1000;
// The measured comparison floor: FINAL_ITERATIONS carries ~0.12% mean error, so a difference below
// roughly 0.3% is not evidence either way. Anything larger is treated as a real change.
const NOISE_PCT = 0.3;

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  const rows = [];
  // TWO full optimizer runs per build (OCBA off, then on), so five builds is ten runs and the
  // cost swings more than 10x with level. Measured: five builds took over 30 minutes, which is
  // not something to discover by waiting.
  const budget = makeBudget(args, { minutes: 20 });

  for (const name of names) {
    if (budget.stop(rows.length, names.length)) break;
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const imported = await H.evaluateAllocation(cfg, build.talents, build.attributes, JUDGE_ITERS);
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const pooled = await H.makePooledScorer(cfg, mode, undefined, POOL);
    try {
      const per = {};
      for (const ocba of [false, true]) {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, {
          mode,
          scorer: pooled.score,
          effort: {
            archiveEvals: 9600, refineSupports: 8, seeds: [0x9e3779b9],
            breakpointSpending: true, ocbaPolish: ocba,
          },
        });
        // ASSERT THE FLAG FROM THE RESULT, NEVER FROM THE ARGUMENT WE PASSED. bossDamageBands once
        // reached three of four wiring sites and looked connected; an unwired flag makes the ON arm
        // silently report the control's number, which is written down as "measured, no effect".
        const recorded = res.diag && res.diag.ocbaPolish;
        if (ocba && !recorded) {
          throw new Error(`${name}: asked for ocbaPolish but the run recorded no ocbaPolish stats `
            + '-- the flag is not reaching the polish and this comparison would be a lie');
        }
        if (!ocba && recorded) {
          throw new Error(`${name}: ocbaPolish was OFF but the run recorded OCBA stats`);
        }
        const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, JUDGE_ITERS);
        per[ocba ? 'on' : 'off'] = {
          value: primary(got),
          pct: 100 * (primary(got) - primary(imported)) / primary(imported),
          secs: (Date.now() - t0) / 1000,
          evals: res.evals,
          ocbaStats: res.diag && res.diag.ocbaPolish,
        };
      }
      rows.push({ name, mode, per });
      const o = per.off; const n = per.on;
      const skipped = n.ocbaStats && n.ocbaStats.ocbaConsidered
        ? (1 - n.ocbaStats.ocbaVerified / n.ocbaStats.ocbaConsidered) * 100 : 0;
      console.log(`${name.padEnd(10)} ${mode.padEnd(5)} `
        + `off ${o.pct.toFixed(2).padStart(7)}% ${o.secs.toFixed(0).padStart(4)}s   `
        + `OCBA ${n.pct.toFixed(2).padStart(7)}% ${n.secs.toFixed(0).padStart(4)}s   `
        + `${(o.secs / Math.max(0.001, n.secs)).toFixed(2)}x   `
        + `polish verified ${n.ocbaStats ? n.ocbaStats.ocbaVerified : '?'}/${n.ocbaStats ? n.ocbaStats.ocbaConsidered : '?'}`
        + ` (${skipped.toFixed(0)}% of full-fidelity polish work skipped)`);
    } finally { await pooled.destroy(); }
  }

  budget.report(rows.length, names.length);
  console.log('');
  console.log('VERDICT -- quality is the gate, speed is the report');
  let worse = 0;
  let secsOff = 0;
  let secsOn = 0;
  for (const r of rows) {
    secsOff += r.per.off.secs;
    secsOn += r.per.on.secs;
    const delta = r.per.on.pct - r.per.off.pct;
    if (delta < -NOISE_PCT) {
      worse++;
      console.log(`  WORSE  ${r.name}: ${r.per.off.pct.toFixed(2)}% -> ${r.per.on.pct.toFixed(2)}% `
        + `(${delta.toFixed(2)} points, beyond the ${NOISE_PCT}% comparison floor)`);
    } else {
      console.log(`  ok     ${r.name}: ${r.per.off.pct.toFixed(2)}% -> ${r.per.on.pct.toFixed(2)}% `
        + `(${delta >= 0 ? '+' : ''}${delta.toFixed(2)} points, within noise)`);
    }
  }
  console.log('');
  console.log(`overall ${(secsOff / Math.max(0.001, secsOn)).toFixed(2)}x faster across ${rows.length} build(s)`);
  if (worse) { console.log(`FAIL  ${worse} build(s) got worse beyond the comparison floor -- do not enable`); process.exit(1); }
  console.log('PASS  no build lost quality beyond the comparison floor');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
