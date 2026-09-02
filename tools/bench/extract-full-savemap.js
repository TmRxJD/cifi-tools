'use strict';
// Full save-field map: every field SaveData declares (dump.cs), cross-referenced against a real
// decoded save and grouped into named game systems.
//
// WHY THIS EXISTS
// ---------------
// Every prior save-mapping effort in this project (saveImport.js, shipSchema.js, save-coverage.js)
// is scoped to the ~63 fields THIS tool's optimizer/simulator actually consumes. That is the right
// scope for that job, but it means ~4400 other fields the save carries have never been inventoried
// anywhere -- which matters the moment someone wants to build a DIFFERENT tool (a Mech planner, a
// Mission/Campaign planner, a full account dashboard) against this same save format. This script
// builds that full inventory once, so a future tool starts from a map instead of a blank save file.
//
// METHOD
// ------
// SaveData (dump.cs, ~4640 lines) declares every field the save format has, by construction --
// it's the C# class the save JSON is a direct serialization of. Diffed against a real decoded save,
// 4466 of 4468 declared fields are present (the 2 missing are List<string> fields that apparently
// never get serialized non-empty) and there are ZERO save keys that aren't a declared SaveData
// field -- so this class list is a complete, exhaustive key space, not a sample.
//
// Fields are then grouped by NAME PATTERN into named game systems. Confidence varies a lot and is
// recorded per category:
//   - "confirmed": established by this project's own prior work (live-account diffs, disassembly,
//     cross-referencing the game's scene data or the live cifi-tools bundle) -- see saveImport.js,
//     shipSchema.js and CLAUDE.md for how each of these was actually verified.
//   - "identified": this session recognized the family and what game system it plausibly belongs to
//     by name alone (e.g. "Mech1Unlocked" -> the Mech Planner system) but did NOT verify individual
//     field meanings against a live account the way the confirmed categories were. Treat these as a
//     strong starting point for a new tool, not a verified mapping.
//   - "uncategorized": no pattern was recognized. ~14% of all fields land here -- mostly small,
//     idiosyncratic one-off families (debug flags, obscure counters) that weren't worth a bespoke
//     rule for a first pass. Read the raw name; several are self-explanatory even unmapped.
//
//   node tools/bench/extract-full-savemap.js [--write]

const fs = require('fs');
const path = require('path');

const DUMP_CS = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join('C:/Users/jdion/Projects/CIFI/apk_extract/il2cpp-dump-out/dump.cs');
const SAMPLE_SAVE = path.join(__dirname, '../../bridge/test-fixtures/sample-save-decoded.json');
const OUT = path.join(__dirname, '../reference/save-full-map.json');
const write = process.argv.includes('--write');

const dumpLines = fs.readFileSync(DUMP_CS, 'utf8').split('\n');
const classStart = dumpLines.findIndex((l) => /^public class SaveData\b/.test(l));
if (classStart === -1) throw new Error('SaveData class not found in dump.cs -- has the dump format changed?');
let classEnd = dumpLines.findIndex((l, i) => i > classStart && /^(public|internal)( sealed)? class /.test(l));
if (classEnd === -1) classEnd = dumpLines.length;

const FIELD_RE = /^\s*(?:public|private|internal|protected)\s+(?:static\s+)?([\w<>[\],. ]+?)\s+(\w+);\s*\/\/\s*(0x[0-9A-Fa-f]+)\s*$/;
const fields = [];
for (let i = classStart; i < classEnd; i++) {
  const m = FIELD_RE.exec(dumpLines[i]);
  if (m) fields.push({ type: m[1].trim(), name: m[2], offset: m[3] });
}

const save = JSON.parse(fs.readFileSync(SAMPLE_SAVE, 'utf8'));
const saveKeys = new Set(Object.keys(save));
let present = 0;
for (const f of fields) {
  f.inSample = saveKeys.has(f.name);
  if (f.inSample) {
    present += 1;
    const v = save[f.name];
    f.sampleValue = typeof v === 'object' && v !== null
      ? (Array.isArray(v) ? `[array len ${v.length}]` : JSON.stringify(v).slice(0, 60))
      : v;
  }
}
const fieldNames = new Set(fields.map((f) => f.name));
const extraSaveKeys = [...saveKeys].filter((k) => !fieldNames.has(k));

// Ordered [category, confidence, regex, description] -- first match wins.
const RULES = [
  ['hunter.borge', 'confirmed', /^Borge(?!.*Ability)/, 'Level/stage/talents (Skill{n}Level)/attributes(POM{n}Level)/base stats(Upgrade{Stat}Level)/highest-run stats -- see saveImport.js'],
  ['hunter.ozzy', 'confirmed', /^Ozzy/, 'Same shape as Borge -- talents via POI{n}, see saveImport.js'],
  ['hunter.knox', 'confirmed', /^Knox/, 'Same shape as Borge -- talents via POK{n}, see saveImport.js'],
  ['hunter.attributes_prefixed', 'confirmed', /^PO[MIK]\d+Level$/, 'Attribute levels, caught here since the name doesn\'t start with the hunter\'s own name -- see saveImport.js HUNTER_ATTR_ORDER'],
  ['hunter.vexin', 'identified', /^Vexin/, 'A 4th hunter not in this tool\'s HUNTER_DEFS -- same field shape as Borge/Ozzy/Knox, likely unreleased or very new content'],
  ['relics', 'confirmed', /^AOR\d+|^AORTier2/, 'Relics tier1 (AOR{n}Level) + tier2 (AORTier2Levels[]) -- see saveImport.js'],
  ['inscryptions', 'confirmed', /^IS\d+/, 'IS{slot}Level + IS{slot}IDText -- slot<->display-id bijection, see saveImport.js INSCRYPTION_SLOT'],
  ['gems', 'confirmed', /QualityLevel$|GemNode\d*Level|GemNodeLevels$/, 'Gem trees: {Tree}QualityLevel + 6 nodes each -- see saveImport.js GEM_TREE_SAVE_PREFIX'],
  ['gems.gu', 'identified', /GU\d*/, 'Gem-tree "GU" named-upgrade fields -- CLAUDE.md flags the per-tree index order as unconfirmed'],
  ['gadgets', 'confirmed', /^Gadget\d+Level$/, 'Wrench/Zaptron/Anchor/etc -- see saveImport.js GADGET_SAVE_INDEX'],
  ['diamondspecials', 'confirmed', /^DU\d+/, 'DiamondShop DU{n}Level slots -- see saveImport.js DIAMOND_SPECIAL_SLOT'],
  ['diamondcards', 'confirmed', /CardPurchased$/, 'One-time diamond cards -- see saveImport.js (Gaiden/Iridian confirmed; other Greek-letter cards identified by name only)'],
  ['ultima', 'confirmed', /^DiamondUltima/, 'Diamond Ultima -- see saveImport.js'],
  ['milestones.construction', 'confirmed', /^Milestone\d+Acquired$/, 'Construction Milestones (cm{n}) -- see saveImport.js CM_IDS'],
  ['milestones.variants', 'identified', /^Milestone(?!s)\w*(Progress|List|Goal)/i, 'Milestone progress/list/goal variants alongside the plain Acquired flags'],
  ['milestones.cm_flag', 'confirmed', /^CM\d+$/, 'Boolean family, NOT the same as Milestone<N>Acquired -- confirmed to be a claim/notification flag, deliberately unused'],
  ['shardmilestones', 'confirmed', /^SU\d+/, 'Shard-upgrade registry, separate 0-indexed family -- see saveImport.js (only m0/SU0Level wired so far)'],
  ['research.global', 'confirmed', /^RU\d+(Level|Active|CurrentDrain|AcademyLevel|AutoLevel|GenLevel|LoopLevel|OuroborosLevel|ResearchLevel|ShardLevel|TechLevel)$/, 'Research Laboratory registry (RU0-~110) + the 8 per-ship category sub-trees -- see shipSchema.js + tools/reference/research.json'],
  ['research.ultima_units', 'identified', /^URU\d+/, 'A separate "Ultima Research" registry from the main RU family'],
  ['ships.core', 'confirmed', /^Ship\d+(Rank|RankPoints|RankProgress|RankThisTR|Unlocked|FirstUnlocked|FirstUnlockStat|OuroUnlock|CrewLevel|CrewAutomation|EvoLevel|EvoAutomationOn|UnlockAutomationOn)/, 'Ship rank/crew/evo core state -- see shipSchema.js'],
  ['ships.ru_goal', 'confirmed', /^Ship\d+(Applied)?RU\d+AutomationLevelGoal$/, 'Ship auto-buy TARGET setting, NOT the real install level -- see shipSchema.js'],
  ['ships.loadout', 'confirmed', /^Ship\d+Loadout/, 'Gear-piece loadout slot assignment -- see shipsPage.js'],
  ['ships.tutorial', 'identified', /^Ship\d+(UnlockTutorial|Respec)/, 'Ship-specific UI/tutorial flags'],
  ['fleet.generators', 'confirmed', /^MK\d+(UnlockedBool|AutomationPurchased)$/, 'Generator tier unlock/automation flags -- see shipSchema.js mapSaveToUnlockedGens'],
  ['fleet.generators_named', 'identified', /^(Alpha|Beta|Gamme|Delta|Epsilon|Sigma|Utopia|Typhon|Nora|Lyra|Ixion|Helion|Qoru)MK\d*|^LoopMK\d+/, 'Named higher-tier generator slots beyond MK1-8 (codenames) + LoopMK unlock flags'],
  ['fleet.generators_traversal', 'identified', /^(CellGenerators)?MK\d+(UnlockedThisLoop|Level|ManualLastLoop|LastLoop)/, 'Per-generator-tier traversal/loop stat trackers'],
  ['fleet.gear', 'confirmed', /Item\d+Level$|Item\d+Unlocked$/, '22 real gear pieces ({Color}Item{n}Level) -- see shipSchema.js mapSaveToGearLevels'],
  ['fleet.badges', 'confirmed', /^(Dark)?Badge\d+Acquired$/, 'Academy / Dark Academy badges -- see shipSchema.js mapSaveToFleetBadges'],
  ['fleet.tech', 'confirmed', /^TU\d+/, 'Hardware/Software pairs per generator tier + traversal trackers -- see shipSchema.js mapSaveToShipGear'],
  ['fleet.tech_variants', 'identified', /^Tech\w*/, 'Tech-Upgrade-adjacent fields not matching the TU{n} numbering directly'],
  ['fleet.atu_tuq_udu', 'identified', /^ATU\d+|^TUQ\d+|^UDU\d+/, 'Three more upgrade-tree families named in the game\'s own scene data (scene-defs.json) alongside RU/MK/Project -- not otherwise mapped'],
  ['fleet.shard_mining', 'identified', /^SMPhase\d+/, 'Shard Mining phases (FleetManager references a "ShardMining SM" component)'],
  ['fleet.hq', 'identified', /^HQ\d+/, 'Hunters Headquarters levels'],
  ['loopmods.base', 'confirmed', /^LM\d+/, '295-mod base tree -- see tools/reference/loop-mods.json + loopmod-names.json (39 of 295 have a confirmed display name)'],
  ['loopmods.ouro', 'confirmed', /^LMOuro\d+/, '39-mod Ouroboros-tier tree -- see tools/reference/loop-mods.json'],
  ['trinkets', 'confirmed', /^T\d+F(Level|Tier)$/, 'Galvarium Trinkets -- see saveImport.js TRINKET_SAVE_FIELD (T1F-T3F wired; T4F/T5F present in the class but likely unreleased)'],
  ['iap.purchased', 'identified', /Purchased$/, 'One-time IAP/device purchase flags -- see saveImport.js (only OuroDevicePurchased/travpack confirmed by disassembly; the rest identified by name only)'],
  ['fragments', 'confirmed', /^RelicFragments$/, 'Current balance only (BigDouble) -- rate is not persisted, see saveImport.js'],
  ['mech', 'identified', /^Mech\d+|^FinalMech/, 'Mech Planner system (cifi-tools has a dedicated tool for this) -- not mapped by this project at all yet'],
  ['mech.gear', 'identified', /^MG\d+/, 'Mech Gear / auto-upgrade slots'],
  ['projects', 'identified', /^Project(s)?\d*/, 'Construction Projects'],
  ['missions.campaign', 'identified', /^(Wasta|Sekhur|Egetuar|Cryton|KarsonKrax|Delmakiar)/, '6 named Campaign/Mission planet destinations, each with Mission/Campaign/Farm/CampaignPersonnel sub-fields'],
  ['missions.personnel', 'identified', /^MissionPersonnel\d+/, 'Personnel assigned to missions'],
  ['missions.personnel_extra', 'identified', /personnel|Personnel|legacyStudiesSinceTR/, 'More mission-personnel bookkeeping (retention, focus)'],
  ['missions.vexin', 'identified', /^VexinSkill/, 'Skill tree tied to the Vexin hunter/personnel system'],
  ['rewards.daily', 'identified', /^DailyGift|^Token|^Cube\d+|^Expansion/, 'Daily login gifts / token shop / cube rewards / expansions'],
  ['rewards.presents', 'identified', /Presents|PresentsClaim/i, 'Daily "presents" gift variants (Token/Mixed/Diamond)'],
  ['rewards.trades', 'identified', /^(NecrumR|EsotericR)\d+/, 'Named trade-resource counters -- likely a Mission/Campaign reward-exchange system'],
  ['ads', 'identified', /^BoosterAdPhase|AdCount$|AdTokens/, 'Rewarded-ad booster/token bookkeeping'],
  ['minigame.arcade', 'identified', /^arcade/i, 'Arcade minigame state (lowercase-first naming -- likely a nested serialized dictionary; ArcadeDATA.json is referenced in the binary)'],
  ['achievements', 'identified', /^Achievement/, 'Achievement progress/level counters, one family per achievement type'],
  ['events.cellmas', 'identified', /Cellmass?/, 'Seasonal "Cellmas" event milestones/rewards'],
  ['stats.currencies', 'confirmed', /^(Cells|Shards|ResearchPoints|ModPoints|AcademyPoints|OuroborosPoints|DNAPoints|ContractorPoints)$/, 'Top-level currency balances (BigDouble)'],
  ['stats.traversal_loop', 'identified', /ThisTraversal$|LastTraversal$|ThisLoop$|LastLoop$|ThisConstruction$|LastConstruction$|AllTime$/, 'Per-run/per-reset progress trackers -- "Traversal" is this game\'s own term for a Loop Reset'],
  ['ui.tutorial_flags', 'identified', /TutorialActive$|TutorialDone$|^First\w+Open$|^First\w+Check$/, 'One-time tutorial/first-open UI flags, not game state'],
  ['ui.onetime_checks', 'identified', /^OneTime\w*Check$|^First\w+(Name)?$/, 'One-time migration/animation/UI-seen checks'],
  ['system.online', 'identified', /^Online_/, 'Online/cloud-save bookkeeping'],
  ['system.debug_test', 'identified', /^(wipeMyData|isTesting|InitializeTesting|WasAutoDeleted|Backup|AllTimeHighResetter)$/i, 'Debug/testing/backup-system flags, not real game state'],
  ['system.misc_debug', 'identified', /^OfflineCalcDebugging$|^OneTimeMPReset$|^FreshOuro1$/, 'One-off debug/migration flags'],
];

function categorize(name) {
  for (const [cat, confidence, re] of RULES) {
    if (re.test(name)) return { cat, confidence };
  }
  return { cat: 'uncategorized', confidence: 'none' };
}

const categories = {};
for (const f of fields) {
  const { cat, confidence } = categorize(f.name);
  if (!categories[cat]) {
    const rule = RULES.find((r) => r[0] === cat);
    categories[cat] = { confidence, description: rule ? rule[3] : 'No pattern recognized this pass.', fields: [] };
  }
  categories[cat].fields.push(f);
}

const summary = Object.entries(categories)
  .map(([cat, v]) => ({ category: cat, confidence: v.confidence, count: v.fields.length, description: v.description }))
  .sort((a, b) => b.count - a.count);

console.log(`SaveData: ${fields.length} declared fields, ${present} present in the sample save, ${extraSaveKeys.length} sample keys not found as a declared field\n`);
for (const s of summary) console.log(`${String(s.count).padStart(5)}  [${s.confidence.padEnd(11)}] ${s.category}`);
console.log(`\ntotal: ${fields.length}  uncategorized: ${(categories.uncategorized || { fields: [] }).fields.length}`);

if (write) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({
    generatedFrom: 'dump.cs SaveData class + bridge/test-fixtures/sample-save-decoded.json',
    note: 'Generated by tools/bench/extract-full-savemap.js. Do not hand-edit -- regenerate instead. '
      + 'This is the FULL save field inventory (4468 declared fields), not the ~63 this tool\'s '
      + 'optimizer/simulator actually consumes (see saveImport.js/shipSchema.js for that narrower, '
      + 'load-bearing map). `confidence: "confirmed"` categories are established by this project\'s '
      + 'own prior verified work; `"identified"` categories are this session\'s best read of a name '
      + 'pattern, NOT verified against a live account -- treat them as a starting point for a new '
      + 'tool, not a finished mapping. `extraSaveKeys` lists any real-save key with no declared '
      + 'SaveData field (should be empty; a non-empty list means the dump and the save are from '
      + 'different game versions).',
    fieldCount: fields.length,
    presentInSample: present,
    extraSaveKeys,
    summary,
    categories,
  }, null, 1)}\n`);
  console.log(`\nwrote ${OUT}`);
}
