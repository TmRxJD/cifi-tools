'use strict';
// GAP CHECK AGAINST THE ORIGINAL TOOL.
//
// cifi-tools.com's bundle declares, per hunter, exactly which parameters its Overrides panel
// exposes (its `OD` table) and the maximum level each one accepts (its `{key,label,max}`
// entries). Those two things are the authoritative answer to "what should our Overrides panel
// offer, and what caps should it enforce" -- so diff ours against them rather than eyeballing.
//
// Point the script at a saved copy of the live bundle:
//   node tools/bench/live-override-diff.js <path-to-index-*.js>
//
// Exits non-zero if our tables and the live tables disagree.

const fs = require('fs');
const H = require('./harness.js');

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('usage: node tools/bench/live-override-diff.js <path-to-live-bundle.js>');
  process.exit(2);
}
const src = fs.readFileSync(bundlePath, 'utf8');

// --- what the live tool exposes, per hunter -------------------------------------------------
// Each hunter's OD-style object is recognisable by its baseStats list; the hunter is identified
// by a stat only that hunter has.
const HUNTER_BY_MARKER = { block: 'knox', critchance: 'borge', multichance: 'ozzy' };

// Balance braces from each `{baseStats:[` rather than regex-matching to a closing brace --
// these objects contain nested arrays and further braces, so a lazy regex truncates them.
function objectAt(start) {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function extractOverrideTables() {
  const out = {};
  let from = 0;
  for (;;) {
    const at = src.indexOf('{baseStats:[', from);
    if (at === -1) break;
    from = at + 1;
    const text = objectAt(at);
    if (!text) continue;
    const stats = /baseStats:\[([^\]]*)\]/.exec(text)[1].replace(/"/g, '').split(',');
    const marker = Object.keys(HUNTER_BY_MARKER).find((k) => stats.includes(k));
    if (!marker) continue;
    const hunter = HUNTER_BY_MARKER[marker];
    if (out[hunter]) continue;
    const keys = [...text.matchAll(/"(upgrades\.[a-zA-Z0-9_.]+)"/g)].map((x) => x[1]);
    out[hunter] = { baseStats: stats, upgradeKeys: keys };
  }
  return out;
}

// --- the caps the live tool enforces ---------------------------------------------------------
function extractMaxLevels() {
  const caps = {};
  for (const m of src.matchAll(/\{key:"(upgrades\.[a-zA-Z0-9_.]+)",label:"([^"]*)",max:(\d+)\}/g)) {
    caps[m[1]] = { label: m[2], max: Number(m[3]) };
  }
  return caps;
}

// Deliberate, documented divergences. An entry here needs a REASON, and the reason has to be
// something better than "the diff was noisy" -- otherwise this becomes the place gaps go to hide.
const KNOWN_DIVERGENCES = {
  'upgrades.relics.t2r7:cap': {
    reason: 'The live bundle contradicts ITSELF: its relic definition table says maxLevel 100 '
      + '(alongside unlock_gem "power" / unlock_lvl 3), while its Overrides panel clamps to 40. '
      + 'No recorded build in our 182 fixtures carries t2r7 at all, so there is no empirical '
      + 'tiebreaker. We keep 100 -- the relic\'s own declared cap -- because clamping to 40 '
      + 'would make a real high-level account unable to enter its actual level, and being unable '
      + 'to describe your account is a worse failure than allowing a level you cannot reach.',
  },
};

const live = extractOverrideTables();
const liveCaps = extractMaxLevels();
const sb = H.browserSandbox();

let problems = 0;
const note = (msg) => { console.log('  ' + msg); problems++; };
const reported = new Set();

console.log(`parsed ${Object.keys(live).length} hunter override tables and ${Object.keys(liveCaps).length} declared caps from the live bundle\n`);

for (const hunter of ['borge', 'ozzy', 'knox']) {
  console.log(`=== ${hunter} ===`);
  const liveTable = live[hunter];
  if (!liveTable) { note('could not locate this hunter in the live bundle'); continue; }

  const defs = sb.HUNTER_DEFS[hunter];
  const ours = new Set();
  for (const [cat, group] of Object.entries(defs.globalUpgrades || {})) {
    for (const item of group.items || []) {
      // hunterDefs stores bare ids per category; the live table uses full param names.
      ours.add(item.fullKey || `upgrades.${cat}.${item.id}`);
    }
  }

  const liveKeys = new Set(liveTable.upgradeKeys);
  const missingAll = [...liveKeys].filter((k) => !ours.has(k));
  // The live tool lets you override gem nodes from its Overrides panel; we surface gems through
  // the Gem Planner instead. Different UI location, not a coverage gap -- but ONLY because
  // gem-coverage-test.js separately proves every gem param the wasm reads is reachable from Gem
  // Planner state. Do not soften this filter while that test is failing.
  const missing = missingAll.filter((k) => !k.startsWith('upgrades.gems_nodes.'));
  const viaGemPlanner = missingAll.length - missing.length;
  const extra = [...ours].filter((k) => !liveKeys.has(k));

  if (missing.length) note(`MISSING ${missing.length} override(s) the live tool exposes:\n      ${missing.join('\n      ')}`);
  else console.log(`  no missing overrides (${viaGemPlanner} gem node(s) handled by the Gem Planner)`);
  // Extras are not failures: several are real sim params the live tool simply doesn't expose,
  // and our per-trinket inputs feed the summed count it exposes instead. Listed, not counted.
  if (extra.length) console.log(`  we additionally expose ${extra.length}: ${extra.join(', ')}`);

  // Caps, for whatever both sides declare.
  for (const [cat, group] of Object.entries(defs.globalUpgrades || {})) {
    for (const item of group.items || []) {
      const key = item.fullKey || `upgrades.${cat}.${item.id}`;
      const declared = liveCaps[key];
      if (!declared) continue;
      if (item.maxLevel === declared.max) continue;
      const known = KNOWN_DIVERGENCES[`${key}:cap`];
      if (known) {
        if (!reported.has(key)) {
          reported.add(key);
          console.log(`  known divergence ${key}: ours ${item.maxLevel}, live ${declared.max}\n      ${known.reason}`);
        }
        continue;
      }
      note(`CAP MISMATCH ${key}: ours ${item.maxLevel}, live ${declared.max} ("${declared.label}")`);
    }
  }
}

console.log(`\n${problems ? `${problems} discrepancy group(s) vs the live tool` : 'no gaps: our override tables match the live tool'}`);
process.exit(problems ? 1 : 0);
