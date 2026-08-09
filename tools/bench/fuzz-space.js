'use strict';
// Fuzz the allocation-space move generators against their own legality predicate.
//
// Every allocation the optimizer can ever produce comes from canonicalFill or transfer. If
// either can emit a state that isLegal() rejects, the search can carry it to the final answer --
// which is exactly the "Optimizer produced an illegal talent allocation" assertion firing.
//
//   node tools/bench/fuzz-space.js [rounds]
const H = require('./harness.js');

const Space = H.Space;
const defsFor = (hunter) => H.hunterDefs()[hunter];

// Deterministic PRNG so a failure is reproducible from its round number.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function randomLegal(defs, deps, minVal, budget, rand) {
  const alloc = {};
  defs.forEach((d) => { alloc[d.id] = 0; });
  let spent = 0;
  for (let guard = 0; guard < 4000; guard++) {
    const eligible = defs.filter((d) => (d.cost || 1) + spent <= budget && Space.isEligible(d, defs, deps, minVal, alloc));
    if (!eligible.length) break;
    const pick = eligible[Math.floor(rand() * eligible.length)];
    alloc[pick.id] += 1;
    spent += pick.cost || 1;
  }
  return alloc;
}

function violations(defs, deps, minVal, budget, alloc, label) {
  const out = [];
  for (const d of defs) {
    const lvl = alloc[d.id] || 0;
    if (lvl > d.maxLevel) out.push(`${label}: ${d.id}=${lvl} exceeds max ${d.maxLevel}`);
    if (lvl < 0) out.push(`${label}: ${d.id}=${lvl} is negative`);
  }
  const cost = Space.costOf(defs, alloc);
  if (cost > budget) out.push(`${label}: spends ${cost} over budget ${budget}`);
  if (!Space.isLegal(defs, deps, minVal, alloc, budget)) out.push(`${label}: isLegal() false -> ${JSON.stringify(alloc)}`);
  return out;
}

const rounds = Number(process.argv[2] || 300);
let checked = 0;
const failures = [];

for (const hunter of ['borge', 'ozzy', 'knox']) {
  const d = defsFor(hunter);
  const blocks = [
    { name: 'talents', defs: d.talents, deps: {}, minVal: {} },
    { name: 'attributes', defs: d.attributes, deps: d.attributeDependencies, minVal: d.attributeMinValue },
  ];
  for (const block of blocks) {
    for (let r = 0; r < rounds; r++) {
      const rand = rng(r * 7919 + block.name.length + hunter.length);
      const budget = 5 + Math.floor(rand() * 240);
      const start = randomLegal(block.defs, block.deps, block.minVal, budget, rand);
      failures.push(...violations(block.defs, block.deps, block.minVal, budget, start, `${hunter}/${block.name}/seed r${r}`));

      for (const step of [8, 4, 2, 1]) {
        for (const from of block.defs) {
          for (const to of block.defs) {
            const next = Space.transfer(block.defs, block.deps, block.minVal, budget, start, from.id, to.id, step);
            if (!next) continue;
            checked++;
            failures.push(...violations(block.defs, block.deps, block.minVal, budget, next,
              `${hunter}/${block.name}/transfer r${r} budget${budget} step${step} ${from.id}->${to.id}`));
          }
        }
      }

      const fill = Space.canonicalFill(block.defs, block.deps, block.minVal, budget, block.defs.map((x) => x.id));
      if (fill) {
        checked++;
        failures.push(...violations(block.defs, block.deps, block.minVal, budget, fill, `${hunter}/${block.name}/canonicalFill budget${budget}`));
      }
    }
  }
}

console.log(`checked ${checked} generated allocations`);
if (!failures.length) {
  console.log('no violations');
  process.exit(0);
}
const unique = [...new Set(failures)];
console.log(`${failures.length} violation(s), ${unique.length} distinct:\n`);
unique.slice(0, 12).forEach((f) => console.log('  ' + f));
process.exit(1);
