'use strict';
// Zod schemas for the game-derived reference files under tools/reference/.
//
// WHY ZOD, AND WHERE IT RUNS. The shipped webapp deliberately has no build step -- it loads plain
// files through <script> tags -- so zod is a DEV dependency used by the Node benches only. Nothing
// here reaches the browser. That keeps the property this project values (no bundler) while still
// getting real schema enforcement exactly where drift has actually bitten: the extracted reference
// files that a dozen benches read.
//
// The failure mode these prevent is specific and has happened repeatedly during this work: an
// extractor changes shape, a consumer reads `undefined`, and the bench PASSES because `undefined`
// compares equal to the other side's `undefined`. A silently empty reference looks exactly like a
// clean run. Parsing every file before use turns that into a loud failure at a named path.
//
// Each schema is `.strict()` where the shape is fully known, so an ADDED field also fails -- a new
// key usually means the extractor learned something the consumers have not been taught to read.

const { z } = require('zod');

// Provenance every extracted file carries: what it came from, and which build.
const meta = {
  _source: z.string().min(1),
  _meaning: z.string().min(1).optional(),
  _game: z.string().min(1),
};
const numericKey = z.string().regex(/^\d+$/, 'expected a numeric id as the key');

// A record that must not be EMPTY. This is the whole point of parsing these files: an extractor
// that silently produces `{}` is the exact failure mode zod is here to catch, and a bare
// z.record() accepts it happily -- a first pass at these schemas did, and the negative control
// for "silently empty payload" passed when it should have failed.
const nonEmptyRecord = (key, value) => z.record(key, value)
  .refine((o) => Object.keys(o).length > 0, { message: 'is empty -- the extractor produced nothing' });

// A BigDouble as the game serialises it: 16 bytes, a double mantissa then an int64 exponent.
const bigDouble = z.object({ mantissa: z.number(), exponent: z.number().int() }).strict();

// Provenance as the SCRIPTED extractors spell it. Files written by the Python/typetree tools use
// `_source`/`_game`; those written by the JS scene extractors use `generatedFrom`/`note`. Both are
// real conventions in this repo, so both are declared rather than one being retrofitted onto the
// other -- renaming a field in a generated file just to satisfy a schema would put the schema in
// charge of the data instead of the other way round.
const generatedMeta = {
  generatedFrom: z.string().min(1),
  note: z.string().min(1),
};

// A BigDouble as the game serialises it, in the flattened form the extractors emit.
const bigDoublePair = z.object({ mantissa: z.number(), exponent: z.number() }).strict();

// A number that must actually be finite. NaN and Infinity do not survive JSON, but a mis-parsed
// BigDouble can still land as null or a string, and this makes that intent explicit where it
// matters rather than leaving a bare z.number().
const finite = z.number().finite();

const schemas = {
  'badge-map.json': z.object({
    ...meta,
    // category -> the badges EVERY node of that category multiplies in
    perCategory: nonEmptyRecord(z.string(), z.array(z.string().regex(/^(Dark)?Badge\d+$/))),
    // badge -> the TECH POOL chains that read it. A second, differently-shaped kind of badge:
    // these multiply Tech Software / Tech Hardware output rather than a ship's rank installs, so
    // a per-ship scan cannot see them -- which is how Badge3, a 7.7e14 multiplier on tech output,
    // went unmodelled. Required and non-empty: the game reads one, and an empty section here would
    // mean the extractor stopped finding it.
    techPools: nonEmptyRecord(
      z.string().regex(/^(Dark)?Badge\d+$/),
      z.array(z.string().min(1)).min(1),
    ),
    values: nonEmptyRecord(z.string(), z.number().positive()),
  }).strict(),

  // Tier-2 relic caps come from ScriptableObjects, not from a MonoBehaviour field, so this file is
  // parsed by a bespoke offset reader rather than typetree.py. That makes a silent shape drift more
  // likely here than anywhere else -- a BigDouble read at the wrong offset yields a real-looking
  // number, never an error -- so the value bounds below are part of the check, not decoration.
  'relic-tier2.json': z.object({
    ...meta,
    _crossCheck: z.string().min(1),
    relics: nonEmptyRecord(z.string().regex(/^t2r\d+$/), z.object({
      startCost: bigDouble,
      additiveCostIncrease: bigDouble,
      costExponent: bigDouble,
      baseMaxLevel: bigDouble,
      bonusPerLevel1: bigDouble,
      bonusPerLevel2: bigDouble,
      // the cap CheckRelicMaxLevel() enforces; a 0 or a fraction means the parse drifted
      maxLevel: z.number().int().min(1).max(1000),
    }).strict()),
  }).strict(),

  'node-factors.json': z.object({
    ...meta,
    factors: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.array(z.string().min(1)))),
  }).strict(),

  'ship-node-counters.json': z.object({
    ...meta,
    counters: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.array(z.string().min(1)))),
  }).strict(),

  'ship-node-gates.json': z.object({
    ...meta,
    _semanticsFrom: z.string().min(1),
    categories: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.object({
      // a requirement of 0 means "open from the start"; a cap must be a positive count
      requirement: z.number().nonnegative(),
      maxLevel: z.number().int().nonnegative(),
    }).strict())),
  }).strict(),

  'ship-node-names.json': z.object({
    ...meta,
    panels: nonEmptyRecord(z.string(), nonEmptyRecord(numericKey, z.object({
      Title: z.string().min(1),
      LevelText: z.string().optional(),
      unlockText: z.string().optional(),
    }).passthrough())),
  }).strict(),

  'uniform-node-terms.json': z.object({
    ...meta,
    terms: nonEmptyRecord(z.string(), z.object({
      type: z.string().min(1),
      levelField: z.string().min(1),
      found: z.boolean(),
      // null is a real, meaningful value here: "no level gate found, so undeterminable" -- and it
      // must never be collapsed into false. See extract-uniform-terms.py.
      inertWhenUnowned: z.boolean().nullable(),
    }).strict()),
  }).strict(),

  'gear-install-map.json': z.object({
    ...meta,
    mappings: z.array(z.object({
      category: z.string().min(1),
      node: z.number().int().positive(),
      color: z.string().min(1),
      item: z.number().int().positive(),
      bonus: z.union([z.literal(1), z.literal(2)]),
    }).strict()).min(1),
  }).strict(),

  'gear-names.json': z.object({
    ...meta,
    rows: z.array(z.object({
      index: z.number().int().nonnegative(),
      name: z.string().min(1),
      gemGate: z.string().nullable(),
      quality: z.number().int().positive().nullable(),
      unlockText: z.string().optional(),
    }).strict()).min(1),
  }).strict(),

  'gear-set-bonus-map.json': z.object({
    _source: z.string().min(1),
    _meaning: z.string().min(1),
    // this file's two halves can legitimately come from different builds, so it records both
    _mappingFrom: z.string().min(1),
    _valuesFrom: z.string().min(1),
    unusedBonuses: z.array(z.object({
      name: z.string().min(1),
      value: z.number(),
    }).strict()),
    mappings: z.array(z.object({
      color: z.string().min(1),
      index: z.number().int().positive(),
      resource: z.string().min(1),
      resourceLabel: z.string().min(1),
      value: z.number(),
    }).strict()).min(1),
  }).strict(),
  // ---------------------------------------------------------------------------------------------
  // Authored game data
  // ---------------------------------------------------------------------------------------------

  // Flat name -> value per class. The MAGNITUDES are deliberately unconstrained: this file carries
  // everything from 0.0012 to 5e400, so any bound would be a guess about game balance rather than
  // a schema. What is enforced is that every class is non-empty and every value is either a finite
  // number or an unflattened BigDouble -- not the null/string/object shapes a broken typetree read
  // produces.
  //
  // The BigDouble case is REAL, not a leftover: `FleetManager.EvoBonusHephaestus5` is 1e500, which
  // overflows a JavaScript double, so the extractor keeps it as {mantissa, exponent} rather than
  // flattening it to Infinity. A schema demanding a plain number here would be demanding the
  // extractor throw information away.
  'authored-values.json': z.object({
    ...meta,
    _note: z.string().min(1),
    classes: nonEmptyRecord(
      z.string().min(1),
      nonEmptyRecord(z.string().min(1), z.union([finite, bigDoublePair])),
    ),
  }).strict(),

  // The attribute dependency tree, recovered from HuntersAttributes.CheckPOMUnlcoks(). Keys are
  // the GAME's own POM/POI/POK indices, not our attribute ids -- attribute-tree-check.js joins the
  // two by tree shape. All three hunters are required: a hunter silently dropping out of this file
  // would leave its legality model unverified while the bench still reported a pass for the others.
  'attribute-tree.json': z.object({
    ...meta,
    _meaning: z.string().min(1),
    edges: z.object({
      borge: nonEmptyRecord(numericKey, z.array(z.number().int().nonnegative()).min(1)),
      ozzy: nonEmptyRecord(numericKey, z.array(z.number().int().nonnegative()).min(1)),
      knox: nonEmptyRecord(numericKey, z.array(z.number().int().nonnegative()).min(1)),
    }).strict(),
    _thresholdSource: z.string().min(1),
    // Tier gates: total points spent before a node opens. Knox's is legitimately EMPTY -- it has
    // no tier gates at all -- so this is a plain record, not a nonEmptyRecord. Every value must be
    // a positive integer: a 0 threshold is no gate, and recording one would be recording nothing.
    spendThresholds: z.object({
      borge: z.record(numericKey, z.number().int().positive()),
      ozzy: z.record(numericKey, z.number().int().positive()),
      knox: z.record(numericKey, z.number().int().positive()),
    }).strict(),
  }).strict(),

  // The cap-raise audit. `unreleasedSlots` is where a future build's new content shows up, so its
  // values are `nullable` rather than optional: a slot the extractor could not read must arrive as
  // an explicit null, not vanish -- a missing key would silently shrink the tripwire set.
  'cap-raises.json': z.object({
    ...meta,
    _meaning: z.string().min(1),
    _unreleasedMeaning: z.string().min(1),
    raisable: nonEmptyRecord(z.string().regex(/^Final.*MaxLevel/), z.object({
      class: z.string().min(1),
      operands: z.array(z.string().min(1)).min(1),
    }).strict()),
    allFinalMaxLevelNames: z.array(z.string().min(1)).min(1),
    unreleasedSlots: nonEmptyRecord(z.string().min(1), z.object({
      maxLevel: z.number().nullable(),
      baseBonus: z.number().nullable(),
    }).strict()),
  }).strict(),

  // Which production pools read each install node's bonus -- the node's true resource set.
  // An EMPTY array is meaningful and must stay allowed: direct Cells/Shards/RP boosters and
  // amplifiers have no *Production consumer, and node-resource-check.js relies on being able to
  // tell "no consumer" apart from "not extracted". The whole record must not be empty, though --
  // that would mean the extractor read nothing and every comparison silently passed.
  'node-resources.json': z.object({
    ...meta,
    _meaning: z.string().min(1),
    productionConsumers: nonEmptyRecord(
      z.enum(['Gen', 'Tech', 'Loop', 'Auto', 'Shard', 'Research', 'Academy']),
      nonEmptyRecord(numericKey, z.object({
        // Empty ONLY for an amplifier; the extractor refuses to emit a node that is neither, so a
        // node with no resources and amplifier:false cannot reach this file.
        resources: z.array(z.string().min(1)),
        amplifier: z.boolean(),
        // "Class.Member" for each consumer the resource set was derived from. Never empty: a node
        // with no classified consumer is exactly the unverified state this whole file exists to
        // rule out.
        consumers: z.array(z.string().regex(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/)).min(1),
      }).strict().refine(
        (v) => v.amplifier || v.resources.length > 0,
        { message: 'a node must resolve to a resource set or be flagged as an amplifier' },
      )),
    ),
  }).strict(),

  'gem-gates.json': z.object({
    ...generatedMeta,
    entries: z.array(z.object({
      id: z.string().min(1),
      // null on any of these means the bundle declared no such text for the entry, which is a real
      // state rather than a gap -- several gated entries carry an id and a gate and nothing else.
      name: z.string().nullable(),
      label: z.string().nullable(),
      category: z.string().nullable(),
      description: z.string().nullable(),
      gem: z.string().min(1),
      // which bundle construct the tree was recovered from, when it was not stated outright
      treeResolvedFrom: z.string().optional(),
      // a gate's level is never 0: a level-0 requirement is no gate at all
      level: z.number().int().positive(),
      treeKnown: z.boolean(),
      // the second half of a gate, present only on the entries that need a specific gem node
      node: z.number().int().positive().optional(),
    }).strict()).min(1),
  }).strict(),

  'gem-trees.json': z.object({
    ...generatedMeta,
    plannerIdToSimParam: nonEmptyRecord(z.string().min(1), z.string().min(1)),
    trees: nonEmptyRecord(z.string().min(1), z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      maxLevel: z.number().int().positive(),
      color: z.object({
        primary: z.string().min(1),
        secondary: z.string().min(1),
        gradient: z.string().min(1),
      }).strict(),
      // A null cost is a declared-but-UNRELEASED quality level -- Evolution declares levels the
      // game does not sell yet. Same meaning as a null gemNode cost below, and the same reason it
      // must not be coerced to 0: a 0 would read as "free", the silent-zero trap this repo has
      // been bitten by on relic costs.
      qualityCosts: z.array(z.object({
        level: z.number().int().positive(),
        cost: z.number().nonnegative().nullable(),
      }).strict()).min(1),
      // Structure confirmed against the game's own metadata: 7 trees x 6 nodes. A null cost is a
      // declared-but-unreleased node, which gem-tree-test.js asserts sits above the tree's cap.
      gemNodes: z.array(z.object({
        node: z.number().int().min(1).max(6),
        cost: z.number().nullable(),
        unlockRequirement: z.string().nullable().optional(),
      }).strict()).length(6),
      // The upgrade rows are not uniform, and the variation is the bundle's own. `weight` is a
      // resource NAME on a plain resource upgrade ("Cells"), a flat NUMBER on an additive one
      // (bonus-blueprints: 500), and an empty object on a per-ship upgrade that carries `resource`
      // and `effects` instead (cradle-bonus). Declaring the union keeps the schema honest about a
      // shape the site really has; collapsing it to one type would mean the schema disagreeing
      // with the data it validates.
      upgrades: z.array(z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        weight: z.union([z.string().min(1), z.number(), z.record(z.string(), z.unknown())]).optional(),
        baseCost: z.number().nonnegative(),
        costMultiplier: z.number().positive(),
        maxLevel: z.number().int().positive(),
        color: z.string().min(1),
        unlock: z.number().int().nonnegative(),
        // absent where an upgrade's cost curve has no step-ups at all
        costBumps: z.array(z.object({
          startLevel: z.number().int().nonnegative(),
          multiplier: z.number(),
        }).strict()).optional(),
        multiplier: z.record(z.string(), z.unknown()).optional(),
        type: z.string().min(1).optional(),
        resource: z.string().min(1).optional(),
        // a FLAG ("this upgrade is hunter-side"), not a hunter name
        hunter: z.boolean().optional(),
        effects: z.array(z.object({
          resource: z.string().min(1),
          multiplier: z.record(z.string(), z.unknown()),
        }).strict()).optional(),
      }).strict()),
    }).strict()),
  }).strict(),

  // The map is asserted elsewhere to be a BIJECTION (inscryption-slot-test.js); that is a relation
  // between entries, so it cannot be expressed here. What the schema pins is that the ids and slots
  // are positive integers inside the 110-row shop, which is what a drifted extraction breaks first.
  'inscryption-slots.json': z.object({
    ...generatedMeta,
    provenDisplayedToSlot: nonEmptyRecord(numericKey, z.number().int().min(1).max(110)),
    unnamedSlots: z.array(z.number().int().min(1).max(110)),
  }).strict(),

  // Ship evolution stages. `stages` must start at 0 and be contiguous, because the UI builds its
  // dropdown as 0..maxStage -- a gap would offer a stage with no artwork. maxStage is bounded at 7
  // (Cradle's, the highest the game declares); a larger value almost certainly means the extractor
  // matched something that is not a stage, such as CradleEvo7_1.
  // Gear piece icons: displayed name -> file. Keyed by the GAME's uppercase names; the UI resolves
  // by slug, so the KEY casing is not load-bearing but the file name is.
  'gear-icons.json': z.object({
    ...meta,
    icons: nonEmptyRecord(z.string().min(1), z.string().regex(/^[a-z0-9-]+\.png$/)),
  }).strict(),

  'ship-evo-stages.json': z.object({
    ...meta,
    ships: nonEmptyRecord(z.string().min(1), z.object({
      stages: z.array(z.number().int().min(0).max(7)).min(1),
      maxStage: z.number().int().min(0).max(7),
    }).strict()),
  }).strict(),

  'relic-caps.json': z.object({
    ...meta,
    _raises: z.string().min(1),
    bandBaseMaxLevel: z.object({
      Low: z.number().int().positive(),
      Medium: z.number().int().positive(),
      High: z.number().int().positive(),
    }).strict(),
    relicBand: nonEmptyRecord(z.string().regex(/^r\d+$/), z.object({
      band: z.enum(['Low', 'Medium', 'High']),
      powerRaised: z.boolean(),
    }).strict()),
  }).strict(),

  'ship-node-coefficients.json': z.object({
    ...meta,
    _how: z.string().min(1),
    baseBonusByCategory: nonEmptyRecord(z.string().min(1), nonEmptyRecord(numericKey, finite)),
  }).strict(),

  // ---------------------------------------------------------------------------------------------
  // Scene-extracted tables
  // ---------------------------------------------------------------------------------------------

  // The per-mod field set is genuinely heterogeneous -- a mod may or may not declare v2/v3 tiers,
  // an Ouroboros mod carries BigDouble costs where a normal one carries plain numbers -- so the
  // record VALUES are not pinned to one field set. That is a deliberate limit, not an oversight:
  // enumerating a union of every observed shape would fail the moment the game adds a mod with one
  // more field, which is exactly the change a reference should absorb rather than reject. The
  // envelope is strict, both collections must be non-empty, and every value must be a number or a
  // BigDouble -- which is what a drifted read actually breaks.
  'loop-mods.json': z.object({
    ...generatedMeta,
    loopMods: nonEmptyRecord(numericKey, nonEmptyRecord(
      z.string().min(1), z.union([finite, bigDoublePair]),
    )),
    ouroLoopMods: nonEmptyRecord(numericKey, nonEmptyRecord(
      z.string().min(1), z.union([finite, bigDoublePair]),
    )),
  }).strict(),

  // The four buckets partition every published mod, and three of them being empty would mean the
  // matcher pinned everything -- so only `mapped` is required to be non-empty.
  'loopmod-names.json': z.object({
    note: z.string().min(1),
    mapped: z.array(z.object({
      index: z.number().int().nonnegative(),
      name: z.string().min(1),
      tier: z.string().min(1),
      buffs: z.string().min(1),
      startCostExponent: z.number(),
      maxLevel: z.number().int().positive(),
    }).strict()).min(1),
    ambiguous: z.array(z.object({
      name: z.string().min(1),
      // "ambiguous" means more than one candidate index; one candidate is a match, not ambiguity
      candidates: z.array(z.number().int().nonnegative()).min(2),
      startCostExponent: z.number(),
    }).strict()),
    conflicting: z.array(z.object({
      name: z.string().min(1),
      candidate: z.number().int().nonnegative(),
      reason: z.string().min(1),
    }).strict()),
    unmatched: z.array(z.object({
      name: z.string().min(1),
      startCostExponent: z.number(),
      maxLevel: z.number().int().positive(),
    }).strict()),
  }).strict(),

  // Scraped from the live site rather than extracted from the game, so it records a source URL
  // instead of a build. Costs are published as base-10 EXPONENTS, which is what makes them directly
  // comparable to the scene's BigDouble exponents -- see match-loopmods.js.
  'loopmod-overview.json': z.object({
    source: z.string().min(1),
    note: z.string().min(1),
    mods: z.array(z.object({
      name: z.string().min(1),
      tier: z.string().min(1),
      buffs: z.string().min(1),
      maxLevelShown: z.number().int().positive(),
      levels: z.array(z.object({
        level: z.number().int().nonnegative(),
        costE: z.number(),
      }).strict()).min(1),
    }).strict()).min(1),
  }).strict(),

  'research.json': z.object({
    ...generatedMeta,
    categoryShip: nonEmptyRecord(z.string().min(1), z.number().int().positive()),
    // Every field is optional because the entries genuinely differ: exactly ONE carries an
    // explicit `levelCosts` table of BigDoubles, and the other 79 carry a `StartCost` +
    // `GrowthExponent` pair the cost curve is derived from. The object is nonetheless `.strict()`
    // -- an unexpected key means the extractor learned a field no consumer reads yet, which is
    // precisely what these schemas exist to surface.
    research: nonEmptyRecord(numericKey, z.object({
      levelCosts: nonEmptyRecord(z.string().regex(/^Level\d+Cost$/), bigDoublePair).optional(),
      StartCost: finite.optional(),
      GrowthExponent: finite.optional(),
      Bonus1: finite.optional(),
      Bonus2: finite.optional(),
      Bonus3: finite.optional(),
      Bonus4: finite.optional(),
      Bonus5: finite.optional(),
      Bonus6: finite.optional(),
      Bonus7: finite.optional(),
      Bonus8: finite.optional(),
    }).strict()),
    shipTrees: nonEmptyRecord(z.string().min(1), nonEmptyRecord(numericKey, z.object({
      MaxLevel: z.number(),
      BaseBonus: finite,
      Requirement: z.number(),
    }).strict())),
  }).strict(),

  // 18 numbered families, each a map of index -> authored fields whose SHAPE differs per family
  // (a Relic carries StartCost, a BorgeSkill carries a cap). Values may be plain numbers or
  // BigDoubles. The family names are pinned because a MISSING family is the failure that matters:
  // scene-defs-test.js compares our caps and costs against these, and an absent family silently
  // compares nothing. VexinSkill is listed deliberately -- it is present and entirely zeroed, which
  // is itself the finding that Vexin is unauthored content.
  'scene-defs.json': z.object({
    ...generatedMeta,
    families: z.object(Object.fromEntries(
      ['RU', 'SU', 'TU', 'Badge', 'Relic', 'POM', 'POI', 'TUQ', 'POK', 'MK', 'Project',
        'OzzySkill', 'KnoxSkill', 'VexinSkill', 'BorgeSkill', 'UDU', 'ATU', 'DU']
        .map((k) => [k, nonEmptyRecord(numericKey, z.record(z.string().min(1), z.unknown()))]),
    )).strict(),
  }).strict(),

  // ---------------------------------------------------------------------------------------------
  // The save-field ledger and the SirRed baseline
  // ---------------------------------------------------------------------------------------------

  'save-full-map.json': z.object({
    ...generatedMeta,
    fieldCount: z.number().int().positive(),
    presentInSample: z.number().int().nonnegative(),
    extraSaveKeys: z.array(z.string()),
    summary: z.array(z.object({
      category: z.string().min(1),
      confidence: z.string().min(1),
      count: z.number().int().nonnegative(),
      description: z.string().min(1),
    }).strict()).min(1),
    categories: nonEmptyRecord(z.string().min(1), z.object({
      confidence: z.string().min(1),
      description: z.string().min(1),
      fields: z.array(z.object({
        type: z.string().min(1),
        name: z.string().min(1),
        offset: z.string().regex(/^0x[0-9A-Fa-f]+$/),
        inSample: z.boolean(),
        // absent from the sample save is a real state, and so is a null-valued field
        sampleValue: z.unknown().optional(),
      }).strict()).min(1),
    }).strict()),
  }).strict(),

  // SirRed's decompiled community tool. These two are a BASELINE, not an authority -- changing our
  // data to match them has produced a wrong value twice (the 10x Demeter coefficients, and the
  // Demeter 2/3 gates the game says are 0). They are schema-checked anyway so that a re-extraction
  // which silently produces nothing gets caught: sirred-ship-check.js is a REPORT that exits 0, so
  // an empty file there would look exactly like agreement.
  //
  // Both are FLAT designation -> value maps with no envelope at all, so there is no meta to check;
  // the key pattern is the whole structural constraint (Cra01, Heph11, Zeus07).
  'sirred-install-coefficients.json': nonEmptyRecord(
    z.string().regex(/^(Cra|Aux|Zag|Heph|Dem|Koi|Zeus)\d{2}$/), finite,
  ),

  'sirred-install-slots.json': nonEmptyRecord(
    z.string().regex(/^(Cra|Aux|Zag|Heph|Dem|Koi|Zeus)\d{2}$/),
    z.object({
      maxLevel: z.number().int().positive(),
      unlockThreshold: z.number().int().nonnegative(),
    }).strict(),
  ),

  // ARCHIVE SEED STRUCTURES. Both files share a shape: an envelope plus a `seeds` array of build
  // STRUCTURES (supports and allocations), deliberately WITHOUT scores -- their own note says
  // "STRUCTURES ONLY. Scores depend on account sim params and must never be shipped here", which
  // is the same reasoning that makes a fixture unscoreable under another account's state.
  //
  // `.seed-smoke.json` is the 5-build smoke version of `archive-seeds.json`; identical shape, so
  // one schema is reused rather than copied.
  'archive-seeds.json': archiveSeedFile(),
  '.seed-smoke.json': archiveSeedFile(),
};

function archiveSeedFile() {
  const alloc = nonEmptyRecord(z.string(), z.number().int().nonnegative());
  return z.object({
    generatedAt: z.string(),
    note: z.string(),
    effort: z.string(),
    // TWO RECORD SHAPES, AND THE FILE IS RIGHT TO HOLD BOTH. A build whose optimize() THREW is
    // recorded as {uid, name, hunter, error} rather than omitted -- 2 of 93 on the current file,
    // both the "left 1 talent point unspent" invariant firing. Keeping the failure in the file is
    // the honest choice (a silently shorter seed list would hide it), so the schema expresses the
    // union instead of rejecting it. Loosening the SUCCESS shape to make these validate would have
    // been the wrong fix: it would stop the schema catching a genuinely truncated record.
    seeds: z.array(z.union([z.object({
      uid: z.string(),
      name: z.string(),
      hunter: z.enum(['borge', 'ozzy', 'knox']),
      error: z.string().min(1),
    }).strict(), z.object({
      uid: z.string(),
      name: z.string(),
      hunter: z.enum(['borge', 'ozzy', 'knox']),
      level: z.number().int().positive(),
      mode: z.string(),
      talentBudget: z.number().int().nonnegative(),
      attributeBudget: z.number().int().nonnegative(),
      talentSupport: z.array(z.string()),
      attrSupport: z.array(z.string()),
      talentAlloc: alloc,
      attrAlloc: alloc,
      // Proportions are the allocation normalised, so they are fractions rather than counts.
      talentProportions: nonEmptyRecord(z.string(), z.number()),
      attrProportions: nonEmptyRecord(z.string(), z.number()),
      regime: z.string(),
      killsBoss: z.boolean(),
      reachesBoss: z.boolean(),
      secs: z.number().nonnegative(),
    }).strict()])).min(1),
  }).strict();
}

module.exports = { schemas, meta, numericKey };
