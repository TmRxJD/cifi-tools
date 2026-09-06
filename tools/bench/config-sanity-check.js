'use strict';
// EVERY CONFIG, VALIDATED STRICTLY, BEFORE ANY MEASUREMENT IS TRUSTED.
//
// WHY THIS EXISTS. Config defects have cost more time than the search itself, and every one was
// silent -- the run completed, produced plausible numbers, and the numbers were wrong:
//
//   * a Knox build scored with OZZY's hunterStats (foreign keys resolve to nothing, missing ones
//     default) read as 0.48% BELOW the account build when it is 18.48% ABOVE;
//   * community fixtures scored under the DEVELOPER'S account upgrades read as +237% when the
//     correct figure is +35%;
//   * the shipped optimize effort was declared twice with different values, so every bench in this
//     directory validated a configuration the app never runs;
//   * a serialized fixture config lost Infinity to JSON (uncapped maxLevel became null), so the
//     search found 0 of 289 supports realizable -- and the obvious equivalence check PASSED anyway,
//     because scoring a fixed allocation never reads maxLevel.
//
// That last one is the lesson this file is built around: a config can be correct for one code path
// and destroyed for another. So this checks STRUCTURE, not just whether a score comes out.
//
//   node tools/bench/config-sanity-check.js
//   node tools/bench/config-sanity-check.js --fixtures=ozzy@54,borge@73

const path = require('path');
const fs = require('fs');
const H = require(path.join(__dirname, 'harness.js'));

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const problems = [];
const checks = { run: 0, passed: 0 };
function must(cond, what) {
  checks.run++;
  if (cond) { checks.passed++; return true; }
  problems.push(what);
  return false;
}

function validateNodeList(label, defs, kind) {
  must(Array.isArray(defs) && defs.length > 0, `${label}: ${kind} is empty or not an array`);
  const seen = new Set();
  for (const d of defs || []) {
    must(typeof d.id === 'string' && d.id.length > 0, `${label}: a ${kind} node has no id`);
    must(!seen.has(d.id), `${label}: duplicate ${kind} id "${d.id}"`);
    seen.add(d.id);
    const cost = d.cost === undefined ? 1 : d.cost;
    must(Number.isInteger(cost) && cost >= 1, `${label}: ${kind} "${d.id}" has cost ${cost} (must be an integer >= 1)`);
    // THE CHECK THAT WOULD HAVE CAUGHT THE JSON ROUND-TRIP. null, undefined and NaN are all
    // "falsy-ish" in the wrong comparisons and each makes a node silently unusable.
    const cap = d.maxLevel;
    const capOk = cap === Infinity || (Number.isFinite(cap) && cap > 0);
    must(capOk, `${label}: ${kind} "${d.id}" has maxLevel ${JSON.stringify(cap)} `
      + '(must be a positive number or Infinity -- null/NaN/0 makes the node unfillable)');
  }
  return seen;
}

function validateCfg(label, cfg, opts = {}) {
  must(typeof cfg.hunter === 'string', `${label}: cfg.hunter missing`);
  must(Number.isInteger(cfg.level) && cfg.level > 0, `${label}: cfg.level is ${cfg.level}`);

  const talentIds = validateNodeList(label, cfg.TALENTS, 'talent');
  const attrIds = validateNodeList(label, cfg.ATTRIBUTES, 'attribute');

  // Dependencies must reference nodes that exist, and must not be self-referential.
  const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
  for (const [id, parents] of Object.entries(deps)) {
    must(attrIds.has(id), `${label}: dependency declared for unknown attribute "${id}"`);
    must(Array.isArray(parents), `${label}: dependency for "${id}" is not an array`);
    for (const p of parents || []) {
      must(attrIds.has(p), `${label}: attribute "${id}" depends on unknown "${p}"`);
      must(p !== id, `${label}: attribute "${id}" depends on itself`);
    }
  }
  // No cycles -- a cycle makes every member permanently unreachable.
  const state = {};
  const hasCycle = (id, stack) => {
    if (state[id] === 'done') return false;
    if (stack.has(id)) return true;
    stack.add(id);
    for (const p of deps[id] || []) if (hasCycle(p, stack)) return true;
    stack.delete(id);
    state[id] = 'done';
    return false;
  };
  for (const id of attrIds) {
    must(!hasCycle(id, new Set()), `${label}: dependency cycle involving "${id}"`);
  }

  const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
  for (const [id, v] of Object.entries(minVal)) {
    must(attrIds.has(id), `${label}: minValue declared for unknown attribute "${id}"`);
    must(Number.isFinite(v) && v >= 0, `${label}: minValue for "${id}" is ${v}`);
  }

  must(Number.isInteger(cfg.TALENT_BUDGET) && cfg.TALENT_BUDGET > 0,
    `${label}: TALENT_BUDGET is ${cfg.TALENT_BUDGET}`);
  must(Number.isInteger(cfg.ATTRIBUTE_BUDGET) && cfg.ATTRIBUTE_BUDGET > 0,
    `${label}: ATTRIBUTE_BUDGET is ${cfg.ATTRIBUTE_BUDGET}`);

  // hunterStats must belong to THIS hunter. AccountState guards its own constructor; this catches
  // a cfg assembled or mutated after the fact.
  const defs = H.hunterDefs()[cfg.hunter];
  if (defs && cfg.hunterStats) {
    const allowed = new Set(defs.baseStatKeys);
    for (const k of Object.keys(cfg.hunterStats)) {
      must(allowed.has(k), `${label}: hunterStats carries "${k}", which is not a ${cfg.hunter} stat`);
    }
  }

  // THE SEARCH PATH. A config can score correctly and still be unsearchable -- that is exactly what
  // the lost Infinity did. At least one support must be fillable, or the optimizer has no space.
  // A THROW HERE IS A FINDING, NOT A CRASH. space.js validates its own inputs and throws on, say,
  // a dependency naming a node that does not exist. If the validator dies on that it reports
  // nothing at all -- and a validator that aborts is worse than one that fails, because the run
  // looks like an infrastructure problem rather than a bad config.
  let sup = [];
  let realizable = 0;
  try {
    sup = H.Space.enumerateSupports(cfg.ATTRIBUTES, deps, cfg.ATTRIBUTE_BUDGET);
    must(sup.length > 0, `${label}: no attribute supports enumerate at all`);
    for (const s of sup) {
      if (H.Space.canonicalFill(cfg.ATTRIBUTES, deps, minVal, cfg.ATTRIBUTE_BUDGET, s.ids)) realizable++;
    }
    must(realizable > 0, `${label}: 0 of ${sup.length} supports are realizable within the budget `
      + '-- the search space is empty (this is what a lost Infinity looks like)');
  } catch (e) {
    must(false, `${label}: enumerating the search space threw -- ${e.message}`);
  }

  if (opts.importTalents && opts.importAttributes) try {
    must(H.Space.isLegal(cfg.ATTRIBUTES, deps, minVal, opts.importAttributes, cfg.ATTRIBUTE_BUDGET),
      `${label}: the reference allocation is ILLEGAL in its own config`);
    must(H.Space.costOf(cfg.ATTRIBUTES, opts.importAttributes) <= cfg.ATTRIBUTE_BUDGET,
      `${label}: the reference attribute spend exceeds its own budget`);
    must(H.Space.costOf(cfg.TALENTS, opts.importTalents) <= cfg.TALENT_BUDGET,
      `${label}: the reference talent spend exceeds its own budget`);
  } catch (e) {
    must(false, `${label}: checking the reference allocation threw -- ${e.message}`);
  }

  // The worker must be constructible from it, or parallel scoring silently differs from serial.
  try {
    const wc = H.browserSandbox().AccountState.workerCfg(cfg);
    for (const f of H.browserSandbox().AccountState.WORKER_FIELDS) {
      must(wc[f] !== undefined, `${label}: workerCfg dropped "${f}"`);
    }
  } catch (e) {
    must(false, `${label}: workerCfg threw -- ${e.message}`);
  }

  return { supports: sup.length, realizable };
}

(async () => {
  const names = flag('fixtures', 'borge@13,borge@73,ozzy@31,ozzy@54,knox@13,knox@22').split(',');
  const all = H.loadKnownBuilds();

  console.log('config-sanity-check: strict structural validation of every config path');
  console.log('');

  for (const name of names) {
    const fx = H.findFixture(all, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build);
    const r = validateCfg(`${name} (cfgForImport)`, cfg, {
      importTalents: build.talents, importAttributes: build.attributes,
    });
    console.log(`${name.padEnd(12)} lvl${String(build.level).padStart(3)}  `
      + `budgets ${cfg.TALENT_BUDGET}/${cfg.ATTRIBUTE_BUDGET}  `
      + `supports ${r.supports}  realizable ${r.realizable}`);
  }

  // The serialized form the browser consumes -- round-trip must be LOSSLESS, structurally.
  const exported = path.join(__dirname, '../../webapp/public/fixture-cfgs.json');
  if (fs.existsSync(exported)) {
    console.log('');
    console.log('serialized fixture configs (what the browser loads):');
    const raw = fs.readFileSync(exported, 'utf8');
    const revived = JSON.parse(raw, (k, v) => (v === '__Infinity__' ? Infinity : v));
    for (const f of revived) {
      const r = validateCfg(`${f.name} (serialized)`, f.cfg, {
        importTalents: f.importTalents, importAttributes: f.importAttributes,
      });
      // And it must MATCH the canonical config it was exported from, field for field.
      const fx = H.findFixture(all, f.name);
      const build = await H.parseBuildCode(fx.code, fx.hunter);
      const canonical = H.cfgForImport(fx.hunter, build);
      const norm = (c) => JSON.stringify(c, (k, v) => (v === Infinity ? '__Inf__' : v));
      must(norm(canonical.ATTRIBUTES) === norm(f.cfg.ATTRIBUTES),
        `${f.name}: serialized ATTRIBUTES differ from the canonical config`);
      must(norm(canonical.TALENTS) === norm(f.cfg.TALENTS),
        `${f.name}: serialized TALENTS differ from the canonical config`);
      must(canonical.ATTRIBUTE_BUDGET === f.cfg.ATTRIBUTE_BUDGET
        && canonical.TALENT_BUDGET === f.cfg.TALENT_BUDGET,
        `${f.name}: serialized budgets differ from the canonical config`);
      console.log(`${f.name.padEnd(12)} round-trip ok  supports ${r.supports}  realizable ${r.realizable}`);
    }
  } else {
    console.log('\n(no webapp/public/fixture-cfgs.json -- skipping serialization checks)');
  }

  // NEGATIVE CONTROLS. A validator that cannot fail is decoration -- this project shipped one
  // such check earlier today (an assertion that was tautological once the value it compared was
  // derived). Each corruption below is a defect that HAS actually occurred or that would silently
  // destroy a run, and each must be caught.
  if (flag('skip-negative', null) === null) {
    console.log('');
    console.log('negative controls (each MUST be caught):');
    const fx = H.findFixture(all, names[0]);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const clone = () => JSON.parse(JSON.stringify(H.cfgForImport(fx.hunter, build),
      (k, v) => (v === Infinity ? '__Inf__' : v)), (k, v) => (v === '__Inf__' ? Infinity : v));

    const controls = [
      ['maxLevel Infinity lost to JSON', (c) => { c.ATTRIBUTES.find((d) => d.maxLevel === Infinity).maxLevel = null; }],
      ['another hunter’s stats', (c) => { c.hunterStats = { multichance: 5, evade: 3 }; }],
      ['zero attribute budget', (c) => { c.ATTRIBUTE_BUDGET = 0; }],
      ['dependency on an unknown node', (c) => { c.ATTRIBUTE_DEPENDENCIES[c.ATTRIBUTES[1].id] = ['no_such_node']; }],
      ['duplicate attribute id', (c) => { c.ATTRIBUTES.push({ ...c.ATTRIBUTES[0] }); }],
      ['negative cost', (c) => { c.ATTRIBUTES[2].cost = -1; }],
    ];
    let caught = 0;
    for (const [what, corrupt] of controls) {
      const c = clone();
      corrupt(c);
      const before = problems.length;
      // THE COUNTERS MUST BE RESTORED TOO, NOT JUST THE PROBLEM LIST.
      //
      // A negative control deliberately fails `must`, which increments checks.run without
      // incrementing checks.passed. Clearing `problems` hid the findings but left the tally, so a
      // completely clean run printed "3303/3311 checks passed" -- eight apparent failures that were
      // the controls doing their job. A summary line that looks like a partial failure on a healthy
      // run is exactly the kind of thing people learn to ignore, and then miss a real one.
      const runBefore = checks.run;
      const passedBefore = checks.passed;
      validateCfg(`NEGATIVE(${what})`, c, {});
      const detected = problems.length > before;
      // Remove the deliberate findings so they do not pollute the real report.
      problems.length = before;
      checks.run = runBefore;
      checks.passed = passedBefore;
      if (detected) caught++;
      console.log(`  ${detected ? 'caught  ' : 'MISSED  '} ${what}`);
    }
    if (caught !== controls.length) {
      problems.push(`negative controls: only ${caught}/${controls.length} corruptions were caught `
        + '-- the validator does not actually validate those cases');
    }
  }

  console.log('');
  console.log(`${checks.passed}/${checks.run} checks passed`
    + (checks.passed === checks.run ? '' : `  (${checks.run - checks.passed} FAILED)`));
  if (problems.length) {
    console.log('');
    console.log('PROBLEMS:');
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log('every config is structurally valid, searchable, and round-trips losslessly');
  }
})();
