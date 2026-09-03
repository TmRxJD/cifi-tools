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
};

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

console.log(`\nchecked ${badgeKeys.length} fleet badge(s) against the game`);
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('every badge, the ships it applies to, and its multiplier match the game');
