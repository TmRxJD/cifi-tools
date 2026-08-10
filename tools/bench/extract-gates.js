'use strict';
// Generate the COMPLETE gem-gate reference from the live cifi-tools bundle.
//
// UPGRADE_GATES in hunterDefs.js covers only the 20 gates that apply to overrides the hunter sim
// reads. The bundle declares far more -- gem-node bonuses, planner features, hunter unlocks --
// and future tools (a gem planner especially) will need all of them. This writes the full set to
// a committed JSON reference so that work does not start by re-deriving it.
//
//   node tools/bench/extract-gates.js <live-bundle.js> [--write]
//
// Without --write it prints a summary and changes nothing.

const fs = require('fs');
const path = require('path');

const bundlePath = process.argv[2];
if (!bundlePath) { console.error('usage: extract-gates.js <live-bundle.js> [--write]'); process.exit(2); }
const write = process.argv.includes('--write');
const src = fs.readFileSync(bundlePath, 'utf8');
const OUT = path.join(__dirname, '../reference/gem-gates.json');

function objectAt(start) {
  let depth = 0; let inStr = false; let esc = false; let q = '';
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function enclosing(at) {
  let depth = 0;
  for (let i = at; i > 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) return objectAt(i); depth--; }
  }
  return null;
}

const TREES = ['attraction', 'creation', 'evolution', 'exodus', 'innovation', 'power', 'temporal'];
const found = new Map();

for (const field of ['unlock_gem:', 'unlock_lvl:', 'unlock:', 'unlock_level:']) {
  let from = 0;
  for (;;) {
    const at = src.indexOf(field, from);
    if (at === -1) break;
    from = at + 1;
    const obj = enclosing(at);
    if (!obj || obj.length > 900) continue;
    const id = /\b(?:id|key):\s*["']([^"']+)["']/.exec(obj);
    if (!id) continue;

    const gemMatch = /\bunlock(?:_gem)?:\s*["']([a-z]+)["']/.exec(obj);
    const lvlMatch = /\bunlock_(?:lvl|level):\s*(\d+)/.exec(obj);
    // Some entries carry only `unlock: <number>`: a level with the tree implied by context.
    const bareLevel = /\bunlock:\s*(\d+)/.exec(obj);

    const gem = gemMatch && TREES.includes(gemMatch[1]) ? gemMatch[1] : null;
    const level = lvlMatch ? Number(lvlMatch[1]) : (bareLevel ? Number(bareLevel[1]) : null);
    if (level === null) continue;

    const key = id[1];
    if (found.has(key)) continue;
    found.set(key, {
      id: key,
      name: (/\bname:\s*["']([^"']*)["']/.exec(obj) || [])[1] || null,
      label: (/\blabel:\s*["']([^"']*)["']/.exec(obj) || [])[1] || null,
      category: (/\bcategory:\s*["']([^"']*)["']/.exec(obj) || [])[1] || null,
      description: (/\bdescription:\s*["']([^"']*)["']/.exec(obj) || [])[1] || null,
      gem,
      level,
      // `gem: null` means the bundle stated a level without naming a tree in the same object --
      // the tree is implied by which planner section the entry lives in. Recorded honestly as
      // unknown rather than guessed, so a consumer can tell the two cases apart.
      treeKnown: Boolean(gem),
    });
  }
}

// Resolve the tree for entries that stated only a level: they live inside a specific tree's
// `upgrades` array, so the owning tree IS the answer -- it just is not repeated on each entry.
// gem-trees.json (from extract-gem-trees.js) is where that ownership is recorded.
const TREES_REF = path.join(__dirname, '../reference/gem-trees.json');
if (fs.existsSync(TREES_REF)) {
  const treeRef = JSON.parse(fs.readFileSync(TREES_REF, 'utf8'));
  for (const [treeName, tree] of Object.entries(treeRef.trees)) {
    for (const up of tree.upgrades || []) {
      const row = found.get(up.id);
      if (row && !row.treeKnown) {
        row.gem = treeName;
        row.treeKnown = true;
        row.treeResolvedFrom = 'owning tree upgrades[] array';
        if (up.unlock !== undefined && up.unlock !== null) row.level = up.unlock;
      }
    }
  }
}

const rows = [...found.values()].sort((a, b) => (a.gem || 'zzz').localeCompare(b.gem || 'zzz') || a.level - b.level || a.id.localeCompare(b.id));
const withTree = rows.filter((r) => r.treeKnown);
const withoutTree = rows.filter((r) => !r.treeKnown);

console.log(`${rows.length} gated entries: ${withTree.length} with an explicit tree, ${withoutTree.length} level-only\n`);
const byTree = {};
for (const r of withTree) (byTree[r.gem] ||= []).push(r);
for (const [tree, list] of Object.entries(byTree)) {
  const levels = [...new Set(list.map((r) => r.level))].sort();
  console.log(`  ${tree.padEnd(11)} ${String(list.length).padStart(3)} entries at levels ${levels.join(', ')}`);
}
console.log(`\n  (level-only, tree implied by planner section: ${withoutTree.length})`);

if (write) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({
    generatedFrom: path.basename(bundlePath),
    note: 'Generated by tools/bench/extract-gates.js. Do not hand-edit -- regenerate instead.',
    entries: rows,
  }, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);
}
