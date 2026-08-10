'use strict';
// Gem tree structure and gate satisfiability.
//
// Reads tools/reference/gem-trees.json -- the tree definitions extracted from the live bundle
// (regenerate with tools/bench/extract-gem-trees.js) -- so this runs in the normal suite without
// needing a copy of the bundle on disk.
//
// What it protects:
//   1. Our GEM_TREES matches the real tree shape (max level, node count). We had node counts
//      right but nothing checking them.
//   2. Every gate in UPGRADE_GATES is SATISFIABLE. A gate demanding a level above its tree's
//      maximum can never be met, so the upgrade would be permanently unreachable -- silently.
//   3. The cross-tree node prereq is recorded: nodes 4-6 of every tree need Exodus 5.
//
//   node tools/bench/gem-tree-test.js

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const REF = path.join(__dirname, '../reference/gem-trees.json');
if (!fs.existsSync(REF)) {
  console.error(`missing ${REF} -- regenerate with tools/bench/extract-gem-trees.js <bundle> --write`);
  process.exit(2);
}
const ref = JSON.parse(fs.readFileSync(REF, 'utf8'));
const sb = H.browserSandbox();

let failures = 0;
function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`FAIL  ${name}\n        ${problem}`); failures++; }
    else console.log(`pass  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n        threw: ${err.message}`);
    failures++;
  }
}

check('we model every gem tree the game has, and no extras', () => {
  const ours = Object.keys(sb.GEM_TREES).sort();
  const theirs = Object.keys(ref.trees).sort();
  if (ours.join(',') !== theirs.join(',')) return `ours [${ours}] vs live [${theirs}]`;
  return null;
});

check('tree max levels and node counts match the live definitions', () => {
  for (const [name, t] of Object.entries(ref.trees)) {
    const ours = sb.GEM_TREES[name];
    if (!ours) return `${name} missing from GEM_TREES`;
    if (ours.maxLevel !== t.maxLevel) return `${name}: maxLevel ours ${ours.maxLevel}, live ${t.maxLevel}`;
    if (ours.nodeCount !== t.gemNodes.length) return `${name}: nodeCount ours ${ours.nodeCount}, live ${t.gemNodes.length}`;
  }
  return null;
});

// The whole point of a gate is that it can eventually be met. One demanding level 6 of a tree
// that caps at 4 would make its upgrade permanently unreachable, and nothing would say so.
check('every unlock gate is satisfiable within its tree max level', () => {
  for (const [key, gate] of Object.entries(sb.UPGRADE_GATES)) {
    const tree = ref.trees[gate.gem];
    if (!tree) return `${key} gates on "${gate.gem}", which is not a gem tree`;
    if (gate.level > tree.maxLevel) {
      return `${key} needs ${gate.gem} ${gate.level} but that tree caps at ${tree.maxLevel} -- unreachable`;
    }
    if (gate.level < 1) return `${key} has a nonsensical gate level ${gate.level}`;
  }
  return null;
});

check('a maxed gem state unlocks every gated upgrade', () => {
  const maxed = {};
  for (const [name, t] of Object.entries(ref.trees)) maxed[name] = { level: t.maxLevel };
  for (const key of Object.keys(sb.UPGRADE_GATES)) {
    if (!sb.isUpgradeUnlocked(key, maxed)) return `${key} still locked with every tree at max`;
  }
  // ...and an empty state unlocks none of them.
  for (const key of Object.keys(sb.UPGRADE_GATES)) {
    if (sb.isUpgradeUnlocked(key, {})) return `${key} unlocked with no gems at all`;
  }
  return null;
});

// Cross-tree prereq: a node can require ANOTHER tree's level. Recorded so a future gem planner
// does not have to rediscover it, and so a bundle change to it shows up here.
check('the cross-tree node prereq is exactly "nodes 4-6 need Exodus 5"', () => {
  for (const [name, t] of Object.entries(ref.trees)) {
    for (const node of t.gemNodes) {
      const req = node.unlockRequirement || null;
      const expected = name === 'exodus' ? 'exodus-5' : (node.node >= 4 ? 'exodus-5' : null);
      if (req !== expected) {
        return `${name} node ${node.node}: requirement ${JSON.stringify(req)}, expected ${JSON.stringify(expected)}`;
      }
    }
  }
  return null;
});

// A null level cost means "declared but not purchasable yet" -- Evolution ships with levels 2
// and 3 listed and unpriced, and caps at 1. So the real invariant is not "every level has a
// cost" but "priced exactly up to maxLevel, unpriced strictly above it", and increasing among
// the priced ones. That relationship is also what tells a planner where the content ends.
check('level costs are priced up to maxLevel, unpriced above it, and increasing', () => {
  for (const [name, t] of Object.entries(ref.trees)) {
    const costs = t.qualityCosts || [];
    if (!costs.length) return `${name} has no level costs at all`;
    for (const c of costs) {
      const priced = c.cost !== null && c.cost !== undefined;
      if (c.level <= t.maxLevel && !priced) return `${name} level ${c.level} is at or below maxLevel ${t.maxLevel} but has no cost`;
      if (c.level > t.maxLevel && priced) return `${name} level ${c.level} is above maxLevel ${t.maxLevel} yet priced ${c.cost}`;
    }
    const priced = costs.filter((c) => c.cost !== null && c.cost !== undefined);
    for (let i = 1; i < priced.length; i++) {
      if (!(priced[i].cost > priced[i - 1].cost)) {
        return `${name} level ${priced[i].level} costs ${priced[i].cost}, not more than the previous ${priced[i - 1].cost}`;
      }
    }
  }
  return null;
});

console.log(`\n${failures ? `${failures} FAILED` : 'gem tree structure and every unlock gate check out'}`);
process.exit(failures ? 1 : 0);
