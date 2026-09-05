'use strict';
// Shared plumbing for the optimizer benchmark.
//
// Everything here loads the SHIPPED browser files -- hunterDefs.js, hunterSimBrowser.js,
// buildCode.js, and the optimizer under webapp/public/optimizer/ -- rather than a Node
// re-implementation of them. There is no second copy of the search, the legality rules, the
// param resolver or the build-code format to drift out of sync. What the benchmark measures
// is exactly what the webapp runs.
//
// The browser files fetch() params.json and release.wasm; a small shim below serves those two
// from disk so they can run unmodified under Node.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '../../webapp/public');

let sandbox = null;
function browserSandbox() {
  if (sandbox) return sandbox;
  const sb = {
    console,
    WebAssembly,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    performance,
    setTimeout,
    clearTimeout,
    // hunterSimBrowser.js resolves its assets against HUNTERSIM_ASSET_BASE (or location.href
    // in a real page). Under Node there is no location, so name the base explicitly; the fetch
    // shim below maps it back to webapp/public on disk.
    HUNTERSIM_ASSET_BASE: 'https://huntersim.local/',
    // Serves exactly the two assets the browser modules request, straight off disk.
    fetch: async (url) => {
      const name = String(url).replace('https://huntersim.local/', '').split('?')[0];
      const file = path.join(PUBLIC, name);
      if (!fs.existsSync(file)) throw new Error(`fetch shim: no such asset ${url}`);
      const buf = fs.readFileSync(file);
      return {
        ok: true,
        json: async () => JSON.parse(buf.toString('utf8')),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    },
  };
  // optimizer/search.js is in this list because storeSchema.js DERIVES the shipped optimize
  // effort from HunterOptimizer.DEFAULT_EFFORT rather than restating it. Without it the store
  // cannot be constructed at all -- which is the intended behaviour: the alternative was a
  // silent second declaration that disagreed with the optimizer for who knows how long.
  //
  // shipsPage.js owns the Fleet store shapes that storeSchema.js references, so it has to load
  // here too. It is a UI module: give it just enough of a DOM to reach its top-level exports
  // without executing any rendering (nothing here calls a render function).
  // shipsPage.js binds click handlers at module scope (document.getElementById(x).onclick = ...),
  // so the stub must return an inert ELEMENT rather than null or loading throws immediately.
  const makeEl = () => ({
    style: {},
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    closest: () => null,
  });
  sb.document = {
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {},
    body: makeEl(),
  };
  sb.navigator = { hardwareConcurrency: 4 };
  sb.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sb.window = sb;
  sb.self = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  for (const f of ['hunterDefs.js', 'shipSchema.js', 'shipsPage.js', 'buildCode.js', 'costFormulas.js', 'hunterSimBrowser.js', 'optimizer/space.js', 'optimizer/objective.js', 'optimizer/search.js', 'storeSchema.js', 'saveImport.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), sb, { filename: f });
  }
  sandbox = sb;
  return sb;
}

// The optimizer modules are plain CommonJS-compatible, so Node requires them directly -- the
// same files the browser loads via <script>.
const Space = require('../../webapp/public/optimizer/space.js');
const Optimizer = require('../../webapp/public/optimizer/search.js');
const Objective = require('../../webapp/public/optimizer/objective.js');

/** Decode a real cifi-tools.com share code into a build. */
async function parseBuildCode(code) {
  const sb = browserSandbox();
  return sb.parseBuildCode(code);
}

function hunterDefs() {
  return browserSandbox().HUNTER_DEFS;
}

/**
 * Build the optimizer cfg for an imported build, mirroring app.js's cfgFor().
 *
 * TWO BUDGET MODES, and the difference is not cosmetic.
 *
 * 'spend' (default) sets the budget to what the import ACTUALLY SPENT. That is the honest
 * apples-to-apples test of allocation quality: a build that left points unspent would otherwise
 * hand the optimizer extra budget and turn the comparison into a free win.
 *
 * 'level' sets it from talentBudgetForLevel/attributeBudgetForLevel -- what the REAL APP does.
 *
 * Running only 'spend' is what let an under-spend bug reach a user while the gate reported
 * 182/182 "as good or better". No share code encodes `lvl`, so parseBuildCode infers
 * level = sum(talent levels); with budget then set to that same spend, budget and spend are
 * IDENTICAL in every fixture and an under-spent incumbent is unconstructible. The gate was
 * structurally blind to the entire failure mode -- measured, not guessed: 0 of 182 fixtures
 * could produce one. 'level' mode is what exercises the path the app actually takes.
 */
function cfgForImport(hunter, build, { budgetMode = 'spend' } = {}) {
  const d = hunterDefs()[hunter];
  const overrides = { ...build.overrides, ...build.upgradeOverrides };

  // Same advanced-talent rule as cfgFor(): an advanced talent is only available to the search
  // if the build being compared against already has points in it.
  //
  // Caps must be RESOLVED for this build's context, not read raw: Borge's Call Me Lucky Loot
  // caps at 12 rather than 10 once Attraction gem node 2 is active, and two real fixtures carry
  // ll=12. Reading the static maxLevel made the optimizer reject its own (legal) incumbent.
  const ctx = { buildOverrides: overrides, gemPlannerStore: { gemStates: {} } };
  const sb = browserSandbox();
  const talents = sb.resolveMaxLevels(
    d.talents.filter((t) => !t.advanced || (build.talents[t.id] || 0) > 0), ctx,
  );
  const attributes = sb.resolveMaxLevels(d.attributes, ctx);

  const talentSpent = talents.reduce((s, t) => s + (build.talents[t.id] || 0), 0);
  const attrSpent = Space.costOf(attributes, build.attributes);
  const sb2 = browserSandbox();
  const talentBudget = budgetMode === 'level' ? sb2.talentBudgetForLevel(build.level) : talentSpent;
  const attrBudget = budgetMode === 'level' ? sb2.attributeBudgetForLevel(build.level) : attrSpent;

  return {
    hunter,
    level: build.level,
    hunterStats: {},
    globalUpgrades: {},
    gemPlannerStore: { gemStates: {} },
    baseOverrides: overrides,
    TALENTS: talents,
    ATTRIBUTES: attributes,
    ATTRIBUTE_DEPENDENCIES: d.attributeDependencies,
    ATTRIBUTE_MIN_VALUE: d.attributeMinValue,
    TALENT_BUDGET: talentBudget,
    ATTRIBUTE_BUDGET: attrBudget,
  };
}

/** A scorer backed by the shipped compileEvaluator -- the exact evaluation path the app uses. */
async function makeScorer(cfg, mode, ctxOverride) {
  const sb = browserSandbox();
  const evalFast = await sb.HunterSim.compileEvaluator(cfg.hunter, cfg);
  // Same one definition the browser worker uses, so the bench and the app cannot disagree about
  // which boss is being aimed at.
  const ctx = { ...Objective.contextFor(cfg), ...(ctxOverride || {}) };
  return async function score(pairs, iterations) {
    const out = [];
    // Boss progress rides alongside the score, exactly as the browser pool does it, so a bench and
    // the app cannot disagree about what the search can see.
    const boss = [];
    for (const p of pairs) {
      const r = await evalFast(p.talentAlloc, p.attrAlloc, iterations);
      // Same canonical objective the browser workers use -- not a second copy of the mode rules.
      out.push(Objective.scoreFor(mode, r, ctx));
      boss.push({ kill: r.bossKillRate, hp: r.bossHpPercent, maxStage: r.maxStage });
    }
    out.boss = boss;
    return out;
  };
}


/** Score one specific allocation at full fidelity. */
async function scoreAllocation(cfg, mode, talentAlloc, attrAlloc, iterations = Optimizer.FINAL_ITERATIONS) {
  const score = await makeScorer(cfg, mode);
  const [value] = await score([{ talentAlloc, attrAlloc }], iterations);
  return value;
}

/**
 * Full evaluation of one allocation -- loot per minute AND average stage together, from a
 * single run. The gate needs both: an optimizer told to maximize loot must not be allowed to
 * quietly gut stage progression, and a push build is judged on stage in the first place.
 */
async function evaluateAllocation(cfg, talentAlloc, attrAlloc, iterations = Optimizer.FINAL_ITERATIONS) {
  const sb = browserSandbox();
  const evalFast = await sb.HunterSim.compileEvaluator(cfg.hunter, cfg);
  const r = await evalFast(talentAlloc, attrAlloc, iterations);
  // EVERY field, not a chosen three. The old shape was `{loot, stage, time}`, and dropping the
  // rest actively caused a misdiagnosis: on a Knox build where nine different search methods all
  // returned ~6,900 against an import of 64,031, the entire explanation was `bossKillRate 93.5`
  // vs `0` -- a field this function did not return, so the investigation went looking for a search
  // defect that was not there. Same failure as relic-sweep.js calling r7 inert while watching only
  // loot. `loot`/`stage`/`time` are kept as aliases so existing callers are untouched.
  return {
    loot: r.lootPerMin, stage: r.avgStage, time: r.avgTime,
    lootPerMin: r.lootPerMin, avgStage: r.avgStage, avgTime: r.avgTime,
    minStage: r.minStage, maxStage: r.maxStage,
    bossHpPercent: r.bossHpPercent, bossKillRate: r.bossKillRate,
    mat1: r.mat1, mat2: r.mat2, mat3: r.mat3, xp: r.xp,
  };
}

/**
 * Every known build fixture, tagged with its hunter and the mode it should be judged in.
 *
 * The fixture files export several arrays each -- the main loot-score progression plus
 * "*_PUSH_BUILDS" (builds tuned for stage push, not loot) and Borge's "*_LATE_BUILDS". A push
 * build must be compared on average stage, not loot per minute, or the benchmark would mark a
 * perfectly good build as a failure for the wrong objective. Mode is derived from the export
 * name so a new fixture array is picked up automatically.
 */
/**
 * Find one fixture by a user-supplied name, refusing to guess when the name is ambiguous.
 *
 * Accepts the unique `uid` (`borge:KNOWN_BORGE_LATE_BUILDS#2`), a `hunter#index` shorthand, or a
 * `hunter:SET#index`. The shorthand THROWS when it matches more than one fixture rather than
 * taking the first -- silently investigating a different build than the one a gate flagged is
 * worse than failing.
 */
function findFixture(all, name) {
  const flat = Object.values(all).flat();
  // The level-based name is the preferred form: `knox@31` is a level 31 Knox.
  const byName = flat.filter((f) => f.name === name);
  if (byName.length === 1) return byName[0];
  const exact = flat.filter((f) => f.uid === name);
  if (exact.length === 1) return exact[0];
  const m = /^([a-z]+)(?::([A-Z_]+))?#(\d+)$/.exec(name);
  if (!m) throw new Error(`unrecognised fixture name "${name}" (want hunter#index or hunter:SET#index)`);
  const [, hunter, set, idx] = m;
  const hits = flat.filter((f) => f.hunter === hunter && f.index === Number(idx)
    && (!set || f.set === set));
  if (!hits.length) throw new Error(`no fixture "${name}"`);
  if (hits.length > 1) {
    throw new Error(`"${name}" is ambiguous -- ${hits.length} fixtures share it: `
      + `${hits.map((f) => f.uid).join(', ')}. Name one exactly.`);
  }
  return hits[0];
}

/**
 * The NEWEST decoded save under tools/gamefiles/save, or null when none is pulled.
 *
 * Benches used to do `readdirSync(...).filter(startsWith('decoded-'))[0]`, which is directory
 * order -- so the moment a second save was pulled, every one of them silently kept testing
 * against the OLDER account state while reporting as though it were current. Sorted descending
 * by filename, which is date-ordered by the `decoded-YYYYMMDD.json` convention.
 */
function latestDecodedSave() {
  const dir = path.join(__dirname, '../gamefiles/save');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('decoded-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return null;
  return { path: path.join(dir, files[0]), name: files[0] };
}

function loadKnownBuilds() {
  const dir = path.join(__dirname, '../../compare-mcp');
  const files = {
    borge: 'known-builds.mjs',
    ozzy: 'known-builds-ozzy.mjs',
    knox: 'known-builds-knox.mjs',
  };
  const out = {};
  for (const [hunter, file] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const entries = [];
    const re = /export\s+const\s+(\w+)\s*=\s*(\[)/g;
    let m;
    while ((m = re.exec(src))) {
      // Walk from the opening bracket to its match so nested brackets/strings don't truncate.
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) throw new Error(`Unterminated array for ${m[1]} in ${file}`);
      const arr = vm.runInNewContext(src.slice(open, end + 1));
      const mode = /_PUSH_/.test(m[1]) ? 'push' : 'loot';
      // `index` is the position WITHIN a set and is NOT unique per hunter: Borge's loot fixtures
      // run 0-61 in KNOWN_BORGE_BUILDS and 0-10 again in KNOWN_BORGE_LATE_BUILDS, and Ozzy's
      // collide over 0-4. A bench that identifies a build as "borge#2" therefore names two
      // different builds, and any `find(f => f.index === n)` silently takes whichever was loaded
      // first -- so a gate could flag one build and the diagnostic could investigate another.
      // `uid` is the unique name; use it for reporting and selection.
      arr.forEach((b, i) => entries.push({
        ...b, hunter, mode, set: m[1], index: i, uid: `${hunter}:${m[1]}#${i}`,
      }));
    }
    // NAME FIXTURES BY LEVEL, NOT BY ARRAY POSITION.
    //
    // `#22` was an index. It reads as a level and is not one -- knox#22 is a LEVEL 31 build, and
    // that cost real time: a whole debugging session ran against a level-31 fixture while the
    // build being compared against was level 22. An identifier that looks like a level must be
    // one.
    //
    // Several builds can share a level, so collisions get a letter suffix in load order
    // (knox@31, knox@31b, knox@31c). `uid` stays as it was -- it is the unique array address and
    // some notes reference it -- but `name` is what benches print and accept.
    const byLevel = new Map();
    for (const e of entries) {
      const lvl = Number(e.level) || 0;
      const seen = byLevel.get(lvl) || 0;
      byLevel.set(lvl, seen + 1);
      e.name = `${hunter}@${lvl}${seen ? String.fromCharCode(97 + seen) : ''}`;
    }
    out[hunter] = entries;
  }
  return out;
}

module.exports = {
  browserSandbox, parseBuildCode, hunterDefs, cfgForImport, makeScorer, scoreAllocation,
  latestDecodedSave,
  findFixture,
  loadKnownBuilds, evaluateAllocation, Space, Optimizer, Objective,
};
