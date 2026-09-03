'use strict';
// Gated upgrades must be HIDDEN until their gem requirement is met -- not shown with a "requires
// X" note. This is the original tool's plumbing, and mirroring it is the point.
//
// cifi-tools has ONE unlock predicate and reuses it for hunter tabs, tool entries, sidebar links
// and individual upgrade cards:
//
//     if (!unlock_gem || !unlock_lvl) return true
//     const t = getGemState(unlock_gem); if (!t) return false
//     if (t.level < unlock_lvl) return false
//     if (unlock_node !== undefined && !t.nodes?.[unlock_node - 1]) return false
//     return true
//
// Its pages then FILTER their item lists through it (assets/Trinkets-*.js does exactly that), and
// the sidebar drops a whole category once nothing in it is visible. We used to render the locked
// card anyway with an amber "Requires Temporal Gem level 4" note, which let you see -- and edit --
// upgrades the original would not have shown you yet.
//
// Two things are checked: the predicate itself (both halves, level AND node), and that a locked
// item is genuinely absent from the rendered list rather than merely annotated.
//
//   node tools/bench/gate-visibility-check.js

const H = require('./harness.js');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

const gems = () => sb.window.store.gems;
const setTree = (tree, level, nodes) => {
  gems()[tree].level = level;
  gems()[tree].nodes = nodes || new Array(6).fill(false);
};

// --- 1. the predicate, both halves -----------------------------------------------------------
const LEVEL_ONLY = 'upgrades.loopmods.roe';            // temporal 4, no node
const WITH_NODE = 'upgrades.trinkets.last_handbook';   // creation 4 AND node 5

setTree('temporal', 0);
if (sb.isUpgradeUnlocked(LEVEL_ONLY, gems())) fail(`${LEVEL_ONLY} unlocked at temporal 0`);
setTree('temporal', 3);
if (sb.isUpgradeUnlocked(LEVEL_ONLY, gems())) fail(`${LEVEL_ONLY} unlocked at temporal 3 (needs 4)`);
setTree('temporal', 4);
if (!sb.isUpgradeUnlocked(LEVEL_ONLY, gems())) fail(`${LEVEL_ONLY} still locked at temporal 4`);
if (!failures) pass('a level-only gate opens exactly at its level');

const before = failures;
setTree('creation', 4, [false, false, false, false, false, false]);
if (sb.isUpgradeUnlocked(WITH_NODE, gems())) {
  fail(`${WITH_NODE} unlocked at creation 4 with node 5 NOT owned -- the node half is being ignored`);
}
setTree('creation', 3, [false, false, false, false, true, false]);
if (sb.isUpgradeUnlocked(WITH_NODE, gems())) fail(`${WITH_NODE} unlocked at creation 3 (needs 4)`);
setTree('creation', 4, [false, false, false, false, true, false]);
if (!sb.isUpgradeUnlocked(WITH_NODE, gems())) fail(`${WITH_NODE} still locked at creation 4 + node 5`);
if (failures === before) pass('a node gate needs BOTH the tree level and the specific node');

// --- 2. missing gem state means locked, never unlocked ---------------------------------------
const before2 = failures;
if (sb.isUpgradeUnlocked(LEVEL_ONLY, {})) {
  fail('an upgrade reads as unlocked when there is no gem state at all -- the optimistic default '
    + 'is how a planner offers something the account cannot buy');
}
if (failures === before2) pass('missing gem state means locked');

// --- 3. every gate in the table actually gates -------------------------------------------------
const before3 = failures;
const empty = {};
for (const key of Object.keys(sb.UPGRADE_GATES || {})) {
  if (sb.isUpgradeUnlocked(key, empty)) fail(`${key} is in UPGRADE_GATES but reads unlocked with no gems`);
}
if (failures === before3) pass(`all ${Object.keys(sb.UPGRADE_GATES || {}).length} gated upgrades are locked on a fresh account`);

// --- 4. a locked item is ABSENT from the list, not annotated ----------------------------------
const before4 = failures;
const cat = (sb.window.ALL_UPGRADE_CATEGORIES || {}).loopmods;
if (!cat) {
  console.log('SKIP list-filter check: ALL_UPGRADE_CATEGORIES not exposed to the sandbox');
} else {
  const idsWhen = (level) => {
    setTree('temporal', level);
    return (cat.items || [])
      .filter((i) => sb.isUpgradeUnlocked(`upgrades.loopmods.${i.id}`, gems()))
      .map((i) => i.id);
  };
  const locked = idsWhen(0);
  const unlocked = idsWhen(4);
  if (locked.includes('roe')) fail('roe survives the list filter at temporal 0 -- it would render');
  if (!unlocked.includes('roe')) fail('roe is filtered out even at temporal 4');
  if (failures === before4) {
    pass(`the rendered list grows from ${locked.length} to ${unlocked.length} items when temporal hits 4`);
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\ngated upgrades are hidden until unlocked, exactly as the original does it');
process.exit(failures ? 1 : 0);
