'use strict';
// Does our attribute dependency tree match the GAME's?
//
//   node tools/bench/attribute-tree-check.js
//
// WHY THIS MATTERS MORE THAN A CAP CHECK. The dependency tree is the optimizer's legality model.
// `AllocSpace` enumerates dependency-closed support sets from it, and the whole "structural choice
// is exhaustive" claim rests on that enumeration covering the real space. A wrong edge does not
// make a build slightly worse -- it changes which allocations are considered to exist at all, in a
// way no score comparison can see, because both sides of the comparison would use the same wrong
// tree.
//
// It had no verification against anything. The live bundle does not declare the tree (its
// `minValue` matches are a UI input prop and it has no parent/requires field), and the scene's
// authored POM/POI/POK families carry Cost, MaxLevel and Bonus but no requirement. The tree was
// transcribed and never checked -- so this closes the last major hunter-side input with no
// provenance.
//
// THE JOIN IS STRUCTURAL, AND HAS TO BE. The game numbers attributes POM0..POM14; we name them
// (`ares`, `ylith`, ...). Our array order is NOT the game's index order -- `atlas` and `weak` sit
// at game indices 10 and 9 while appearing in the other order in HUNTER_DEFS -- so joining by
// position would report two false mismatches and, worse, would have silently "confirmed" a wrong
// tree if the orders had happened to line up. Nodes are therefore matched by tree shape, and the
// authored cost/cap are then checked UNDER that matching as independent evidence it is right: the
// structure and the numbers come from different places (recovered code vs authored scene data), so
// their agreeing is a real cross-check rather than a restatement.

const H = require('./harness.js');
const ref = require('../reference/attribute-tree.json');

const sb = H.browserSandbox();
const scene = require('../reference/scene-defs.json').families;

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const pass = (m) => console.log(`pass  ${m}`);

const SCENE_FAMILY = { borge: 'POM', ozzy: 'POI', knox: 'POK' };

/** children map from a child -> parents map. */
function childrenOf(nodes, parentsOf) {
  const kids = new Map(nodes.map((n) => [n, []]));
  for (const n of nodes) for (const p of parentsOf(n)) kids.get(p).push(n);
  return kids;
}

/** A canonical signature for the subtree rooted at `n`: shape only, no names. */
function signature(n, kids) {
  const subs = (kids.get(n) || []).map((c) => signature(c, kids)).sort();
  return `(${subs.join('')})`;
}

for (const hunter of ['borge', 'ozzy', 'knox']) {
  const defs = sb.HUNTER_DEFS[hunter];
  const deps = defs.attributeDependencies || {};
  const ourNodes = (defs.attributes || []).map((a) => a.id);
  const ourParents = (id) => deps[id] || [];

  const fam = scene[SCENE_FAMILY[hunter]] || {};

  // An UNRELEASED slot: wired into the attribute screen (so it has an edge) but carrying no
  // authored values at all -- Cost 0, MaxLevel 0, Bonus 0. Knox has exactly one, POK11. Not
  // modelling it is correct rather than an omission, the same shape as the game's empty
  // `VexinSkill` family: there is nothing authored to model, and a node the player can never
  // buy a level of cannot enter an allocation.
  //
  // It is EXCLUDED rather than tolerated, so that a future build filling POK11 in stops being
  // excluded and starts failing this bench, which is the moment we would want to hear about it.
  const unreleased = new Set(
    Object.entries(fam)
      .filter(([, v]) => !v.Cost && !v.MaxLevel)
      .map(([i]) => Number(i)),
  );

  const gameEdges = ref.edges[hunter] || {};
  const gameNodes = [...new Set([
    ...Object.keys(gameEdges).map(Number),
    ...Object.values(gameEdges).flat(),
  ])].filter((n) => !unreleased.has(n)).sort((a, b) => a - b);
  const gameParents = (i) => (gameEdges[String(i)] || []).filter((p) => !unreleased.has(p));

  if (unreleased.size) {
    console.log(`note  ${hunter}: game node(s) ${[...unreleased].join(', ')} carry no authored `
      + 'cost, cap or bonus -- unreleased, and correctly not modelled');
  }

  if (ourNodes.length !== gameNodes.length) {
    fail(`${hunter}: we model ${ourNodes.length} attributes, the game declares ${gameNodes.length} `
      + `released one(s)`);
    continue;
  }

  const ourKids = childrenOf(ourNodes, ourParents);
  const gameKids = childrenOf(gameNodes, gameParents);
  const ourRoots = ourNodes.filter((n) => !ourParents(n).length);
  const gameRoots = gameNodes.filter((n) => !gameParents(n).length);

  if (ourRoots.length !== 1 || gameRoots.length !== 1) {
    fail(`${hunter}: expected exactly one ungated root each, got ours=[${ourRoots}] game=[${gameRoots}]`);
    continue;
  }

  // Match top-down. At each step the children of two matched nodes are paired by subtree shape,
  // and an ambiguous pairing FAILS rather than picking one -- an arbitrary choice here would
  // produce a confident mapping that is wrong, which is worse than no mapping.
  const map = new Map(); // our id -> game index
  const queue = [[ourRoots[0], gameRoots[0]]];
  let ambiguous = null;
  while (queue.length) {
    const [ours, theirs] = queue.shift();
    map.set(ours, theirs);
    const oc = (ourKids.get(ours) || []).slice();
    const gc = (gameKids.get(theirs) || []).slice();
    if (oc.length !== gc.length) {
      ambiguous = `${ours} has ${oc.length} child(ren), game node ${theirs} has ${gc.length}`;
      break;
    }
    const bySig = new Map();
    gc.forEach((g) => {
      const s = signature(g, gameKids);
      if (!bySig.has(s)) bySig.set(s, []);
      bySig.get(s).push(g);
    });
    for (const o of oc) {
      const s = signature(o, ourKids);
      const cands = bySig.get(s);
      if (!cands || !cands.length) { ambiguous = `no game child of ${theirs} has ${ours}'s shape ${s}`; break; }
      if (cands.length > 1) {
        // Same shape: break the tie on authored cost/cap, which is legitimate here because it is
        // an independent source rather than the structure being tested.
        const attr = (defs.attributes || []).find((a) => a.id === o);
        const want = [attr.cost === undefined ? 1 : attr.cost,
          (attr.maxLevel === null || attr.maxLevel === undefined || !Number.isFinite(attr.maxLevel)) ? null : attr.maxLevel];
        const fits = cands.filter((g) => {
          const a = fam[String(g)];
          if (!a) return false;
          const cap = a.MaxLevel === undefined ? null : a.MaxLevel;
          return (a.Cost === undefined ? 1 : a.Cost) === want[0] && cap === want[1];
        });
        if (fits.length !== 1) {
          ambiguous = `${ours}'s child ${o} matches ${cands.length} game nodes by shape `
            + `(${cands.join(', ')}) and ${fits.length} by authored cost/cap -- cannot pin it`;
          break;
        }
        cands.splice(cands.indexOf(fits[0]), 1);
        queue.push([o, fits[0]]);
        continue;
      }
      queue.push([o, cands.pop()]);
    }
    if (ambiguous) break;
  }

  if (ambiguous) {
    fail(`${hunter}: our tree does not match the game's -- ${ambiguous}`);
    continue;
  }
  if (map.size !== ourNodes.length) {
    fail(`${hunter}: only ${map.size} of ${ourNodes.length} attributes were reachable from the root`);
    continue;
  }

  // Every edge, both directions.
  const problems = [];
  for (const id of ourNodes) {
    const ourP = ourParents(id).map((p) => map.get(p)).sort((a, b) => a - b);
    const theirP = gameParents(map.get(id)).slice().sort((a, b) => a - b);
    if (JSON.stringify(ourP) !== JSON.stringify(theirP)) {
      problems.push(`${hunter}.${id} (game node ${map.get(id)}): ours <- [${ourP}], game <- [${theirP}]`);
    }
  }

  // Independent confirmation that the structural join is the right one.
  let confirmed = 0;
  for (const attr of defs.attributes || []) {
    const a = fam[String(map.get(attr.id))];
    if (!a) continue;
    confirmed++;
    const ourCost = attr.cost === undefined ? 1 : attr.cost;
    const theirCost = a.Cost === undefined ? 1 : a.Cost;
    if (ourCost !== theirCost) problems.push(`${hunter}.${attr.id}: cost ${ourCost}, game ${theirCost}`);
    const ourCap = (attr.maxLevel === null || attr.maxLevel === undefined || !Number.isFinite(attr.maxLevel)) ? null : attr.maxLevel;
    const theirCap = a.MaxLevel === undefined ? null : a.MaxLevel;
    if (ourCap !== theirCap) problems.push(`${hunter}.${attr.id}: cap ${ourCap}, game ${theirCap}`);
  }

  if (problems.length) problems.forEach(fail);
  else {
    pass(`${hunter}: all ${ourNodes.length} attributes map onto the game's tree, every edge agrees, `
      + `and ${confirmed} authored cost/cap pair(s) confirm the mapping`);
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nevery attribute dependency matches the game');
process.exit(failures ? 1 : 0);
