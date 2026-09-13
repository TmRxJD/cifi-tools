'use strict';
// Zod schemas for the app's OWN data: the wasm parameter lists, the persisted store, and the
// decoded-save fixture. `reference-schemas.js` covers the game-derived files under
// tools/reference/; this covers everything else the tool actually runs on.
//
// WHY THE STORE IS IN HERE AT ALL, given storeSchema.js already validates it. `validateStore()`
// checks INVARIANTS -- relationships between fields, like "an inferred level must be able to fund
// the allocation it was inferred from". This checks SHAPE: that `gems.<tree>.nodes` is six
// booleans and not, say, an object keyed by node number. The two catch different bugs, and shape
// drift is the one that produces a silent `undefined` at a read site rather than a thrown error.
// The store is the one thing here with no backend behind it -- there is no re-fetching a store
// that was written in a wrong shape.
//
// Zod stays a DEV dependency: nothing in this file is loaded by the browser, so the shipped webapp
// still has no build step.

const { z } = require('zod');

const nonEmptyRecord = (key, value) => z.record(key, value)
  .refine((o) => Object.keys(o).length > 0, { message: 'is empty -- nothing was produced' });

const count = z.number().int().nonnegative();
const numericKey = z.string().regex(/^\d+$/, 'expected a numeric id as the key');

// A gem tree as the Gem Planner persists it. `nodes` is SIX booleans -- the game's own structure is
// 7 trees x 6 nodes, confirmed against its metadata -- and the length matters: `isUpgradeUnlocked`
// indexes `nodes[gate.node - 1]`, so a short array silently reads `undefined` and locks an upgrade
// the account has actually bought.
const gemTree = z.object({
  level: count,
  nodes: z.array(z.boolean()).length(6),
  upgrades: z.record(z.string(), z.union([z.number(), z.boolean()])),
}).strict();

// Per-hunter state. The stat NAMES differ per hunter (Ozzy has multichance/multipower where Borge
// has critchance/critpower; Knox has block/charge/reload/proj), so the record is left open on keys
// and closed on value type -- a stat that arrives as a string is the failure worth catching, and
// asserting the exact stat list here would duplicate hunterDefs.js and drift from it.
// A SAVED BUILD. This was `z.unknown()`, which is the biggest gap the store had: builds are the
// user's own irreplaceable data (there is no backend -- see the store's own warning), and a shape
// error here is exactly the kind that surfaces as a corrupted build rather than a thrown error.
//
// `level` is REQUIRED and positive, because it becomes the wasm `lvl` argument -- an absent one
// silently evaluates the whole build at level 0 and returns a plausible, meaningless score. That
// is not hypothetical: it is the bug that produced a "borge@61 is 50% below cifi-tools" report and
// an investigation into gems, categories and relics before the argument vector was dumped.
//
// `talents`/`attributes` are open on KEYS (the node ids differ per hunter, and restating them here
// would duplicate hunterDefs.js and drift from it) and closed on VALUE -- a level arriving as a
// string is the failure worth catching. `overrides` is genuinely heterogeneous per upgrade family,
// so it is open-valued and says so rather than being left off.
const savedBuild = z.object({
  // `newDraftBuild()` creates it as null and it stays null until saved, so null is a real state.
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  name: z.string(),
  level: z.number().int().positive(),
  talents: z.record(z.string().min(1), z.number()),
  attributes: z.record(z.string().min(1), z.number()),
  categoryId: z.union([z.number(), z.string(), z.null()]).optional(),
  overrides: z.record(z.string().min(1), z.unknown()).optional(),
}).strict();

const hunterState = z.object({
  hunterStats: nonEmptyRecord(z.string().min(1), z.number()),
  builds: z.array(savedBuild),
  iterations: z.number().int().positive(),
  lootFilter: z.object({
    mat1: z.boolean(), mat2: z.boolean(), mat3: z.boolean(), xp: z.boolean(),
  }).strict(),
}).strict();

// Free-form maps the user fills in, keyed by ship or generator id. Declared explicitly as
// open-valued rather than left off the schema, so that "we chose not to constrain this" is
// distinguishable from "nobody thought about it".
const freeFormMap = z.record(z.string(), z.unknown());

const storeSchema = z.object({
  globalUpgrades: z.record(z.string(), z.unknown()),
  gems: nonEmptyRecord(z.string().min(1), gemTree),
  categories: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    isSystem: z.boolean(),
  }).passthrough()).min(1),
  viewMode: z.string().min(1),

  ships: freeFormMap,
  researchUnits: freeFormMap,
  shipBuilds: freeFormMap,
  shipInputs: freeFormMap,

  // Mostly plain counters, plus `focusWeights`, which is a nested per-resource weighting map.
  // The union says so rather than a blanket z.unknown(): a counter arriving as a string is the
  // failure worth catching, and it is what a bad import produces.
  // Progression counters plus `meltdown` and the nested `focusWeights` map. Open on keys because
  // the counter set is per-ship and lives in shipsPage.js.
  //
  // `meltdown` is pinned POSITIVE and checked separately, because it is an EXPONENT
  // (Pow(MK1Production, m)) and 0 is not a state the game has: before the first Ouroboros reset
  // the un-melted branch runs, which is m = 1. A stored 0 would flatten every node's contribution
  // to 1 while looking like an ordinary empty field.
  shipGear: nonEmptyRecord(
    z.string().min(1),
    z.union([z.number(), z.record(z.string().min(1), z.number())]),
  ).refine((g) => g.meltdown === undefined || (typeof g.meltdown === 'number' && g.meltdown > 0), {
    message: 'shipGear.meltdown must be > 0 -- it is an exponent, and "no meltdown" is 1, not 0',
  }),
  gearSets: z.object({
    // Every piece's game-sourced fields are owned by REAL_GEAR_PIECES; the store owns only
    // level/owned. Both are checked because a piece persisted without a name cannot be reconciled
    // back to its definition -- pieces are keyed by name.
    pieces: z.array(z.object({
      name: z.string().min(1),
      level: count,
    }).passthrough()).min(1),
  }).passthrough(),
  // These three were .passthrough(), which accepts any extra key silently -- and a new key is
  // usually the signal that an extractor learned something no consumer has been taught to read.
  // Their shapes are fully known, so they are strict now.
  fleetBoosts: z.object({ levels: z.record(z.string(), count) }).strict(),
  fleetResearch: z.object({ levels: z.record(z.string(), count) }).strict(),
  fleetBadges: z.object({ owned: z.record(z.string(), z.boolean()) }).strict(),
  unlockedGens: z.record(numericKey, z.boolean()),
  // Ouroboros account state. Optional inside because a store that has never imported a save has
  // not learned the flag yet, and "unknown" must stay distinguishable from "false" -- the gate
  // that reads it treats a missing value as not-reset, which is the safe direction for offering
  // a tier the account may not have.
  ouroState: z.object({ firstOuroResetDone: z.boolean().optional() }).strict(),

  optimizerSettings: z.object({
    shipEnabled: z.record(numericKey, z.boolean()),
    zaglag: z.boolean(),
    prepForLongRun: z.boolean(),
    runLength: z.string().min(1),
  }).passthrough(),
  importPrefs: z.object({
    categories: z.record(z.string(), z.boolean()),
    autoPoll: z.boolean(),
    quiet: z.boolean(),
    checklistCollapsed: z.boolean(),
  }).passthrough(),
  loadoutTabs: z.object({
    tabs: z.array(z.object({ id: z.number() }).passthrough()).min(1),
    activeId: z.number(),
    nextId: z.number(),
  }).passthrough(),
  effectivePathMode: z.string().min(1),

  // These two were added to StoreSchema and NOT here, so a real save import failed this schema
  // with `Unrecognized keys: "lastHunter", "optimizeEffort"` -- app-schema-test had been red and
  // nobody had run all.js to see it. That is exactly the drift the key-set guard below exists to
  // catch, and it caught it; the fix is to declare them, not to loosen the schema.
  //
  // This module stays a PURE schema -- it must not reach into the sandbox, or every consumer pays
  // to construct one. That `optimizeEffort` names a level the optimizer actually declares is
  // asserted in schema-test ("the shipped optimize effort is declared exactly once"), which owns
  // that relationship; duplicating it here would be a second source for one fact.
  lastHunter: z.enum(['borge', 'ozzy', 'knox']),
  lastScan: freeFormMap,
  optimizeEffort: z.string().min(1),
  // 0 means show the complete install order; positive values keep only that trailing detail.
  installOrderShowLast: z.number().int().nonnegative(),
  // The run time limit in MINUTES, clamped 1..120 by StoreSchema.clampOptimizeMinutes. Bounded
  // here as well as there because a value outside that range reaches optimize() as a cap that
  // either fires instantly or never -- and a 1-minute cap looks identical to a slow machine.
  optimizeMaxMinutes: z.number().int().min(1).max(120),

  // Fragments are ACCOUNT-WIDE, which is why they sit at the top level rather than under a hunter.
  // `perDay` is a user input the sim cannot infer; `current` comes from the save and `currentAt`
  // stamps it so accrual restarts from a real number.
  fragments: z.object({
    perDay: z.number().nonnegative(),
    current: z.number().nonnegative(),
    currentAt: z.number().nonnegative(),
    autoAccrue: z.boolean(),
  }).strict(),

  settings: z.object({
    advancedTalents: z.record(z.string(), z.unknown()),
    ui: z.record(z.string(), z.boolean()),
  }).passthrough(),

  borge: hunterState,
  ozzy: hunterState,
  knox: hunterState,
}).strict();

// The ordered wasm argument names per hunter. Order IS the contract -- an argument's position is
// its slot -- and a duplicate name would make two parameters resolve to one slot, silently.
// Lengths are not asserted here: wasm-arity-check.js compares them against the real module's
// arity, which is a stronger check than any number written down twice.
const paramsSchema = z.object({
  borge: z.array(z.string().min(1)).min(1),
  ozzy: z.array(z.string().min(1)).min(1),
  knox: z.array(z.string().min(1)).min(1),
}).strict().superRefine((val, ctx) => {
  for (const [hunter, names] of Object.entries(val)) {
    const seen = new Set();
    names.forEach((n, i) => {
      if (seen.has(n)) {
        ctx.addIssue({
          code: 'custom',
          path: [hunter, i],
          message: `duplicate parameter name "${n}" -- two parameters would share one wasm slot`,
        });
      }
      seen.add(n);
    });
  }
});

// The decoded-save fixture the save benches read. A save is a flat map of field name -> value, and
// its value types are genuinely mixed (numbers, booleans, strings, BigDouble pairs, arrays), so
// what is worth pinning is that it is a non-empty flat map with plausible field names -- an empty
// or nested fixture would make every save bench pass while comparing nothing.
const decodedSaveSchema = nonEmptyRecord(z.string().min(1), z.unknown());

module.exports = { storeSchema, paramsSchema, decodedSaveSchema };
