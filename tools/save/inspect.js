'use strict';
// Decode a CIFI save and inspect its fields. The save is the game's own answer to "what is the
// real value", which makes it the arbiter whenever the live cifi-tools bundle is ambiguous.
//
//   node tools/save/inspect.js <DATA.text>                 # decode, summarise, write JSON next to it
//   node tools/save/inspect.js <DATA.text> AOR             # ...and print fields matching /AOR/i
//   node tools/save/inspect.js <decoded.json> QualityLevel # works on an already-decoded file too
//
// Field naming worth knowing (recovered here, corroborated against the game's IL2CPP metadata):
//   AOR<N>Level                  tier-1 relic levels  ("Academy Of Relics")
//   AORTier2Levels/UnlockProgress tier-2 relics (levels are obfuscated; progress is readable)
//   <Tree>QualityLevel           the gem tree level that UPGRADE_GATES compares against
//   <Tree>GemNode<N>Level        per-node levels; Exodus instead uses ExodusGemNodeLevels[]
//   <Tree>GU<N>Level             the per-tree gem UPGRADE (bonus) levels
//   Gadget<N>Level               gadgets, by index rather than name
//   CM<N>                        construction milestones, boolean

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '../../webapp/public');

async function decode(file) {
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const sb = { console, TextEncoder, TextDecoder, crypto: require('node:crypto').webcrypto, atob, btoa };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'saveImport.js'), 'utf8'), sb, { filename: 'saveImport.js' });
  return sb.decodeCifiSaveText(fs.readFileSync(file, 'utf8'));
}

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/save/inspect.js <DATA.text|decoded.json> [regex]'); process.exit(2); }
  const save = await decode(file);
  const keys = Object.keys(save);
  console.log(`${keys.length.toLocaleString()} fields`);

  if (!file.endsWith('.json')) {
    const out = file.replace(/\.text$/, '') + '.decoded.json';
    fs.writeFileSync(out, JSON.stringify(save, null, 1));
    console.log(`decoded JSON -> ${out}`);
  }

  const trees = ['Attraction', 'Creation', 'Evolution', 'Exodus', 'Innovation', 'Power', 'Temporal'];
  console.log('\ngem tree levels: ' + trees.map((t) => `${t.toLowerCase()} ${save[`${t}QualityLevel`] ?? '?'}`).join(', '));
  const relics = [];
  for (let n = 1; n <= 20; n++) if (`AOR${n}Level` in save) relics.push(`r${n}:${save[`AOR${n}Level`]}`);
  console.log('relic levels  : ' + (relics.join(' ') || '(none found)'));

  const pattern = process.argv[3];
  if (pattern) {
    const rx = new RegExp(pattern, 'i');
    const hits = keys.filter((k) => rx.test(k)).sort();
    console.log(`\n${hits.length} field(s) matching /${pattern}/i`);
    for (const k of hits.slice(0, 80)) console.log(`   ${k} = ${JSON.stringify(save[k]).slice(0, 70)}`);
    if (hits.length > 80) console.log(`   ... and ${hits.length - 80} more`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
