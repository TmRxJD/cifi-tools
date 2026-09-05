'use strict';
// THE PARALLEL EVALUATOR MUST RETURN BIT-IDENTICAL RESULTS TO THE SERIAL ONE.
//
// A pool that is merely CLOSE is worse than no pool: this repo's whole method rests on the
// evaluator being exactly deterministic (it is what makes memoization sound and what lets a 0.2%
// difference be called real). A pool that perturbed results by even a rounding step would quietly
// invalidate every measurement taken through it, while looking like a speedup.
//
// So this compares EVERY field of EVERY result, exactly, with no tolerance -- and it checks the
// two properties that could break independently:
//   1. same values as serial, field for field
//   2. same ORDER as the caller supplied, since the pool splits work across threads and
//      reassembles it (an off-by-one in the reassembly returns valid numbers for the wrong build,
//      which no value check would catch)
//
// It also reports the speedup, because "is it actually faster" is the only reason to accept the
// extra machinery at all.

const H = require('./harness.js');
const { EvalPool, DEFAULT_SIZE } = require('./eval-pool.js');

const FIELDS = ['lootPerMin', 'avgStage', 'avgTime', 'minStage', 'maxStage',
  'bossHpPercent', 'bossKillRate', 'mat1', 'mat2', 'mat3', 'xp'];

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, 'borge@35');
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });

  // A spread of DISTINCT allocations, so the order check has something to detect. Perturbing one
  // attribute at a time keeps them all legal while making every result different.
  const Space = H.Space;
  const pairs = [{ talentAlloc: build.talents, attrAlloc: build.attributes }];
  const attrs = cfg.ATTRIBUTES;
  for (let i = 0; i < attrs.length && pairs.length < 12; i++) {
    for (let j = 0; j < attrs.length && pairs.length < 12; j++) {
      if (i === j) continue;
      const nx = Space.transfer(attrs, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE,
        cfg.ATTRIBUTE_BUDGET, build.attributes, attrs[i].id, attrs[j].id, 1);
      if (nx) pairs.push({ talentAlloc: build.talents, attrAlloc: nx });
    }
  }
  console.log(`${fx.name}: ${pairs.length} distinct allocations, pool size ${DEFAULT_SIZE}`);
  if (pairs.length < 4) { console.log('FAIL  too few allocations to compare -- nothing tested'); process.exit(1); }

  const ITERS = 200;

  const t0 = Date.now();
  const serial = [];
  for (const p of pairs) serial.push(await H.evaluateAllocation(cfg, p.talentAlloc, p.attrAlloc, ITERS));
  const serialMs = Date.now() - t0;

  const pool = await new EvalPool(fx.hunter, cfg).start();
  const t1 = Date.now();
  const par = await pool.evaluate(pairs, ITERS);
  const parMs = Date.now() - t1;
  await pool.destroy();

  let bad = 0;
  let compared = 0;
  if (par.length !== serial.length) {
    console.log(`FAIL  pool returned ${par.length} results for ${serial.length} pairs`);
    process.exit(1);
  }
  for (let i = 0; i < serial.length; i++) {
    for (const f of FIELDS) {
      const a = serial[i][f];
      const b = par[i][f];
      if (a === undefined && b === undefined) continue;
      compared++;
      if (!Object.is(a, b)) {
        bad++;
        if (bad <= 5) console.log(`FAIL  pair ${i} field ${f}: serial ${a} vs pool ${b}`);
      }
    }
  }

  // ORDER: every allocation is distinct, so identical values in the right slots is the proof.
  // Deliberately checked as its own claim -- a reassembly bug returns real numbers for the wrong
  // build, which the field comparison above would only catch by luck.
  const distinct = new Set(serial.map((r) => r.lootPerMin)).size;
  console.log(`distinct loot values among the ${serial.length} allocations: ${distinct}`);
  if (distinct < 3) {
    console.log('FAIL  the allocations are not distinct enough for the ORDER check to mean anything');
    process.exit(1);
  }

  console.log('');
  console.log(`compared ${compared} field values across ${serial.length} allocations`);
  console.log(`serial ${serialMs}ms   pool ${parMs}ms   speedup ${(serialMs / Math.max(1, parMs)).toFixed(2)}x`);
  if (bad) { console.log(`FAIL  ${bad} field value(s) differ -- the pool is NOT equivalent`); process.exit(1); }
  if (!compared) { console.log('FAIL  compared nothing'); process.exit(1); }
  // AND THE SCORER BUILT ON IT MUST MATCH TOO. The raw fields being identical does not by itself
  // prove the pooled SCORER matches -- it applies the objective on the main thread, and a wrong ctx
  // or a dropped `.boss` would make the archive form different cells while every raw number agreed.
  // That exact failure (a scorer dropping `.boss`) once collapsed the archive to a single cell and
  // silently degraded QD to a hill climb.
  const serialScorer = await H.makeScorer(cfg, 'loot');
  const pooled = await H.makePooledScorer(cfg, 'loot');
  let scoreBad = 0;
  try {
    const a = await serialScorer(pairs, ITERS);
    const b = await pooled.score(pairs, ITERS);
    if (!a.boss || !b.boss) throw new Error('a scorer returned no .boss metadata');
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) { scoreBad++; if (scoreBad <= 3) console.log(`FAIL  score ${i}: ${a[i]} vs ${b[i]}`); }
      for (const f of ['kill', 'hp', 'maxStage']) {
        if (!Object.is(a.boss[i][f], b.boss[i][f])) {
          scoreBad++;
          if (scoreBad <= 6) console.log(`FAIL  boss.${f} ${i}: ${a.boss[i][f]} vs ${b.boss[i][f]}`);
        }
      }
    }
    console.log(`scorer: compared ${a.length} scores + ${a.length * 3} boss fields`);
  } finally { await pooled.destroy(); }
  if (scoreBad) { console.log(`FAIL  ${scoreBad} scorer value(s) differ`); process.exit(1); }

  console.log('PASS  the pool is bit-identical to serial evaluation, in the caller order,');
  console.log('      and the pooled SCORER matches the serial scorer including boss metadata');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
