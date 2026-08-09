// THE schema for the persisted store. One declaration; everything else derives from it.
//
// WHY THIS EXISTS
// ---------------
// The store shape used to be written out twice: once as an object literal in freshStore(), and
// again as ~25 sequential `if (!parsed.x) parsed.x = <default>` backfill lines in loadStore().
// Adding a field meant remembering to touch both. Forgetting the second one shipped `undefined`
// into an existing user's store on their next load, which surfaces far away from the change as
// a "cannot read properties of undefined" on some unrelated screen. Several of those backfill
// lines had also drifted into carrying their own inline copies of defaults that no longer
// matched freshStore()'s.
//
// Here the shape is declared ONCE. A fresh store is the schema materialized; loading an older
// store is the same schema deep-filled over whatever was saved. A new field is one line, and it
// is impossible for the two paths to disagree because there is only one path.
//
// HOW TO ADD A FIELD
//   Add it to SCHEMA below with a default factory. That is the whole change.
//
// HOW TO ADD AN INVARIANT
//   Add a check to validateStore(). It runs on every load and after every migration, and in a
//   dev context it throws rather than limping on with a store that violates its own rules.
(function (global) {
  'use strict';

  const HUNTERS = ['borge', 'ozzy', 'knox'];

  // Base stat keys per hunter, mirroring HUNTER_DEFS[h].baseStatKeys. Seeded to 0 so a fresh
  // account starts with an explicit zero for every stat rather than a missing key -- resolveParam
  // treats missing and zero the same, but the editor renders from these keys.
  function seedHunterStats(hunter) {
    const stats = {};
    global.HUNTER_DEFS[hunter].baseStatKeys.forEach((k) => { stats[k] = 0; });
    stats.stage = 1;
    return stats;
  }

  const DEFAULT_CATEGORIES = [
    { id: 'active', name: 'Active', isSystem: true },
    { id: 'archived', name: 'Archived', isSystem: true },
  ];

  const IMPORT_CATEGORY_KEYS = [
    'hunterBuilds', 'relics', 'inscriptions', 'diamondCards', 'milestone', 'gems',
    'shipRanks', 'shipGear', 'unlockedGens', 'gearSets', 'fleetBadges', 'fleetResearch',
    'researches', 'diamondUltima',
  ];

  function defaultImportPrefs() {
    const categories = {};
    IMPORT_CATEGORY_KEYS.forEach((k) => { categories[k] = true; });
    return { categories, autoPoll: false, quiet: false, checklistCollapsed: false };
  }

  // The Fleet domain (shipsPage.js) owns the shapes of its own store fields; this file names
  // them but does not redefine them. Resolved lazily because shipsPage.js is a sibling script,
  // and a missing factory is a load-order bug worth failing loudly on rather than silently
  // substituting an empty object -- which is precisely what this schema used to do.
  function fleetDefault(key) {
    const factory = global.FleetStoreDefaults && global.FleetStoreDefaults[key];
    if (typeof factory !== 'function') {
      throw new Error(`storeSchema: FleetStoreDefaults.${key} is missing (shipsPage.js must load before storeSchema.js)`);
    }
    return factory();
  }

  const defaultLoadoutTabs = () => fleetDefault('loadoutTabs');

  // Every top-level field of the store, with a factory for its default value. `deep: true`
  // means "recurse into this object and fill missing sub-keys too" -- used for the settings
  // objects that gain new keys over time. Plain maps (ships, gearSets, ...) are user data:
  // present-or-default, never merged key-by-key.
  const SCHEMA = {
    globalUpgrades: { make: () => ({}) },
    gems: { make: () => global.defaultGemState() },
    categories: { make: () => JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)) },
    viewMode: { make: () => 'vertical' },
    // Genuinely free-form maps, keyed by ship/gen id as the user fills them in.
    ships: { make: () => ({}) },
    researchUnits: { make: () => ({}) },
    shipBuilds: { make: () => ({}) },
    shipInputs: { make: () => ({}) },
    // Fleet-domain fields: shapes owned by shipsPage.js, named here. `deep` so a field added to
    // one of those factories reaches existing accounts on next load instead of only appearing
    // once the relevant page is opened.
    shipGear: { deep: true, make: () => fleetDefault('shipGear') },
    gearSets: { deep: true, make: () => fleetDefault('gearSets') },
    fleetBoosts: { deep: true, make: () => fleetDefault('fleetBoosts') },
    fleetResearch: { deep: true, make: () => fleetDefault('fleetResearch') },
    fleetBadges: { deep: true, make: () => fleetDefault('fleetBadges') },
    unlockedGens: { deep: true, make: () => fleetDefault('unlockedGens') },
    optimizerSettings: { deep: true, make: () => fleetDefault('optimizerSettings') },
    importPrefs: { deep: true, make: defaultImportPrefs },
    loadoutTabs: { make: defaultLoadoutTabs },
    // advancedTalents[hunter]: has the user opted into showing this hunter's advanced talent
    // (e.g. The Legacy of Ultima). Was previously conjured at four separate call sites with
    // `store.settings = store.settings || {}` and never declared anywhere -- so it existed on
    // some accounts and not others depending on which screen you had happened to visit.
    settings: { deep: true, make: () => ({ advancedTalents: {} }) },
  };

  HUNTERS.forEach((h) => {
    SCHEMA[h] = { make: () => ({ hunterStats: seedHunterStats(h), builds: [] }) };
  });

  // Keys that older versions wrote and nothing reads any more. Listed explicitly so removal is
  // a deliberate, reviewable act rather than data quietly accumulating forever.
  const RETIRED_KEYS = ['currentLoadout'];

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Fill missing keys of `target` from `defaults`, recursively. Never overwrites a value the
  // user already has -- migration only ever ADDS what is absent.
  function deepFill(target, defaults) {
    let filled = 0;
    for (const [key, def] of Object.entries(defaults)) {
      if (!(key in target) || target[key] === undefined) {
        target[key] = isPlainObject(def) ? JSON.parse(JSON.stringify(def)) : def;
        filled++;
      } else if (isPlainObject(def) && isPlainObject(target[key])) {
        filled += deepFill(target[key], def);
      }
    }
    return filled;
  }

  /** A brand new store: the schema materialized. */
  function freshStore() {
    const store = {};
    for (const [key, spec] of Object.entries(SCHEMA)) store[key] = spec.make();
    return store;
  }

  /**
   * Bring a loaded store up to the current schema. Mutates and returns it, plus a report of
   * what changed so the caller can decide whether to persist the repair.
   */
  function migrateStore(parsed) {
    const added = [];
    const removed = [];

    for (const [key, spec] of Object.entries(SCHEMA)) {
      if (!(key in parsed) || parsed[key] === undefined || parsed[key] === null) {
        parsed[key] = spec.make();
        added.push(key);
      } else if (spec.deep && isPlainObject(parsed[key])) {
        if (deepFill(parsed[key], spec.make())) added.push(`${key}.*`);
      }
    }

    for (const key of RETIRED_KEYS) {
      if (key in parsed) { delete parsed[key]; removed.push(key); }
    }

    return { store: parsed, added, removed, changed: added.length > 0 || removed.length > 0 };
  }

  /**
   * Assert the store's invariants. Returns an array of human-readable violations (empty when
   * clean) rather than throwing, so the caller chooses the policy: the app logs loudly and
   * carries on so a user is never locked out of their data by a validation bug, while the
   * benchmark treats any violation as a hard failure.
   */
  function validateStore(store) {
    const problems = [];
    const note = (m) => problems.push(m);

    for (const key of Object.keys(SCHEMA)) {
      if (!(key in store)) note(`missing top-level key "${key}"`);
    }

    for (const h of HUNTERS) {
      const hunter = store[h];
      if (!isPlainObject(hunter)) { note(`${h} is not an object`); continue; }
      if (!Array.isArray(hunter.builds)) { note(`${h}.builds is not an array`); continue; }
      if (!isPlainObject(hunter.hunterStats)) note(`${h}.hunterStats is not an object`);

      const ids = new Set();
      hunter.builds.forEach((b, i) => {
        const where = `${h}.builds[${i}]`;
        if (!isPlainObject(b)) { note(`${where} is not an object`); return; }
        if (!b.id) note(`${where} has no id`);
        else if (ids.has(b.id)) note(`${where} duplicates id "${b.id}"`);
        else ids.add(b.id);
        if (!Number.isInteger(b.level) || b.level < 1) note(`${where}.level is ${b.level}, expected an integer >= 1`);
        if (!isPlainObject(b.talents)) note(`${where}.talents is not an object`);
        if (!isPlainObject(b.attributes)) note(`${where}.attributes is not an object`);
        problems.push(...validateAllocation(h, b, where, store.gems));
      });
    }

    const catIds = new Set();
    (store.categories || []).forEach((c, i) => {
      if (!c || !c.id) note(`categories[${i}] has no id`);
      else if (catIds.has(c.id)) note(`categories[${i}] duplicates id "${c.id}"`);
      else catIds.add(c.id);
    });
    for (const required of ['active', 'archived']) {
      if (!catIds.has(required)) note(`categories is missing the system category "${required}"`);
    }

    return problems;
  }

  /**
   * A build's allocation must be legal by the same rules the optimizer and the editor use --
   * within budget, dependencies satisfied, tier thresholds met. This is the invariant that used
   * to be violated silently: illegal allocations reached saved builds and then scored as if they
   * were real, because nothing ever checked a build after it was written.
   */
  function validateAllocation(hunter, build, where, gems) {
    const problems = [];
    const rawDefs = global.HUNTER_DEFS[hunter];
    if (!rawDefs || !isPlainObject(build.talents) || !isPlainObject(build.attributes)) return problems;

    // Caps must be resolved for this build's context before checking them. Borge's Call Me
    // Lucky Loot caps at 12 rather than 10 once Attraction gem node 2 is active, so validating
    // against the static maxLevel would flag a perfectly legal saved build as corrupt.
    const capCtx = { gemPlannerStore: { gemStates: gems || {} }, buildOverrides: build.overrides || {} };
    const d = {
      ...rawDefs,
      talents: global.resolveMaxLevels(rawDefs.talents, capCtx),
      attributes: global.resolveMaxLevels(rawDefs.attributes, capCtx),
    };

    const talentBudget = global.talentBudgetForLevel(build.level);
    const attributeBudget = global.attributeBudgetForLevel(build.level);
    const Space = global.AllocSpace;

    const talentSpent = global.AllocSpace.costOf(d.talents, build.talents);
    if (talentSpent > talentBudget) problems.push(`${where} spends ${talentSpent} talent points, budget is ${talentBudget}`);

    const attrSpent = Space.costOf(d.attributes, build.attributes);
    if (attrSpent > attributeBudget) problems.push(`${where} spends ${attrSpent} attribute points, budget is ${attributeBudget}`);

    for (const a of d.attributes) {
      if (!Space.isHeld(a, d.attributes, d.attributeDependencies, d.attributeMinValue, build.attributes)) {
        problems.push(`${where}.attributes.${a.id} = ${build.attributes[a.id]} is not legal (dependency or tier threshold unmet)`);
      }
    }
    for (const t of d.talents) {
      const lvl = build.talents[t.id] || 0;
      if (lvl > t.maxLevel) problems.push(`${where}.talents.${t.id} = ${lvl} exceeds max ${t.maxLevel}`);
      if (lvl < 0) problems.push(`${where}.talents.${t.id} is negative`);
    }
    return problems;
  }

  const StoreSchema = {
    HUNTERS,
    SCHEMA,
    RETIRED_KEYS,
    DEFAULT_CATEGORIES,
    seedHunterStats,
    defaultImportPrefs,
    defaultLoadoutTabs,
    freshStore,
    migrateStore,
    validateStore,
    validateAllocation,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = StoreSchema;
  else global.StoreSchema = StoreSchema;
})(typeof window !== 'undefined' ? window : globalThis);
