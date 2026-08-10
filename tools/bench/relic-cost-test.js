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

// Tier-2 caps now come from the live bundle's own parameter table rather than being refused.
check('tier-2 relics have the caps the live bundle declares', () => {
  const expected = { t2r4: 25, t2r5: 100, t2r6: 40, t2r7: 40, t2r8: 21, t2r9: 100, t2r10: 5 };
  for (const [id, max] of Object.entries(expected)) {
    if (!CF.knownRelicIds().includes(id)) return `${id} is missing from the table entirely`;
    const ours = CF.relicMaxLevel(id);
    if (ours !== max) return `${id}: ours ${ours}, live bundle ${max}`;
  }
  return null;
});

// Tier-2 caps are not in the extracted dataset, so relicMaxLevel throws for them by design.
// 100 levels is far past anything reachable and is plenty to compare two implementations over.
const UNRESOLVED = CF.unresolvedRelicCaps();
const levelsToCompare = (id) => {
  // Bound by what can actually be PRICED (a static table runs out; a formula does not), then by
  // the cap. Relics with an unresolved cap chain get a sane ceiling instead.
  const priceable = CF.relicPriceableLevels(id);
  if (UNRESOLVED[id]) return Math.min(priceable, 100);
  return Math.min(priceable, CF.relicMaxLevel(id));
};

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
    if (!UNRESOLVED[id]) {
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

// Relics #5 and #6 cap at 8 and rise to 11 only with Power Gem Node 1 -- which is why their
// static cost tables carry 11 entries. Reading the table length as the cap (which is what this
// module did when the table first landed) silently offers three levels the account cannot buy.
// Same shape as Borge's Call Me Lucky Loot, and the same class of bug: optimistic default.
// Two independent sources disagree about where r5/r6/r9's caps start and which gem node raises
// them (see costFormulas.js). None are hunter sim params, so nothing consumes the number --
// refusing to state one is strictly better than picking a side and being confidently wrong.
check('a relic with an unresolved cap chain refuses to state a max level', () => {
  const unresolved = CF.unresolvedRelicCaps();
  for (const id of ['r5', 'r6', 'r9']) {
    if (!unresolved[id]) return `${id} should be marked cap-unresolved`;
    try {
      const v = CF.relicMaxLevel(id);
      return `${id} returned max level ${v} despite an unresolved cap chain`;
    } catch (err) {
      if (!/unresolved cap chain/.test(err.message)) return `${id} threw the wrong error: ${err.message}`;
    }
    // Costs are still exact and must still be available.
    if (!(CF.relicCostAtLevel(id, 5) > 0)) return `${id} lost its cost formula`;
  }
  // Relics with a KNOWN cap must still answer.
  for (const id of ['r4', 'r16', 'r19']) {
    if (unresolved[id]) return `${id} is wrongly marked unresolved`;
    if (!(CF.relicMaxLevel(id) > 0)) return `${id} has no usable max level`;
  }
  return null;
});

// ---- Fragments -----------------------------------------------------------------------------
// Relics are bought with fragments, which the evaluator does not produce, so the rate is a user
// input. The failure mode to guard against is a MISSING rate quietly reading as "instant" or
// "free" -- the same shape as the silent-zero relic cost this file exists to prevent.

const DAY = 86400000;

check('with no rate entered, affordability is unknown -- not instant', () => {
  const state = { perDay: 0, current: 0, currentAt: 0, autoAccrue: true };
  const d = CF.fragmentDaysUntilAffordable(5000, state);
  return d === null ? null : `returned ${d} instead of null for "no rate known"`;
});

check('something already affordable takes zero days even with no rate', () => {
  const state = { perDay: 0, current: 10000, currentAt: 0, autoAccrue: true };
  return CF.fragmentDaysUntilAffordable(5000, state) === 0 ? null : 'did not report it as already affordable';
});

check('days-until-affordable divides the shortfall by the rate', () => {
  const state = { perDay: 100, current: 500, currentAt: 0, autoAccrue: false };
  const d = CF.fragmentDaysUntilAffordable(1500, state);
  return d === 10 ? null : `expected 10 days for a 1000 shortfall at 100/day, got ${d}`;
});

check('a stamped balance accrues while you are away', () => {
  const now = 1_700_000_000_000;
  const state = { perDay: 24, current: 100, currentAt: now - 2 * DAY, autoAccrue: true };
  const have = CF.fragmentsOnHand(state, now);
  return have === 148 ? null : `expected 100 + 2 days at 24/day = 148, got ${have}`;
});

check('accrual can be turned off', () => {
  const now = 1_700_000_000_000;
  const state = { perDay: 24, current: 100, currentAt: now - 5 * DAY, autoAccrue: false };
  return CF.fragmentsOnHand(state, now) === 100 ? null : 'accrued despite autoAccrue being false';
});

check('a balance that was never stamped does not accrue out of nowhere', () => {
  const state = { perDay: 999, current: 7, currentAt: 0, autoAccrue: true };
  return CF.fragmentsOnHand(state, 1_700_000_000_000) === 7 ? null : 'accrued from an unset timestamp';
});

check('fragment state is required, not defaulted', () => {
  try {
    CF.fragmentsOnHand(null, Date.now());
    return 'accepted a missing fragment state';
  } catch { return null; }
});

// The store field this reads is account-level on purpose: one Relic #7 exists, bought once.
check('the store declares fragments at account level, not per hunter', () => {
  const S = H.browserSandbox().StoreSchema;
  const fresh = S.freshStore();
  if (!fresh.fragments) return 'store.fragments is missing';
  for (const k of ['perDay', 'current', 'currentAt', 'autoAccrue']) {
    if (!(k in fresh.fragments)) return `store.fragments.${k} is missing`;
  }
  if (fresh.fragments.perDay !== 0) return 'a fragment rate was guessed instead of left unset';
  for (const hunter of S.HUNTERS) {
    if (fresh[hunter] && fresh[hunter].fragments) return `${hunter} also carries a fragments field -- two homes for one number`;
  }
  return null;
});

console.log(`\n${failures ? `${failures} FAILED` : 'all relic cost invariants hold'}`);
process.exit(failures ? 1 : 0);
