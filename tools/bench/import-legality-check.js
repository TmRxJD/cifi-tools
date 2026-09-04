'use strict';
// IS EVERY IMPORT FIXTURE ACTUALLY REPRODUCIBLE BY THE OPTIMIZER?
//
//   node tools/bench/import-legality-check.js [--hunter=ozzy]
//
// Every quality gate in this repo compares the optimizer against a recorded import and treats a
// shortfall as a search defect. That inference is only valid if the import is a build the search is
// ALLOWED to produce: legal under our dependency/threshold model, inside our declared caps, and
// affordable at the budget the bench hands over. If any of those is false the gate is measuring our
// DATA, not our search, and no amount of search work will close the gap.
//
// This is a report, not a hunt for a specific bug -- it checks the assumption the other gates rest
// on, which nothing else does.

const H = require('./harness.js');
const Space = H.Space;

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const HUNTERS = opt('hunter', 'borge,ozzy,knox').split(',');

(async () => {
  const known = H.loadKnownBuilds();
  let problems = 0;
  let checked = 0;

  for (const hunter of HUNTERS) {
    for (const fx of known[hunter]) {
      const build = await H.parseBuildCode(fx.code);
      if (!build) continue;
      checked++;
      const cfg = H.cfgForImport(hunter, build, { budgetMode: 'spend' });
      const deps = cfg.ATTRIBUTE_DEPENDENCIES;
      const minVal = cfg.ATTRIBUTE_MIN_VALUE;
      const notes = [];

      // 1. Caps. A build above our declared maxLevel cannot be produced, legally or otherwise.
      for (const d of cfg.TALENTS) {
        const v = build.talents[d.id] || 0;
        if (v > d.maxLevel) notes.push(`talent ${d.id}=${v} exceeds cap ${d.maxLevel}`);
      }
      for (const d of cfg.ATTRIBUTES) {
        const v = build.attributes[d.id] || 0;
        if (v > d.maxLevel) notes.push(`attr ${d.id}=${v} exceeds cap ${d.maxLevel}`);
      }
      // A talent the build funds that our TALENTS list does not contain at all.
      const known2 = new Set(cfg.TALENTS.map((d) => d.id));
      for (const [id, v] of Object.entries(build.talents || {})) {
        if (v > 0 && !known2.has(id)) notes.push(`talent ${id}=${v} is not in our talent list`);
      }
      const knownA = new Set(cfg.ATTRIBUTES.map((d) => d.id));
      for (const [id, v] of Object.entries(build.attributes || {})) {
        if (v > 0 && !knownA.has(id)) notes.push(`attr ${id}=${v} is not in our attribute list`);
      }

      // 2. Legality under the dependency/threshold model the search is bound by.
      if (!Space.isLegal(cfg.ATTRIBUTES, deps, minVal, build.attributes, cfg.ATTRIBUTE_BUDGET)) {
        notes.push('attribute allocation is ILLEGAL under our dependency/threshold model');
      }
      if (!Space.isLegal(cfg.TALENTS, {}, {}, build.talents, cfg.TALENT_BUDGET)) {
        notes.push('talent allocation is ILLEGAL under our model');
      }

      // 3. The budget the bench hands the optimizer must actually fund it. With budgetMode
      //    'spend' this is true by construction, so a failure here means costOf disagrees with
      //    itself -- worth knowing loudly rather than never checking.
      const tCost = Space.costOf(cfg.TALENTS, build.talents);
      const aCost = Space.costOf(cfg.ATTRIBUTES, build.attributes);
      if (tCost > cfg.TALENT_BUDGET) notes.push(`talents cost ${tCost} > budget ${cfg.TALENT_BUDGET}`);
      if (aCost > cfg.ATTRIBUTE_BUDGET) notes.push(`attrs cost ${aCost} > budget ${cfg.ATTRIBUTE_BUDGET}`);

      if (notes.length) {
        problems++;
        console.log(`ISSUE ${hunter}/${fx.set}#${fx.index} lvl${build.level}`);
        for (const n of notes) console.log(`        ${n}`);
      }
    }
  }
  console.log(`\nchecked ${checked} import fixture(s)`);
  console.log(problems
    ? `${problems} import(s) the optimizer CANNOT legally reproduce -- any shortfall gate on these `
      + 'is measuring our data, not our search'
    : 'every import is legal, within caps, and affordable at the budget the benches hand over');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
