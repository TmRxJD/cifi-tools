'use strict';
// Extract the loop-mod ("module") definition table from an AssetRipper scene export.
//
// This is the data that is NOT in the save (the save has only per-mod LEVELS, LM<N>Level) and
// NOT statically readable from the IL2CPP dump (which gives field names and offsets, not values).
// It lives as serialized MonoBehaviour fields on LoopModifiers, and only becomes readable once
// AssetRipper reconstructs typetrees from the dumper's DummyDll.
//
// HOW TO GET THE INPUT (see tools/il2cpp-cli/README.md for the full pipeline):
//   1. Dump the APK with tools/il2cpp-cli -> DummyDll/
//   2. Stage a Unity-style layout: <anything>/CIFI_Data/{level0, sharedassets0.assets,
//      globalgamemanagers, globalgamemanagers.assets, Managed/*.dll}
//      The *_Data folder name matters -- AssetRipper detects a Unity build by it.
//   3. AssetRipper --headless --port N, POST /LoadFolder, then POST /Export/UnityProject
//      NOT /Export/PrimaryContent: level0 is a SCENE, and scene contents do not appear in
//      "primary content" -- that one difference is why three earlier attempts exported zero.
//
//   node tools/bench/extract-loopmods.js <MainSceneNew.unity> [--write]
//
// The scene is ~177 MB, so this streams it rather than reading it whole.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const scenePath = process.argv[2];
if (!scenePath) { console.error('usage: extract-loopmods.js <scene.unity> [--write]'); process.exit(2); }
const write = process.argv.includes('--write');
const OUT = path.join(__dirname, '../reference/loop-mods.json');

// Serialized fields appear as "  LM<n><Field>: <value>" at a fixed indent inside the
// LoopModifiers MonoBehaviour block.
//
// TWO SHAPES, and missing the second one is what made the high-tier mods look cost-less on the
// first pass. Small numbers are plain scalars. Costs beyond double range -- and they go to 10^6200
// -- are a BigDouble serialized as a nested block:
//     LM264StartCost:
//       mantissa: 1
//       exponent: 2400
// Those exponents are exactly the "MP Cost (e)" column of cifi-tools' Loop Mod Overview, which is
// what makes the name mapping possible at all. Capture both.
const FIELD = /^\s{2}LM(Ouro)?(\d+)([A-Za-z0-9]+):\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$/;
const FIELD_OPEN = /^\s{2}LM(Ouro)?(\d+)([A-Za-z0-9]+):\s*$/;
const SUBFIELD = /^\s{4}(mantissa|exponent):\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$/;

const mods = new Map();
const ouro = new Map();

const rl = readline.createInterface({ input: fs.createReadStream(scenePath), crlfDelay: Infinity });

let pending = null; // a BigDouble block we are inside of

rl.on('line', (line) => {
  if (pending) {
    const sub = SUBFIELD.exec(line);
    if (sub) {
      pending.parts[sub[1]] = Number(sub[2]);
      if ('mantissa' in pending.parts && 'exponent' in pending.parts) {
        const { map, idx, field, parts } = pending;
        if (!map.has(idx)) map.set(idx, {});
        // Keep the exponent as its own key: it is the value the community overview publishes,
        // and 10^6200 is not representable as a JS number.
        map.get(idx)[field] = { mantissa: parts.mantissa, exponent: parts.exponent };
        map.get(idx)[`${field}E`] = parts.exponent;
        pending = null;
      }
      return;
    }
    pending = null; // block ended without both parts
  }

  const m = FIELD.exec(line);
  if (m) {
    const [, isOuro, idxRaw, field, valueRaw] = m;
    // UI wiring (Button, Icon, Text, Overlay...) is serialized alongside the data; those are
    // object references, not numbers, so they do not match the numeric value pattern.
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) return;
    const target = isOuro ? ouro : mods;
    const idx = Number(idxRaw);
    if (!target.has(idx)) target.set(idx, {});
    target.get(idx)[field] = value;
    return;
  }

  const open = FIELD_OPEN.exec(line);
  if (open) {
    const [, isOuro, idxRaw, field] = open;
    pending = { map: isOuro ? ouro : mods, idx: Number(idxRaw), field, parts: {} };
  }
});

rl.on('close', () => {
  const shape = (map) => Object.fromEntries([...map.entries()].sort((a, b) => a[0] - b[0]));
  const modObj = shape(mods);
  const ouroObj = shape(ouro);

  const fieldCounts = {};
  for (const rec of Object.values(modObj)) for (const f of Object.keys(rec)) fieldCounts[f] = (fieldCounts[f] || 0) + 1;

  console.log(`loop mods: ${Object.keys(modObj).length}   ouro mods: ${Object.keys(ouroObj).length}\n`);
  console.log('field coverage across loop mods:');
  for (const [f, n] of Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f.padEnd(26)} ${n}`);
  }

  const withCost = Object.entries(modObj).filter(([, r]) => r.StartCost !== undefined);
  console.log(`\n${withCost.length} mod(s) carry a StartCost. First few:`);
  for (const [idx, rec] of withCost.slice(0, 5)) {
    const bits = Object.entries(rec).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  LM${idx.padStart(3)}  ${bits.slice(0, 130)}`);
  }

  if (write) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify({
      generatedFrom: path.basename(scenePath),
      note: 'Generated by tools/bench/extract-loopmods.js from an AssetRipper Unity-project export. '
        + 'Do not hand-edit -- regenerate instead. Indices are the game\'s own LM<N>; the save stores '
        + 'levels under the same index as LM<N>Level. Display NAMES are runtime UI Text and are not here.',
      loopMods: modObj,
      ouroLoopMods: ouroObj,
    }, null, 1)}\n`);
    console.log(`\nwrote ${OUT}`);
  }
});
