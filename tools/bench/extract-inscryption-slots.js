'use strict';
// Recover the inscryption DISPLAY id -> save-slot mapping from the game's own scene.
//
// The save stores inscryption levels as `IS<slot>Level`, but the slot is NOT the number the game
// (and this app) shows as "Inscryption #N". An earlier mapping assumed a uniform +12 offset,
// inferred from five consecutive values matching on one account. That inference was right for the
// range it was drawn from and wrong everywhere else.
//
// The scene settles it without inference. Each shop row is a GameObject named
// `ChrystosEmporiumUpgrade<slot>` and, for every row the developers renamed, the name carries the
// displayed id too: `ChrystosEmporiumUpgrade72-ID60` means slot 72 shows as "#60". The slot number
// is confirmed independently by the MultiverseMarket component's own `IS<slot>IDText` reference
// pointing at that row's IDText child, so the two halves of each pair are cross-checked rather
// than parsed out of one string.
//
// This corroborates the original empirical finding exactly -- slots 69..74 display as #57..#62,
// which is the five-for-five value match that produced the +12 rule -- while showing that slots
// 75..110 display as #75..#110, i.e. no offset at all.
//
//   node tools/bench/extract-inscryption-slots.js <MainSceneNew.unity> [--write]
//
// See tools/il2cpp-cli/README.md for how to produce the scene. It is ~177 MB, so this streams it.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const scenePath = process.argv[2];
if (!scenePath) {
  console.error('usage: extract-inscryption-slots.js <scene.unity> [--write]');
  process.exit(2);
}
const write = process.argv.includes('--write');
const OUT = path.join(__dirname, '../reference/inscryption-slots.json');

const goName = new Map();     // GameObject fileID -> name
const trGO = new Map();       // Transform fileID -> GameObject fileID
const trOf = new Map();       // GameObject fileID -> Transform fileID
const trFather = new Map();   // Transform fileID -> parent Transform fileID
const mbGO = new Map();       // MonoBehaviour fileID -> GameObject fileID
const idTextRef = new Map();  // slot -> IDText MonoBehaviour fileID

let type = null;
let id = null;

const rl = readline.createInterface({ input: fs.createReadStream(scenePath), crlfDelay: Infinity });
rl.on('line', (line) => {
  let m = /^--- !u!(\d+) &(\d+)/.exec(line);
  if (m) { type = m[1]; id = Number(m[2]); return; }

  if (type === '1') {
    m = /^  m_Name: (.*)$/.exec(line);
    if (m) goName.set(id, m[1].trim());
    return;
  }
  // 4 = Transform, 224 = RectTransform. UI rows are RectTransforms.
  if (type === '4' || type === '224') {
    m = /^  m_GameObject: \{fileID: (\d+)\}/.exec(line);
    if (m) { trGO.set(id, Number(m[1])); trOf.set(Number(m[1]), id); return; }
    m = /^  m_Father: \{fileID: (\d+)\}/.exec(line);
    if (m) trFather.set(id, Number(m[1]));
    return;
  }
  if (type === '114') {
    m = /^  m_GameObject: \{fileID: (\d+)\}/.exec(line);
    if (m) { mbGO.set(id, Number(m[1])); return; }
    // MultiverseMarket's own wiring: which row object each slot's IDText lives on.
    m = /^  IS(\d+)IDText: \{fileID: (\d+)\}/.exec(line);
    if (m) idTextRef.set(Number(m[1]), Number(m[2]));
  }
});

rl.on('close', () => {
  const parentNameOf = (go) => {
    const t = trOf.get(go);
    if (t === undefined) return null;
    const f = trFather.get(t);
    if (f === undefined) return null;
    return goName.get(trGO.get(f)) ?? null;
  };

  const proven = {};   // displayed id -> slot
  const rows = [];
  let mismatched = 0;

  for (const [slot, mb] of [...idTextRef.entries()].sort((a, b) => a[0] - b[0])) {
    const go = mbGO.get(mb);
    const parent = go === undefined ? null : parentNameOf(go);
    const slotInName = parent && /Upgrade(\d+)/.exec(parent);
    const displayed = parent && /-ID(\d+)/.exec(parent);

    // Cross-check: the component says this is slot N, the row is named ...Upgrade<N>. If those
    // disagree the scene is not what we think it is, so refuse the row rather than trust it.
    if (slotInName && Number(slotInName[1]) !== slot) { mismatched++; continue; }

    rows.push({ slot, parent, displayed: displayed ? Number(displayed[1]) : null });
    if (displayed) proven[Number(displayed[1])] = slot;
  }

  const provenIds = Object.keys(proven).map(Number).sort((a, b) => a - b);
  console.log(`${rows.length} shop rows resolved, ${provenIds.length} carry an explicit -ID<n>`);
  if (mismatched) console.log(`${mismatched} row(s) rejected: component slot disagreed with the row name`);

  // Report the offsets present, grouped into runs -- this is the finding, so make it visible.
  const runs = [];
  for (const d of provenIds) {
    const off = proven[d] - d;
    const last = runs[runs.length - 1];
    if (last && last.off === off && d === last.to + 1) last.to = d;
    else runs.push({ from: d, to: d, off });
  }
  console.log('\ndisplayed id range   slot = displayed +');
  for (const r of runs) console.log(`  #${r.from}-#${r.to}`.padEnd(21), r.off);

  if (write) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify({
      generatedFrom: path.basename(scenePath),
      note: 'Generated by tools/bench/extract-inscryption-slots.js. Do not hand-edit -- regenerate. '
        + 'Maps the inscryption number the game DISPLAYS ("Inscryption #N") to the save field '
        + '`IS<slot>Level`. Only rows the developers renamed with an -ID<n> suffix are listed: those '
        + 'are proven. Rows without the suffix are omitted rather than guessed -- their slot is '
        + 'genuinely unknown, and a guess here silently imports another inscryption\'s level.',
      provenDisplayedToSlot: proven,
      unnamedSlots: rows.filter((r) => r.displayed === null).map((r) => r.slot),
    }, null, 1)}\n`);
    console.log(`\nwrote ${OUT}`);
  }
});
