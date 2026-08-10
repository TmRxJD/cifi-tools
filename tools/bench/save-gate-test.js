'use strict';
// EMPIRICAL checks against a REAL save file -- the game's own data, not the live tool's reading
// of it.
//
// Field names below were recovered from the save itself and corroborated against the game's
// IL2CPP metadata string table (e.g. `AttractionGemNode1Level`, `<Tree>QualityLevel`), so they
// are not guesses from value shape.
//
//   AOR<N>Level          tier-1 relic levels (Academy Of Relics), N = the in-game relic number
//   <Tree>QualityLevel   the gem tree level that UPGRADE_GATES compares against
//   <Tree>GemNode<N>Level / ExodusGemNodeLevels[]   per-node levels
//
// WHAT THIS CAN AND CANNOT PROVE. A single account only exercises the gates its own progression
// touches, and the game does not write save fields for content the account has never reached --
// so an ABSENT field is consistent with a gate but does not prove it. The test therefore
// separates "actively confirmed" from "consistent but unproven" and prints both, rather than
// reporting a green tick that overstates the evidence.
//
//   node tools/bench/save-gate-test.js [path-to-decoded-save.json]

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const savePath = process.argv[2] || path.join(__dirname, '../gamefiles/save/decoded-20260809.json');
if (!fs.existsSync(savePath)) {
  console.log(`SKIP: no decoded save at ${savePath}`);
  console.log('  game files are gitignored -- see tools/gamefiles/README.md to re-pull and decode.');
  process.exit(0);
}
const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
const sb = H.browserSandbox();
const CF = sb.CostFormulas;

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

const TREES = ['attraction', 'creation', 'evolution', 'exodus', 'innovation', 'power', 'temporal'];
const treeLevel = {};
for (const t of TREES) {
  const key = `${t[0].toUpperCase()}${t.slice(1)}QualityLevel`;
  if (!(key in save)) throw new Error(`save has no ${key} -- the field naming has changed`);
  treeLevel[t] = Number(save[key]) || 0;
}
console.log(`reference account: ${TREES.map((t) => `${t} ${treeLevel[t]}`).join(', ')}\n`);

// ---- relic caps, against 20 real levels ------------------------------------------------------
check('no relic on this account exceeds the cap we declare', () => {
  const unresolved = CF.unresolvedRelicCaps();
  const problems = [];
  let compared = 0;
  for (let n = 1; n <= 20; n++) {
    const field = `AOR${n}Level`;
    if (!(field in save)) continue;
    const level = Number(save[field]) || 0;
    const id = `r${n}`;
    if (unresolved[id]) continue; // we deliberately state no cap for these
    const cap = CF.relicMaxLevel(id);
    compared++;
    if (level > cap) problems.push(`${id} is at ${level} on the account but we cap it at ${cap}`);
  }
  if (compared < 15) return `only compared ${compared} relics -- the AOR<N>Level mapping is probably wrong`;
  console.log(`        (${compared} relic levels compared against declared caps)`);
  return problems.length ? problems.join('\n        ') : null;
});

check('every relic level on the account is priceable by our cost table', () => {
  for (let n = 1; n <= 20; n++) {
    const field = `AOR${n}Level`;
    if (!(field in save)) continue;
    const level = Number(save[field]) || 0;
    if (level <= 0) continue;
    const cost = CF.relicCostAtLevel(`r${n}`, level);
    if (!Number.isFinite(cost) || cost <= 0) return `r${n} at level ${level} priced ${cost}`;
  }
  return null;
});

// ---- gem structure -------------------------------------------------------------------------
check('the save carries exactly the gem node fields the game metadata declares', () => {
  for (const t of TREES) {
    const Tree = `${t[0].toUpperCase()}${t.slice(1)}`;
    if (t === 'exodus') {
      // Exodus stores its nodes as one array, unlike the rest -- matches the metadata, which
      // has no ExodusGemNode<N>Level fields.
      const arr = save.ExodusGemNodeLevels;
      if (!Array.isArray(arr)) return 'ExodusGemNodeLevels is not an array';
      if (arr.length !== 6) return `ExodusGemNodeLevels has ${arr.length} entries, expected 6`;
      continue;
    }
    for (let n = 1; n <= 6; n++) {
      if (!(`${Tree}GemNode${n}Level` in save)) return `${Tree}GemNode${n}Level missing from the save`;
    }
    if (`${Tree}GemNode7Level` in save) return `${Tree} has a 7th node -- our model says 6`;
  }
  return null;
});

check('no gem tree on this account exceeds the max level we model', () => {
  for (const t of TREES) {
    const max = sb.GEM_TREES[t].maxLevel;
    if (treeLevel[t] > max) return `${t} is at ${treeLevel[t]} on the account but we cap it at ${max}`;
  }
  return null;
});

// ---- the gates themselves --------------------------------------------------------------------
// Where the save keeps the owned level of each gated key, for the ones we can address.
function ownedLevel(key) {
  const [, category, id] = key.split('.');
  if (category === 'relics') {
    const m = /^t2r(\d+)$/.exec(id);
    if (m) {
      // Tier-2 levels are stored obfuscated; the unlock-progress array is the readable signal.
      const prog = save.AORTier2UnlockProgress;
      if (!Array.isArray(prog)) return null;
      const idx = Number(m[1]) - 1;
      return { field: `AORTier2UnlockProgress[${idx}]`, level: Number(prog[idx]) || 0 };
    }
    const f = `AOR${id.replace(/^r/, '')}Level`;
    return f in save ? { field: f, level: Number(save[f]) || 0 } : null;
  }
  if (category === 'cms') {
    const f = id.toUpperCase();
    return f in save ? { field: f, level: save[f] ? 1 : 0 } : null;
  }
  return null;
}

check('nothing gated is owned while its gate is unmet', () => {
  const problems = [];
  const confirmed = [];
  const unprovable = [];
  for (const [key, gate] of Object.entries(sb.UPGRADE_GATES)) {
    const owned = ownedLevel(key);
    const met = treeLevel[gate.gem] >= gate.level;
    if (!owned) { unprovable.push(`${key} (no readable save field)`); continue; }
    if (owned.level > 0 && !met) {
      problems.push(`${key} owned (${owned.field} = ${owned.level}) but ${gate.gem} is ${treeLevel[gate.gem]}, gate needs ${gate.level}`);
    } else if (!met) {
      confirmed.push(`${key} correctly un-owned (${gate.gem} ${treeLevel[gate.gem]} < ${gate.level})`);
    }
  }
  console.log(`        (${confirmed.length} gate(s) actively confirmed by an un-owned readable field;`);
  console.log(`         ${unprovable.length} not testable from this account -- the game writes no field for content it has never reached)`);
  return problems.length ? problems.join('\n        ') : null;
});

console.log(`\n${failures ? `${failures} FAILED` : 'real account data is consistent with everything we model'}`);
process.exit(failures ? 1 : 0);
