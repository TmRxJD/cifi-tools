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
  for (const f of ['hunterDefs.js', 'shipSchema.js', 'shipsPage.js', 'buildCode.js', 'hunterSimBrowser.js', 'optimizer/space.js', 'storeSchema.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), sb, { filename: f });
  }
  sandbox = sb;
  return sb;
}

// The optimizer modules are plain CommonJS-compatible, so Node requires them directly -- the
// same files the browser loads via <script>.
const Space = require('../../webapp/public/optimizer/space.js');
const Optimizer = require('../../webapp/public/optimizer/search.js');

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
 * Budgets deliberately come from what the IMPORT ACTUALLY SPENT, not from
 * talentBudgetForLevel/attributeBudgetForLevel. A community build that left points unspent
 * would otherwise hand the optimizer extra budget and turn the comparison into a free win;
 * matching the import's own spend is the honest apples-to-apples test of allocation quality.
 */
function cfgForImport(hunter, build) {
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
    TALENT_BUDGET: talentSpent,
    ATTRIBUTE_BUDGET: attrSpent,
    currentTalents: build.talents,
    currentAttrs: build.attributes,
  };
}

/** A scorer backed by the shipped compileEvaluator -- the exact evaluation path the app uses. */
async function makeScorer(cfg, mode) {
  const sb = browserSandbox();
  const evalFast = await sb.HunterSim.compileEvaluator(cfg.hunter, cfg);
  return async function score(pairs, iterations) {
    const out = [];
    for (const p of pairs) {
      const r = await evalFast(p.talentAlloc, p.attrAlloc, iterations);
      out.push(mode === 'push' ? r.avgStage : r.lootPerMin);
    }
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
  return { loot: r.lootPerMin, stage: r.avgStage, time: r.avgTime };
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
      arr.forEach((b, i) => entries.push({ ...b, hunter, mode, set: m[1], index: i }));
    }
    out[hunter] = entries;
  }
  return out;
}

module.exports = {
  browserSandbox, parseBuildCode, hunterDefs, cfgForImport, makeScorer, scoreAllocation,
  loadKnownBuilds, evaluateAllocation, Space, Optimizer,
};
