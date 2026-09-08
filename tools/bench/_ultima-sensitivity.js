'use strict';
// What does upgrades.ultima.ulti actually do to the reported numbers?
// It is a real wasm argument, and the save importer now fills it. If it scales loot/materials
// directly, then auto-importing it changed every scanned build's displayed earnings.
const H = require('./harness.js');

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, process.argv[2] || 'ozzy@63');
  const build = await H.parseBuildCode(fx.code, fx.hunter);

  for (const ulti of [0, 1, 1.1989, 2, 5, 10]) {
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    cfg.baseOverrides = { ...(cfg.baseOverrides || {}), 'upgrades.ultima.ulti': ulti };
    const r = await H.evaluateAllocation(cfg, build.talents, build.attributes, 1000);
    console.log(`ulti=${String(ulti).padEnd(7)} loot ${r.loot.toExponential(4)}`
      + `  mat1 ${r.mat1.toExponential(4)}  xp ${r.xp.toExponential(4)}`
      + `  stage ${r.avgStage.toFixed(1)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
