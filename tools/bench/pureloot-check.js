'use strict';
// The live site's "Import with Upgrades" drops "pure loot upgrades"; the bench applies every
// decoded override. Does that explain a clone-vs-recorded overcount?
const H = require('./harness.js');

(async () => {
  const sb = H.browserSandbox();
  const code = process.argv[2];
  const recorded = Number(process.argv[3]);
  const build = await H.parseBuildCode(code);
  const all = { ...build.overrides, ...build.upgradeOverrides };
  const pure = Object.keys(all).filter((k) => sb.isPureLootOverrideKey(k));
  const filtered = Object.fromEntries(Object.entries(all).filter(([k]) => !sb.isPureLootOverrideKey(k)));

  const cfg = H.cfgForImport(build.hunter, build);
  const withAll = await H.evaluateAllocation(cfg, build.talents, build.attributes);
  const withoutPure = await H.evaluateAllocation({ ...cfg, baseOverrides: filtered }, build.talents, build.attributes);

  const pct = (v) => `${(100 * (v - recorded) / recorded).toFixed(2)}%`;
  console.log(`level ${build.level}, recorded ${recorded}`);
  console.log(`pure-loot keys in this code (${pure.length}): ${pure.join(', ') || '(none)'}`);
  pure.forEach((k) => console.log(`    ${k} = ${all[k]}`));
  console.log(`clone, ALL overrides      : ${withAll.loot.toFixed(0)}  (${pct(withAll.loot)})`);
  console.log(`clone, pure-loot excluded : ${withoutPure.loot.toFixed(0)}  (${pct(withoutPure.loot)})`);
})().catch((e) => { console.error(e); process.exit(1); });
