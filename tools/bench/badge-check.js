'use strict';
// Which badge multiplies each ship's install nodes, and by how much -- checked against the game.
//
// Badges are per-SHIP uniform multipliers: they scale every node of a ship equally, so they cannot
// reorder an allocation, and the batch optimizer takes per-ship budgets from the user rather than
// splitting one budget across ships. That is exactly why a missing badge is invisible to every
// other bench here -- and Badge12 ("Innovation Badge #2", x222 on Demeter, Koios and Zeus) was
// missing entirely, understating those three ships' totals by that factor for anyone who owned it.
//
// Ships and multipliers are derived from the shipped BEHAVIOUR (probing
// computeFleetBadgeMultipliers with one badge owned at a time) rather than from the declaration,
// both because FLEET_BADGE_ITEMS is module-private and because what the tool applies is the thing
// worth testing.
//
// Regenerate the reference with:
//   CIFI_APK=apk-0.7.3.61 python tools/bench/extract-badge-map.py
//
//   node tools/bench/badge-check.js

const H = require('./harness.js');
const REF = require('../reference/badge-map.json');

const sb = H.browserSandbox();
sb.window.store = sb.StoreSchema.freshStore();
const { SHIP_CATEGORY } = sb.ShipData;

// our badge key -> the game's badge id
const KEY_TO_BADGE = {
  badge_innovation: 'Badge2',
  badge_innovation_2: 'Badge12',
  badge_dark_innovation: 'DarkBadge1',
  badge_tech: 'Badge3',
};

// THERE ARE TWO KINDS OF BADGE and conflating them hides one of them. The three above multiply a
// SHIP's rank-install bonuses, so they are verified per ship. `Badge3` multiplies the TECH POOLS
// (`TechUpgrades.TotalSoftwareMult` / `TotalHardwareMult`) and applies to no ship at all -- a
// per-ship scan cannot see it, which is exactly why a 7.7e14 multiplier on tech output went
// unmodelled. Tech output compounds into long-run Ouroboros progression, so that mattered.
const TECH_POOL_BADGES = new Set(Object.keys(REF.techPools || {}));

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };

const badgeKeys = Object.keys(sb.getFleetBadges().owned);
const effect = {};
for (const key of badgeKeys) {
  const owned = sb.getFleetBadges().owned;
  badgeKeys.forEach((k) => { owned[k] = false; });
  owned[key] = true;
  const mults = sb.computeFleetBadgeMultipliers();
  const ships = Object.keys(mults).map(Number).sort((a, b) => a - b);
  const values = [...new Set(Object.values(mults))];
  if (values.length > 1) fail(`"${key}" applies different multipliers per ship: ${JSON.stringify(mults)}`);
  effect[key] = { ships, mult: values[0] };
}

// 1. every badge the game applies to a modelled ship must be modelled, on those ships
const modelled = new Set(badgeKeys.map((k) => KEY_TO_BADGE[k]).filter(Boolean));
for (const [shipIdRaw, category] of Object.entries(SHIP_CATEGORY)) {
  const shipId = Number(shipIdRaw);
  const wanted = REF.perCategory[category];
  if (!wanted) continue; // Ouroboros has no entry in SHIP_NODE_CATALOG
  for (const badge of wanted) {
    if (!modelled.has(badge)) {
      fail(`${badge} multiplies every ${category} node (ship ${shipId}) but is not modelled at all`);
      continue;
    }
    const key = badgeKeys.find((k) => KEY_TO_BADGE[k] === badge);
    if (!effect[key].ships.includes(shipId)) {
      fail(`${badge} applies to ship ${shipId} (${category}) in the game, but we apply "${key}" to `
        + `ships ${JSON.stringify(effect[key].ships)}`);
    }
  }
}

// 2. we must not claim a badge on a ship the game does not apply it to, and the value must match
for (const key of badgeKeys) {
  const badge = KEY_TO_BADGE[key];
  if (!badge) { fail(`no game badge mapped for "${key}"`); continue; }
  // Checked below against the tech chains instead; it is not a per-ship multiplier.
  if (TECH_POOL_BADGES.has(badge)) continue;
  for (const shipId of effect[key].ships) {
    const category = SHIP_CATEGORY[shipId];
    const wanted = REF.perCategory[category] || [];
    if (!wanted.includes(badge)) {
      fail(`we apply "${key}" to ship ${shipId} (${category}), but no ${category} node reads `
        + `${badge} -- that would overstate every total on that ship`);
    }
  }
  const authored = REF.values[badge];
  if (authored == null) { fail(`no authored value for ${badge}`); continue; }
  if (Math.abs(effect[key].mult - authored) > Math.abs(authored) * 1e-9) {
    fail(`"${key}": we apply x${effect[key].mult}, the game authored x${authored}`);
  }
}

// 3. TECH-POOL badges: the game must read them in BOTH tech chains, our multiplier must match the
// authored value, and they must claim no ship (a per-ship claim would double-count them).
const techKeys = Object.keys(REF.techPools || {});
if (!techKeys.length) {
  fail('badge-map.json declares no tech-pool badge -- re-run extract-badge-map.py; the game reads '
    + 'one in TotalSoftwareMult and TotalHardwareMult');
}
for (const badge of techKeys) {
  const chains = REF.techPools[badge];
  if (!(chains.includes('TotalSoftwareMult') && chains.includes('TotalHardwareMult'))) {
    fail(`${badge} is read by ${chains.join(', ')} -- expected both tech chains`);
  }
  const key = Object.keys(KEY_TO_BADGE).find((k) => KEY_TO_BADGE[k] === badge);
  if (!key) { fail(`the game applies ${badge} to the tech pools but we model no such badge`); continue; }

  // Probe BEHAVIOUR, not the declaration -- same as the per-ship half of this bench. Reading the
  // table would only confirm the table; toggling the badge and measuring the multiplier confirms
  // the tool actually applies it.
  const store = sb.StoreSchema.freshStore();
  sb.window.store = store;
  Object.keys(store.fleetBadges.owned).forEach((k) => { store.fleetBadges.owned[k] = false; });
  const off = sb.computeTechPoolBadgeMultiplier();
  if (off !== 1) fail(`the tech-pool badge multiplier is ${off} with nothing owned -- must be 1`);
  store.fleetBadges.owned[key] = true;
  const on = sb.computeTechPoolBadgeMultiplier();

  const authored = REF.values[badge];
  // float32 storage: 7.7e14 is held as 769999991996416.
  const rel = Math.abs(on - authored) / Math.max(Math.abs(authored), 1e-300);
  if (!(rel < 1e-6)) fail(`owning "${key}" multiplies the tech pools by ${on}, the game's `
    + `${badge}Bonus is ${authored}`);

  // It must not ALSO be applied per ship, or it would be counted twice.
  const perShip = sb.computeFleetBadgeMultipliers();
  const claimed = Object.entries(perShip).filter(([, v]) => Math.abs(v - 1) > 1e-12);
  if (claimed.length) {
    fail(`"${key}" is a tech-pool badge but owning it also changes per-ship multipliers `
      + `(${claimed.map(([shipId, v]) => `ship ${shipId}=x${v}`).join(', ')}) -- it would be `
      + 'counted twice');
  }
}
if (!failures) {
  console.log(`pass  ${techKeys.length} tech-pool badge(s) match the game: read by both tech `
    + 'chains, applied to no ship, multiplier equal to the authored value');
}

console.log(`\nchecked ${badgeKeys.length} fleet badge(s) against the game`);
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('every badge, the ships it applies to, and its multiplier match the game');
