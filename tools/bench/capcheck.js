'use strict';
// Report, per known build, whether the point budget exceeds what the available nodes can hold.
// A budget above capacity is the condition that used to make a whole block un-optimizable.
const H = require('./harness.js');

const capacityOf = (defs) => defs.reduce((s, d) => s + (d.maxLevel === Infinity ? Infinity : d.maxLevel * (d.cost || 1)), 0);

(async () => {
  const known = H.loadKnownBuilds();
  let flagged = 0;
  for (const hunter of ['borge', 'ozzy', 'knox']) {
    for (const fx of known[hunter]) {
      const build = await H.parseBuildCode(fx.code);
      if (!build) continue;
      const cfg = H.cfgForImport(hunter, build);
      const tCap = capacityOf(cfg.TALENTS);
      const aCap = capacityOf(cfg.ATTRIBUTES);
      if (cfg.TALENT_BUDGET > tCap || cfg.ATTRIBUTE_BUDGET > aCap) {
        flagged++;
        console.log(`${hunter}/${fx.set}#${fx.index} lvl${build.level}: talent ${cfg.TALENT_BUDGET}/${tCap}, attr ${cfg.ATTRIBUTE_BUDGET}/${aCap}`);
      }
    }
  }
  console.log(flagged ? `\n${flagged} build(s) exceed node capacity` : 'no build exceeds node capacity');
})().catch((e) => { console.error(e); process.exit(1); });
