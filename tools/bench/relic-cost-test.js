'use strict';
// Relic cost invariants.
//
// The relic table in costFormulas.js was widened from 6 hand-transcribed relics to all 20 tier-1
// relics, using an independent source (Ryther's Relic Optimizer, which stores each relic's cost
// as an explicit formula string). The point of this file is that the widening cannot have
// silently changed the relics we had ALREADY verified against the live site: the previous
// implementation is reproduced verbatim below and compared level-by-level.
//
//   node tools/bench/relic-cost-test.js

const H = require('./harness.js');

const CF = H.browserSandbox().CostFormulas;

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

// The PREVIOUS implementation, copied verbatim from git history. Do not "clean this up" -- its
// entire value is being an independent second expression of the same numbers.
function legacyRelicCostAtLevel(relicId, level) {
  if (level <= 0) return 0;
  switch (relicId) {
    case 'relic04': case 'r4': {
      const t = (0.8 + 0.4 * (level - 1)) * Math.pow(1.12, level - 1) * Math.pow(1.02, Math.max(0, level - 10)) * Math.pow(1.015, Math.max(0, level - 20));
      return level < 10 ? t : Math.floor(t);
    }
    case 'relic07': case 'r7': {
      const t = (2 + 1.8 * (level - 1)) * Math.pow(1.14, level - 1) * Math.pow(1.01, Math.max(0, level - 10)) * Math.pow(1.02, Math.max(0, level - 20));
      return Math.floor(t);
    }
    case 'relic09': case 'r9': {
      const t = (8 + 1.8 * (level - 1)) * Math.pow(1.18, level - 1) * Math.pow(1.03, Math.max(0, level - 10)) * Math.pow(1.08, Math.max(0, level - 20));
      return Math.floor(t);
    }
    case 'relic16': case 'r16': {
      const t = (40 + 5 * (level - 1)) * Math.pow(1.08, level - 1) * Math.pow(1.028, Math.max(0, level - 10));
      return Math.floor(t);
    }
    case 'relic17': case 'r17': {
      const t = (50 + 6 * (level - 1)) * Math.pow(1.1, level - 1) * Math.pow(1.037, Math.max(0, level - 10));
      return Math.floor(t);
    }
    case 'relic19': case 'r19': {
      const t = (666 + 111 * (level - 1)) * Math.pow(1.66, level - 1);
      return Math.floor(t);
    }
    case 't2r5': {
      const t = level - 1;
      let n = (13e5 + 3e5 * t) * Math.pow(1.35, t); let r = 0;
      for (let i = 0; 5 * i <= t; i++) r += t - (5 * i - 1);
      n *= Math.pow(1.04, r);
      return Math.floor(n);
    }
    case 't2r7': {
      const t = level - 1;
      let n = (3e5 + 85e4 * t) * Math.pow(1.71, t);
      if (t >= 8) n *= Math.pow(1.09, t - 8 + 1);
      return Math.floor(n);
    }
    case 't2r4': {
      const t = level - 1;
      let n = (3e6 + 5e4 * t) * Math.pow(1.2, t); let r = 0;
      for (let i = 0; 4 * i <= t; i++) r += t - (4 * i - 1);
      n *= Math.pow(1.08, r);
      return Math.floor(n);
    }
    case 't2r8': {
      const t = level - 1;
      let n = (21e5 + 84e4 * t) * Math.pow(1.42, t); let r = 0;
      for (let i = 0; 4 * i <= t; i++) r += t - (4 * i - 1);
      n *= Math.pow(1.21, r);
      return Math.floor(n);
    }
    case 't2r10': {
      const t = level - 1;
      let n = (6e6 + 8e4 * t) * Math.pow(15, t);
      if (t >= 1) n *= Math.pow(21, t - 1 + 1);
      return Math.floor(n);
    }
    default:
      return 0;
  }
}

const PREVIOUSLY_MODELED = ['r4', 'r7', 'r9', 'r16', 'r17', 'r19', 't2r4', 't2r5', 't2r7', 't2r8', 't2r10'];

// Tier-2 caps are not in the extracted dataset, so relicMaxLevel throws for them by design.
// 100 levels is far past anything reachable and is plenty to compare two implementations over.
const levelsToCompare = (id) => (id.startsWith('t2') ? 100 : CF.relicMaxLevel(id));

check('the widened table reproduces every previously-modeled relic exactly', () => {
  for (const id of PREVIOUSLY_MODELED) {
    const max = levelsToCompare(id);
    for (let lvl = 1; lvl <= max; lvl++) {
      const now = CF.relicCostAtLevel(id, lvl);
      const before = legacyRelicCostAtLevel(id, lvl);
      if (now !== before) return `${id} level ${lvl}: now ${now}, previously ${before}`;
    }
  }
  return null;
});

check("the 'relic04' id form resolves to the same relic as 'r4'", () => {
  for (let lvl = 1; lvl <= 30; lvl++) {
    if (CF.relicCostAtLevel('relic04', lvl) !== CF.relicCostAtLevel('r4', lvl)) return `diverged at level ${lvl}`;
  }
  return null;
});

// The whole reason this change was made: a silent 0 makes an unmodeled relic look FREE, so it
// wins every cost-ranked comparison it enters.
check('an unknown relic throws instead of pricing at zero', () => {
  try {
    const v = CF.relicCostAtLevel('r99', 1);
    return `returned ${v} instead of throwing`;
  } catch (err) {
    return /No cost formula for relic/.test(err.message) ? null : `threw the wrong error: ${err.message}`;
  }
});

// The tier-1 caps arrived with the cost formulas from one source; hunterDefs.js declares caps
// for the relics its Overrides panel exposes, from another. They must not disagree.
check('tier-1 caps agree with the caps hunterDefs already declares', () => {
  const defs = H.browserSandbox().HUNTER_DEFS;
  let compared = 0;
  for (const hunter of Object.keys(defs)) {
    const cats = defs[hunter].globalUpgrades || {};
    const items = (cats.relics && cats.relics.items) || [];
    for (const item of items) {
      if (String(item.id).startsWith('t2')) continue; // caps intentionally not modeled here
      const ours = CF.relicMaxLevel(item.id);
      if (ours !== item.maxLevel) return `${hunter} ${item.id}: costFormulas says ${ours}, hunterDefs says ${item.maxLevel}`;
      compared++;
    }
  }
  return compared >= 4 ? null : `only compared ${compared} relics -- the lookup probably found nothing`;
});

check('an unknown relic has no max level either', () => {
  try {
    const v = CF.relicMaxLevel('nonsense');
    return `returned max level ${v} for an unknown relic`;
  } catch (err) {
    return /No max level known for relic/.test(err.message) ? null : `threw the wrong error: ${err.message}`;
  }
});

check('all 20 tier-1 relics plus the tier-2 set are priceable', () => {
  const known = CF.knownRelicIds();
  for (let n = 1; n <= 20; n++) {
    if (!known.includes(`r${n}`)) return `r${n} missing from the table`;
  }
  for (const id of known) {
    if (!id.startsWith('t2')) {
      const max = CF.relicMaxLevel(id);
      if (!(max >= 1)) return `${id} has a nonsensical max level ${max}`;
    }
    const first = CF.relicCostAtLevel(id, 1);
    if (!Number.isFinite(first) || first <= 0) return `${id} level 1 costs ${first}`;
  }
  return null;
});

// Cost must never go DOWN as a relic levels: a planner that walks upgrades in cost order would
// otherwise loop. r10 is the one to watch -- it subtracts flat rebates per level band.
check('every relic costs strictly more at each successive level', () => {
  for (const id of CF.knownRelicIds()) {
    const max = levelsToCompare(id);
    for (let lvl = 2; lvl <= max; lvl++) {
      const prev = CF.relicCostAtLevel(id, lvl - 1);
      const cur = CF.relicCostAtLevel(id, lvl);
      if (cur <= prev) return `${id}: level ${lvl} costs ${cur}, which is not more than level ${lvl - 1}'s ${prev}`;
    }
  }
  return null;
});

check('a level range sums the individual level costs', () => {
  const sum = CF.relicCostRange('r4', 3, 8);
  let expected = 0;
  for (let lvl = 4; lvl <= 8; lvl++) expected += CF.relicCostAtLevel('r4', lvl);
  return sum === expected ? null : `range gave ${sum}, sum of levels is ${expected}`;
});

console.log(`\n${failures ? `${failures} FAILED` : 'all relic cost invariants hold'}`);
process.exit(failures ? 1 : 0);
