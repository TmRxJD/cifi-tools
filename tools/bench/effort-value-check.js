'use strict';
// DOES `fast` EARN ITS PLACE IN THE DROPDOWN? Same build, both efforts, measured SOLO.
//
//   node tools/bench/effort-value-check.js [--only=a,b,c] [--sample=N] [--seed=N]
//
// THE QUESTION. An effort level is a promise: noticeably quicker, at some cost in quality. If
// `fast` is not actually faster, it is a worse build for no saving -- a trap that makes the tool
// look bad and teaches users to distrust the cheap path.
//
// THE BAR, from the project owner verbatim: "within 5% is the goal, I would accept within 10%,
// outside of that it's not worth having". So 5% is reported as the target and 10% is the line that
// decides whether the option survives -- and both are printed, because a result that passes at 8%
// is a different conversation from one that passes at 2% and should not read the same.
//
// WHY SOLO, AND WHY THAT MATTERS MORE THAN IT SOUNDS. The acceptance gate runs 7 builds per batch
// in parallel, so its per-build seconds are inflated several-fold by contention and are NOT a user's
// wall clock. A `fast` sweep showing 181-960s per build says nothing about how long one run takes,
// and comparing that against a differently-loaded `complete` run would be measuring the machine
// rather than the search. Both arms here run one at a time, in the same process, back to back.
//
// NOISE FLOOR. Two FINAL_ITERATIONS scores differ by ~0.2% from sampling alone (eval-precision-check:
// mean 0.12%, worst 0.35% on a fixed allocation), so a quality gap under ~1% is not a gap. Runtime
// has no such floor but is noisy in the other direction -- background load -- so the SPEEDUP RATIO
// is reported per build rather than averaged into a single headline number that hides a build where
// the ratio inverted.
//
// This is a REPORT with a verdict, not a pass/fail gate: the decision it informs (keep or remove a
// UI option) is the project owner's, and a bench should not make it for them.

const H = require('./harness.js');
const { NOISE_PCT } = require('./verdict.js');
const { makeBudget } = require('./budget.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const SAMPLE = Number(opt('sample', 0));
const SEED = Number(opt('seed', 1234));
const ITERS = 1000;

// The bar, from the project owner: fast must be meaningfully quicker and stay close on quality.
// GOAL is what we would like; LIMIT is what decides whether the option is worth having at all.
const MIN_SPEEDUP = 1.5;
const QUALITY_GOAL_PCT = 5;
const QUALITY_LIMIT_PCT = 10;

function pickStratified(flat, n, seed) {
  // Same idea as run.js: spread across hunters and level bands so a sample is never all cheap
  // low-level builds, where every effort level looks identical.
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const byHunter = { borge: [], ozzy: [], knox: [] };
  for (const f of flat) if (byHunter[f.hunter]) byHunter[f.hunter].push(f);
  const out = [];
  const per = Math.max(1, Math.round(n / 3));
  for (const h of Object.keys(byHunter)) {
    const list = byHunter[h].slice().sort((a, b) => (a.level || 0) - (b.level || 0));
    if (!list.length) continue;
    const bands = Math.min(per, list.length);
    const size = Math.ceil(list.length / bands);
    for (let i = 0; i < bands; i++) {
      const band = list.slice(i * size, (i + 1) * size);
      if (band.length) out.push(band[Math.floor(rnd() * band.length)]);
    }
  }
  return out.slice(0, n);
}

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  let picks;
  if (ONLY) picks = ONLY.split(',').map((x) => H.findFixture(known, x.trim()));
  else if (SAMPLE) picks = pickStratified(flat, SAMPLE, SEED);
  else picks = pickStratified(flat, 6, SEED);

  console.log(`Comparing effort levels on ${picks.length} build(s), one at a time (no contention).`);
  console.log(`Bar: >= ${MIN_SPEEDUP}x faster; ${QUALITY_GOAL_PCT}% of complete is the goal, ${QUALITY_LIMIT_PCT}% the limit.`);
  console.log(`Quality differences under ~${NOISE_PCT.meaningful}% are sampling, not signal.\n`);

  // Two full optimizer runs per build, and per-build cost varies more than 10x with level.
  const budget = makeBudget(args, { minutes: 20 });
  const rows = [];
  for (const fx of picks) {
    if (budget.stop(rows.length, picks.length)) break;
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const scoreCtx = (mode === 'boss' || mode === 'bossTimeless') && Number.isFinite(fx.bossStage)
      ? { bossTarget: fx.bossStage } : undefined;
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);

    const arm = async (effort) => {
      const pooled = await H.makePooledScorer(cfg, mode, scoreCtx);
      try {
        const t0 = Date.now();
        // maxSeconds: 0 disables the wall-clock cap. With it on, a slow arm gets truncated and the
        // comparison silently becomes "which arm hit the cap" instead of "which arm is faster".
        const res = await H.Optimizer.optimize(cfg, { mode, scorer: pooled.score, effort, maxSeconds: 0 });
        const secs = (Date.now() - t0) / 1000;
        const score = primary(await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc, ITERS));
        // FINGERPRINT THE ALLOCATION, NOT JUST THE SCORE. A matching score does not mean a matching
        // build -- this repo already keeps search-identity-probe.js for exactly that reason. Without
        // it a "+0.00%" row cannot distinguish "both efforts found the SAME build" (fast loses
        // nothing) from "they found DIFFERENT builds that happen to score alike" (fast is lucky on
        // this fixture and says nothing about the next one). Those are different claims about
        // whether the cheap option is trustworthy, and they must not print identically.
        const sig = JSON.stringify([res.best.talentAlloc, res.best.attrAlloc]);
        return { secs, score, evals: res.evals, sig };
      } finally { await pooled.destroy(); }
    };

    const fast = await arm('fast');
    const complete = await arm('complete');
    const speedup = complete.secs / fast.secs;
    const qualityPct = 100 * (fast.score - complete.score) / Math.abs(complete.score);
    const sameBuild = fast.sig === complete.sig;
    rows.push({ name: fx.name, level: fx.level, fast, complete, speedup, qualityPct, sameBuild });

    console.log(`${String(fx.name).padEnd(11)} lvl${String(fx.level).padEnd(3)}`
      + `  fast ${fast.secs.toFixed(0).padStart(4)}s/${String(fast.evals).padStart(5)}ev`
      + `  complete ${complete.secs.toFixed(0).padStart(4)}s/${String(complete.evals).padStart(5)}ev`
      + `  speedup ${speedup.toFixed(2)}x`
      + `  quality ${qualityPct >= 0 ? '+' : ''}${qualityPct.toFixed(2)}%`
      + `  ${sameBuild ? 'same build' : 'DIFFERENT build'}`);
  }

  budget.report(rows.length, picks.length);
  console.log('');
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const speedups = rows.map((r) => r.speedup);
  const losses = rows.map((r) => r.qualityPct);
  console.log(`median speedup      ${med(speedups).toFixed(2)}x   (range ${Math.min(...speedups).toFixed(2)}x .. ${Math.max(...speedups).toFixed(2)}x)`);
  console.log(`median quality gap  ${med(losses).toFixed(2)}%   (worst ${Math.min(...losses).toFixed(2)}%)`);
  // Reported, never graded. A different build scoring the same is not a failure -- the objective is
  // what the user asked for, and two builds can genuinely tie on it. It is stated because it says
  // how much a 0.00% row generalises: identical builds mean fast lost nothing HERE and would lose
  // nothing on a rerun, while a tie between different builds is a coincidence of this fixture.
  const identical = rows.filter((r) => r.sameBuild).length;
  console.log(`identical builds    ${identical}/${rows.length}`);

  // A VERDICT ON A PARTIAL RUN IS A VERDICT ON WHAT RAN. Printing "fast earns its place"
  // after measuring one build of three would be exactly the overclaim this suite exists to
  // prevent, so the scope is stated in the verdict line itself rather than only above it.
  const scope = rows.length < picks.length
    ? `(ONLY ${rows.length} of ${picks.length} build(s) measured) ` : '';
  const tooSlow = rows.filter((r) => r.speedup < MIN_SPEEDUP);
  const missedGoal = rows.filter((r) => r.qualityPct < -QUALITY_GOAL_PCT);
  const tooWorse = rows.filter((r) => r.qualityPct < -QUALITY_LIMIT_PCT);
  console.log('');
  if (tooSlow.length) {
    console.log(`${tooSlow.length}/${rows.length} build(s) are under ${MIN_SPEEDUP}x faster: `
      + tooSlow.map((r) => `${r.name} ${r.speedup.toFixed(2)}x`).join(', '));
  }
  if (missedGoal.length) {
    console.log(`${missedGoal.length}/${rows.length} build(s) miss the ${QUALITY_GOAL_PCT}% goal: `
      + missedGoal.map((r) => `${r.name} ${r.qualityPct.toFixed(2)}%`).join(', '));
  }
  if (tooWorse.length) {
    console.log(`${tooWorse.length}/${rows.length} build(s) are past the ${QUALITY_LIMIT_PCT}% limit: `
      + tooWorse.map((r) => `${r.name} ${r.qualityPct.toFixed(2)}%`).join(', '));
  }
  if (!tooSlow.length && !tooWorse.length) {
    console.log(`VERDICT: ${scope}fast earns its place -- consistently faster and inside the `
      + `${QUALITY_LIMIT_PCT}% limit${missedGoal.length ? `, though ${missedGoal.length} build(s) `
      + `miss the ${QUALITY_GOAL_PCT}% goal` : ' and the ' + QUALITY_GOAL_PCT + '% goal'}.`);
  } else if (tooSlow.length >= Math.ceil(rows.length / 2)) {
    console.log(`VERDICT: ${scope}fast is NOT meaningfully faster`.replace(/`/g,'') + '  on most builds. An effort level that does '
      + 'not save time is a worse build for nothing, and should be removed rather than tuned.');
  } else {
    console.log('VERDICT: mixed -- see the per-build rows above before deciding.');
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
