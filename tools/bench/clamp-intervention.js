'use strict';
// DOES CLAMPING THE PROPOSED AMOUNT TO THE TARGET'S HEADROOM FIX THE UNCAPPED-SINK BIAS?
//
// The intervention test for the theory measured by uncapped-bias-check.js. That bench established
// two things and stopped short of a third:
//   * transfers into uncapped nodes accept 98-100% against 21-59% for capped ones (+60.3 points);
//   * the two builds the shipped configuration loses on over-fund the uncapped root by ~15 points
//     of budget, while the ten it wins on average -5.4.
// What it could NOT establish is whether the bias CAUSES the loss or merely accompanies it. Only
// removing the bias and re-measuring can do that.
//
// RUN BOTH ARMS ON BOTH KINDS OF BUILD. A change that fixes the failures while quietly costing the
// passes is not an improvement, and testing only the failures cannot see that. The passing builds
// here sit at exactly 0.00%, so any regression shows immediately.
//
//   node tools/bench/clamp-intervention.js
//   node tools/bench/clamp-intervention.js --fixtures=ozzy@54,borge@73 --seeds=2

const path = require('path');
const H = require(path.join(__dirname, 'harness.js'));

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const SEEDS = [0x9e3779b9, 0x12345678, 0xa5a5a5a5];

(async () => {
  // Two builds the shipped configuration LOSES on, two it matches exactly. Both directions matter.
  const names = flag('fixtures', 'ozzy@54,borge@73,ozzy@31,borge@59').split(',');
  const seedCount = Number(flag('seeds', '1'));
  const seeds = SEEDS.slice(0, seedCount);
  const all = H.loadKnownBuilds();

  console.log('clamp-intervention: does clamping transfer amounts to target headroom help?');
  console.log(`fixtures: ${names.join(', ')}   seeds: ${seeds.length}`);
  console.log('ALL SCORES AT FINAL_ITERATIONS. Positive gap = optimizer beats the reference.');
  console.log('');

  const rows = [];
  for (const name of names) {
    const fx = H.findFixture(all, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build);
    const evalFast = await H.browserSandbox().HunterSim.compileEvaluator(fx.hunter, cfg);
    const scorer = await H.makeScorer(cfg, 'loot');
    const refScore = (await evalFast(build.talents, build.attributes, H.Optimizer.FINAL_ITERATIONS)).lootPerMin;

    for (const clamp of [false, true]) {
      const per = [];
      for (const seed of seeds) {
        const t0 = Date.now();
        const res = await H.Optimizer.optimize(cfg, {
          mode: 'loot',
          scorer,
          effort: { label: 'clamp', seeds: [seed], clampToHeadroom: clamp },
        });
        const got = (await evalFast(res.best.talentAlloc, res.best.attrAlloc,
          H.Optimizer.FINAL_ITERATIONS)).lootPerMin;
        // Root share, the quantity the theory says should move.
        const A = cfg.ATTRIBUTES;
        let total = 0;
        let root = 0;
        for (const d of A) {
          const spend = (res.best.attrAlloc[d.id] || 0) * (d.cost || 1);
          total += spend;
          if (!Number.isFinite(d.maxLevel)) root += spend;
        }
        per.push({
          seed: seed.toString(16).slice(0, 4),
          gapPct: ((got - refScore) / refScore) * 100,
          rootSharePct: total ? (root / total) * 100 : 0,
          secs: (Date.now() - t0) / 1000,
        });
        process.stderr.write(`  ${name} clamp=${clamp ? 'ON ' : 'off'} seed ${per[per.length - 1].seed}: `
          + `${per[per.length - 1].gapPct.toFixed(2)}%  root ${per[per.length - 1].rootSharePct.toFixed(1)}%\n`);
      }
      const mean = (f) => per.reduce((s, x) => s + f(x), 0) / per.length;
      rows.push({
        name, level: build.level, clamp,
        gapPct: mean((x) => x.gapPct),
        rootSharePct: mean((x) => x.rootSharePct),
        secs: mean((x) => x.secs),
      });
    }
  }

  const pad = (v, n) => String(v).padStart(n);
  console.log(`${'fixture'.padEnd(12)} ${pad('clamp', 6)} ${pad('gap %', 9)} ${pad('root share', 11)} ${pad('secs', 6)}`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(12)} ${pad(r.clamp ? 'ON' : 'off', 6)} `
      + `${pad((r.gapPct >= 0 ? '+' : '') + r.gapPct.toFixed(2), 9)} `
      + `${pad(r.rootSharePct.toFixed(1) + '%', 11)} ${pad(r.secs.toFixed(0), 6)}`);
  }

  // Stated verdict, by rule.
  console.log('');
  console.log('=== VERDICT ===');
  const byName = {};
  for (const r of rows) (byName[r.name] = byName[r.name] || {})[r.clamp ? 'on' : 'off'] = r;
  const NOISE = 0.2;
  let helped = 0;
  let hurt = 0;
  let unchanged = 0;
  for (const [name, pair] of Object.entries(byName)) {
    if (!pair.on || !pair.off) continue;
    const delta = pair.on.gapPct - pair.off.gapPct;
    const rootDelta = pair.on.rootSharePct - pair.off.rootSharePct;
    const label = delta > NOISE ? 'HELPED' : (delta < -NOISE ? 'HURT' : 'unchanged');
    if (label === 'HELPED') helped++;
    else if (label === 'HURT') hurt++;
    else unchanged++;
    console.log(`${name.padEnd(12)} ${label.padEnd(10)} gap ${pair.off.gapPct.toFixed(2)}% -> `
      + `${pair.on.gapPct.toFixed(2)}%  (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pts), `
      + `root share ${pair.off.rootSharePct.toFixed(1)}% -> ${pair.on.rootSharePct.toFixed(1)}% `
      + `(${rootDelta >= 0 ? '+' : ''}${rootDelta.toFixed(1)} pts)`);
  }
  console.log('');
  if (helped > 0 && hurt === 0) {
    console.log(`CONCLUSION: clamping HELPED ${helped} build(s), hurt none, left ${unchanged} unchanged. `
      + 'The uncapped-sink bias is causal for the builds it helped, and removing it costs nothing '
      + 'on the builds already at parity.');
  } else if (helped > 0 && hurt > 0) {
    console.log(`CONCLUSION: MIXED -- clamping helped ${helped} and hurt ${hurt}. It is not a free `
      + 'win; the bias is real but removing it this way trades one failure for another.');
  } else if (hurt > 0) {
    console.log(`CONCLUSION: clamping HURT ${hurt} build(s) and helped none. The uncapped-sink bias `
      + 'is real but is NOT the cause of the gaps -- do not ship this.');
  } else {
    console.log('CONCLUSION: clamping changed nothing outside measurement precision. The bias is '
      + 'real at the move level but does not reach the outcome; the gaps have another cause.');
  }
})();
