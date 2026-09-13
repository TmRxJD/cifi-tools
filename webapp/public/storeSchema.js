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
    // Added later than the rest: saveImport.js's mapCifiSaveToStore had computed these for a
    // while, but nothing ever copied them from `mapped.globalUpgrades` into the real store --
    // they'd get decoded on every import and then silently dropped every time.
    'diamondSpecials', 'cms', 'gadgets', 'loopmods', 'trinkets', 'iap',
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
  // Build-card stripe colours. ONE definition of the limits and the colour format, exported so the
  // picker (app.js) trims to the same numbers validateStore() enforces -- two copies of a limit is
  // how a UI ends up writing a state the validator then reports as corrupt.
  const CARD_COLOR_LIMITS = { favorites: 5, recent: 10 };
  const HEX_COLOR = /^#[0-9a-f]{6}$/;

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
    // Ouroboros account state -- currently just `firstOuroResetDone`, which is half of the
    // condition gating generator tiers MK9-MK12 (the Evolution gem quality level is the other
    // half, and lives in `gems`). Declared here rather than conjured at the call site, which is
    // this project's rule for exactly the reason it exists: a shape created ad hoc is a shape no
    // invariant checks.
    ouroState: { deep: true, make: () => ({}) },
    optimizerSettings: { deep: true, make: () => fleetDefault('optimizerSettings') },
    importPrefs: { deep: true, make: defaultImportPrefs },
    loadoutTabs: { make: defaultLoadoutTabs },
    // Which objective the Effective Path ranks by. Declared here rather than conjured at the
    // call site, and validated against the optimizer's own path-applicable mode table so a
    // stale/renamed mode cannot persist into a screen that then throws.
    effectivePathMode: { make: () => 'loot' },
    // How many trailing steps the Install Order list shows in full. A late-game ship can spend
    // 500+ points, and a 500-row list is unusable for the thing it is for: knowing what to click
    // next. Everything BEFORE the tail is bulk-buyable in any order -- the sequence only matters
    // where it is still interleaving -- so the prefix collapses to a per-node total and only the
    // tail stays ordered.
    // 0 MEANS SHOW EVERYTHING, and is the default: the compression must be something the user
    // turns on, because silently hiding steps from a list whose whole purpose is completeness
    // would be worse than a long list.
    installOrderShowLast: { make: () => 0 },
    // Which hunter the sim page was last showing. Persisted so a refresh returns you to the
    // hunter you were working on instead of snapping back to Borge -- the app's in-memory
    // `currentHunter` defaulted to 'borge' on every load, so the selection was lost with the page.
    lastHunter: { make: () => 'borge' },
    // Raw values from the most recent bridge scan. This used to live in a second, unnamespaced
    // localStorage key even in extension mode, which made the native Pinia store only a partial
    // account state. Keeping it here makes one persisted store own the whole companion state.
    lastScan: { make: () => ({}) },
    // Build-card stripe colour palette, account-wide (a colour means the same thing on every
    // hunter's cards). `favorites` are pinned by the user; `recent` is maintained automatically,
    // most-recent first. The per-card choice lives on the build itself as `stripeColor`.
    cardColors: { deep: true, make: () => ({ favorites: [], recent: [] }) },
    // How much search effort the user is willing to pay for. A standing preference about time,
    // validated against the optimizer's own EFFORT_LEVELS at render time so a stale or renamed
    // level falls back to the default instead of reaching a search that cannot honour it.
    // DERIVED, NEVER RESTATED. This used to be a literal 'complete' while the optimizer's own
    // DEFAULT_EFFORT said 'fast'; benches inherit the optimizer's value, so the two disagreeing
    // meant every bench measured a configuration the app never uses. Read it from the one place
    // that declares it, and fail loudly if that place is missing rather than inventing a fallback.
    // HOW LONG A RUN MAY TAKE, in minutes. Ten by default, which is the ceiling the project
    // owner asked for. It bounds the OPTIONAL work -- the final polish and the wider full-fidelity
    // finalist comparison -- so a capped run returns a build chosen at full fidelity but less
    // refined, never a partial or illegal one. There is a floor it cannot go below: enumeration,
    // screening and the final ranking have to happen for the answer to be ranked at all.
    optimizeMaxMinutes: { make: () => 10 },
    optimizeEffort: {
      make: () => {
        const opt = global.HunterOptimizer;
        if (!opt || !opt.DEFAULT_EFFORT) {
          throw new Error('storeSchema: HunterOptimizer.DEFAULT_EFFORT is unavailable; the '
            + 'shipped optimize effort is declared there and must not be duplicated here');
        }
        return opt.DEFAULT_EFFORT;
      },
    },
    // Fragments are the currency relics are bought with, and they are ACCOUNT-WIDE, not
    // per-hunter and not per-build: there is one Relic #7, you buy it once, and every hunter
    // that reads it benefits. So this lives at the top level of the store alongside the other
    // account-scoped state, NOT under store[hunter].
    //
    // The sim cannot supply the rate. mat1/mat2/mat3 come out of the evaluator per run, but
    // fragments come from campaign/boss content the evaluator does not model -- which is
    // exactly why the user has to tell us. Shape mirrors what the live tool already does for
    // Tesseracts in its gadget planner (tessarectsPerDay + a timestamped current value that
    // accrues while you are away), so the two behave the same way for the same reason.
    fragments: {
      deep: true,
      make: () => ({
        perDay: 0,            // 0 means "not told" -- never guess a rate
        current: 0,           // fragments on hand when `currentAt` was stamped
        currentAt: 0,         // epoch ms; 0 means never set
        autoAccrue: true,     // add perDay * elapsed to `current` when reading it
      }),
    },
    // advancedTalents[hunter]: has the user opted into showing this hunter's advanced talent
    // (e.g. The Legacy of Ultima). Was previously conjured at four separate call sites with
    // `store.settings = store.settings || {}` and never declared anywhere -- so it existed on
    // some accounts and not others depending on which screen you had happened to visit.
    // `ui` mirrors the original tool's Settings → Interface / Enthusiast Mode sections.
    // `highIterations` only RAISES the iteration ceiling; it is not itself an iteration count,
    // so turning it off must not silently rewrite a value the user already chose (see
    // iterationCeiling / clampIterations below, which is why the ceiling is a function rather
    // than a stored number).
    settings: {
      deep: true,
      make: () => ({
        advancedTalents: {},
        ui: { upgradesSidebar: true, highIterations: false },
      }),
    },
  };

  // Simulation iteration bounds, matching the original tool's own slider (min 250, max 4000,
  // step 250, default 1000) and its "Enable High Iterations Mode" setting, which raises the
  // ceiling to 100,000 for precision at the cost of runtime.
  const ITERATIONS = { min: 250, max: 4000, maxHigh: 100000, step: 250, default: 1000 };

  /** The ceiling that applies right now, given whether the user enabled high-iterations mode. */
  function iterationCeiling(store) {
    return store?.settings?.ui?.highIterations ? ITERATIONS.maxHigh : ITERATIONS.max;
  }

  /**
   * Coerce an iteration count into something the evaluator can actually be asked for.
   *
   * Deliberately clamps rather than throwing: this reads user input on every keystroke, and a
   * half-typed "2" is not a bug worth exploding on. It does NOT round to `step` -- an imported
   * or previously-saved value outside the step grid is still a valid number of iterations, and
   * silently changing it would be a surprise.
   */
  /**
   * Minutes a run may take: 1..120, defaulting to 10 for anything unparseable.
   *
   * Clamped rather than trusted because it is a free-text number input: a blank, a negative or a
   * pasted "600" would otherwise reach optimize() as a cap that either fires instantly or never.
   * Zero is NOT special-cased to mean "no limit" -- optimize() already reads <= 0 that way, and a
   * spinner that silently disables the limit at its own minimum is a trap.
   */
  function clampOptimizeMinutes(value) {
    // EMPTY IS NOT ZERO. `Number('')` is 0, which is finite, so a blank input fell through the
    // NaN guard and clamped to the MINIMUM (1 minute) instead of the default (10) -- the comment
    // above said "unparseable defaults to 10" while the code did something else. A user who
    // cleared the box to retype would have silently armed a 1-minute cap.
    if (value === '' || value === null || value === undefined) return 10;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 10;
    return Math.max(1, Math.min(120, n));
  }

  function clampIterations(value, store) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return ITERATIONS.default;
    return Math.min(iterationCeiling(store), Math.max(ITERATIONS.min, n));
  }

  // Which loot rows a build card shows. Per hunter, matching the original (its own filter is
  // stored per hunter as `lootFilters_<hunterId>`). All on by default -- a filter that starts
  // hiding things would look like missing data.
  const LOOT_KEYS = ['mat1', 'mat2', 'mat3', 'xp'];
  const defaultLootFilter = () => Object.fromEntries(LOOT_KEYS.map((k) => [k, true]));

  HUNTERS.forEach((h) => {
    // `deep` so that per-hunter fields added later reach accounts that already exist, instead
    // of only appearing for users who happen to start fresh.
    SCHEMA[h] = {
      deep: true,
      make: () => ({
        hunterStats: seedHunterStats(h),
        builds: [],
        // Per hunter, not global: the original tool keys iterations by hunter too, and it is
        // the right shape -- a level-79 Borge costs far more per evaluation than a level-12
        // Knox, so the accuracy/speed tradeoff is genuinely a different one per hunter.
        iterations: ITERATIONS.default,
        lootFilter: defaultLootFilter(),
      }),
    };
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

    // A persisted optimize mode must still exist in the optimizer's table. Renaming or removing
    // a mode would otherwise leave an account pointing at one that no longer resolves, and the
    // failure would surface later, on a screen that looks unrelated.
    if ('effectivePathMode' in store) {
      const pathModes = global.OptimizerObjective.pathModes();
      if (!pathModes[store.effectivePathMode]) {
        note(`effectivePathMode "${store.effectivePathMode}" is not a purchase-path mode (have: ${Object.keys(pathModes).join(', ')})`);
      }
    }

    // Fragments: the rate is a user input, but it must be a sane one -- a negative rate would
    // make time-to-afford run backwards.
    if (isPlainObject(store.fragments)) {
      const f = store.fragments;
      if (!(Number(f.perDay) >= 0)) note(`fragments.perDay is ${f.perDay}, must be a number >= 0`);
      if (!(Number(f.current) >= 0)) note(`fragments.current is ${f.current}, must be a number >= 0`);
    }

    for (const h of HUNTERS) {
      const hunter = store[h];
      if (!isPlainObject(hunter)) { note(`${h} is not an object`); continue; }
      if (!Array.isArray(hunter.builds)) { note(`${h}.builds is not an array`); continue; }
      if (!isPlainObject(hunter.hunterStats)) note(`${h}.hunterStats is not an object`);

      // Iterations reaches the evaluator directly. A zero, a negative or a NaN would produce a
      // meaningless score rather than an error, so it is worth catching here where the message
      // can name the field.
      const it = hunter.iterations;
      if (!Number.isFinite(Number(it)) || Number(it) < ITERATIONS.min) {
        note(`${h}.iterations is ${it}, must be a number >= ${ITERATIONS.min}`);
      } else if (Number(it) > iterationCeiling(store)) {
        note(`${h}.iterations is ${it}, above the current ceiling of ${iterationCeiling(store)}`
          + `${store?.settings?.ui?.highIterations ? '' : ' (enable High Iterations Mode to raise it)'}`);
      }

      // A loot filter with an unknown key would silently do nothing; one with a non-boolean
      // would hide a row by accident. Both are cheap to catch.
      if (!isPlainObject(hunter.lootFilter)) {
        note(`${h}.lootFilter is not an object`);
      } else {
        for (const [k, v] of Object.entries(hunter.lootFilter)) {
          if (!LOOT_KEYS.includes(k)) note(`${h}.lootFilter has unknown key "${k}" (have: ${LOOT_KEYS.join(', ')})`);
          else if (typeof v !== 'boolean') note(`${h}.lootFilter.${k} is ${typeof v}, must be a boolean`);
        }
      }

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
        // Optional: absent means "use the default stripe" (hunter accent, yellow for the reference
        // build). Present, it is written straight into a style attribute, so it must be a colour.
        if (b.stripeColor !== undefined && !HEX_COLOR.test(b.stripeColor)) {
          note(`${where}.stripeColor is "${b.stripeColor}", expected a #rrggbb colour`);
        }
      });
    }

    const cc = store.cardColors;
    if (cc) {
      for (const [list, limit] of Object.entries(CARD_COLOR_LIMITS)) {
        if (!Array.isArray(cc[list])) { note(`cardColors.${list} is not an array`); continue; }
        if (cc[list].length > limit) note(`cardColors.${list} holds ${cc[list].length}, limit is ${limit}`);
        cc[list].forEach((c, i) => { if (!HEX_COLOR.test(c)) note(`cardColors.${list}[${i}] is "${c}", expected #rrggbb`); });
        if (new Set(cc[list]).size !== cc[list].length) note(`cardColors.${list} contains duplicates`);
      }
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
    // A VALIDATOR THAT CANNOT VALIDATE MUST SAY SO, NOT RETURN "no problems".
    //
    // This returned an EMPTY problem list for any unusable input -- no hunter defs, a missing
    // talents or attributes map, a null build -- and an empty list is read everywhere as VALID.
    // So the one function whose job is catching corrupt state blessed exactly the state it could
    // not inspect. A malformed-input sweep found it answering all 19 garbage calls with `[]`.
    // Reporting a problem (rather than throwing) keeps a half-written store loadable while making
    // the gap visible, which is the behaviour the rest of this file already takes for corruption.
    if (!build || typeof build !== 'object') {
      problems.push(`${where} is not an object, so it cannot be validated`);
      return problems;
    }
    const rawDefs = global.HUNTER_DEFS[hunter];
    if (!rawDefs) {
      problems.push(`${where} names hunter "${hunter}", which has no definitions -- cannot be validated`);
      return problems;
    }
    if (!isPlainObject(build.talents) || !isPlainObject(build.attributes)) {
      problems.push(`${where} is missing a talents or attributes map, so it cannot be validated`);
      return problems;
    }

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
    CARD_COLOR_LIMITS,
    HEX_COLOR,
    validateAllocation,
    ITERATIONS,
    iterationCeiling,
    clampIterations,
    clampOptimizeMinutes,
    LOOT_KEYS,
    defaultLootFilter,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = StoreSchema;
  else global.StoreSchema = StoreSchema;
})(typeof window !== 'undefined' ? window : globalThis);
