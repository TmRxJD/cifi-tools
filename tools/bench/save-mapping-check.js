'use strict';
// Which save fields does the importer actually READ, and do they all exist?
//
//   node tools/bench/save-mapping-check.js [--list]
//
// `save-coverage.js` asks the opposite question -- which of the tool's INPUTS the save could fill --
// and is a report. This asks whether the reads themselves are sound, which is where the real bugs
// have been:
//
//   * `HUNTER_ATTR_ORDER` loaded attribute levels into the wrong attributes, 15 slots across three
//     hunters. Every value still landed somewhere, so nothing internal noticed.
//   * Knox's `finish` read `KnoxSkill8Level` -- the Ultima slot -- instead of `KnoxSkill9Level`.
//
// Both were positional mappings, and both were invisible because a wrong read still returns a
// plausible number. So the checks here are the ones that can catch that class:
//
//   1. Every field the importer reads must EXIST in a real save. A field that does not exist reads
//      as `undefined` and silently imports nothing -- which is exactly how the old `+12`
//      inscryption rule sent three ids to IS115/116/117, fields that do not exist.
//   2. Every value imported must be within the GAME's authored cap for the thing it was imported
//      into. This is what would have caught Ozzy's `sisters: 7` against a cap of 1.
//   3. Numbered families the importer reads must be read COMPLETELY -- if it reads
//      `ExodusGemNode1..3Level` while the save holds 6, the tail is silently dropped.
//
// The reads are recorded by handing the importer a Proxy over the save rather than by parsing its
// source, so this measures what the code does, not what it appears to do.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const SAVE_DIR = path.join(__dirname, '../gamefiles/save');
const decoded = fs.existsSync(SAVE_DIR)
  ? fs.readdirSync(SAVE_DIR).filter((f) => f.startsWith('decoded-') && f.endsWith('.json')).sort().reverse()
  : [];
if (!decoded.length) {
  console.log('SKIP: no decoded save -- this verifies NOTHING without one.');
  process.exit(0);
}

const sb = H.browserSandbox();
const scene = require('../reference/scene-defs.json').families;
const save = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, decoded[0]), 'utf8'));

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

// --- 1. record every read ------------------------------------------------------------------------
const read = new Set();
const missing = new Set();
const probe = new Proxy(save, {
  get(target, prop) {
    if (typeof prop === 'string') {
      read.add(prop);
      if (!(prop in target)) missing.add(prop);
    }
    return target[prop];
  },
  has(target, prop) {
    if (typeof prop === 'string') read.add(prop);
    return prop in target;
  },
});
const mapped = sb.mapSaveToStore(probe);
if (sb.mapSaveToShips) {
  try { sb.mapSaveToShips(probe); } catch { /* ship path has its own bench */ }
}

console.log(`the importer read ${read.size} distinct save field(s)`);
if (process.argv.includes('--list')) {
  console.log([...read].sort().join('\n'));
}

// A read of a field that is absent is not automatically wrong -- an account simply may not own the
// thing. It IS wrong when the whole numbered family is absent, which is the shape a renamed or
// mis-numbered field takes.
const familyOf = (k) => k.replace(/\d+/g, '#');
const familiesRead = new Map();
for (const k of read) {
  const f = familyOf(k);
  if (!familiesRead.has(f)) familiesRead.set(f, { read: [], present: [] });
  familiesRead.get(f).read.push(k);
  if (k in save) familiesRead.get(f).present.push(k);
}
const deadFamilies = [...familiesRead.entries()]
  .filter(([, v]) => v.read.length >= 2 && v.present.length === 0)
  .map(([f, v]) => `${f} (${v.read.length} fields read, NONE exist in the save)`);
if (deadFamilies.length) {
  deadFamilies.forEach((d) => fail(`the importer reads a field family that does not exist: ${d}`));
} else {
  pass(`every numbered field family the importer reads exists in the save `
    + `(${familiesRead.size} families)`);
}

// --- 2. nothing imported may exceed the GAME's authored cap --------------------------------------
const ATTR_FAMILY = { borge: 'POM', ozzy: 'POI', knox: 'POK' };
const SKILL_FAMILY = { borge: 'BorgeSkill', ozzy: 'OzzySkill', knox: 'KnoxSkill' };
const overCap = [];
for (const [hunter, st] of Object.entries(mapped.perHunter || {})) {
  const defs = sb.HUNTER_DEFS[hunter];
  // CAPS MUST BE RESOLVED FOR THIS ACCOUNT, NOT READ RAW. Borge's Call Me Lucky Loot caps at 12
  // rather than 10 once Attraction gem node 2 is owned, and this account owns it -- so reading the
  // static `maxLevel` reported a correct import of ll=12 as "imported past the cap", which is a
  // bench failing GOOD DATA. That is the more dangerous direction, because the tempting fix is to
  // change the importer. CLAUDE.md already records this exact mistake being made in the optimizer;
  // this is the same one, in a check.
  const capCtx = { buildOverrides: {}, gemPlannerStore: { gemStates: mapped.gems || {} } };
  const talentCaps = sb.resolveMaxLevels(defs.talents || [], capCtx);
  const attrCaps = sb.resolveMaxLevels(defs.attributes || [], capCtx);
  for (const [id, lvl] of Object.entries(st.attributes || {})) {
    const a = attrCaps.find((x) => x.id === id);
    if (a && Number.isFinite(a.maxLevel) && lvl > a.maxLevel) {
      overCap.push(`${hunter}.${id} imported ${lvl}, cap ${a.maxLevel}`);
    }
  }
  for (const [id, lvl] of Object.entries(st.talents || {})) {
    const t = talentCaps.find((x) => x.id === id);
    if (t && Number.isFinite(t.maxLevel) && lvl > t.maxLevel) {
      overCap.push(`${hunter}.${id} imported ${lvl}, cap ${t.maxLevel}`);
    }
  }
  void ATTR_FAMILY[hunter]; void SKILL_FAMILY[hunter];
}
if (overCap.length) {
  overCap.forEach((o) => fail(`imported past the cap -- the value went into the wrong slot: ${o}`));
} else {
  pass('every imported talent and attribute level is within its cap');
}

// --- 3. the spend must be fundable by the level it was imported with -----------------------------
// The same invariant schema-test asserts for build codes. A mis-slotted attribute usually breaks it,
// because costs differ between slots -- Ozzy's `sisters` costs 15 where `scarab` costs 2.
for (const [hunter, st] of Object.entries(mapped.perHunter || {})) {
  if (!st.level) continue;
  const defs = sb.HUNTER_DEFS[hunter];
  const tSpend = Object.entries(st.talents || {})
    .reduce((n, [id, lv]) => n + lv * (((defs.talents || []).find((t) => t.id === id) || {}).cost || 1), 0);
  const aSpend = H.Space.costOf(defs.attributes, st.attributes || {});
  const tBudget = sb.talentBudgetForLevel(st.level);
  const aBudget = sb.attributeBudgetForLevel(st.level);
  if (tSpend > tBudget || aSpend > aBudget) {
    fail(`${hunter} lvl${st.level}: imported spend ${tSpend}T/${aSpend}A exceeds the level's `
      + `budget ${tBudget}T/${aBudget}A -- a value landed in a slot that costs more than it should`);
  } else {
    pass(`${hunter} lvl${st.level}: imported spend ${tSpend}/${tBudget}T ${aSpend}/${aBudget}A fits`);
  }
}

// --- 4. numbered families must be read to their full extent --------------------------------------
// The game has 6 gem nodes per tree (nodes 4-6 gated behind Exodus 5). Reading only 3 would drop
// the tail silently on any account that has them.
// TWO SHAPES, and missing that under-reports rather than failing. Six trees store their nodes as
// individual `<Tree>GemNode<N>Level` fields; EXODUS alone stores them as a single
// `ExodusGemNodeLevels` array. The importer handles both, so a check that only counts the
// individual fields sees six trees and looks like one is missing.
const perTree = {};
[...read].forEach((k) => {
  const m = /^(.*)GemNode(\d+)Level$/.exec(k);
  if (m) perTree[m[1]] = (perTree[m[1]] || 0) + 1;
});
[...read].forEach((k) => {
  const m = /^(.*)GemNodeLevels$/.exec(k);
  // The array branch reads six entries out of one field.
  if (m && Array.isArray(save[k])) perTree[m[1]] = 6;
});
const treeNames = Object.keys(perTree);
const EXPECTED_TREES = 7;
if (treeNames.length !== EXPECTED_TREES) {
  fail(`gem nodes read for ${treeNames.length} tree(s), expected ${EXPECTED_TREES} `
    + `(${treeNames.join(', ')})`);
}
const shortTrees = treeNames.filter((t) => perTree[t] < 6);
if (!treeNames.length) {
  fail('the importer reads no gem node fields at all');
} else if (shortTrees.length) {
  shortTrees.forEach((t) => fail(`${t} gem nodes: importer reads ${perTree[t]}, the game has 6 `
    + '(nodes 4-6 are gated behind Exodus 5, but they exist)'));
} else {
  pass(`all ${treeNames.length} gem trees are read to their full 6 nodes`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nevery save mapping the importer uses checks out');
process.exit(failures ? 1 : 0);
