'use strict';
// Check our relic max-level caps against the ORIGINAL tool's own `JP` object.
//
// cifi-tools.com was built in collaboration with the game's developers, so a value taken from its
// bundle is authoritative -- for anything the site actually models, matching it IS the
// verification (see CLAUDE.md's "Where a value has to come from"). `JP` is the live tool's own
// per-relic definition table (id, name, description, tier, maxLevel, getCost) -- not to be
// confused with a DIFFERENT, unrelated table in the same bundle that also has `key:"t2rN"` and a
// `max:` field for an orb/fragment-calculator input widget. That second table is easy to mistake
// for the real one (it happened once already, in this project's own history) because it lists
// three of the ten tier-2 ids with plausible-looking max values. `JP` is what the live site's own
// `XP()` "how far can this relic go" function actually reads, confirmed by grepping its call
// sites in the bundle -- that is what makes it authoritative and the widget table not.
//
//   node tools/bench/relic-maxlevel-check.js <live-bundle.js>
//
// Fetch a bundle from the live site's network tab. It is not vendored here: it is someone else's
// build artifact and it changes without notice, so this is a check you run, not a gate that runs
// itself -- same arrangement as inscryption-cost-check.js and gate-coverage.js.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness.js');

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('usage: node tools/bench/relic-maxlevel-check.js <live-bundle.js>');
  process.exit(2);
}
if (!fs.existsSync(bundlePath)) {
  console.error(`no such bundle: ${bundlePath}`);
  process.exit(2);
}

/** Slice a balanced object literal starting at the first `{` at or after `from`. */
function objectLiteralAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

const bundle = fs.readFileSync(bundlePath, 'utf8');
// Anchor on the WRAPPING table's own shape (its r1 entry, keyed) rather than a minified variable
// name, which churns between builds -- see inscryption-cost-check.js's history for why. The
// anchor must land on the `{` that opens the WHOLE table, not r1's own sub-object, or
// objectLiteralAt below captures only r1's six fields.
const marker = 'r1:{id:"r1",name:';
const markerAt = bundle.indexOf(marker);
if (markerAt < 0) {
  console.error('could not find the relic definition table in this bundle -- its shape may have '
    + 'changed. Search it for `id:"r1",name:` to find the new one.');
  process.exit(1);
}
const at = bundle.lastIndexOf('{', markerAt);
const liveSrc = objectLiteralAt(bundle, at);
if (!liveSrc) { console.error('relic table found but its object literal is unbalanced'); process.exit(1); }
// The literal contains bare function values (getCost:KP.r1); strip them to plain markers so
// vm can evaluate it without needing KP itself.
const sanitized = liveSrc.replace(/getCost:KP\.\w+/g, 'getCost:null');
const live = vm.runInNewContext(`(${sanitized})`);

const CF = H.browserSandbox().CostFormulas;
const sb = H.browserSandbox();

// Relics HunterSim actually exposes as overrides, across all 3 hunters -- pulled straight from
// hunterDefs.js rather than hand-maintained here, so this list can't drift out of sync with it.
const exposed = new Set();
for (const hunter of Object.values(sb.HUNTER_DEFS)) {
  const items = hunter.globalUpgrades?.relics?.items || [];
  for (const item of items) exposed.add(item.id);
}

console.log(`original tool: ${Object.keys(live).length} relic definitions, `
  + `${exposed.size} of which HunterSim exposes as overrides\n`);

let problems = 0;
let unexposed = 0;
for (const [id, def] of Object.entries(live)) {
  let ours;
  try {
    ours = CF.relicMaxLevel(id);
  } catch (err) {
    if (!exposed.has(id)) {
      // Not wired up at all, and never offered to a user -- a scope choice (e.g. no sim param
      // reaches it), not a correctness bug. relic-arg-probe.js is what catches a relic that IS
      // exposed but silently inert.
      unexposed += 1;
      continue;
    }
    console.log(`${id} ("${def.name}"): EXPOSED as an override but ours THROWS -- ${err.message}`);
    problems += 1;
    continue;
  }
  if (ours !== def.maxLevel) {
    const tag = exposed.has(id) ? 'MISMATCH' : 'mismatch (not exposed as an override, informational)';
    console.log(`${tag} ${id} ("${def.name}"): ours ${ours}, live bundle ${def.maxLevel}`);
    if (exposed.has(id)) problems += 1;
  }
}
if (unexposed) console.log(`(${unexposed} relic(s) in the live tool are not modelled here at all -- not exposed as overrides, so not a gap)`);

if (problems === 0) {
  console.log(`\nevery EXPOSED relic max level matches the original tool exactly`);
  process.exit(0);
} else {
  console.log(`\n${problems} discrepancy(ies)`);
  process.exit(1);
}
