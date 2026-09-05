'use strict';
// Serialize canonical fixture configs so the BROWSER can run them at browser speed.
//
// WHY THIS RATHER THAN A BROWSER-SIDE cfgForImport. Node scores serially and is ~6x slower than
// the worker pool, so every configuration sweep has been paying a 6x tax. The obvious shortcut --
// rebuild the fixture config in the browser -- was tried twice and produced two DIFFERENT wrong
// answers for ozzy@54: 299,370 (dropped the code's upgrade overrides) and 1,668,456 (merged them
// but still diverged), against the canonical 1,004,600. A share code carries base stats AND
// upgrade overrides, cfgForImport merges them a particular way, and guessing that merge is how a
// third comparison path gets born. This project already has one canonical builder; the fix is to
// SHIP ITS OUTPUT, not to write another.
//
// The config is plain data -- resolved defs, budgets, overrides -- so it serializes exactly.
//
//   node tools/bench/export-fixture-cfgs.js ozzy@54 borge@73 ozzy@31 borge@59
//
// Writes webapp/public/fixture-cfgs.json (gitignored), which the dev server serves.

const path = require('path');
const fs = require('fs');
const H = require(path.join(__dirname, 'harness.js'));

const OUT = path.join(__dirname, '../../webapp/public/fixture-cfgs.json');

(async () => {
  const names = process.argv.slice(2);
  if (!names.length) throw new Error('export-fixture-cfgs: name at least one fixture');
  const all = H.loadKnownBuilds();
  const out = [];
  for (const name of names) {
    const fx = H.findFixture(all, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build);
    // The reference score, computed HERE by the canonical path, so the browser can assert it
    // reproduces the same number before trusting anything else it measures.
    const ref = await H.evaluateAllocation(cfg, build.talents, build.attributes);
    out.push({
      name,
      uid: fx.uid,
      hunter: fx.hunter,
      level: build.level,
      mode: fx.mode,
      expectedLootScore: fx.expectedLootScore,
      cfg,
      importTalents: build.talents,
      importAttributes: build.attributes,
      canonicalReferenceLoot: ref.loot,
    });
    console.log(`${name.padEnd(12)} lvl${String(build.level).padStart(3)}  `
      + `reference ${Math.round(ref.loot)}  (budgets ${cfg.TALENT_BUDGET}/${cfg.ATTRIBUTE_BUDGET})`);
  }
  // INFINITY DOES NOT SURVIVE JSON, AND ITS LOSS IS SILENT AND TOTAL.
  //
  // An uncapped node carries maxLevel: Infinity. JSON.stringify turns that into `null`, so every
  // `alloc < maxLevel` comparison in the search becomes false and NOTHING is fillable -- the first
  // browser run of this file enumerated 289 supports and found 0 realizable.
  //
  // Worse, it hid from the obvious check: scoring a FIXED allocation never reads maxLevel, so all
  // four canonical reference scores reproduced exactly while the config was already unusable for
  // search. An equivalence test has to exercise the code path being tested.
  //
  // So Infinity is written as a marker string and MUST be restored on load. A consumer that finds
  // a bare null in maxLevel is looking at corrupted data and should say so rather than proceed.
  const encoded = JSON.stringify(out, (k, v) => (v === Infinity ? '__Infinity__' : v));
  fs.writeFileSync(OUT, encoded);
  console.log(`\nwrote ${out.length} config(s) to ${OUT}`);
  console.log('the browser MUST reproduce canonicalReferenceLoot before any result from it is trusted');
})();
