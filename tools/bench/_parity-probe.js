'use strict';
// One fixture's code + our computed stats, for hand-comparison against cifi-tools.com.
const H = require('./harness.js');

(async () => {
  const known = H.loadKnownBuilds();
  const fx = H.findFixture(known, process.argv[2] || 'ozzy@63');
  console.log(`${fx.name}  level ${fx.level}  mode ${fx.mode || 'loot'}`);
  console.log(`recorded expectedLootScore: ${fx.expectedLootScore}`);
  console.log(`\ncode:\n${fx.code}\n`);

  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
  const r = await H.evaluateAllocation(cfg, build.talents, build.attributes, 1000);
  const keys = Object.keys(r).sort();
  console.log('our evaluation of the IMPORT (code-only state, empty gems):');
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'number') console.log(`  ${k.padEnd(16)} ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  console.log(`\n  ultima.ulti in this build's overrides: `
    + `${JSON.stringify((build.overrides || {})['upgrades.ultima.ulti'])}`);
})().catch((e) => { console.error(e); process.exit(1); });
