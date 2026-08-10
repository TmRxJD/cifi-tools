'use strict';
// Which of the overrides WE expose carry an unlock requirement in the live bundle, and do we
// model it?
//
// The live bundle gates most non-base-stat upgrades behind a gem tree reaching a level
// (unlock_gem + unlock_lvl, or unlock + unlock_level -- two spellings of the same thing).
// Recommending or pricing something the account cannot unlock yet is a confidently wrong
// answer, so every gate that applies to an override we expose has to be mapped.
//
//   node tools/bench/gate-coverage.js <path-to-live-bundle.js>

const fs = require('fs');
const H = require('./harness.js');

const bundlePath = process.argv[2];
if (!bundlePath) { console.error('usage: gate-coverage.js <live-bundle.js>'); process.exit(2); }
const src = fs.readFileSync(bundlePath, 'utf8');

function objectAt(start) {
  let depth = 0; let inStr = false; let esc = false; let q = '';
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function enclosing(at) {
  let depth = 0;
  for (let i = at; i > 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) return objectAt(i); depth--; }
  }
  return null;
}

/** id -> { gem, level } for every gated entry the bundle declares. */
function extractGates() {
  const out = new Map();
  for (const field of ['unlock_gem:', 'unlock_lvl:', 'unlock:', 'unlock_level:']) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(field, from);
      if (at === -1) break;
      from = at + 1;
      const obj = enclosing(at);
      if (!obj || obj.length > 700) continue;
      const id = /\b(?:id|key):\s*["']([^"']+)["']/.exec(obj);
      if (!id) continue;
      const gem = /\bunlock(?:_gem)?:\s*["']([a-z]+)["']/.exec(obj);
      const lvl = /\bunlock_(?:lvl|level):\s*(\d+)/.exec(obj);
      if (!gem || !lvl) continue;
      const key = id[1];
      if (!out.has(key)) out.set(key, { gem: gem[1], level: Number(lvl[1]) });
    }
  }
  return out;
}

const gates = extractGates();
const sb = H.browserSandbox();
const modelled = sb.UPGRADE_GATES || {};

let missing = 0;
let wrong = 0;
let ok = 0;
const rows = [];

for (const hunter of ['borge', 'ozzy', 'knox']) {
  for (const [cat, group] of Object.entries(sb.HUNTER_DEFS[hunter].globalUpgrades || {})) {
    for (const item of group.items || []) {
      const key = `upgrades.${cat}.${item.id}`;
      // The bundle keys some of these by a friendlier id than the param suffix.
      const live = gates.get(item.id) || gates.get(key)
        || (item.id === 'm0' ? gates.get('eternal_milestone') : undefined);
      const ours = modelled[key];
      if (!live) { if (ours) { rows.push(`  EXTRA    ${key} — we gate it, the bundle does not`); wrong++; } continue; }
      if (!ours) { rows.push(`  MISSING  ${key.padEnd(40)} needs ${live.gem} gem level ${live.level}`); missing++; continue; }
      if (ours.gem !== live.gem || ours.level !== live.level) {
        rows.push(`  WRONG    ${key.padEnd(40)} ours ${ours.gem}/${ours.level}, live ${live.gem}/${live.level}`);
        wrong++;
        continue;
      }
      ok++;
    }
  }
}

console.log(`${gates.size} gated entries in the live bundle; ${Object.keys(modelled).length} modelled here\n`);
// Same key appears for all three hunters; dedupe the report.
console.log([...new Set(rows)].join('\n') || '  (none)');
console.log(`\n${ok} correctly mapped, ${missing} missing, ${wrong} wrong`);
process.exit(missing + wrong ? 1 : 0);
