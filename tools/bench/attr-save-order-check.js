'use strict';
// Does the save importer put each `PO?<n>Level` into the RIGHT attribute?
//
//   node tools/bench/attr-save-order-check.js [--print]
//
// `saveImport.js` maps the save's `POM<n>Level` / `POI<n>Level` / `POK<n>Level` fields onto our
// attribute ids POSITIONALLY, through a hand-maintained `HUNTER_ATTR_ORDER` list. Its own comment
// records that the order was "best-effort matched to HUNTER_DEFS order, then live-verified" by
// eyeballing caps and dependency chains -- which is exactly the kind of hand-derived mapping this
// repo has watched go wrong before, and it did here: importing the real save gave Ozzy
// `sisters: 7` when `sisters` is capped at 1, and the live site rejected the resulting build
// outright with "This Build is invalid. Please check the attributes."
//
// The game settles it without guessing. Each `PO?<n>` carries an authored Cost and MaxLevel
// (scene-defs.json), and `attribute-tree.json` carries the dependency edges -- so a node's game
// index is pinned by (cost, cap, position in the tree), the same structural join
// attribute-tree-check.js already uses and verifies. This bench derives the mapping that way and
// asserts the importer's list agrees with it.
//
// A positional mapping that is wrong is SILENT: every value still lands somewhere, the totals still
// look plausible, and the only symptom is a build that is subtly -- or in this case illegally --
// wrong.

const H = require('./harness.js');
const scene = require('../reference/scene-defs.json').families;
const tree = require('../reference/attribute-tree.json');

const sb = H.browserSandbox();
const FAMILY = { borge: 'POM', ozzy: 'POI', knox: 'POK' };

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

/** The importer's own list, parsed from the shipped file so this checks what actually ships. */
function importerOrder() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../webapp/public/saveImport.js'), 'utf8');
  const block = /const HUNTER_ATTR_ORDER = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('HUNTER_ATTR_ORDER not found in saveImport.js');
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}

/** our attribute id -> game index, joined by tree shape with cost/cap as the tie-break. */
function gameIndexFor(hunter) {
  const defs = sb.HUNTER_DEFS[hunter];
  const deps = defs.attributeDependencies || {};
  const fam = scene[FAMILY[hunter]] || {};
  const edges = (tree.edges || {})[hunter] || {};

  const ourNodes = (defs.attributes || []).map((a) => a.id);
  const parentsOf = (id) => deps[id] || [];
  const gameParents = (i) => edges[String(i)] || [];
  const unreleased = new Set(Object.entries(fam)
    .filter(([, v]) => !v.Cost && !v.MaxLevel).map(([i]) => Number(i)));
  const gameNodes = [...new Set([
    ...Object.keys(edges).map(Number), ...Object.values(edges).flat(),
  ])].filter((n) => !unreleased.has(n));

  const kids = (nodes, parents) => {
    const m = new Map(nodes.map((n) => [n, []]));
    nodes.forEach((n) => parents(n).forEach((p) => m.get(p) && m.get(p).push(n)));
    return m;
  };
  const ourKids = kids(ourNodes, parentsOf);
  const gameKids = kids(gameNodes, gameParents);
  const sig = (n, k) => `(${(k.get(n) || []).map((c) => sig(c, k)).sort().join('')})`;

  const specOf = (id) => {
    const a = (defs.attributes || []).find((x) => x.id === id);
    const cap = (a.maxLevel == null || !Number.isFinite(a.maxLevel)) ? null : a.maxLevel;
    return `${a.cost === undefined ? 1 : a.cost}/${cap}`;
  };
  const gameSpec = (i) => {
    const v = fam[String(i)] || {};
    return `${v.Cost === undefined ? 1 : v.Cost}/${v.MaxLevel === undefined ? null : v.MaxLevel}`;
  };

  const map = new Map();
  const ourRoot = ourNodes.find((n) => !parentsOf(n).length);
  const gameRoot = gameNodes.find((n) => !gameParents(n).length);
  const queue = [[ourRoot, gameRoot]];
  while (queue.length) {
    const [o, g] = queue.shift();
    map.set(o, g);
    const oc = (ourKids.get(o) || []).slice();
    const gc = (gameKids.get(g) || []).slice();
    for (const child of oc) {
      // Shape first, then the authored cost/cap -- two independent sources, so agreeing is a
      // cross-check rather than a restatement.
      let cands = gc.filter((x) => sig(x, gameKids) === sig(child, ourKids));
      if (cands.length > 1) cands = cands.filter((x) => gameSpec(x) === specOf(child));
      if (cands.length !== 1) return { error: `${child}: ${cands.length} candidates under ${g}` };
      const picked = cands[0];
      gc.splice(gc.indexOf(picked), 1);
      queue.push([child, picked]);
    }
  }
  return { map };
}

const shipped = importerOrder();
for (const hunter of ['borge', 'ozzy', 'knox']) {
  const derived = gameIndexFor(hunter);
  if (derived.error) { fail(`${hunter}: could not derive the mapping -- ${derived.error}`); continue; }

  const correct = [];
  for (const [id, idx] of derived.map) correct[idx] = id;

  const list = shipped[hunter] || [];
  const problems = [];
  for (const [id, idx] of derived.map) {
    if (list[idx] !== id) {
      problems.push(`${FAMILY[hunter]}${idx}Level should load "${id}", the importer loads `
        + `"${list[idx] === undefined ? '(nothing)' : list[idx]}"`);
    }
  }
  if (process.argv.includes('--print')) {
    console.log(`\n  ${hunter} correct order:\n    ${JSON.stringify(correct.filter((x) => x !== undefined))}`);
  }
  if (problems.length) problems.forEach(fail);
  else pass(`${hunter}: all ${derived.map.size} save slots load the attribute the game puts there`);
}

// --- TALENTS: the same positional scheme, checked against the game's authored caps -------------
// The Skill families are ONE-indexed in the game (BorgeSkill1..9), so our list index i maps to
// game index i+1. Getting that backwards makes every talent look mis-mapped; it was worth
// resolving rather than "fixing", since Borge and Ozzy match 9/9 under the correct offset.
//
// Knox is the real case: the game's slot 8 is its Ultima signature talent, which this tool
// deliberately does not model (no `ultima` argument exists for Knox in params.json). Leaving it out
// of the order list shifted `finish` onto that slot, so it read KnoxSkill8Level instead of
// KnoxSkill9Level. A `null` placeholder keeps the positions honest.
const SKILL_FAMILY = { borge: 'BorgeSkill', ozzy: 'OzzySkill', knox: 'KnoxSkill' };

function talentOrder() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../webapp/public/saveImport.js'), 'utf8');
  const block = /const HUNTER_TALENT_ORDER = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('HUNTER_TALENT_ORDER not found in saveImport.js');
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'|(null)/g)].map((x) => x[1] || null);
  }
  return out;
}

const tOrder = talentOrder();
for (const hunter of ['borge', 'ozzy', 'knox']) {
  const fam = scene[SKILL_FAMILY[hunter]] || {};
  const talents = sb.HUNTER_DEFS[hunter].talents || [];
  const list = tOrder[hunter] || [];
  const problems = [];
  let compared = 0;

  list.forEach((id, i) => {
    const entry = fam[String(i + 1)];   // the family is 1-indexed
    if (!entry || entry.MaxLevel === undefined) return;
    if (!id) return;                    // a slot we deliberately do not model
    const t = talents.find((x) => x.id === id);
    if (!t) { problems.push(`${hunter}: "${id}" is imported but is not a talent in HUNTER_DEFS`); return; }
    compared++;
    if (t.maxLevel !== entry.MaxLevel) {
      problems.push(`${SKILL_FAMILY[hunter]}${i + 1}Level -> "${id}" (cap ${t.maxLevel}) but the `
        + `game's slot ${i + 1} caps at ${entry.MaxLevel}`);
    }
  });

  // Every modelled talent must be claimed by exactly one slot.
  const claimed = list.filter(Boolean);
  const missing = talents.map((t) => t.id).filter((id) => !claimed.includes(id));
  if (missing.length) problems.push(`${hunter}: talents never loaded from the save: ${missing.join(', ')}`);

  if (!compared) fail(`${hunter}: no talent slots were comparable`);
  else if (problems.length) problems.forEach(fail);
  else pass(`${hunter}: all ${compared} talent slot(s) load the talent the game caps that way`);
}

console.log(failures
  ? `\n${failures} failure(s) -- a positional import that is wrong is SILENT; every value still `
    + 'lands somewhere and the totals still look plausible'
  : '\nthe save importer maps every attribute slot the way the game numbers them');
process.exit(failures ? 1 : 0);
