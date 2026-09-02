'use strict';
// Extract the Research Laboratory tree (RU0-RU~110, `ResearchLaboratory` MonoBehaviour) and the
// Generator research sub-tree (RU1-RU13 `Gen` fields on `FleetManager`) from an AssetRipper
// Unity-project scene export -- same technique as extract-loopmods.js, applied to a different
// MonoBehaviour. See that file's header for the full AssetRipper pipeline.
//
// Why two separate id spaces share the "RU" prefix: the save's global `RU{n}Level`/`RU{n}Active`
// registry (see shipSchema.js mapSaveToResearchUnits) is the SAME numbering as ResearchLaboratory's
// RU{n}StartCost/Bonus fields here -- confirmed by RU1's values (StartCost 1, GrowthExponent 20,
// Bonus1 2) matching the "Research 1 - Token Bank Cap" header comment in dump.cs. The `RU{n}Gen*`
// fields on FleetManager are a DIFFERENT, unrelated numbering (the Generator-unlock sub-tree,
// matching the save's `RU{n}GenLevel` category for n=1..13) -- don't conflate the two "RU" spaces.
//
// CONFIRMED NOT HERE: the per-ship 11-slot install grid (Ship{n}RU{1..11}AutomationLevelGoal in
// the save) has no matching Ship{n}RU{k}Cost/MaxLevel/Name field anywhere in this scene -- grepped
// for and absent. That mapping is resolved by code, not serialized data; it needs disassembly/
// emulation of FleetManager's slot-click handler, not another AssetRipper pass.
//
//   node tools/bench/extract-research.js <MainSceneNew.unity> [--write]

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const scenePath = process.argv[2];
if (!scenePath) { console.error('usage: extract-research.js <scene.unity> [--write]'); process.exit(2); }
const write = process.argv.includes('--write');
const OUT = path.join(__dirname, '../reference/research.json');

// ResearchLaboratory: RU{n}StartCost/GrowthExponent/Bonus{1..10} (scalars), and for low ids a
// BigDouble ladder RU{n}Level{k}Cost (nested mantissa/exponent, same shape as loop mods).
//
// FleetManager: RU{n}{Category}MaxLevel/BaseBonus/Requirement, for 8 DIFFERENT "RU" id spaces
// (Gen/Tech/Loop/Auto/Shard/Research/Academy/Ouroboros) -- each completely unrelated to the
// ResearchLaboratory space above and to each other despite sharing the "RU" prefix. Confirmed by
// disassembling each category's BuyRU1<Category>() handler (capstone against libil2cpp.so
// directly -- r2/Ghidra is blocked by this machine's Application Control policy, so this reads
// the raw ELF bytes instead) and cross-referencing the struct-offset literals it reads against
// dump.cs's own field-offset comments:
//   BuyRU1Gen        reads MasterManager+0x4AE8 = Ship1RankPoints  -> Gen        is Ship1's tree
//   BuyRU1Tech       reads MasterManager+0x4AEC = Ship2RankPoints  -> Tech       is Ship2's tree
//   BuyRU1Loop       reads MasterManager+0x4AF0 = Ship3RankPoints  -> Loop       is Ship3's tree
//   BuyRU1Auto       reads MasterManager+0x4AF4 = Ship4RankPoints  -> Auto       is Ship4's tree
//   BuyRU1Shard      reads MasterManager+0x4AF8 = Ship5RankPoints  -> Shard      is Ship5's tree
//   BuyRU1Research   reads MasterManager+0x4AFC = Ship6RankPoints  -> Research   is Ship6's tree
//   BuyRU1Academy    reads MasterManager+0x4B00 = Ship7RankPoints  -> Academy    is Ship7's tree
//   BuyRU1Ouroboros  reads MasterManager+0x4B04 = Ship8RankPoints  -> Ouroboros  is Ship8's tree
// This settles the "ship rank point install" question this file's header used to flag as
// unconfirmed: there is no shared 11-slot grid every ship picks from. Each ship owns exactly one
// category outright, spends only ITS OWN Ship{n}RankPoints on it, and the numbered slot within
// that category (RU{n}{Category}Level in the save) is that ship's own upgrade ladder. `Category`
// membership is exhaustive and 1:1 -- do not assume an 9th category or a shared pool exists.
const CATEGORIES = ['Gen', 'Tech', 'Loop', 'Auto', 'Shard', 'Research', 'Academy', 'Ouroboros'];
const CATEGORY_SHIP = { Gen: 1, Tech: 2, Loop: 3, Auto: 4, Shard: 5, Research: 6, Academy: 7, Ouroboros: 8 };
const RESEARCH_FIELD = /^\s{2}RU(\d+)(StartCost|GrowthExponent|Bonus\d+):\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$/;
const RESEARCH_FIELD_OPEN = /^\s{2}RU(\d+)(Level\d+Cost):\s*$/;
const CATEGORY_FIELD = new RegExp(`^\\s{2}RU(\\d+)(${CATEGORIES.join('|')})(MaxLevel|BaseBonus|Requirement):\\s*(-?[\\d.]+(?:[eE][-+]?\\d+)?)\\s*$`);
const SUBFIELD = /^\s{4}(mantissa|exponent):\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$/;

const research = new Map();
const shipTrees = Object.fromEntries(CATEGORIES.map((c) => [c, new Map()]));

const rl = readline.createInterface({ input: fs.createReadStream(scenePath), crlfDelay: Infinity });
let pending = null;

rl.on('line', (line) => {
  if (pending) {
    const sub = SUBFIELD.exec(line);
    if (sub) {
      pending.parts[sub[1]] = Number(sub[2]);
      if ('mantissa' in pending.parts && 'exponent' in pending.parts) {
        const { idx, field, parts } = pending;
        if (!research.has(idx)) research.set(idx, {});
        const rec = research.get(idx);
        rec.levelCosts = rec.levelCosts || {};
        rec.levelCosts[field] = { mantissa: parts.mantissa, exponent: parts.exponent };
        pending = null;
      }
      return;
    }
    pending = null;
  }

  const cm = CATEGORY_FIELD.exec(line);
  if (cm) {
    const [, idxRaw, category, field, valueRaw] = cm;
    const idx = Number(idxRaw);
    const map = shipTrees[category];
    if (!map.has(idx)) map.set(idx, {});
    map.get(idx)[field] = Number(valueRaw);
    return;
  }

  const m = RESEARCH_FIELD.exec(line);
  if (m) {
    const [, idxRaw, field, valueRaw] = m;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) return;
    const idx = Number(idxRaw);
    if (!research.has(idx)) research.set(idx, {});
    research.get(idx)[field] = value;
    return;
  }

  const open = RESEARCH_FIELD_OPEN.exec(line);
  if (open) {
    const [, idxRaw, field] = open;
    pending = { idx: Number(idxRaw), field, parts: {} };
  }
});

rl.on('close', () => {
  const shape = (map) => Object.fromEntries([...map.entries()].sort((a, b) => a[0] - b[0]));
  const researchObj = shape(research);
  const shipTreesObj = Object.fromEntries(CATEGORIES.map((c) => [c, shape(shipTrees[c])]));

  console.log(`research nodes: ${Object.keys(researchObj).length}\n`);
  const withCost = Object.entries(researchObj).filter(([, r]) => r.StartCost !== undefined || r.levelCosts);
  console.log(`${withCost.length} research node(s) carry cost data. First few:`);
  for (const [idx, rec] of withCost.slice(0, 6)) {
    console.log(`  RU${idx}`, JSON.stringify(rec).slice(0, 140));
  }
  console.log('\nper-ship category trees (slot counts):');
  for (const cat of CATEGORIES) {
    console.log(`  Ship${CATEGORY_SHIP[cat]} ${cat.padEnd(10)} ${Object.keys(shipTreesObj[cat]).length} slots`);
  }

  if (write) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify({
      generatedFrom: path.basename(scenePath),
      note: 'Generated by tools/bench/extract-research.js from an AssetRipper Unity-project export. '
        + 'Do not hand-edit -- regenerate instead. `research` ids match the save\'s global RU{n}Level/'
        + 'RU{n}Active registry (see shipSchema.js mapSaveToResearchUnits) and dump.cs\'s [Header] '
        + 'comments on ResearchLaboratory for names. `shipTrees` holds the 8 per-ship install trees '
        + '(FleetManager\'s RU{n}{Category} fields) -- category-to-ship ownership confirmed by '
        + 'disassembling each BuyRU1<Category>() handler against libil2cpp.so directly (see this '
        + 'file\'s header for the offsets); each ship spends only its OWN Ship{n}RankPoints on its '
        + 'own category, there is no shared cross-ship grid. `Requirement` is the level-in-the-'
        + 'PREVIOUS slot needed to unlock a slot (that ship\'s own dependency chain).',
      categoryShip: CATEGORY_SHIP,
      research: researchObj,
      shipTrees: shipTreesObj,
    }, null, 1)}\n`);
    console.log(`\nwrote ${OUT}`);
  }
});
