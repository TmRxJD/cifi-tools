'use strict';
// Can our Gem Planner express every gem parameter the live tool exposes as an override?
//
// The override-table diff (live-override-diff.js) reports the live tool's gem_nodes keys as
// "missing" from our Overrides panel. That is expected and not automatically a gap: we surface
// gems through the Gem Planner instead. But "we do it elsewhere" is only an answer if the
// elsewhere actually covers every one of them, so check it rather than assume.
//
// A gem param is COVERED if some Gem Planner state makes resolveParam return a non-default
// value for it -- i.e. the user can actually reach that number through our UI's data model.
//
//   node tools/bench/gem-coverage-test.js

const H = require('./harness.js');

const sb = H.browserSandbox();
let failures = 0;

// Every gem-ish param the wasm actually reads, per hunter, straight from params.json.
const fs = require('fs');
const path = require('path');
const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../../webapp/public/params.json'), 'utf8'));

function maxedGemState() {
  const state = sb.defaultGemState();
  for (const [key, tree] of Object.entries(sb.GEM_TREES)) {
    state[key].level = 20;
    state[key].nodes = new Array(tree.nodeCount).fill(true);
    for (const k of Object.keys(state[key].upgrades)) state[key].upgrades[k] = 10;
  }
  return state;
}

const baseState = (gemStates) => ({
  hunterStats: {}, talents: {}, attributes: {}, upgrades: {}, overrides: {},
  level: 60, gemPlannerStore: { gemStates },
});

// creation_galvTrinketsCount is NOT reachable from gem state alone by design: it sums
// state.upgrades.trinkets, gated behind Creation Gem 5. Our Overrides panel exposes the
// individual trinkets (the live tool exposes the summed count instead), and the trinket-chain
// check below is what verifies that route. Expected, so not a failure.
const NEEDS_NON_GEM_INPUT = new Set(['upgrades.gems_nodes.creation_galvTrinketsCount']);
const uncovered = [];
const covered = [];

for (const hunter of ['borge', 'ozzy', 'knox']) {
  const gemParams = params[hunter].filter((p) => String(p).startsWith('upgrades.gems_nodes.'));
  for (const p of gemParams) {
    const off = sb.HunterSim.resolveParam(p, baseState(sb.defaultGemState()));
    const on = sb.HunterSim.resolveParam(p, baseState(maxedGemState()));
    if (off === on && !NEEDS_NON_GEM_INPUT.has(p)) uncovered.push({ hunter, p, off, on });
    else covered.push({ hunter, p, off, on });
  }
}

console.log(`${covered.length} gem param(s) reachable from Gem Planner state, ${uncovered.length} not\n`);
if (uncovered.length) {
  console.log('NOT reachable by maxing every gem tree (each needs another input, or is unwired):');
  for (const u of uncovered) console.log(`  ${u.hunter.padEnd(6)} ${u.p.padEnd(55)} stays ${u.off}`);
  failures++;
}

// Trinket-count is the known one that needs a NON-gem input as well: it sums
// state.upgrades.trinkets, and only once Creation Gem 5 is unlocked. Our Overrides panel
// exposes the individual trinkets (the live tool exposes the summed count instead), so verify
// the whole chain works -- gate closed, gate open, and the sum actually summing.
console.log('\ntrinket chain (our per-trinket overrides -> the live tool\'s summed count):');
const withTrinkets = (gemStates, trinkets) => ({ ...baseState(gemStates), upgrades: { trinkets } });
const KEY = 'upgrades.gems_nodes.creation_galvTrinketsCount';
const trinkets = { last_handbook: 3, transmission_amplifier: 4, ouro_codex: 5 };

const gated = sb.HunterSim.resolveParam(KEY, withTrinkets(sb.defaultGemState(), trinkets));
const opened = sb.HunterSim.resolveParam(KEY, withTrinkets(maxedGemState(), trinkets));
console.log(`  Creation Gem 5 locked -> ${gated}   (must be 0: the trinkets do not count yet)`);
console.log(`  Creation Gem 5 open   -> ${opened}   (must be 3+4+5 = 12)`);
if (gated !== 0) { console.log('  FAIL: trinkets counted while the gate was closed'); failures++; }
if (opened !== 12) { console.log('  FAIL: trinket sum wrong'); failures++; }

console.log(`\n${failures ? `${failures} problem(s)` : 'every gem parameter the live tool exposes is reachable through our Gem Planner'}`);
process.exit(failures ? 1 : 0);
