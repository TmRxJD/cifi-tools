'use strict';

// Fresh-install defaults -- deliberately all-zero/agnostic. An earlier version of this file
// seeded these from one specific real account's own captured localStorage (specific
// non-zero relic/inscryption/milestone/loot-multiplier levels), which meant every NEW install
// of this tool silently started with someone else's progression baked in, and -- worse --
// any field a user hadn't gotten around to re-configuring on the Gems/Upgrades pages kept
// contributing that stranger's numbers to their own sim results indefinitely. This surfaced
// as a real, measurable bug: several "pure loot" fields (hunterloot, ultima, scavenger2,
// milestone count, iridian/gaiden cards, gem loot-bonus nodes) are deliberately excluded from
// build-share codes since they don't move Loot SCORE, but they very much move the raw
// mat1/mat2/mat3/xp yield shown on a build card -- confirmed directly: evaluating the exact
// same build with the old anchored defaults vs. all-zero inflated mat1 by ~1000x. Every field
// here must be filled in by the user (Gems page, Upgrades pages, Hunter Stats modal) to match
// their own real account -- there is no substitute "reasonable" non-zero default that isn't
// just some other account's data.
// "stage" (highest stage ever reached) is a required sim input, not just display -- the
// site's own EVAL_PARAMS list includes it (resolved from hunterStats.stage), and leaving
// it at 0 visibly breaks the simulation (flat 100-100 stage range with zero Monte Carlo
// variance). 1 is the minimal honest value true of any account, real or brand new.
const SEED_HUNTER_STATS = {
  borge: { hp: 0, atk: 0, regen: 0, dr: 0, evade: 0, effect: 0, critchance: 0, critpower: 0, atkspeed: 0, stage: 1 },
  ozzy: { hp: 0, atk: 0, regen: 0, dr: 0, evade: 0, effect: 0, multichance: 0, multipower: 0, atkspeed: 0, stage: 1 },
  knox: { hp: 0, atk: 0, regen: 0, dr: 0, block: 0, effect: 0, charge: 0, chargeGain: 0, reload: 0, proj: 0, stage: 1 },
};

const SEED_GLOBAL_UPGRADES = {};

// Every build id used to be `String(Date.now())` (optionally +hunterKey), which collides
// whenever two builds get created/saved within the same millisecond -- e.g. running the
// optimizer, saving, then immediately importing another build. A collision means two builds
// share one id, so any id-keyed lookup (delete's `filter(b => b.id !== id)`, save's
// `findIndex(b => b.id === id)`) silently affects BOTH of them at once: deleting one build
// deleted another that happened to share its id (and, since duplicate/re-saved builds often
// share a name too, looked like "deleting by name"), and importing a new build could stomp an
// existing one it collided with. crypto.randomUUID() (or a random-suffix fallback on very old
// browsers) makes a collision astronomically unlikely instead of merely "unlikely within the
// same millisecond of normal clicking."
function genBuildId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const STORAGE_KEY = 'huntersim_clone_v2';
const DEFAULT_CATEGORIES = [{ id: 'active', name: 'Active', isSystem: true }, { id: 'archived', name: 'Archived', isSystem: true }];

function freshStore() {
  const perHunter = {};
  ['borge', 'ozzy', 'knox'].forEach((h) => { perHunter[h] = { hunterStats: { ...SEED_HUNTER_STATS[h] }, builds: [] }; });
  return {
    globalUpgrades: { ...SEED_GLOBAL_UPGRADES },
    gems: window.defaultGemState(),
    categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
    viewMode: 'vertical',
    ...perHunter,
  };
}

// One-time repair for data saved before genBuildId() existed: every build/category id used
// to be String(Date.now()) (optionally +hunterKey), which collides whenever two were
// created/saved within the same millisecond -- so an account that hit that bug before the
// fix can have ACTUAL duplicate ids already sitting in its saved data. Fixing the generator
// only prevents NEW collisions; it does nothing for ones already persisted, which is exactly
// why "delete one build with the same name deleted both" could still happen even after that
// fix landed -- the two builds already shared one id from before. Keeps the first occurrence
// of each id as-is and reassigns a fresh unique id to every later collision.
function dedupeIds(list) {
  const seen = new Set();
  let changed = false;
  for (const item of list) {
    if (!item || !item.id || seen.has(item.id)) {
      if (item) { item.id = genBuildId(); changed = true; }
    } else {
      seen.add(item.id);
    }
  }
  return changed;
}
function dedupeStoreIds(parsed) {
  let changed = dedupeIds(parsed.categories || []);
  ['borge', 'ozzy', 'knox'].forEach((h) => { if (dedupeIds(parsed[h]?.builds || [])) changed = true; });
  return changed;
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.gems) parsed.gems = window.defaultGemState();
      if (!parsed.categories) parsed.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
      if (!parsed.viewMode) parsed.viewMode = 'vertical';
      if (!parsed.knox) parsed.knox = { hunterStats: { ...SEED_HUNTER_STATS.knox }, builds: [] };
      if (dedupeStoreIds(parsed)) {
        // Persist the repair immediately rather than waiting for the next unrelated save --
        // otherwise a read-only session (just browsing, no edits) would silently re-detect
        // and "fix" the same already-in-memory duplicates every reload without ever writing
        // the correction back.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        idbSet(STORAGE_KEY, JSON.stringify(parsed));
      }
      return parsed;
    }
  } catch { /* fall through to defaults */ }
  __storeWasFreshOnLoad = true;
  return freshStore();
}

// Redundant persistence: testers reported losing all builds/settings after a "clear
// cache"/browser data-clear around an update -- some browsers (especially mobile) bundle
// localStorage into that clear even though it's technically "site data", not "cache". IndexedDB
// is stored separately from most browsers' quick "clear cache" action and often survives it, so
// every save is mirrored there too (fire-and-forget, never blocks the UI), and on startup -- if
// localStorage came back empty -- we fall back to whatever IndexedDB still has before giving up
// and seeding fresh defaults.
const IDB_NAME = 'huntersim_backup';
const IDB_STORE = 'kv';
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } catch { /* best effort only */ }
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch { return undefined; }
}
// True only when loadStore() had to fall back to fresh defaults (no usable localStorage
// data) -- gates the one-time IndexedDB recovery attempt at startup below.
let __storeWasFreshOnLoad = false;
function saveStore() {
  const json = JSON.stringify(store);
  localStorage.setItem(STORAGE_KEY, json);
  idbSet(STORAGE_KEY, json);
  updateNavGating();
}

// Confirmed exact from the live bundle's isUnlocked() (AppNavbar.vue): a gem tree level
// gate, plus an optional specific node (1-based) that must also be toggled on.
function isGemUnlocked(gemKey, lvl, node) {
  if (!gemKey || !lvl) return true;
  const state = store.gems[gemKey];
  if (!state) return false;
  if (state.level < lvl) return false;
  if (node !== undefined && !(state.nodes && state.nodes[node - 1])) return false;
  return true;
}
window.isGemUnlocked = isGemUnlocked;

// Hides hunter nav tabs + sidebar category links until their real unlock condition is met
// (Ozzy needs Exodus lvl2, Knox lvl4, Gadgets Exodus lvl4, Researches Innovation lvl2, CMs
// Power lvl2, Trinkets Creation lvl4 + node 5 -- all confirmed straight from Ld.hunters /
// Ld.upgradeCategories in the live bundle). If the active hunter/route becomes locked
// (e.g. the user lowers a gem level back down), falls back to Borge / the sim page.
function updateNavGating() {
  let activeHunterLocked = false;
  document.querySelectorAll('[data-unlock-gem]').forEach((el) => {
    const gem = el.dataset.unlockGem;
    const lvl = Number(el.dataset.unlockLvl);
    const node = el.dataset.unlockNode ? Number(el.dataset.unlockNode) : undefined;
    const unlocked = isGemUnlocked(gem, lvl, node);
    el.classList.toggle('hidden', !unlocked);
    if (!unlocked && el.dataset.nav === currentHunter) activeHunterLocked = true;
    if (!unlocked && el.dataset.route === currentRoute()) navigate('sim');
  });
  if (activeHunterLocked) switchHunter('borge');
}
window.updateNavGating = updateNavGating;

let store = loadStore();
let currentHunter = 'borge';
let editingBuild = null;
let showCategoryId = 'active';
try { window.__lastScan = JSON.parse(localStorage.getItem('huntersim_last_scan') || '{}'); } catch { window.__lastScan = {}; }

// One-time startup recovery: localStorage came back empty (freshStore() defaults), so check
// the IndexedDB mirror before the user ever sees the seeded defaults -- if it has real data,
// restore it, re-persist to localStorage, and re-render whatever's already on screen.
if (__storeWasFreshOnLoad) {
  idbGet(STORAGE_KEY).then((json) => {
    if (!json) return;
    try {
      const recovered = JSON.parse(json);
      if (!recovered.gems) recovered.gems = window.defaultGemState();
      if (!recovered.categories) recovered.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
      if (!recovered.viewMode) recovered.viewMode = 'vertical';
      if (!recovered.knox) recovered.knox = { hunterStats: { ...SEED_HUNTER_STATS.knox }, builds: [] };
      dedupeStoreIds(recovered);
      Object.keys(store).forEach((k) => delete store[k]);
      Object.assign(store, recovered);
      const repairedJson = JSON.stringify(recovered);
      localStorage.setItem(STORAGE_KEY, repairedJson);
      idbSet(STORAGE_KEY, repairedJson);
      if (typeof render === 'function') render();
    } catch { /* corrupt backup, ignore */ }
  });
}

function defs() { return window.HUNTER_DEFS[currentHunter]; }
function budgetsForLevel(level) { return { talentBudget: window.talentBudgetForLevel(level), attributeBudget: window.attributeBudgetForLevel(level) }; }

const MAT_LABELS = ['Obsidian', 'Behlium', 'Hellish-Biomatter'];
const HUNTER_TITLES = { borge: 'Borge Simulator', ozzy: 'Ozzy Simulator', knox: 'Knox Simulator' };
const HUNTER_ACCENTS = { borge: 'red', ozzy: 'green', knox: 'blue' };

function newDraftBuild() {
  const talents = {}; defs().talents.forEach((t) => { talents[t.id] = 0; });
  const attributes = {}; defs().attributes.forEach((a) => { attributes[a.id] = 0; });
  return { id: null, name: '', level: 1, talents, attributes, categoryId: 'active', overrides: {} };
}

function cfgFor(hunter, build) {
  const d = window.HUNTER_DEFS[hunter];
  const { talentBudget, attributeBudget } = budgetsForLevel(build.level);
  const mergedUpgrades = window.buildNestedUpgrades(store.globalUpgrades);
  // The optimizer/beam search must never allocate points into an advanced talent (e.g. The
  // Legacy of Ultima) that isn't unlocked yet -- it was previously getting the FULL
  // unfiltered talent list, so "Optimize within budget" could spend points there even while
  // the talent stayed hidden in the editor, skewing the rest of the distribution. Existing
  // points already in an advanced talent are kept (it's still a valid current allocation),
  // just no NEW points get assigned unless the talent is actually visible/unlocked.
  const showAdvanced = shouldShowAdvancedTalents(hunter);
  const talents = d.talents.filter((t) => !t.advanced || showAdvanced || (build.talents[t.id] || 0) > 0);
  return {
    hunter, level: build.level, hunterStats: store[hunter].hunterStats,
    globalUpgrades: mergedUpgrades, gemPlannerStore: { gemStates: store.gems }, baseOverrides: build.overrides || {},
    TALENTS: talents, ATTRIBUTES: d.attributes,
    ATTRIBUTE_DEPENDENCIES: d.attributeDependencies, ATTRIBUTE_MIN_VALUE: d.attributeMinValue,
    TALENT_BUDGET: talentBudget, ATTRIBUTE_BUDGET: attributeBudget,
    currentTalents: build.talents, currentAttrs: build.attributes,
  };
}

function fmt(n) {
  if (n === undefined || n === null) return '-';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return n.toFixed(2);
}
function fmtTime(minutes) {
  if (!minutes) return '-';
  const h = Math.floor(minutes / 60); const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Verbatim port of the live site's "Clone Build" naming rule (confirmed directly: cloning
// "Borge Loot" gives "Borge Loot (Copy)"; cloning THAT gives "Borge Loot (Copy 2)"; cloning
// again gives "(Copy 3)", etc.) -- based on the SOURCE build's own name, not a scan for
// name collisions across the list.
function nextCopyName(name) {
  const m = name.match(/^(.*) \(Copy(?: (\d+))?\)$/);
  if (!m) return `${name} (Copy)`;
  const n = m[2] ? parseInt(m[2], 10) + 1 : 2;
  return `${m[1]} (Copy ${n})`;
}

// ==================== ROUTER ====================

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  return hash || 'sim';
}

function navigate(route) { location.hash = `#/${route}`; }

function render() {
  const route = currentRoute();
  updateNavGating();
  const milestoneLabel = document.getElementById('milestoneSidebarLabel');
  if (milestoneLabel) milestoneLabel.textContent = `Milestone #0 (${store.globalUpgrades['shardmilestones.m0'] || 0})`;
  document.querySelectorAll('.sidebar-link').forEach((el) => {
    el.classList.toggle('bg-gray-800', el.dataset.route === route);
    el.classList.toggle('text-white', el.dataset.route === route);
  });
  const root = document.getElementById('pageRoot');
  if (route === 'gems') { renderGemsPage(root); return; }
  if (route === 'settings') { renderSettingsPage(root); return; }
  if (route.startsWith('upgrades/')) { renderUpgradesPage(root, route.slice('upgrades/'.length)); return; }
  renderSimPage(root);
}
window.addEventListener('hashchange', render);

// ==================== SIMULATOR PAGE ====================

function renderSimPage(root) {
  root.innerHTML = `
    <div class="mb-6 rounded-lg overflow-hidden shadow-lg">
      <div id="hunterBanner" class="bg-gradient-to-r from-red-900 to-gray-800 px-5 py-5 sm:py-0.5 border-b border-gray-600">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <div class="hidden sm:flex items-center justify-center">
              <img id="hunterPortrait" src="assets/hunter_borge.png" alt="Borge" class="object-contain rounded-lg select-none w-16 h-16" draggable="false" style="filter: drop-shadow(rgba(0,0,0,0.5) 0px 0px 4px);" />
            </div>
            <div>
              <h1 id="hunterTitle" class="text-2xl font-bold mb-1">Borge Simulator</h1>
              <p class="text-sm text-gray-300">Compare builds and optimize your performance</p>
            </div>
          </div>
          <div class="flex flex-row flex-wrap justify-end gap-2">
            <button id="hunterStatsBtn" class="flex items-center space-x-1 px-3 py-2 rounded-full bg-gradient-to-r from-blue-500 to-blue-700 hover:from-blue-600 hover:to-blue-800 text-white font-semibold shadow-lg transition-colors duration-200 text-xs sm:text-sm">${iconSvg('chart-arrows-vertical', 16)}<span id="hunterStatsBtnLabel">Borge Stats</span></button>
            <button id="newBuildBtn" class="flex items-center space-x-1 px-3 py-2 rounded-full bg-gradient-to-r from-gray-500 to-gray-700 hover:from-gray-600 hover:to-gray-800 text-white font-semibold shadow-lg transition-colors duration-200 text-xs sm:text-sm">${iconSvg('plus', 16)}<span>New Build</span></button>
            <button id="importBtn" class="flex items-center space-x-1 px-3 py-2 rounded-full bg-gradient-to-r from-blue-500 to-blue-700 hover:from-blue-600 hover:to-blue-800 text-white font-semibold shadow-lg transition-colors duration-200 text-xs sm:text-sm">${iconSvg('download', 16)}<span>Import</span></button>
          </div>
        </div>
      </div>
      <div class="bg-gray-800 py-3 px-4 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm text-gray-400">Settings:</span>
          <label class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors cursor-pointer">
            ${iconSvg('repeat', 14, 'text-blue-400')}
            <input id="baseIterations" type="number" value="1000" min="100" step="100" class="w-16 bg-transparent text-white focus:outline-none" />
            <span>iterations</span>
          </label>
          <button id="manageCategoriesBtn" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">${iconSvg('folder', 14, 'text-blue-400')}<span>Manage Categories</span></button>
          <button id="viewVerticalBtn" class="flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors" title="Vertical View">${iconSvg('layout-distribute-vertical', 14)}<span>Vertical</span></button>
          <button id="viewHorizontalBtn" class="flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors" title="Horizontal View">${iconSvg('layout-distribute-horizontal', 14)}<span>Horizontal</span></button>
        </div>
        <button id="temporaryUpgradesBtn" class="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg border border-gray-600 transition-colors">${iconSvg('clock', 16)}<span class="text-sm font-medium">Temporary Upgrades</span></button>
      </div>
      <div class="flex items-stretch bg-gray-900 border-b border-gray-700 overflow-x-auto" id="categoryTabs"></div>
    </div>
    <div id="buildList" class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));"></div>`;

  switchHunter(currentHunter, true);
  document.getElementById('newBuildBtn').onclick = () => openBuildModal(newDraftBuild());
  document.getElementById('importBtn').onclick = () => document.getElementById('importModal').classList.remove('hidden');
  document.getElementById('hunterStatsBtn').onclick = openStatsModal;
  document.getElementById('hunterStatsBtnLabel').textContent = `${HUNTER_TITLES[currentHunter].replace(' Simulator', '')} Stats`;
  document.getElementById('manageCategoriesBtn').onclick = openCategoriesModal;
  document.getElementById('temporaryUpgradesBtn').onclick = openTemporaryModal;
  document.getElementById('baseIterations').addEventListener('change', renderBuildList);
  document.getElementById('viewVerticalBtn').onclick = () => setViewMode('vertical');
  document.getElementById('viewHorizontalBtn').onclick = () => setViewMode('horizontal');
  updateViewModeButtons();
  renderCategoryTabs();
  renderBuildList();
}

function setViewMode(mode) { store.viewMode = mode; saveStore(); updateViewModeButtons(); renderBuildList(); }
function updateViewModeButtons() {
  const v = document.getElementById('viewVerticalBtn'); const h = document.getElementById('viewHorizontalBtn');
  if (!v || !h) return;
  v.className = `flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors ${store.viewMode === 'vertical' ? 'bg-gradient-to-r from-blue-500 to-blue-700 text-white font-semibold shadow-lg' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`;
  h.className = `flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors ${store.viewMode === 'horizontal' ? 'bg-gradient-to-r from-blue-500 to-blue-700 text-white font-semibold shadow-lg' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`;
}

function renderCategoryTabs() {
  const wrap = document.getElementById('categoryTabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  store.categories.forEach((cat) => {
    const count = store[currentHunter].builds.filter((b) => (b.categoryId || 'active') === cat.id).length;
    const zone = document.createElement('div');
    zone.className = 'category-drop-zone relative flex-shrink-0';
    zone.dataset.categoryId = cat.id;
    const active = showCategoryId === cat.id;
    zone.innerHTML = `<button class="relative px-4 py-3 font-semibold text-sm transition-all duration-200 border-r border-gray-800 whitespace-nowrap ${active ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/40'}">
        <div class="flex items-center gap-2">${iconSvg('folder', 18, active ? 'text-blue-400' : 'text-gray-600')}<span>${escapeHtml(cat.name)}</span>
          <div class="ml-2 px-2.5 py-0.5 text-xs font-bold rounded-md ${active ? 'bg-blue-500 text-blue-100 border border-blue-400' : 'bg-gray-800 text-gray-600 border border-gray-700'}">${count}</div>
        </div>
        ${active ? '<div class="absolute bottom-0 left-0 right-0 h-1 rounded-t-sm bg-blue-500"></div>' : ''}
      </button>`;
    zone.querySelector('button').onclick = () => { showCategoryId = cat.id; renderCategoryTabs(); renderBuildList(); };
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const buildId = e.dataTransfer.getData('text/build-id');
      const build = store[currentHunter].builds.find((b) => b.id === buildId);
      if (build) { build.categoryId = cat.id; saveStore(); renderCategoryTabs(); renderBuildList(); }
    });
    wrap.appendChild(zone);
  });
}

const MAT_ASSETS = ['assets/loot_mat1.png', 'assets/loot_mat2.png', 'assets/loot_mat3.png'];
const MAT_BORDER_COLORS = ['border-red-600/30', 'border-orange-600/30', 'border-amber-600/30', 'border-blue-600/30'];
const MAT_TEXT_COLORS = ['text-red-300', 'text-orange-300', 'text-amber-300', 'text-blue-300'];

// Small <img>/icon for a cost-formula resource key (mat1/mat2/mat3 use the same real loot
// material art the build cards show; Fragments/Hellish-Biomatter have no local asset since
// they never appear in the sim's own loot output, so they fall back to a generic icon).
function matIcon(resKey) {
  const idx = { mat1: 0, mat2: 1, mat3: 2 }[resKey];
  if (idx !== undefined) return `<img src="${MAT_ASSETS[idx]}" alt="${resKey}" class="w-4 h-4 inline-block" />`;
  return iconSvg(resKey === 'frags' ? 'sparkles' : 'crown', 14, 'text-purple-300');
}

// Re-confirmed directly against the live site's CURRENT rendered DOM (button titles/order
// read straight off a live card): the Lvl badge, "View override costs" (red circle), and
// "Re-evaluate Build" (gray circle) are absolute-positioned in the header's top-right corner
// (Lvl to the left, the two circles stacked top-1.5/top-8 at the far right) -- rendered
// directly in the card template now, not from this list. The action bar is a single centered
// row with these 8 buttons; "Screenshot to clipboard" lives separately, inline with the
// "Main Statistics" section title (confirmed: only one camera icon exists on the whole card,
// and it's there, not in the action bar).
const ACTION_BUTTONS = [
  { act: 'edit', icon: 'edit', title: 'Edit build' },
  { act: 'dup', icon: 'copy', title: 'Copy build' },
  { act: 'overrides', icon: 'adjustments-horizontal', title: 'Overrides' },
  { act: 'compareEfficiency', icon: 'scale', title: 'Compare upgrade efficiency' },
  { act: 'buildStats', icon: 'chart-bar', title: 'Show Build Statistics' },
  { act: 'export', icon: 'share', title: 'Share build code' },
  { act: 'archive', icon: 'archive', title: 'Archive build' },
  { act: 'delete', icon: 'trash', title: 'Delete build', extra: 'hover:text-red-400' },
];
const SECOND_ROW_BUTTONS = [
  { act: 'screenshot', icon: 'camera', title: 'Screenshot to clipboard' },
];

// The live site lets each build override the account's GLOBAL upgrade values (e.g. a build
// planned around spending diamonds/currency to push ATK Speed, an inscription level, or a
// gem's catch-up power above the account's current value) -- confirmed via a live build
// ("Borge Loot") whose HP Regen/Evade/Effect/Crit Chance/ATK Speed AND an inscription level
// and gem catch-up value all differed from the account's global state. Grouped here the
// same way the live site's Overrides panel groups them (Base Stats / Relics / Inscryptions
// / Loop Mods / Diamond Specials / Diamond Cards / Gem Nodes), each row showing the
// account's current global value alongside the override input, matching the live UI.
const BASE_STAT_LABELS = {
  hp: 'Max HP', atk: 'ATK Power', regen: 'HP Regen', dr: 'DMG Reduction',
  evade: 'Evade Chance', effect: 'Effect Chance',
  critchance: 'Crit Chance', critpower: 'Crit Power', atkspeed: 'ATK Speed',
  multichance: 'Multistrike Chance', multipower: 'Multistrike Power',
  block: 'Block Chance', charge: 'Charge Chance', chargeGain: 'Charge Gained', reload: 'Reload Time',
  proj: 'Projectiles Per Salvo',
};

// Built per-hunter (Base Stats / Relics / Inscryptions read straight from HUNTER_DEFS so
// Ozzy/Knox get their OWN relic and inscription ID lists -- these are NOT shared with
// Borge's; e.g. Ozzy's relics are r4/r7/r17/t2r7, not Borge's r4/r7/r16/r19, and each
// hunter's inscription IDs are entirely disjoint). Loop Mods/Diamond Specials/Diamond
// Cards/Gem Nodes below are still Borge-specific (Ozzy uses "Construction Milestones"
// instead of "Loop Mods" with different fields, which hasn't been mapped out yet) -- rather
// than show mismatched fields for other hunters, those groups are Borge-only for now.
function getOverrideGroups() {
  const d = defs();
  const groups = [
    {
      title: 'Base Stats',
      fields: d.baseStatKeys.filter((k) => k !== 'stage' && k !== 'proj').map((key) => ({
        key, label: BASE_STAT_LABELS[key] || key, global: () => store[currentHunter].hunterStats[key],
      })),
    },
  ];
  const relics = d.globalUpgrades?.relics?.items || [];
  if (relics.length) {
    groups.push({
      title: 'Relics',
      fields: relics.map((r) => ({
        key: `upgrades.relics.${r.id}`, label: r.label, global: () => store.globalUpgrades[`relics.${r.id}`],
      })),
    });
  }
  const inscryptions = d.globalUpgrades?.inscryptions?.items || [];
  if (inscryptions.length) {
    groups.push({
      title: 'Inscryptions',
      fields: inscryptions.map((i) => ({
        key: `upgrades.inscryptions.${i.id}`, label: i.label, global: () => store.globalUpgrades[`inscryptions.${i.id}`],
      })),
    });
  }
  // Gadgets (Wrench/Zaptron/Anchor) were missing from this panel entirely -- the live site's
  // Overrides editor has its own priced Gadgets section (confirmed via its `O()`/cost-badge
  // function, which has a whole branch for "upgrades.gadgets." keys).
  const GADGET_BY_HUNTER = { borge: { id: 'wrench', label: 'The Wrench of Gore' }, ozzy: { id: 'zaptron', label: 'Zaptron-533 Bio-Repair Tool' }, knox: { id: 'anchor', label: 'The Anchor of Ages' } };
  const gadget = GADGET_BY_HUNTER[currentHunter];
  if (gadget) {
    groups.push({
      title: 'Gadgets',
      fields: [{ key: `upgrades.gadgets.${gadget.id}`, label: gadget.label, global: () => store.globalUpgrades[`gadgets.${gadget.id}`] }],
    });
  }
  if (currentHunter === 'borge') {
    groups.push(
      {
        title: 'Loop Mods',
        fields: [
          { key: 'upgrades.loopmods.trample', label: 'Trample: Borge', toggle: true, global: () => store.globalUpgrades['loopmods.trample'] },
          { key: 'upgrades.loopmods.scavenger', label: "Scavenger's Advantage", global: () => store.globalUpgrades['loopmods.scavenger'] },
          { key: 'upgrades.loopmods.stelzi', label: 'Mutual Mining Agreement: The Stelzi', global: () => store.globalUpgrades['loopmods.stelzi'] },
        ],
      },
      {
        title: 'Diamond Specials',
        fields: [
          { key: 'upgrades.diamondspecials.hunterloot', label: 'Hunter Loot Booster', global: () => store.globalUpgrades['diamondspecials.hunterloot'] },
          { key: 'upgrades.diamondspecials.reviveboost', label: 'Revive Boost', global: () => store.globalUpgrades['diamondspecials.reviveboost'] },
        ],
      },
      {
        title: 'Diamond Cards',
        fields: [
          { key: 'upgrades.diamondcards.gaiden', label: 'Gaiden Card', toggle: true, global: () => store.globalUpgrades['diamondcards.gaiden'] },
          { key: 'upgrades.diamondcards.iridian', label: 'Iridian Card', toggle: true, global: () => store.globalUpgrades['diamondcards.iridian'] },
        ],
      },
      {
        title: 'Gem Nodes & Upgrades',
        fields: [
          { key: 'upgrades.gems_nodes.attraction_level', label: 'Attraction Gem Level', global: () => store.gems?.attraction?.level },
          { key: 'upgrades.gems_nodes.attraction_catchUp', label: 'Attraction Catch-Up Power', global: () => store.gems?.attraction?.upgrades?.['catch-up-power-borge-ozzy'] },
          { key: 'upgrades.gems_nodes.attraction_lootBorge', label: 'Attraction Loot (Borge)', global: () => store.gems?.attraction?.upgrades?.['borge-loot-bonus'] },
        ],
      },
    );
  }
  return groups;
}

// Verbatim port of the live Overrides panel's row template (captured via outerHTML from
// cifi-tools.com): a numeric row is a double-chevron (jump) + single-chevron (step)
// stepper on each side of a read-only value box -- unlike the Build Creator card, this one
// DOES have the << / >> jump buttons -- and a boolean row is a global ON/OFF badge next to
// a single toggle pill button. Classes copied 1:1 from the live DOM.
// Resolves which resource (mat1/mat2/mat3/frags/hbm) a given Overrides-panel field key
// costs, for the current hunter -- used to show the same material icon next to each row
// that the live site's panel does (previously missing entirely).
function overrideFieldResource(key) {
  const CF = window.CostFormulas;
  if (key.startsWith('upgrades.relics.')) return CF.relicResource(currentHunter);
  if (key.startsWith('upgrades.inscryptions.')) return CF.inscryptionResource(currentHunter);
  if (key.startsWith('upgrades.')) return null;
  return CF.baseStatResource(currentHunter, key);
}

// Verbatim port of the live Overrides panel's `A(e)` (is this row eligible to show a "Cost:"
// badge at all) and `O(e)` (the cost itself) -- extracted directly from
// cifi-tools.com/assets/index-CBtvNH_D.js. The live panel does NOT show every row's diff as
// a cost: only baseStats/relics/gadgets/inscryptions/gems_nodes rows, only while an override
// is actually set, and only when it's a POSITIVE difference (current > global) -- a lowered
// override still shows red/green value coloring but never a Cost badge, since you can't
// "buy" your way down. "stage"/"proj" are excluded entirely (matches `A(e)`'s first check).
// Our clone previously showed no Cost badge at all for any row, which is the actual bug being
// fixed here -- not a sign-based row *filter* (the live site never hides rows by sign).
function overrideCostEligible(key, current, globalVal) {
  if (key === 'stage' || key === 'proj') return false;
  if (current === '' || current <= globalVal) return false;
  return !key.startsWith('upgrades.') || key.startsWith('upgrades.relics.') || key.startsWith('upgrades.gadgets.')
    || key.startsWith('upgrades.inscryptions.') || key.startsWith('upgrades.gems_nodes.');
}

// Extracts a gems_nodes field's named-upgrade alias the same way resolveParam
// (hunterSimBrowser.js) does: split at the FIRST underscore (gemName_alias, e.g.
// "attraction_lootBorge" -> "lootBorge"), then look up the one shared canonical table
// (window.GEM_UPGRADE_ALIASES, defined in hunterDefs.js) instead of hand-listing every
// gemName+alias combination in a separate table here -- that hardcoded list previously had
// to be kept in sync by hand and would silently miss any new tree/alias pairing.
function gemFieldAlias(field) {
  const us = field.indexOf('_');
  if (us <= 0) return null;
  const suffix = field.substring(us + 1);
  return window.GEM_UPGRADE_ALIASES[suffix] ? suffix : null;
}

// Mirrors `O(e)`'s per-category dispatch to the real cost-range formulas (relics -> dV,
// gadgets -> fV, inscryptions -> yV, the aliased gem named-upgrades -> wV, everything else
// -- base stats, and any gems_nodes key that isn't an aliased named-upgrade, exactly matching
// the live site's own fallthrough -- -> aV/baseStatCostRange).
function overrideCost(key, fromLevel, toLevel) {
  const CF = window.CostFormulas;
  if (key.startsWith('upgrades.relics.')) return CF.relicCostRange(key.split('.')[2], fromLevel, toLevel);
  if (key.startsWith('upgrades.gadgets.')) return CF.gadgetCostRange(key.split('.')[2], fromLevel, toLevel);
  if (key.startsWith('upgrades.inscryptions.')) return CF.inscryptionCostRange(key.split('.')[2], fromLevel, toLevel);
  if (key.startsWith('upgrades.gems_nodes.')) {
    const alias = gemFieldAlias(key.split('.')[2]);
    if (alias) return CF.gemAliasCostRange(alias, fromLevel, toLevel);
    return CF.baseStatCostRange(key, fromLevel, toLevel, currentHunter);
  }
  return CF.baseStatCostRange(key, fromLevel, toLevel, currentHunter);
}

function overrideNumericRow(f, current, globalVal, onChange) {
  const overridden = current !== '';
  const displayVal = overridden ? current : globalVal;
  const valueClass = overridden ? (current > globalVal ? 'text-green-400' : current < globalVal ? 'text-red-400' : 'text-gray-500') : 'text-gray-500';
  const resource = overrideFieldResource(f.key);
  const costEligible = overrideCostEligible(f.key, current, globalVal);
  const costLine = costEligible
    ? `<div class="text-[10px] text-amber-400 mt-0.5">Cost: ${window.CostFormulas.fmtBig(overrideCost(f.key, Math.floor(globalVal), Math.floor(current)))}</div>` : '';
  const div = document.createElement('div');
  div.className = 'bg-gray-750/60 rounded-md p-1.5 bg-gray-700/60 transition-colors border border-transparent hover:border-gray-600';
  div.innerHTML = `
    <div class="flex justify-between items-center mb-1">
      <div class="flex-1 mr-2 flex items-center gap-1.5">${resource ? matIcon(resource) : ''}<span class="text-xs font-medium text-gray-300">${escapeHtml(f.label)}</span></div>
    </div>
    <div class="flex items-center justify-between">
      <div class="flex items-center">
        <div class="text-[10px] mr-2 uppercase text-gray-400">global</div>
        <div class="text-xs text-gray-300">${globalVal}</div>
      </div>
      <div class="flex items-center">
        <div class="flex items-center">
          <button data-min class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-l-md mr-px"><div class="flex">${iconSvg('chevron-left', 14)}${iconSvg('chevron-left', 14, '-ml-2')}</div></button>
          <button data-dec class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white">${iconSvg('chevron-left', 14)}</button>
          <div class="min-w-[45px] text-center bg-gray-800 py-[1px] h-6 border-y border-gray-600 flex items-center justify-center"><span class="${valueClass}">${displayVal}</span></div>
          <button data-inc class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white">${iconSvg('chevron-right', 14)}</button>
          <button data-max class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-r-md ml-px"><div class="flex">${iconSvg('chevron-right', 14)}${iconSvg('chevron-right', 14, '-ml-2')}</div></button>
        </div>
      </div>
    </div>
    ${costLine}`;
  div.querySelector('[data-inc]').onclick = () => onChange((overridden ? current : globalVal) + 1);
  div.querySelector('[data-dec]').onclick = () => onChange((overridden ? current : globalVal) - 1);
  div.querySelector('[data-max]').onclick = () => onChange((overridden ? current : globalVal) + 10);
  div.querySelector('[data-min]').onclick = () => onChange('');
  return div;
}

function overrideToggleRow(f, current, globalVal, onChange) {
  const isOn = current === '' ? !!globalVal : !!current;
  const div = document.createElement('div');
  div.className = 'bg-gray-750/60 rounded-md p-1.5 bg-gray-700/60 transition-colors border border-transparent hover:border-gray-600';
  div.innerHTML = `
    <div class="flex justify-between items-center mb-1">
      <div class="flex-1 mr-2"><span class="text-xs font-medium text-gray-300">${escapeHtml(f.label)}</span></div>
    </div>
    <div class="flex items-center justify-between">
      <div class="flex items-center">
        <div class="text-[10px] mr-2 uppercase text-gray-400">global</div>
        <div class="text-xs px-1.5 py-0.5 rounded ${globalVal ? 'bg-green-900/50 text-green-300' : 'bg-gray-700 text-gray-400'}">${globalVal ? 'ON' : 'OFF'}</div>
      </div>
      <div class="flex">
        <button data-toggle class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-red-800/50 text-white"> ${isOn ? 'OFF' : 'ON'} </button>
      </div>
    </div>`;
  div.querySelector('[data-toggle]').onclick = () => onChange(isOn ? 0 : 1);
  return div;
}

// Looks up a field's max level so "Hide Maxed" can tell whether the account is already
// capped on it -- base stats use the sim's own statCaps, upgrade fields (key format
// "upgrades.<category>.<id>") look themselves up in window.ALL_UPGRADE_CATEGORIES by id.
function overrideFieldMaxLevel(key) {
  if (!key.startsWith('upgrades.')) return defs().statCaps[key] ?? Infinity;
  const parts = key.split('.');
  const id = parts[parts.length - 1];
  for (const cat of Object.values(window.ALL_UPGRADE_CATEGORIES || {})) {
    const item = cat.items?.find((i) => i.id === id);
    if (item) return item.maxLevel;
  }
  return Infinity;
}

function openOverridesModal(build, onSave) {
  const existing = document.getElementById('overridesModal');
  if (existing) existing.remove();
  const overrides = { ...(build.overrides || {}) };
  let hideMaxed = false;
  const overlay = document.createElement('div');
  overlay.id = 'overridesModal';
  overlay.className = 'fixed inset-0 z-50 overflow-y-auto bg-gray-900/80';
  overlay.innerHTML = `
    <div class="flex min-h-full items-end sm:items-center justify-center p-2 pb-[70px] sm:p-4 sm:pb-4">
      <div class="bg-gray-800 rounded-t-xl sm:rounded-lg shadow-2xl w-full max-w-3xl max-h-[85dvh] sm:max-h-[90vh] overflow-y-auto animate-fade-in border border-gray-700">
        <div class="bg-gradient-to-r from-gray-700 to-gray-800 p-2.5 border-b border-gray-600 sticky top-0 z-10">
          <div class="flex justify-between items-center mb-2 sm:mb-0">
            <div class="flex-1"><h2 class="text-base sm:text-lg font-bold text-white truncate mr-2 flex items-center"><span class="text-red-400">${escapeHtml(build.name || 'Unnamed')}</span><span> - Overrides</span></h2></div>
            <div class="flex items-center gap-2">
              <div class="hidden sm:block bg-gray-800/50 rounded-lg border border-gray-700/50 p-2">
                <div class="flex items-center justify-between">
                  <span class="text-gray-300 text-xs font-medium mr-3">Hide Maxed:</span>
                  <button data-hide-maxed class="relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none bg-gray-600"><span class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1"></span></button>
                </div>
              </div>
              <button data-reset class="px-2 py-1 sm:px-3 bg-gray-600 hover:bg-gray-500 text-xs sm:text-sm text-white rounded-md"> Reset </button>
              <button data-close class="p-1.5 rounded-full hover:bg-gray-700 transition-colors">${iconSvg('x', 16)}</button>
            </div>
          </div>
          <div class="block sm:hidden mt-2">
            <div class="bg-gray-800/50 rounded-lg border border-gray-700/50 p-2">
              <div class="flex items-center justify-between">
                <span class="text-gray-300 text-xs font-medium">Hide Maxed:</span>
                <button data-hide-maxed-m class="relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none bg-gray-600"><span class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1"></span></button>
              </div>
            </div>
          </div>
        </div>
        <div class="p-3 sm:p-4" id="overridesBody"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('#overridesBody');
  const renderBody = () => {
    body.innerHTML = '';
    getOverrideGroups().forEach((group) => {
      const rowsData = group.fields.map((f) => {
        const current = overrides[f.key] !== undefined ? overrides[f.key] : '';
        const globalVal = f.global() ?? 0;
        const maxLevel = overrideFieldMaxLevel(f.key);
        const isMaxed = maxLevel !== Infinity && (current !== '' ? current : globalVal) >= maxLevel;
        return { f, current, globalVal, isMaxed };
      }).filter((r) => !hideMaxed || !r.isMaxed);
      if (!rowsData.length) return;
      const section = document.createElement('div');
      section.className = 'mb-3';
      section.innerHTML = `<div class="flex items-center mb-1.5"><div class="w-1.5 h-5 bg-blue-500 rounded-r mr-2"></div><h3 class="font-medium text-sm text-blue-200">${escapeHtml(group.title)}</h3></div>`;
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-1.5';
      rowsData.forEach(({ f, current, globalVal }) => {
        const onChange = (val) => { if (val === '') delete overrides[f.key]; else overrides[f.key] = val; renderBody(); };
        grid.appendChild(f.toggle ? overrideToggleRow(f, current, globalVal, onChange) : overrideNumericRow(f, current, globalVal, onChange));
      });
      section.appendChild(grid);
      body.appendChild(section);
    });
  };
  renderBody();
  const setHideMaxed = (val) => {
    hideMaxed = val;
    ['[data-hide-maxed]', '[data-hide-maxed-m]'].forEach((sel) => {
      const btn = overlay.querySelector(sel);
      btn.className = `relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none ${hideMaxed ? 'bg-blue-600' : 'bg-gray-600'}`;
      btn.querySelector('span').className = `inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${hideMaxed ? 'translate-x-5' : 'translate-x-1'}`;
    });
    renderBody();
  };
  overlay.querySelector('[data-hide-maxed]').onclick = () => setHideMaxed(!hideMaxed);
  overlay.querySelector('[data-hide-maxed-m]').onclick = () => setHideMaxed(!hideMaxed);
  const close = () => {
    if (onSave) onSave(overrides);
    else {
      const target = store[currentHunter].builds.find((b) => b.id === build.id);
      if (target) { target.overrides = overrides; saveStore(); renderBuildList(); }
    }
    overlay.remove();
  };
  overlay.querySelector('[data-close]').onclick = close;
  overlay.querySelector('[data-reset]').onclick = () => { Object.keys(overrides).forEach((k) => delete overrides[k]); renderBody(); };
}

function genericModal(title, bodyHtml, id) {
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto border border-gray-700">
      <div class="flex justify-between items-center p-4 border-b border-gray-700">
        <h3 class="text-lg font-semibold text-white">${title}</h3>
        <button data-close class="text-gray-400 hover:text-white">&times;</button>
      </div>
      <div class="p-4">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return overlay;
}

// Shared shell matching the live site's larger modals (Build Statistics, Upgrade
// Efficiency, etc.): gradient header with a left icon + red-accented title and a max-w-5xl
// body, as opposed to genericModal's plain max-w-lg dialog used for smaller popups.
function titledModal(icon, title, bodyHtml, id) {
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'fixed inset-0 z-50 overflow-y-auto bg-gray-900/80 flex items-center justify-center p-2 sm:p-4 pb-[70px] pt-[50px] sm:py-0';
  overlay.innerHTML = `
    <div class="bg-gray-800 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto animate-fade-in border border-gray-700">
      <div class="bg-gradient-to-r from-gray-700 to-gray-800 p-4 border-b border-gray-600 sticky top-0 z-10 flex justify-between items-center">
        <h2 class="text-xl font-bold text-white flex items-center">${iconSvg(icon, 20, 'mr-2 text-red-400')} ${title}</h2>
        <button data-close class="p-1.5 rounded-full hover:bg-gray-700 transition-colors text-gray-300 hover:text-white">${iconSvg('x', 18)}</button>
      </div>
      <div class="p-5">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return overlay;
}

// Verbatim port of the live "Override Costs" modal (captured via outerHTML): grouped
// per-category tables (Base Stats / Relics / Inscryptions) with Upgrade/Global/
// Override/Difference/Resource/Cost columns, a per-resource cost total per category header,
// and a footer grid of grand totals per resource -- using the real cost-curve formulas
// extracted from the live bundle (costFormulas.js), not a placeholder. The live modal also
// has a "Collection Time" column computed from the account's per-resource production rate;
// we don't have that production-rate data (it isn't in the save file or any API we read),
// so that column is intentionally omitted rather than showing a fabricated duration.
async function openOverrideCostsModal(build) {
  const overrides = build.overrides || {};
  const CF = window.CostFormulas;
  const d = defs();
  const overrideGroups = getOverrideGroups();

  // Collection Time is inferred (not a stored value) from THIS build's own simulated
  // per-resource loot rate (mat1/mat2/mat3 per run * runs/day) -- the same numbers already
  // shown on the build card's Main Statistics. Fragments/Hellish-Biomatter aren't part of
  // the sim's loot output (they come from bosses/events we don't model), so Collection Time
  // is only computable for the 3 per-hunter stat resources, not relics/inscriptions.
  let perDayRate = {};
  try {
    const iterations = Number(document.getElementById('baseIterations')?.value) || 1000;
    const r = await HunterSim.evaluate(currentHunter, {
      level: build.level, hunterStats: store[currentHunter].hunterStats, talents: build.talents, attributes: build.attributes,
      overrides: build.overrides || {}, upgrades: window.buildNestedUpgrades(store.globalUpgrades),
      gemPlannerStore: { gemStates: store.gems }, iterations,
    });
    const runsPerDay = r.avgTime ? 1440 / r.avgTime : 0;
    perDayRate = { mat1: r.mat1 * runsPerDay, mat2: r.mat2 * runsPerDay, mat3: r.mat3 * runsPerDay };
  } catch { /* Collection Time just won't be shown if evaluation fails */ }

  // Verbatim behavior port of the live "Override Costs" modal's own computation (its `C()`
  // function, extracted directly from the bundle): it iterates ONLY the keys actually present
  // in build.overrides, computes `difference = overrideValue - globalValue`, and INCLUDES A
  // ROW ONLY WHEN `difference > 0` -- i.e. only upgrades you don't already have (an override
  // set below or equal to your current global value is never shown here at all, not even
  // with a zero/negative cost). Our clone previously showed every overridden field regardless
  // of sign, which is the bug being fixed.
  const positiveOverrideKeys = (prefix) => Object.keys(overrides).filter((k) => {
    if (!k.startsWith(prefix)) return false;
    const field = overrideGroups.flatMap((g) => g.fields).find((f) => f.key === k);
    const globalVal = field ? (field.global() ?? 0) : 0;
    return overrides[k] > globalVal;
  });
  const positiveOverrideBaseStats = d.baseStatKeys.filter((k) => {
    if (overrides[k] === undefined) return false;
    const field = overrideGroups.find((g) => g.title === 'Base Stats').fields.find((f) => f.key === k);
    const globalVal = field ? (field.global() ?? 0) : 0;
    return overrides[k] > globalVal;
  });

  const groups = [
    {
      title: 'Base Stats', icon: 'writing',
      rows: positiveOverrideBaseStats.map((k) => {
        const field = overrideGroups.find((g) => g.title === 'Base Stats').fields.find((f) => f.key === k);
        const globalVal = field ? (field.global() ?? 0) : 0;
        const overrideVal = overrides[k];
        const resource = CF.baseStatResource(currentHunter, k);
        const cost = resource ? CF.baseStatCostRange(k, globalVal, overrideVal, currentHunter) : undefined;
        return { label: field ? field.label : k, globalVal, overrideVal, resource, cost };
      }),
    },
    {
      title: 'Relics', icon: 'scale',
      rows: positiveOverrideKeys('upgrades.relics.').map((k) => {
        const id = k.split('.')[2];
        const field = overrideGroups.find((g) => g.title === 'Relics')?.fields.find((f) => f.key === k);
        const globalVal = field ? (field.global() ?? 0) : 0;
        const overrideVal = overrides[k];
        const resource = CF.relicResource(currentHunter);
        const cost = resource ? CF.relicCostRange(id, globalVal, overrideVal) : undefined;
        return { label: field ? field.label : id, globalVal, overrideVal, resource, cost };
      }),
    },
    {
      title: 'Gadgets', icon: 'settings',
      rows: positiveOverrideKeys('upgrades.gadgets.').map((k) => {
        const id = k.split('.')[2];
        const field = overrideGroups.find((g) => g.title === 'Gadgets')?.fields.find((f) => f.key === k);
        const globalVal = field ? (field.global() ?? 0) : 0;
        const overrideVal = overrides[k];
        // No resource/material table extracted for gadgets yet -- shown without a material
        // icon (still a real, correctly-formatted cost number, just no currency badge).
        const cost = CF.gadgetCostRange(id, globalVal, overrideVal);
        return { label: field ? field.label : id, globalVal, overrideVal, resource: null, cost };
      }),
    },
    {
      title: 'Inscryptions', icon: 'chart-bar',
      rows: positiveOverrideKeys('upgrades.inscryptions.').map((k) => {
        const id = k.split('.')[2];
        const field = overrideGroups.find((g) => g.title === 'Inscryptions')?.fields.find((f) => f.key === k);
        const globalVal = field ? (field.global() ?? 0) : 0;
        const overrideVal = overrides[k];
        const resource = CF.inscryptionResource(currentHunter);
        const cost = resource ? CF.inscryptionCostRange(id, globalVal, overrideVal) : undefined;
        return { label: field ? field.label : id, globalVal, overrideVal, resource, cost };
      }),
    },
    {
      title: 'Gem Nodes', icon: 'diamond',
      rows: positiveOverrideKeys('upgrades.gems_nodes.').map((k) => {
        const suffix = k.split('.')[2];
        const field = overrideGroups.find((g) => g.title === 'Gem Nodes & Upgrades')?.fields.find((f) => f.key === k);
        const globalVal = field ? (field.global() ?? 0) : 0;
        const overrideVal = overrides[k];
        const alias = gemFieldAlias(suffix);
        const cost = alias ? CF.gemAliasCostRange(alias, globalVal, overrideVal) : CF.baseStatCostRange(k, globalVal, overrideVal, currentHunter);
        return { label: field ? field.label : suffix, globalVal, overrideVal, resource: null, cost };
      }),
    },
  ].filter((g) => g.rows.length);

  const modeledPrefixes = ['upgrades.inscryptions.', 'upgrades.relics.', 'upgrades.gadgets.', 'upgrades.gems_nodes.'];
  const knownKeys = new Set([
    ...positiveOverrideBaseStats,
    ...modeledPrefixes.flatMap((p) => positiveOverrideKeys(p)),
  ]);
  // Anything else with a positive override we don't have a cost formula for yet -- still
  // flagged for transparency (an intentional divergence from the live site, which -- since it
  // has cost data for every category it supports -- would never hit this "unknown" case at
  // all; ours honestly says so instead of fabricating a number).
  const unmodeledKeys = Object.keys(overrides).filter((k) => {
    if (knownKeys.has(k)) return false;
    const field = overrideGroups.flatMap((g) => g.fields).find((f) => f.key === k);
    const globalVal = field ? (field.global() ?? 0) : 0;
    return overrides[k] > globalVal;
  });

  const resourceTotals = {};
  groups.forEach((g) => g.rows.forEach((r) => {
    if (r.cost === undefined || !r.resource) return;
    resourceTotals[r.resource] = (resourceTotals[r.resource] || 0) + r.cost;
  }));

  const fmtTimeShort = (mins) => {
    if (mins === null || mins === undefined || !isFinite(mins)) return '—';
    const days = Math.floor(mins / 1440); const hrs = Math.floor((mins % 1440) / 60);
    if (days > 0) return `${days}d ${hrs}h`;
    if (hrs > 0) return `${hrs}h ${Math.round(mins % 60)}m`;
    return `${Math.round(mins)}m`;
  };

  const rowHtml = (r) => {
    const rate = r.resource ? perDayRate[r.resource] : undefined;
    const timeMins = (r.cost !== undefined && rate) ? CF.collectionTimeMinutes(r.cost, rate) : null;
    return `
    <tr class="border-b border-gray-700/50">
      <td class="py-1.5 pr-3 text-white font-medium">${escapeHtml(r.label)}</td>
      <td class="py-1.5 pr-3 text-gray-400">${r.globalVal}</td>
      <td class="py-1.5 pr-3 text-blue-300">${r.overrideVal}</td>
      <td class="py-1.5 pr-3 text-green-400">${r.overrideVal - r.globalVal}</td>
      <td class="py-1.5 pr-3">${r.resource ? `<span class="inline-flex items-center gap-1">${matIcon(r.resource)}${CF.resourceAbbr(currentHunter, r.resource)}</span>` : '—'}</td>
      <td class="py-1.5 pr-3 text-amber-400 font-medium">${r.cost === undefined ? 'unknown' : CF.fmtBig(r.cost)}</td>
      <td class="py-1.5 pr-3 text-gray-400">${fmtTimeShort(timeMins)}</td>
    </tr>`;
  };

  const groupHtml = groups.map((g) => {
    const totalsForGroup = {};
    g.rows.forEach((r) => { if (r.cost !== undefined && r.resource) totalsForGroup[r.resource] = (totalsForGroup[r.resource] || 0) + r.cost; });
    const totalsBadges = Object.entries(totalsForGroup).map(([res, amt]) => `<span class="text-amber-400 font-medium ml-3 inline-flex items-center gap-1">${matIcon(res)}${CF.fmtBig(amt)}</span>`).join('');
    return `
      <div class="mb-4 rounded-lg border border-gray-700 overflow-hidden">
        <div class="flex items-center justify-between px-3 py-2 bg-gray-700/50">
          <div class="flex items-center gap-2">${iconSvg(g.icon, 16, 'text-blue-400')}<span class="font-semibold text-white text-sm">${escapeHtml(g.title)}</span><span class="text-xs text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">${g.rows.length} upgrade${g.rows.length === 1 ? '' : 's'}</span></div>
          <div class="text-xs">${totalsBadges}</div>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-sm">
          <thead><tr class="text-left text-xs text-gray-400 border-b border-gray-700"><th class="py-1.5 pr-3 font-normal">Upgrade</th><th class="py-1.5 pr-3 font-normal">Global</th><th class="py-1.5 pr-3 font-normal">Override</th><th class="py-1.5 pr-3 font-normal">Difference</th><th class="py-1.5 pr-3 font-normal">Resource</th><th class="py-1.5 pr-3 font-normal">Cost</th><th class="py-1.5 pr-3 font-normal">Collection Time</th></tr></thead>
          <tbody>${g.rows.map(rowHtml).join('')}</tbody>
        </table></div>
      </div>`;
  }).join('');

  const footerHtml = Object.keys(resourceTotals).length ? `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      ${Object.entries(resourceTotals).map(([res, amt]) => `
        <div class="bg-gray-700/50 rounded-lg p-3">
          <div class="text-xs text-gray-400 mb-1 flex items-center gap-1.5">${matIcon(res)}${CF.resourceLabel(currentHunter, res)}</div>
          <div class="text-amber-400 font-bold">${CF.fmtBig(amt)}</div>
        </div>`).join('')}
    </div>` : '';

  const unmodeledHtml = unmodeledKeys.length ? `<p class="text-xs text-gray-500 mt-3">Cost formula not yet extracted for: ${unmodeledKeys.map(escapeHtml).join(', ')}.</p>` : '';
  const timeNoteHtml = '<p class="text-xs text-gray-500 mt-2">Collection Time is inferred from this build\'s own simulated loot rate; it\'s only computable for the 3 hunter-specific stat resources (not Fragments/Hellish-Biomatter, which come from bosses/events the sim doesn\'t model).</p>';

  const body = Object.keys(overrides).length
    ? `<p class="text-sm text-gray-300 mb-4">This overview shows the cost differences between your global values and the override values used in this build.</p>${groupHtml}${footerHtml}${unmodeledHtml}${timeNoteHtml}`
    : '<p class="text-sm text-gray-400">No overrides set on this build.</p>';

  titledModal('adjustments-horizontal', `Override Costs: ${escapeHtml(build.name || 'Unnamed')}`, body, 'overrideCostsModal');
}

// Evaluates the build's current Loot Score, then tries +1 on every talent/attribute that
// has budget room, sorting by the resulting Loot Score delta -- a real, computed "which
// point gets you the most" ranking (not currency-cost-normalized like the live site's
// version, since we don't have upgrade price data, but genuinely useful for build planning).
async function openCompareEfficiencyModal(build) {
  const overlay = titledModal('scale', `Upgrade Efficiency: ${escapeHtml(build.name || 'Unnamed')}`,
    '<p class="text-sm text-gray-400">Evaluating...</p>', 'compareEfficiencyModal');
  const iterations = Number(document.getElementById('baseIterations').value) || 1000;
  const baseState = {
    level: build.level, hunterStats: store[currentHunter].hunterStats, talents: build.talents, attributes: build.attributes,
    overrides: build.overrides || {}, upgrades: window.buildNestedUpgrades(store.globalUpgrades),
    gemPlannerStore: { gemStates: store.gems }, iterations,
  };
  const base = await HunterSim.evaluate(currentHunter, baseState);
  const d = defs();
  const { talentBudget, attributeBudget } = budgetsForLevel(build.level);
  const talentSpent = d.talents.reduce((s, t) => s + (build.talents[t.id] || 0), 0);
  const attrSpent = costOfAttrs(d, build.attributes);
  const deps = d.attributeDependencies || {};
  const minVal = d.attributeMinValue || {};

  const candidates = [];
  const showAdvancedForCompare = shouldShowAdvancedTalents(currentHunter);
  d.talents.filter((t) => !t.advanced || showAdvancedForCompare || (build.talents[t.id] || 0) > 0).forEach((t) => {
    const level = build.talents[t.id] || 0;
    if (level < talentMaxLevel(t, build) && talentSpent < talentBudget) {
      candidates.push({ label: t.label, kind: 'talent', apply: (talents) => { talents[t.id] = level + 1; } });
    }
  });
  d.attributes.forEach((a) => {
    const level = build.attributes[a.id] || 0;
    const canInc = Optimizer.isEligible(a, d.attributes, deps, minVal, build.attributes)
      && attrSpent + (a.cost || 1) <= attributeBudget;
    if (canInc) candidates.push({ label: a.label, kind: 'attribute', apply: (attrs) => { attrs[a.id] = level + 1; } });
  });

  const results = [];
  for (const c of candidates) {
    const talents = { ...build.talents };
    const attributes = { ...build.attributes };
    if (c.kind === 'talent') c.apply(talents); else c.apply(attributes);
    const r = await HunterSim.evaluate(currentHunter, { ...baseState, talents, attributes });
    results.push({ label: c.label, kind: c.kind, lootDelta: r.lootPerMin - base.lootPerMin, stageDelta: r.avgStage - base.avgStage });
  }
  results.sort((a, b) => b.lootDelta - a.lootDelta);

  const rows = results.length ? results.map((r) => `
    <div class="flex items-center justify-between py-1.5 border-b border-gray-700/50 text-sm">
      <span class="text-gray-300">${escapeHtml(r.label)} <span class="text-gray-500">(${r.kind})</span></span>
      <span class="text-right">
        <div class="${r.lootDelta >= 0 ? 'text-green-400' : 'text-red-400'} font-medium">${r.lootDelta >= 0 ? '+' : ''}${fmt(r.lootDelta)} loot</div>
        <div class="text-xs text-gray-500">${r.stageDelta >= 0 ? '+' : ''}${r.stageDelta.toFixed(2)} stage</div>
      </span>
    </div>`).join('') : '<p class="text-sm text-gray-400">No further points can be spent at this level.</p>';

  overlay.querySelector('.p-5').innerHTML = `
    <div class="text-sm text-gray-300 mb-4">Compare different upgrade combinations to find the best cost-efficiency.</div>
    <p class="text-xs text-gray-400 mb-3">Ranked by Loot Score gained per next available talent/attribute point (not currency-cost-normalized -- we don't have the game's price tables reverse-engineered yet, so resource/scenario picking isn't modeled here).</p>
    ${rows}`;
}

// Build Statistics modal -- Stage Distribution (per-stage hit histogram) and Build Stats
// (final post-upgrade combat numbers), both read from real wasm getters via
// HunterSim.evaluateDetailed(). The live site has 4 tabs (Stage Distribution, Stage Odds,
// Revive Distribution, Build Stats); Stage Odds/Revive Distribution need boss/death-tracking
// data we haven't wired up yet, so those two tabs are shown (matching the real 4-tab
// layout) but with an honest "not available yet" placeholder instead of fabricated numbers.
async function openBuildStatsModal(build) {
  const overlay = titledModal('chart-bar', `Build Statistics: ${escapeHtml(build.name || 'Unnamed')}`,
    '<p class="text-sm text-gray-400">Evaluating...</p>', 'buildStatsModal');
  const iterations = Number(document.getElementById('baseIterations').value) || 1000;
  const r = await HunterSim.evaluateDetailed(currentHunter, {
    level: build.level, hunterStats: store[currentHunter].hunterStats, talents: build.talents, attributes: build.attributes,
    overrides: build.overrides || {}, upgrades: window.buildNestedUpgrades(store.globalUpgrades),
    gemPlannerStore: { gemStates: store.gems }, iterations,
  });

  const dist = r.stageDistribution || [];
  const maxCount = Math.max(1, ...dist.map((d) => d.count));
  const distHtml = dist.length ? `
    <div class="flex items-end gap-0.5 h-40 mb-2">
      ${dist.map((d) => `<div class="flex-1 bg-gradient-to-t from-red-700 to-red-400 rounded-t" style="height:${(d.count / maxCount) * 100}%" title="Stage ${d.stage}: ${d.count} runs"></div>`).join('')}
    </div>
    <div class="grid grid-cols-3 gap-2 text-center text-sm">
      <div class="bg-gray-700 rounded p-2"><div class="text-gray-400 text-xs">Min Stage</div><div class="font-bold text-white">${r.minStage?.toFixed(1)}</div></div>
      <div class="bg-gray-700 rounded p-2"><div class="text-gray-400 text-xs">Avg Stage</div><div class="font-bold text-white">${r.avgStage?.toFixed(1)}</div></div>
      <div class="bg-gray-700 rounded p-2"><div class="text-gray-400 text-xs">Max Stage</div><div class="font-bold text-white">${r.maxStage?.toFixed(1)}</div></div>
    </div>` : '<p class="text-sm text-gray-400">No stage-distribution data returned by the wasm for this hunter.</p>';

  const statLabels = {
    MaxHp: 'MAX HP', Atk: 'ATK Power', Regen: 'HP Regen', Dr: 'DMG Reduction', Evade: 'Evade Chance',
    Effect: 'Effect Chance', CritRate: 'Crit Chance', CritPower: 'Crit Power', Reload: 'ATK Speed',
    Multistrike: 'Multistrike Chance', MultistrikePower: 'Multistrike Power',
    Block: 'Block Chance', Charge: 'Charge', ChargeGain: 'Charge Gain', Sc: 'Shield Capacity',
  };
  const pctFields = new Set(['Dr', 'Evade', 'Effect', 'CritRate', 'Multistrike', 'Block', 'Charge']);
  const statsHtml = `<div class="grid grid-cols-3 gap-2 text-center text-sm">
    ${Object.entries(r.finalStats || {}).map(([key, val]) => `
      <div class="bg-gray-700 rounded p-2">
        <div class="text-gray-400 text-xs">${statLabels[key] || key}</div>
        <div class="font-bold text-white">${pctFields.has(key) ? `${(val * 100).toFixed(2)}%` : val.toFixed(2)}</div>
      </div>`).join('')}
  </div>`;

  const notAvailableHtml = (what) => `<p class="text-sm text-gray-400">${what} isn't available yet -- it needs boss/death-tracking data the sim doesn't currently record.</p>`;
  const TABS = [
    { key: 'dist', label: 'Stage Distribution', icon: 'chart-bar', html: distHtml },
    { key: 'odds', label: 'Stage Odds', icon: 'scale', html: notAvailableHtml('Stage Odds') },
    { key: 'revive', label: 'Revive Distribution', icon: 'refresh', html: notAvailableHtml('Revive Distribution') },
    { key: 'stats', label: 'Build Stats', icon: 'adjustments-horizontal', html: statsHtml },
  ];
  const tabBtnClass = (active) => `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium ${active ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300'}`;
  overlay.querySelector('.p-5').innerHTML = `
    <div class="flex gap-2 mb-4 flex-wrap">
      ${TABS.map((t, i) => `<button data-tab="${t.key}" class="${tabBtnClass(i === 0)}">${iconSvg(t.icon, 14)}${escapeHtml(t.label)}</button>`).join('')}
    </div>
    ${TABS.map((t, i) => `<div data-pane="${t.key}" class="${i === 0 ? '' : 'hidden'}">${t.html}</div>`).join('')}`;

  overlay.querySelectorAll('[data-tab]').forEach((btn, i) => {
    btn.onclick = () => {
      overlay.querySelectorAll('[data-tab]').forEach((b) => { b.className = tabBtnClass(false); });
      btn.className = tabBtnClass(true);
      overlay.querySelectorAll('[data-pane]').forEach((p) => p.classList.add('hidden'));
      overlay.querySelector(`[data-pane="${btn.dataset.tab}"]`).classList.remove('hidden');
    };
  });
}

async function screenshotCard(card, build) {
  if (!window.html2canvas) { alert('Screenshot library failed to load.'); return; }
  try {
    const canvas = await window.html2canvas(card, { backgroundColor: '#1f2937' });
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch (e) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${(build.name || 'build').replace(/[^a-z0-9]/gi, '_')}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }
    }, 'image/png');
  } catch (e) {
    alert('Screenshot failed: ' + e.message);
  }
}

async function renderBuildList() {
  const list = document.getElementById('buildList');
  if (!list) return;
  const builds = store[currentHunter].builds.filter((b) => (b.categoryId || 'active') === showCategoryId);
  // Auto-fill by available width instead of a fixed column count -- fixed 3-up columns were
  // squeezing each card narrower than its own content (stat labels like "Runs per Day"
  // wrapping/cutting) whenever the viewport had room to spare. minmax(340px, 1fr) lets cards
  // grow to fill the canvas and only wraps to a new row once space actually runs out.
  list.className = 'grid gap-4';
  list.style.gridTemplateColumns = store.viewMode === 'horizontal' ? '1fr' : 'repeat(auto-fill, minmax(340px, 1fr))';
  list.innerHTML = '';
  if (!builds.length) {
    list.innerHTML = `<div class="col-span-full text-center text-gray-500 py-10 border border-dashed border-gray-700 rounded-lg">No builds in this category yet.</div>`;
    return;
  }
  const accent = HUNTER_ACCENTS[currentHunter];
  // Verbatim port of the live site's build-comparison feature: every card after the first
  // in the list shows a green/red arrow+percentage badge on each stat, computed against the
  // FIRST card's own values (confirmed live: card 2 showed "+32.9%" Loot Score / "+6.9" Ø
  // Stage / a red "+18%" Ø Time, all relative to card 1) -- not against a user-chosen
  // baseline. Lower-is-better for Ø Time only; every other stat is higher-is-better.
  let comparisonBaseline = null;
  const deltaBadge = (current, base, invert) => {
    if (!base || current === undefined || current === null) return '';
    const pct = ((current - base) / Math.abs(base)) * 100;
    if (Math.abs(pct) < 0.05) return '';
    const good = invert ? pct < 0 : pct > 0;
    const cls = good ? 'diff-box-green' : 'diff-box-red';
    const icon = pct >= 0 ? 'arrow-up' : 'arrow-down';
    return `<span class="${cls} diff-box-small items-center ml-1">${iconSvg(icon, 10, 'mr-0.5')}${Math.abs(pct).toFixed(1)}%</span>`;
  };
  for (const [buildIdx, build] of builds.entries()) {
    const wrapper = document.createElement('div');
    wrapper.className = 'build-card-wrapper';
    // Only draggable while the mouse is actually down on the grip handle -- making the
    // WHOLE card draggable=true breaks normal button clicks inside it (native HTML5 DnD
    // hijacks the mousedown before click fires), which is why buttons stopped opening
    // anything before this fix.
    wrapper.draggable = false;
    wrapper.addEventListener('dragstart', (e) => {
      wrapper.classList.add('dragging');
      e.dataTransfer.setData('text/build-id', build.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    wrapper.addEventListener('dragend', () => { wrapper.classList.remove('dragging'); wrapper.draggable = false; });
    // Reordering within the grid -- the category tabs already had drop zones for MOVING a
    // build to a different category, but nothing handled dropping one card onto another to
    // REORDER them within the same list, so drags never actually changed card position.
    wrapper.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    wrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/build-id');
      if (!draggedId || draggedId === build.id) return;
      const arr = store[currentHunter].builds;
      const fromIdx = arr.findIndex((b) => b.id === draggedId);
      const toIdx = arr.findIndex((b) => b.id === build.id);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      saveStore();
      renderBuildList();
    });

    const card = document.createElement('div');
    // Confirmed directly on the live site: the FIRST card in the list (the comparison
    // reference/baseline every other card's delta badges are computed against) gets a
    // yellow left border instead of the hunter's accent color, and carries
    // is-reference-build="true" -- every other card keeps the normal accent border.
    const isReferenceBuild = buildIdx === 0;
    card.className = `result-card border-l-4 bg-gray-800 rounded-lg shadow-xl overflow-hidden transition-all duration-200 hover:shadow-2xl border-${isReferenceBuild ? 'yellow' : accent}-500`;
    if (isReferenceBuild) card.setAttribute('is-reference-build', 'true');
    card.innerHTML = `
      <div class="header-wrapper relative">
        <div class="absolute top-1.5 right-[34px] z-10 bg-gray-700/80 text-gray-200 rounded-lg px-1 py-1 shadow-lg text-xs font-medium text-center leading-tight w-9 h-12" title="Build Level">
          <div><div class="pb-2">Lvl</div><div class="font-bold">${build.level}</div></div>
        </div>
        <button data-act="overrideCosts" class="absolute top-1.5 right-2 z-10 text-white rounded-full p-1 shadow-lg transition-colors cursor-pointer bg-red-500/50 hover:bg-red-500/70" title="View override costs">${iconSvg('adjustments-horizontal', 14, 'text-red-300')}</button>
        <button data-act="reEvaluate" class="absolute top-8 right-2 z-10 bg-gray-600 text-gray-300 rounded-full p-1 shadow-lg hover:bg-gray-500 hover:text-white transition-colors" title="Re-evaluate Build">${iconSvg('refresh', 14)}</button>
        <div class="header-main p-4 flex justify-between items-center">
          <div class="flex items-center flex-1 min-w-0">
            <div class="grip-handle mr-2 text-gray-500 hover:text-gray-300 hover:bg-gray-700 rounded cursor-grab active:cursor-grabbing flex-shrink-0" style="padding:2px;" title="Drag to reorder">${iconSvg('grip-vertical', 20, 'text-gray-500')}</div>
            <div class="flex overflow-hidden min-w-0">
              <div class="self-center cursor-pointer mr-1.5 flex-shrink-0 hover:text-gray-300 transition-colors" data-act="edit">${iconSvg('edit-circle', 20, 'text-gray-400')}</div>
              <div class="flex items-baseline flex-wrap min-w-0 overflow-hidden">
                <h3 class="text-lg font-semibold text-white truncate max-w-full cursor-pointer hover:text-gray-300 transition-colors" data-act="edit">${escapeHtml(build.name || 'Unnamed')}</h3>
              </div>
            </div>
          </div>
        </div>
        <div class="action-bar py-2 px-1 flex justify-between items-center bg-gray-800/70 border-t border-b border-gray-700/50">
          <div class="flex items-center gap-1.5 flex-1 justify-center">
            ${ACTION_BUTTONS.map((b) => `<button data-act="${b.act}" class="action-button-compact ${b.extra || ''}" title="${b.title}">${iconSvg(b.icon, 16)}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="p-4 pb-3 pt-2">
        <div class="space-y-2">
          <div class="stats-container">
            <div class="flex items-center justify-between">
              <h4 class="section-title">Main Statistics</h4>
              ${SECOND_ROW_BUTTONS.map((b) => `<button data-act="${b.act}" class="action-button-compact ${b.extra || ''}" title="${b.title}">${iconSvg(b.icon, 16)}</button>`).join('')}
            </div>
            <div class="border-b border-gray-700/40 -mt-2 mb-1"></div>
            <div class="stats-grid" data-mainstats>
              <div class="stat-card"><div class="text-gray-500 text-sm">Simulating...</div></div>
            </div>
          </div>
          <div>
            <h4 class="section-title">Loot</h4>
            <div class="resource-grid mt-3" data-loot></div>
          </div>
          <div data-boss-section class="hidden">
            <h4 class="section-title">Boss Statistics</h4>
            <div class="boss-stats-grid mt-3" data-boss></div>
          </div>
        </div>
      </div>`;

    card.querySelector('.grip-handle').addEventListener('mousedown', () => { wrapper.draggable = true; });
    // Both the title (h3) and the action-bar button use data-act="edit" (matching the real
    // site, where clicking either opens the editor) -- wire up every match, not just the
    // first, or querySelector's single-match behavior silently leaves one of them dead.
    card.querySelectorAll('[data-act="edit"]').forEach((el) => { el.onclick = () => openBuildModal(build); });
    // "Copy build" on the live site opens the Build Creator prefilled with the source
    // build's data (not an instant silent duplicate) -- confirmed by clicking it there and
    // getting the same modal as "New Build"/"Edit", just pre-populated. Passing id:null (and
    // a "(copy)" name) means Save Build creates a brand-new entry instead of overwriting the
    // original, since the update handler only overwrites when an id match is found.
    card.querySelector('[data-act=dup]').onclick = () => {
      const copy = JSON.parse(JSON.stringify(build));
      copy.id = null;
      copy.name = nextCopyName(build.name || 'Unnamed');
      openBuildModal(copy);
    };
    card.querySelector('[data-act=archive]').onclick = () => {
      const archivedCat = store.categories.find((c) => c.id === 'archived');
      const isArchived = build.categoryId === 'archived';
      build.categoryId = isArchived ? 'active' : (archivedCat ? 'archived' : 'active');
      saveStore(); renderCategoryTabs(); renderBuildList();
    };
    card.querySelector('[data-act=overrides]').onclick = () => openOverridesModal(build);
    card.querySelector('[data-act=export]').onclick = () => exportBuildCode(build);
    card.querySelector('[data-act=delete]').onclick = () => {
      store[currentHunter].builds = store[currentHunter].builds.filter((b) => b.id !== build.id);
      saveStore(); renderCategoryTabs(); renderBuildList();
    };
    card.querySelector('[data-act=reEvaluate]').onclick = () => renderBuildList();
    card.querySelector('[data-act=overrideCosts]').onclick = () => openOverrideCostsModal(build);
    card.querySelector('[data-act=compareEfficiency]').onclick = () => openCompareEfficiencyModal(build);
    card.querySelector('[data-act=buildStats]').onclick = () => openBuildStatsModal(build);
    card.querySelector('[data-act=screenshot]').onclick = () => screenshotCard(card, build);
    wrapper.appendChild(card);
    list.appendChild(wrapper);

    const iterations = Number(document.getElementById('baseIterations').value) || 1000;
    const evalPromise = HunterSim.evaluate(currentHunter, {
      level: build.level, iterations, hunterStats: store[currentHunter].hunterStats,
      talents: build.talents, attributes: build.attributes, overrides: build.overrides || {},
      upgrades: window.buildNestedUpgrades(store.globalUpgrades),
      gemPlannerStore: { gemStates: store.gems },
    });
    if (buildIdx === 0) comparisonBaseline = await evalPromise;
    evalPromise.then((r) => {
      const runsPerDay = r.avgTime ? 1440 / r.avgTime : 0;
      const base = buildIdx > 0 ? comparisonBaseline : null;
      const baseRunsPerDay = base?.avgTime ? 1440 / base.avgTime : 0;
      card.querySelector('[data-mainstats]').innerHTML = `
        <div class="stat-card"><div class="stat-header"><div class="flex items-center">${iconSvg('report-money', 16, 'text-amber-400')}<span class="stat-title">Loot Score</span></div></div>
          <div class="stat-value-row"><div class="stat-main-value">${fmt(r.lootPerMin)}</div>${base ? deltaBadge(r.lootPerMin, base.lootPerMin, false) : ''}</div></div>
        <div class="stat-card"><div class="stat-header"><div class="flex items-center">${iconSvg('clock', 16, 'text-blue-400')}<span class="stat-title">Ø Time</span></div></div>
          <div class="stat-value-row"><div class="stat-main-value">${fmtTime(r.avgTime)}</div>${base ? deltaBadge(r.avgTime, base.avgTime, true) : ''}</div></div>
        <div class="stat-card"><div class="stat-header"><div class="flex items-center">${iconSvg('stairs', 16, 'text-red-400')}<span class="stat-title">Ø Stage</span></div></div>
          <div class="stat-value-row"><div class="flex items-baseline"><div class="stat-main-value">${r.avgStage?.toFixed(1)}</div><div class="stat-range ml-2">${r.minStage?.toFixed(0)}-${r.maxStage?.toFixed(0)}</div></div>${base ? deltaBadge(r.avgStage, base.avgStage, false) : ''}</div></div>
        <div class="stat-card"><div class="stat-header">${iconSvg('repeat', 16, 'text-purple-400')}<span class="stat-title">Runs per Day</span></div>
          <div class="stat-value-row"><div class="stat-main-value">${runsPerDay.toFixed(2)}</div>${base ? deltaBadge(runsPerDay, baseRunsPerDay, false) : ''}</div></div>`;

      const values = [r.mat1, r.mat2, r.mat3, r.xp];
      const baseValues = base ? [base.mat1, base.mat2, base.mat3, base.xp] : null;
      const lootCards = [0, 1, 2, 3].map((i) => `
        <div class="resource-card ${MAT_BORDER_COLORS[i]}">
          <div class="resource-icon">${i < 3 ? `<img src="${MAT_ASSETS[i]}" alt="Material ${i + 1}" class="resource-image" />` : `<span class="text-lg">✦</span>`}</div>
          <div class="resource-content"><div class="resource-values">
            <div class="flex flex-col items-center"><span class="value ${MAT_TEXT_COLORS[i]} font-semibold">${fmt(values[i])}</span>${(baseValues && deltaBadge(values[i], baseValues[i], false)) || '<span class="unit text-xs text-gray-500">per run</span>'}</div>
            <div class="flex flex-col items-center"><span class="value ${MAT_TEXT_COLORS[i]} font-semibold">${fmt(values[i] * runsPerDay)}</span>${(baseValues && deltaBadge(values[i] * runsPerDay, baseValues[i] * baseRunsPerDay, false)) || '<span class="unit text-xs text-gray-500">per day</span>'}</div>
          </div></div>
        </div>`).join('');
      card.querySelector('[data-loot]').innerHTML = lootCards;

      // Verbatim port of the live site's "Boss Statistics" section (captured via
      // outerHTML): only shown when the wasm actually returns boss data for this hunter
      // (confirmed real on a shared/imported build) -- heart icon + red bar for Boss HP %,
      // sword icon + emerald bar for Boss Kill %, each with the same delta badge as every
      // other stat when comparing against the reference build.
      // Boss stages are every 100th stage (100, 200, 300...) -- only show Boss Statistics
      // when the build's simulated stage RANGE actually reaches one (i.e. there's a real
      // chance of a boss encounter this run), not just whenever the wasm happens to return
      // boss fields. A build that dies at stage 40 every run never sees a boss at all.
      const hasBossInRange = r.minStage !== undefined && r.maxStage !== undefined
        && Math.floor(r.maxStage / 100) >= Math.max(1, Math.ceil(r.minStage / 100));
      if (hasBossInRange && r.bossHpPercent !== undefined && r.bossKillRate !== undefined) {
        card.querySelector('[data-boss-section]').classList.remove('hidden');
        const hpPct = r.bossHpPercent, killPct = r.bossKillRate;
        const baseHpPct = base?.bossHpPercent, baseKillPct = base?.bossKillRate;
        card.querySelector('[data-boss]').innerHTML = `
          <div class="boss-stat-card">
            <div class="boss-stat-header"><div class="flex items-center">${iconSvg('heart-filled', 16, 'text-red-400 mr-1.5')}<span class="boss-stat-title">Boss HP %</span></div>${base ? deltaBadge(hpPct, baseHpPct, true) : ''}</div>
            <div class="boss-stat-value">${hpPct.toFixed(1)}%</div>
            <div class="boss-progress"><div class="boss-progress-bg"></div><div class="boss-progress-fill bg-red-500" style="width:${Math.min(100, hpPct)}%"></div></div>
          </div>
          <div class="boss-stat-card">
            <div class="boss-stat-header"><div class="flex items-center">${iconSvg('sword', 16, 'text-emerald-400 mr-1.5')}<span class="boss-stat-title">Boss Kill %</span></div>${base ? deltaBadge(killPct, baseKillPct, false) : ''}</div>
            <div class="boss-stat-value">${killPct.toFixed(1)}%</div>
            <div class="boss-progress"><div class="boss-progress-bg"></div><div class="boss-progress-fill bg-emerald-500" style="width:${Math.min(100, killPct)}%"></div></div>
          </div>`;
      }
    });
  }
}

const HUNTER_BANNER_GRADIENT = { borge: 'from-red-900', ozzy: 'from-green-900', knox: 'from-blue-900' };

function switchHunter(h, skipNav) {
  currentHunter = h;
  showCategoryId = 'active';
  ['borge', 'ozzy', 'knox'].forEach((hh) => {
    const btn = document.getElementById(`hunter${hh[0].toUpperCase()}${hh.slice(1)}Btn`);
    btn.className = `nav-pill ${h === hh ? `active-${hh}` : ''}`;
  });
  if (!skipNav && currentRoute() !== 'sim') navigate('sim');
  const title = document.getElementById('hunterTitle');
  const banner = document.getElementById('hunterBanner');
  const portrait = document.getElementById('hunterPortrait');
  if (title) title.textContent = HUNTER_TITLES[h];
  if (banner) banner.className = `bg-gradient-to-r ${HUNTER_BANNER_GRADIENT[h]} to-gray-800 px-5 py-5 sm:py-0.5 border-b border-gray-600`;
  if (portrait) { portrait.src = `assets/hunter_${h}.png`; portrait.alt = HUNTER_TITLES[h].replace(' Simulator', ''); }
  const statsLabel = document.getElementById('hunterStatsBtnLabel');
  if (statsLabel) statsLabel.textContent = `${HUNTER_TITLES[h].replace(' Simulator', '')} Stats`;
  if (currentRoute() === 'sim') { renderCategoryTabs(); renderBuildList(); }
  else render();
  updateNavGating();
}
document.getElementById('hunterBorgeBtn').onclick = () => switchHunter('borge');
document.getElementById('hunterOzzyBtn').onclick = () => switchHunter('ozzy');
document.getElementById('hunterKnoxBtn').onclick = () => switchHunter('knox');
// Import Save applies globally (it can populate any/all hunters from one save file), so it
// lives in the app header now instead of being duplicated per-hunter-page.
document.getElementById('importSaveBtnIcon').innerHTML = iconSvg('download', 16);
document.getElementById('copyBridgeCmdBtn').innerHTML = iconSvg('copy', 16);
document.getElementById('copyBridgeCmdBtn').onclick = () => {
  const cmd = document.getElementById('bridgeInstallCmd').textContent;
  navigator.clipboard?.writeText(cmd).catch(() => {});
  const btn = document.getElementById('copyBridgeCmdBtn');
  btn.innerHTML = iconSvg('info-circle', 16, 'text-green-400');
  setTimeout(() => { btn.innerHTML = iconSvg('copy', 16); }, 1200);
};
document.getElementById('importSaveBtn').onclick = openImportSaveModal;

// Shows the local CIFI Bridge's connection state in the sidebar whenever it's reachable, so
// you don't have to open the Import Save modal just to check. Polls rather than holding one
// persistent socket open in the background, since the bridge can start/stop independently
// of this page and reconnecting per-check is simpler than managing socket lifecycle here.
// Describes what CHECK_ADB's ADB_STATUS response means for the connected-device line, e.g.
// "connected — emulator detected" vs "connected — no device detected". emulatorCount/
// physicalCount come from the bridge's adb devices probe (bridge/adb-status.mjs).
function describeAdbDeviceStatus(status) {
  if (!status || status.serverRunning === false) return null;
  const { emulatorCount = 0, physicalCount = 0 } = status;
  if (emulatorCount > 0 && physicalCount > 0) return 'emulator + device detected';
  if (emulatorCount > 1) return `${emulatorCount} emulators detected`;
  if (emulatorCount === 1) return 'emulator detected';
  if (physicalCount > 1) return `${physicalCount} devices detected`;
  if (physicalCount === 1) return 'device detected';
  return 'no device detected';
}

let bridgeStatusWs = null;
async function refreshBridgeAdbStatusText(ws, text) {
  const status = await window.checkCifiBridgeAdbStatus(ws);
  const desc = describeAdbDeviceStatus(status);
  text.textContent = desc ? `CIFI Bridge connected — ${desc}` : 'CIFI Bridge connected';
}
async function updateBridgeStatusIndicator() {
  const box = document.getElementById('bridgeStatusSidebar');
  const dot = document.getElementById('bridgeStatusDot');
  const text = document.getElementById('bridgeStatusText');
  try {
    const ws = await window.tryConnectCifiBridge(1000);
    if (ws) {
      bridgeStatusWs = ws;
      box.classList.remove('hidden');
      dot.className = 'w-2 h-2 rounded-full bg-green-500 flex-shrink-0';
      text.textContent = 'CIFI Bridge connected';
      refreshBridgeAdbStatusText(ws, text);
      ws.addEventListener('close', () => { dot.className = 'w-2 h-2 rounded-full bg-gray-500 flex-shrink-0'; text.textContent = 'CIFI Bridge disconnected'; });
    } else {
      box.classList.add('hidden');
    }
  } catch { box.classList.add('hidden'); }
}
updateBridgeStatusIndicator();
setInterval(() => {
  if (!bridgeStatusWs || bridgeStatusWs.readyState !== WebSocket.OPEN) {
    updateBridgeStatusIndicator();
  } else {
    refreshBridgeAdbStatusText(bridgeStatusWs, document.getElementById('bridgeStatusText'));
  }
}, 8000);

// ==================== MANAGE CATEGORIES ====================

// Verbatim port of the live "Category Management" modal's layout (captured via outerHTML):
// System Categories (blue accent bar, builds count, non-deletable "System" pill) and Custom
// Categories (purple accent bar, "Add Category" button, empty-state folder icon) as two
// separate sections, plus a summary line and a "Done" footer button instead of a Save/Close
// pair.
function categoryTreeRow(cat, count, isSystem, color) {
  const row = document.createElement('div');
  row.className = 'category-tree-item-draggable';
  row.innerHTML = `
    <div class="p-2 rounded-lg border transition-all border-${color}-500/30 bg-${color}-900/10 hover:border-gray-500">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <div class="w-[22px]"></div>
          <div class="flex-shrink-0"><div class="w-4 h-4 rounded bg-${color}-500"></div></div>
          <div class="flex-1 min-w-0"><div class="text-sm font-medium text-white truncate">${escapeHtml(cat.name)}</div><div class="text-xs text-gray-400">${count} builds</div></div>
        </div>
        <div class="flex items-center gap-1 flex-shrink-0">
          ${isSystem
            ? '<div class="text-xs text-gray-500 px-2" title="System category cannot be modified"> System </div>'
            : '<button data-del class="text-xs px-2 py-1 bg-red-900/50 hover:bg-red-800 rounded text-white">Delete</button>'}
        </div>
      </div>
    </div>`;
  if (!isSystem) {
    row.querySelector('[data-del]').onclick = () => {
      store.categories = store.categories.filter((c) => c.id !== cat.id);
      ['borge', 'ozzy', 'knox'].forEach((h) => {
        store[h].builds.forEach((b) => { if (b.categoryId === cat.id) b.categoryId = 'active'; });
      });
      saveStore(); renderCategoriesList(); renderCategoryTabs(); renderBuildList();
    };
  }
  return row;
}
function openCategoriesModal() {
  const title = document.getElementById('categoriesModalTitle');
  if (!title.querySelector('svg')) title.insertAdjacentHTML('afterbegin', iconSvg('folder', 16, 'mr-2 text-blue-400'));
  renderCategoriesList();
  document.getElementById('categoriesModal').classList.remove('hidden');
}
function renderCategoriesList() {
  const buildCount = (id) => ['borge', 'ozzy', 'knox'].reduce((s, h) => s + store[h].builds.filter((b) => b.categoryId === id).length, 0);
  const sysList = document.getElementById('systemCategoriesList');
  sysList.innerHTML = '';
  const systemCats = store.categories.filter((c) => c.isSystem);
  const customCats = store.categories.filter((c) => !c.isSystem);
  systemCats.forEach((cat) => sysList.appendChild(categoryTreeRow(cat, buildCount(cat.id), true, cat.id === 'active' ? 'blue' : 'gray')));
  document.getElementById('customCategoriesCount').textContent = `(${customCats.length})`;
  const customList = document.getElementById('customCategoriesList');
  customList.innerHTML = '';
  if (!customCats.length) {
    customList.innerHTML = `<div class="text-center py-4">
      <div class="text-gray-600 mb-2">${iconSvg('folder', 32)}</div>
      <p class="text-gray-400 mb-2 text-xs">No custom categories yet</p>
      <button id="addFirstCategoryBtn" class="bg-purple-600 hover:bg-purple-700 text-white px-2 py-1 rounded-md transition-colors inline-flex items-center gap-1 text-xs">${iconSvg('plus', 12)} Add First Category</button>
    </div>`;
    document.getElementById('addFirstCategoryBtn').onclick = addCustomCategory;
  } else {
    customCats.forEach((cat) => customList.appendChild(categoryTreeRow(cat, buildCount(cat.id), false, 'purple')));
  }
  document.getElementById('categoriesSummary').innerHTML = `<strong>${systemCats.length} system categories</strong> and <strong>${customCats.length} custom categories</strong> available.`;
}
function addCustomCategory() {
  const name = prompt('New category name:');
  if (!name || !name.trim()) return;
  store.categories.push({ id: genBuildId(), name: name.trim(), isSystem: false });
  saveStore(); renderCategoriesList(); renderCategoryTabs();
}
document.getElementById('closeCategoriesBtn').onclick = () => document.getElementById('categoriesModal').classList.add('hidden');
document.getElementById('closeCategoriesDoneBtn').onclick = () => document.getElementById('categoriesModal').classList.add('hidden');
document.getElementById('addCategoryBtn').onclick = addCustomCategory;

// ==================== TEMPORARY UPGRADES ====================

// Verbatim port of the live "Temporary Upgrades" popover's row template (captured via
// outerHTML): a compact single-chevron-each-side stepper with a read-only value box for
// leveled upgrades, or a pill toggle switch for boolean ones -- grouped under a blue-bar
// section header per category, same visual language as the Overrides panel's rows but more
// compact (no double/jump chevrons here).
function renderTemporaryRow(catKey, item) {
  const fullKey = `${catKey}.${item.id}`;
  const isBoolean = item.maxLevel === 1;
  const level = store.globalUpgrades[fullKey] || 0;
  const row = document.createElement('div');
  row.className = 'flex items-center justify-between px-2 py-1.5 hover:bg-gray-700/30 rounded transition-colors';
  const setLevel = (v) => {
    store.globalUpgrades[fullKey] = Math.max(0, item.maxLevel === Infinity ? v : Math.min(item.maxLevel, v));
    saveStore();
    renderTemporaryPopoverBody();
  };
  if (isBoolean) {
    row.innerHTML = `
      <span class="text-xs text-white flex-1 mr-2 leading-relaxed">${escapeHtml(item.label)}</span>
      <button data-toggle class="w-10 h-5 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800 ${level ? 'bg-green-600' : 'bg-red-600'}">
        <div class="w-4 h-4 bg-white rounded-full shadow transform transition-transform duration-200 ${level ? 'translate-x-5' : ''}"></div>
      </button>`;
    row.querySelector('[data-toggle]').onclick = () => setLevel(level ? 0 : 1);
    return row;
  }
  const canDec = level > 0;
  const canInc = item.maxLevel === Infinity || level < item.maxLevel;
  row.innerHTML = `
    <span class="text-xs text-white flex-1 mr-2 leading-relaxed">${escapeHtml(item.label)}</span>
    <div class="flex-shrink-0"><div class="flex items-center">
      <button data-dec class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-l-md ${canDec ? '' : 'opacity-20 cursor-not-allowed'}" ${canDec ? '' : 'disabled'}>${iconSvg('chevron-left', 14)}</button>
      <div class="min-w-[45px] text-center bg-gray-800 py-[1px] h-6 border-y border-gray-600 flex items-center justify-center"><span class="${level ? 'text-green-400' : 'text-gray-500'}">${level}</span></div>
      <button data-inc class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-r-md ${canInc ? '' : 'opacity-20 cursor-not-allowed'}" ${canInc ? '' : 'disabled'}>${iconSvg('chevron-right', 14)}</button>
    </div></div>`;
  if (canDec) row.querySelector('[data-dec]').onclick = () => setLevel(level - 1);
  if (canInc) row.querySelector('[data-inc]').onclick = () => setLevel(level + 1);
  return row;
}

function renderTemporaryPopoverBody() {
  const body = document.getElementById('temporaryBody');
  body.innerHTML = '';
  Object.entries(window.ALL_UPGRADE_CATEGORIES).forEach(([catKey, cat]) => {
    const tempItems = cat.items.filter((i) => i.temporary);
    if (!tempItems.length) return;
    const section = document.createElement('div');
    section.className = 'mb-2 last:mb-0';
    section.innerHTML = `<div class="px-3 py-2 bg-gray-700/50 border-b border-gray-600/30 flex items-center"><div class="w-1.5 h-5 bg-blue-500 rounded-r mr-2"></div><h4 class="text-xs font-semibold text-gray-200 uppercase tracking-wide">${escapeHtml(cat.label)}</h4></div>`;
    const list = document.createElement('div');
    list.className = 'p-1 space-y-1';
    tempItems.forEach((item) => list.appendChild(renderTemporaryRow(catKey, item)));
    section.appendChild(list);
    body.appendChild(section);
  });
}

function openTemporaryModal() {
  const popover = document.getElementById('temporaryPopover');
  const btn = document.getElementById('temporaryUpgradesBtn');
  renderTemporaryPopoverBody();
  const rect = btn.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${rect.left}px`;
  popover.classList.remove('hidden');
  const onOutsideClick = (e) => {
    if (!popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      popover.classList.add('hidden');
      document.removeEventListener('click', onOutsideClick, true);
    }
  };
  setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
}

// ==================== UPGRADE CATEGORY PAGES ====================

// Matches the real Upgrades category page's card style: title + level badge, an effect-
// preview box (e.g. "Borge Max HP x1.24"), and a chevron/progress-bar/chevron control row
// with << >> jump-to-min/max. Effect previews use the real per-item formulas from
// upgradeEffects.js (verified against the live site's own displayed values); researches use
// their exact tier tables; gadgets and Diamond Ultima don't have a confirmed preview formula
// so they show level-only.
function effectBox(lines) {
  if (!lines.length) return '';
  return `<div class="bg-gray-900/50 p-3 rounded-md w-full mb-3">${lines.map((l) => `
      <div class="flex justify-between items-center py-1"><span class="text-gray-400 text-sm">${l.label}</span><span class="text-white font-medium text-sm">${l.value}</span></div>`).join('')}</div>`;
}

function renderUpgradeInput(catKey, item) {
  const fullKey = `${catKey}.${item.id}`;
  const isBoolean = item.maxLevel === 1;
  const level = store.globalUpgrades[fullKey] || 0;
  const cap = item.maxLevel === Infinity ? null : item.maxLevel;
  const card = document.createElement('div');
  card.className = 'relative rounded-xl overflow-hidden border border-gray-700/50 bg-gradient-to-br from-gray-800/80 via-gray-800/60 to-gray-900/80 p-4 flex flex-col';

  if (fullKey === 'ultima.ulti') {
    // Confirmed real (live Ultima.vue): this isn't a leveled upgrade at all -- the stored
    // value itself IS the loot multiplier, set directly via a 1.0000-3.4476 slider (a number
    // input allows typing up to 10.0000 manually). No level/curve formula involved.
    const mult = level || 1;
    card.innerHTML = `
      <div class="flex items-center justify-between gap-2 mb-3">
        <h3 class="font-semibold text-white truncate min-w-0 flex-1 text-[1.05rem]" title="${item.label}">${item.label}</h3>
      </div>
      ${effectBox([{ label: 'Loot Reward', value: `x${mult.toFixed(4)}` }])}
      <div class="flex flex-col items-center gap-2">
        <input data-ulti-input type="number" step="0.0001" min="1" max="10" value="${mult.toFixed(4)}" class="bg-gray-900/70 border border-gray-700/30 text-white text-center font-mono rounded-lg py-1 w-28" />
        <input data-ulti-slider type="range" min="1" max="3.4476" step="0.0001" value="${Math.min(mult, 3.4476)}" class="w-full appearance-none bg-gray-700/60 h-3 rounded-full outline-none cursor-pointer" />
      </div>`;
    const setUlti = (v) => {
      v = Math.max(1, Math.min(10, v));
      store.globalUpgrades[fullKey] = parseFloat(v.toFixed(4));
      saveStore();
      renderUpgradesPage(document.getElementById('pageRoot'), catKey);
    };
    card.querySelector('[data-ulti-input]').onchange = (e) => setUlti(parseFloat(e.target.value) || 1);
    card.querySelector('[data-ulti-slider]').oninput = (e) => setUlti(parseFloat(e.target.value));
    return card;
  }

  if (isBoolean) {
    const f = window.UPGRADE_FORMULAS[fullKey];
    const lines = f && f.type === 'boolean-bonuses' ? f.bonuses.map((b) => ({ label: b.stat, value: `x${b.value.toFixed(2)}` })) : [];
    card.innerHTML = `<div class="flex items-center justify-between gap-2 mb-2">
        <h3 class="font-semibold text-white text-[1.05rem]" title="${item.label}">${item.label}</h3>
        <span class="text-xs font-semibold ${level ? 'text-green-400' : 'text-gray-500'}">${level ? 'Active' : 'Inactive'}</span>
      </div>
      ${effectBox(lines)}
      <label class="flex items-center cursor-pointer mt-auto"><input type="checkbox" ${level ? 'checked' : ''} class="sr-only peer" /><div class="w-10 h-5 bg-gray-700 peer-checked:bg-green-600 rounded-full transition-colors relative"><div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div></div></label>`;
    card.querySelector('input').onchange = (e) => { store.globalUpgrades[fullKey] = e.target.checked ? 1 : 0; saveStore(); renderUpgradesPage(document.getElementById('pageRoot'), catKey); };
    return card;
  }

  const lines = window.RESEARCH_TIERS[item.id] ? window.computeResearchLines(item.id, level)
    : window.GADGET_FORMULAS[item.id] ? window.computeGadgetLines(item.id, level)
    : window.computeEffectLines(fullKey, level, catKey === 'inscryptions');
  const canDec = level > 0;
  const canInc = cap === null || level < cap;
  const pct = cap ? (level / cap) * 100 : 0;
  // "Next Level Cost" -- real, extracted cost formulas (costFormulas.js), matching the live
  // Upgrades page's own cards exactly (e.g. Inscryption #60 at level 0 shows "4.00b").
  let nextCostLine = '';
  const CF = window.CostFormulas;
  if (canInc && CF) {
    let cost;
    if (catKey === 'relics') cost = CF.relicCostRange(item.id, level, level + 1);
    else if (catKey === 'inscryptions') cost = CF.inscryptionCostRange(item.id, level, level + 1);
    if (cost !== undefined && cost !== null) nextCostLine = `<div class="flex justify-between items-center py-1 border-t border-gray-700/50 mt-1 pt-2"><span class="text-gray-400 text-sm">Next Level Cost</span><span class="text-amber-400 font-medium text-sm">${CF.fmtBig(cost)}</span></div>`;
  }
  card.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-3">
      <h3 class="font-semibold text-white truncate min-w-0 flex-1 text-[1.05rem]" title="${item.label}">${item.label}</h3>
      <div class="px-3 py-1 rounded-lg bg-gray-900/70 border border-gray-700/30"><span class="font-bold text-lg text-gray-300" data-level>${level}</span><span class="text-xs text-gray-500">/${cap ?? '∞'}</span></div>
    </div>
    ${effectBox(lines)}${nextCostLine}
    <div class="flex items-center justify-between mt-auto pt-2 gap-1.5">
      <button data-min class="ctrl-btn ctrl-btn--gray" ${canDec ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-left', 16)}${iconSvg('chevron-left', 16, '-ml-2.5')}</button>
      <button data-dec class="ctrl-btn ctrl-btn--gray" ${canDec ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-left', 16)}</button>
      <div class="w-full rounded-full overflow-hidden relative h-2 border border-gray-500/20 flex-1 h-5">
        <div class="absolute inset-0 bg-gray-800/90 rounded-full"></div>
        <div data-fill class="h-full relative rounded-full transition-all duration-300 overflow-hidden bg-gradient-to-r from-gray-600 via-gray-500 to-gray-400" style="width:${pct}%"></div>
      </div>
      <button data-inc class="ctrl-btn ctrl-btn--gray" ${canInc ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-right', 16)}</button>
      <button data-max class="ctrl-btn ctrl-btn--gray" ${canInc ? '' : 'disabled style="opacity:.3"'}>${iconSvg('chevron-right', 16)}${iconSvg('chevron-right', 16, '-ml-2.5')}</button>
    </div>`;
  const setLevel = (v) => {
    v = Math.max(0, cap !== null ? Math.min(v, cap) : v);
    store.globalUpgrades[fullKey] = v;
    saveStore();
    renderUpgradesPage(document.getElementById('pageRoot'), catKey);
  };
  // Confirmed real (live ToolValueControls.vue): the double chevrons are a fastStep of 10,
  // not a jump-to-min/max -- W()/X() do value +/- fastStep (clamped to min/max), same as the
  // single chevrons just with a bigger step.
  card.querySelector('[data-inc]').onclick = () => setLevel(level + 1);
  card.querySelector('[data-dec]').onclick = () => setLevel(level - 1);
  card.querySelector('[data-max]').onclick = () => setLevel(level + 10);
  card.querySelector('[data-min]').onclick = () => setLevel(level - 10);
  return card;
}

// Inscryptions is the one category page that uses per-hunter tabs + a "Hide Maxed" toggle
// on the real site (confirmed live) -- every other category just lists all items with
// inline per-hunter effect lines instead.
let inscriptionsTabHunter = 'Borge';
let hideMaxedInscriptions = false;

function renderUpgradesPage(root, catKey) {
  const cat = window.ALL_UPGRADE_CATEGORIES[catKey];
  if (!cat) { root.innerHTML = ''; return; }

  if (catKey === 'inscryptions') {
    root.innerHTML = `
      <div class="flex items-center justify-center gap-2 mb-4" id="inscTabs"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" id="upgradeItemsGrid"></div>`;
    const tabs = document.getElementById('inscTabs');
    ['Borge', 'Ozzy', 'Knox'].forEach((h) => {
      const btn = document.createElement('button');
      btn.textContent = h;
      btn.className = `px-4 py-1.5 rounded-full text-sm font-semibold ${inscriptionsTabHunter === h ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`;
      btn.onclick = () => { inscriptionsTabHunter = h; renderUpgradesPage(root, catKey); };
      tabs.appendChild(btn);
    });
    const hideBtn = document.createElement('button');
    hideBtn.className = 'ml-auto flex items-center gap-2 text-xs text-gray-400';
    hideBtn.innerHTML = `<span>Hide Maxed</span><div class="w-9 h-5 rounded-full transition-colors ${hideMaxedInscriptions ? 'bg-blue-600' : 'bg-gray-700'}"><div class="w-4 h-4 bg-white rounded-full m-0.5 transition-transform ${hideMaxedInscriptions ? 'translate-x-4' : ''}"></div></div>`;
    hideBtn.onclick = () => { hideMaxedInscriptions = !hideMaxedInscriptions; renderUpgradesPage(root, catKey); };
    tabs.appendChild(hideBtn);

    const grid = document.getElementById('upgradeItemsGrid');
    cat.items
      .filter((item) => {
        const f = window.UPGRADE_FORMULAS[`inscryptions.${item.id}`];
        return f && f.effects[0].hunter === inscriptionsTabHunter;
      })
      .filter((item) => !hideMaxedInscriptions || (store.globalUpgrades[`inscryptions.${item.id}`] || 0) < item.maxLevel)
      .forEach((item) => { grid.appendChild(renderUpgradeInput(catKey, item)); });
    return;
  }

  root.innerHTML = `
    <h1 class="text-2xl font-bold text-white text-center mb-4">${cat.label}</h1>
    <div class="text-center text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">Tier 1</div>
    <div id="upgradeItemsGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"></div>`;
  const grid = document.getElementById('upgradeItemsGrid');
  cat.items.forEach((item) => { grid.appendChild(renderUpgradeInput(catKey, item)); });
}

// ==================== SETTINGS PAGE ====================
// Verbatim-structure port of the live Settings page's four sections (Backup & Restore,
// Storage Issues, Cache Management, Advanced Talents Settings). "Backup & Restore" here is
// a REAL full-store export/import (base64 of the same JSON saveStore() already persists to
// localStorage) rather than a placeholder -- pasting a previously generated code actually
// restores every hunter's builds/settings. "Advanced Talents Settings" stores each hunter's
// gate level in the store and actually hides talents whose `advancedMinLevel` is above it
// (see HUNTER_DEFS talents) once a talent is marked as advanced -- currently no talent in
// HUNTER_DEFS is flagged advanced, since "The Legacy of Ultima" (confirmed real, level-70+
// gated on the live site) hasn't been reverse-engineered into the talent list yet, so the
// gate exists and is wired up but has nothing to hide yet.
function settingsSection(icon, iconColor, title, bodyHtml) {
  return `<div class="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden mb-5">
    <div class="bg-gray-700/40 px-4 py-3 border-b border-gray-700 flex items-center gap-2">
      ${iconSvg(icon, 18, iconColor)}<h2 class="font-semibold text-white">${title}</h2>
    </div>
    <div class="p-4">${bodyHtml}</div>
  </div>`;
}

function renderSettingsPage(root) {
  root.innerHTML = `
    <h1 class="text-2xl font-bold text-white text-center mb-6">Settings</h1>
    <div class="max-w-3xl mx-auto">
      ${settingsSection('download', 'text-blue-400', 'Backup &amp; Restore', `
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Create a Backup</h3>
        <p class="text-xs text-gray-400 mb-2">Create a backup of your entire profile, including all hunters, builds, and settings. You can use this backup to restore your data on another device or after clearing your browser data.</p>
        <button id="generateBackupBtn" class="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-md text-white text-sm mb-4">Generate Backup Code</button>
        <div id="backupCodeOut" class="hidden mb-4"><textarea readonly class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-xs text-gray-300 font-mono h-24"></textarea></div>
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Restore from Backup</h3>
        <p class="text-xs text-gray-400 mb-2">Restore your data from a previously created backup. This will replace all current data. <span class="text-red-400">This action cannot be undone.</span></p>
        <textarea id="restoreCodeInput" placeholder="Paste your backup code here..." class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-xs text-gray-300 font-mono h-20 mb-2"></textarea>
        <div class="flex gap-2">
          <button id="restoreBackupBtn" class="px-3 py-2 bg-amber-700 hover:bg-amber-600 rounded-md text-white text-sm">Restore from Backup</button>
          <button id="uploadBackupBtn" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-md text-white text-sm">Upload Backup File</button>
          <input id="uploadBackupFile" type="file" accept=".txt,.json" class="hidden" />
        </div>
      `)}
      ${settingsSection('refresh', 'text-orange-400', 'Storage Issues', `
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Quick Fix Storage</h3>
        <p class="text-xs text-gray-400 mb-2">If you experience data loss on page refresh or storage warnings, use this quick fix. It re-saves your current data to browser storage.</p>
        <button id="quickFixBtn" class="px-3 py-2 bg-orange-700 hover:bg-orange-600 rounded-md text-white text-sm">Quick Fix Storage Issues</button>
        <span id="quickFixResult" class="text-xs text-green-400 ml-2"></span>
      `)}
      ${settingsSection('folder', 'text-amber-400', 'Cache Management', `
        <p class="text-xs text-gray-400 mb-2">Clear the evaluation cache to free up memory. This won't affect your builds or settings, but may temporarily slow down the application as the cache rebuilds.</p>
        <button id="clearCacheBtn" class="px-3 py-2 bg-orange-700 hover:bg-orange-600 rounded-md text-white text-sm">Clear Evaluation Cache</button>
        <span id="clearCacheResult" class="text-xs text-green-400 ml-2"></span>
      `)}
      ${settingsSection('settings', 'text-purple-400', 'Advanced Talents Settings', `
        <p class="text-xs text-gray-400 mb-3">Advanced talents like "The Legacy of Ultima" are only available at higher Hunter Levels. These settings control when those talents are shown, to provide a beginner-friendly experience.</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3" id="advancedTalentsGrid"></div>
      `)}
    </div>`;

  document.getElementById('generateBackupBtn').onclick = () => {
    const code = btoa(unescape(encodeURIComponent(JSON.stringify(store))));
    const box = document.getElementById('backupCodeOut');
    box.classList.remove('hidden');
    box.querySelector('textarea').value = code;
  };
  document.getElementById('restoreBackupBtn').onclick = () => {
    const raw = document.getElementById('restoreCodeInput').value.trim();
    if (!raw) return;
    if (!confirm('This will replace all current data. This action cannot be undone. Continue?')) return;
    try {
      const restored = JSON.parse(decodeURIComponent(escape(atob(raw))));
      Object.keys(store).forEach((k) => delete store[k]);
      Object.assign(store, restored);
      saveStore();
      alert('Backup restored.');
      render();
    } catch (e) { alert('Invalid backup code: ' + e.message); }
  };
  document.getElementById('uploadBackupBtn').onclick = () => document.getElementById('uploadBackupFile').click();
  document.getElementById('uploadBackupFile').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((t) => { document.getElementById('restoreCodeInput').value = t.trim(); });
  };
  document.getElementById('quickFixBtn').onclick = () => {
    saveStore();
    document.getElementById('quickFixResult').textContent = 'Storage re-saved.';
  };
  document.getElementById('clearCacheBtn').onclick = () => {
    HunterSim.clearCache();
    document.getElementById('clearCacheResult').textContent = 'Cache cleared.';
  };

  const grid = document.getElementById('advancedTalentsGrid');
  ['borge', 'ozzy', 'knox'].forEach((h) => {
    const highestLevel = Math.max(0, ...store[h].builds.map((b) => b.level || 0));
    const hasAdvancedTalent = window.HUNTER_DEFS[h].talents.some((t) => t.advanced);
    const shown = shouldShowAdvancedTalents(h);
    const card = document.createElement('div');
    card.className = 'bg-gray-900/50 border border-gray-700 rounded-lg p-3';
    card.innerHTML = `
      <div class="flex items-center gap-2 mb-1"><span class="font-semibold text-white capitalize">${h}</span></div>
      <div class="text-xs text-gray-400 mb-2">Highest Level: ${highestLevel}</div>
      ${hasAdvancedTalent
        ? `<button data-toggle class="w-full px-3 py-1.5 rounded-md text-sm ${shown ? 'bg-purple-700 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}">${shown ? 'Hide Advanced' : 'Show Advanced'}</button>`
        : `<div class="text-xs text-gray-600">No advanced talents for this hunter.</div>`}`;
    if (hasAdvancedTalent) {
      card.querySelector('[data-toggle]').onclick = () => {
        store.settings = store.settings || {};
        store.settings.advancedTalents = store.settings.advancedTalents || {};
        store.settings.advancedTalents[h] = !shown;
        saveStore();
        renderSettingsPage(root);
      };
    }
    grid.appendChild(card);
  });
}

// Matches the real "Borge/Ozzy/Knox Stats" modal (opened from the banner button) --
// same chevron-stepper cards as everything else, confirmed exact for Borge's stat labels
// against the live site; Ozzy/Knox use the corresponding param names from their own
// EVAL_PARAMS lists with best-match display labels since those two accounts weren't
// available to verify pixel-for-pixel.
const STAT_LABELS = {
  hp: 'MAX HP', atk: 'ATK Power', regen: 'HP Regen', dr: 'DMG Reduction', evade: 'Evade Chance',
  effect: 'Effect Chance', critchance: 'Crit Chance', critpower: 'Crit Power', atkspeed: 'ATK Speed',
  multichance: 'Multistrike Chance', multipower: 'Multistrike Power',
  block: 'Block Chance', charge: 'Charge', chargeGain: 'Charge Gain', reload: 'Reload', proj: 'Projectiles Per Salvo',
  stage: 'Highest Stage Reached',
};
const STAT_BAR_MAX = { hp: 1000, atk: 1000, regen: 100, critpower: 100, stage: 500 };

// Verbatim port of the live "Hunter Stats" modal's card (captured via outerHTML): unlike
// the Build Creator's card (single chevron each side, no mobile variant here), this one has
// a min/dec/bar/inc/max quad-chevron row and no responsive md:hidden alternate layout.
// Wires a double-chevron button to step by 10 on a normal click, but jump straight to the
// true min/max on a press-and-hold (~450ms) instead -- single clicks used to jump straight to
// the absolute min/max here (unlike every other double-chevron stepper in the app, which
// steps by 10; see renderUpgradeInput's ctrl-btn row), which made it too easy to overshoot a
// stat by accident. Hold-to-jump keeps that "snap to max/min" capability available without
// losing it, just off the accidental single-click path.
const HOLD_TO_JUMP_MS = 450;
function wireStepOrHoldButton(button, stepFn, jumpFn) {
  let firedByHold = false;
  let timer = null;
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    firedByHold = false;
    clearTimer();
    timer = setTimeout(() => { firedByHold = true; jumpFn(); }, HOLD_TO_JUMP_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => button.addEventListener(evt, clearTimer));
  button.addEventListener('click', () => {
    if (firedByHold) { firedByHold = false; return; }
    stepFn();
  });
}

function renderQuadStepperCard({ label, level, maxLevel, accentColor, canDec, onInc, onDec, onMax, onMin, onJumpMax, onJumpMin, softMax }) {
  const uncapped = maxLevel === Infinity;
  const barMax = uncapped ? (softMax || 1000) : maxLevel;
  const pct = Math.min(100, (level / barMax) * 100);
  const div = document.createElement('div');
  div.className = 'bg-gray-700 rounded-lg p-2.5 border border-gray-600 hover:border-gray-500 transition-colors shadow-md';
  div.innerHTML = `
    <div class="flex justify-between items-center mb-2">
      <span class="text-sm font-medium text-white">${label}</span>
      <div class="flex items-center"><span class="text-base font-bold text-${accentColor}-400">${level}</span>${uncapped ? '' : `<span class="text-xs text-gray-500 ml-1"> /${maxLevel}</span>`}</div>
    </div>
    <div class="flex items-center justify-between mt-2">
      <button data-min class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors ${canDec ? '' : 'opacity-20 cursor-not-allowed hover:bg-gray-900'} p-2" ${canDec ? '' : 'disabled'} style="min-width:2.5rem;"><div class="flex">${iconSvg('chevron-left', 18)}${iconSvg('chevron-left', 18, '-ml-2')}</div></button>
      <button data-dec class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors ml-1 ${canDec ? '' : 'opacity-20 cursor-not-allowed hover:bg-gray-900'} p-2" ${canDec ? '' : 'disabled'} style="min-width:2.5rem;">${iconSvg('chevron-left', 18)}</button>
      <div class="w-full rounded-full overflow-hidden relative h-2 border border-${accentColor}-500/20 flex-1 mx-1.5 h-5">
        <div class="absolute inset-0 bg-gray-800/90 rounded-full"></div>
        <div class="h-full relative rounded-full transition-all duration-300 overflow-hidden bg-gradient-to-r from-${accentColor}-700 via-${accentColor}-500 to-${accentColor}-400" style="width:${pct}%"></div>
      </div>
      <button data-inc class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors mr-1 p-2" style="min-width:2.5rem;">${iconSvg('chevron-right', 18)}</button>
      <button data-max class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors p-2" style="min-width:2.5rem;">${iconSvg('chevron-right', 18)}${iconSvg('chevron-right', 18, '-ml-2')}</button>
    </div>`;
  div.querySelector('[data-inc]').onclick = onInc;
  wireStepOrHoldButton(div.querySelector('[data-max]'), onMax, onJumpMax || onMax);
  if (canDec) {
    div.querySelector('[data-dec]').onclick = onDec;
    wireStepOrHoldButton(div.querySelector('[data-min]'), onMin, onJumpMin || onMin);
  }
  return div;
}

function openStatsModal() {
  const modal = document.getElementById('statsModal');
  document.getElementById('statsModalTitle').textContent = HUNTER_TITLES[currentHunter].replace(' Simulator', '');
  document.getElementById('statsModalTitle').className = `text-${HUNTER_ACCENTS[currentHunter]}-500`;
  const iconWrap = document.getElementById('statsModalIconWrap');
  if (!iconWrap.querySelector('svg')) iconWrap.insertAdjacentHTML('afterbegin', iconSvg('chart-arrows-vertical', 20, `mr-2 text-${HUNTER_ACCENTS[currentHunter]}-400`));
  else iconWrap.querySelector('svg').setAttribute('class', `tabler-icon mr-2 text-${HUNTER_ACCENTS[currentHunter]}-400`);
  renderStatsModalBody();
  modal.classList.remove('hidden');
}
function renderStatsModalBody() {
  const grid = document.getElementById('statsModalGrid');
  grid.innerHTML = '';
  const d = defs();
  d.baseStatKeys.forEach((key) => {
    const cap = d.statCaps[key];
    const level = store[currentHunter].hunterStats[key] || 0;
    const card = renderQuadStepperCard({
      label: STAT_LABELS[key] || key, level, maxLevel: cap !== Infinity ? cap : Infinity,
      accentColor: HUNTER_ACCENTS[currentHunter], canDec: level > 0, softMax: STAT_BAR_MAX[key],
      onInc: () => { store[currentHunter].hunterStats[key] = level + 1; saveStore(); renderStatsModalBody(); },
      onDec: () => { store[currentHunter].hunterStats[key] = level - 1; saveStore(); renderStatsModalBody(); },
      onMax: () => { store[currentHunter].hunterStats[key] = cap !== Infinity ? Math.min(cap, level + 10) : level + 10; saveStore(); renderStatsModalBody(); },
      onMin: () => { store[currentHunter].hunterStats[key] = Math.max(0, level - 10); saveStore(); renderStatsModalBody(); },
      onJumpMax: () => { store[currentHunter].hunterStats[key] = cap !== Infinity ? cap : level + 10; saveStore(); renderStatsModalBody(); },
      onJumpMin: () => { store[currentHunter].hunterStats[key] = 0; saveStore(); renderStatsModalBody(); },
    });
    grid.appendChild(card);
  });
}
document.getElementById('closeStatsModalBtn').onclick = () => document.getElementById('statsModal').classList.add('hidden');

// ==================== GEMS PAGE ====================
// Structure/styling below matches the live Gems.vue markup: a two-line info banner with the
// "Show only Sim relevant" toggle (persisted the same way, to localStorage), then cards split
// into a bordered "gem-header" (dot + name + level badge, both using the tree's real gradient)
// and a body of node buttons (flex row, not a fixed 6-col grid) + upgrade-field rows with a
// left accent bar in each field's real color.

function renderGemsPage(root) {
  let hideNonSimRelevant = true;
  try { hideNonSimRelevant = JSON.parse(localStorage.getItem('gems_showOnlySimRelevant') || 'true'); } catch { /* ignore */ }
  root.innerHTML = `<h2 class="text-2xl font-bold mb-4 text-center text-white">Gems</h2>
    <div class="bg-blue-900/30 border border-blue-800 rounded-lg p-3 mb-6 flex items-center justify-between gap-3 flex-wrap">
      <p class="text-blue-200 text-sm">Configure your current Gem levels, Gem nodes and upgrades here. These values will be used across all tools on this site.</p>
      <label class="flex items-center gap-2 shrink-0 cursor-pointer">
        <span class="text-blue-200 text-sm font-medium whitespace-nowrap">Show only Sim relevant:</span>
        <span data-sim-toggle class="relative inline-flex h-6 w-12 items-center rounded-full transition-colors ${hideNonSimRelevant ? 'bg-green-600' : 'bg-blue-600'}">
          <span class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${hideNonSimRelevant ? 'translate-x-6' : 'translate-x-1'}"></span>
        </span>
      </label>
    </div>
    <div id="gemTreesGrid" class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5"></div>`;
  // Toggling this OFF reveals each tree's non-sim-relevant fields (GEM_TREES.*.nonSimKeys --
  // Cells/Shards Bonus, MP Bonus (LMs/Ticks), Studies per Study, Mech Bonus Cap), matching
  // the live site's own "Show only Sim relevant" behavior exactly; these values are pure
  // account bookkeeping and never feed HunterSim.evaluate.
  root.querySelector('[data-sim-toggle]').onclick = () => {
    hideNonSimRelevant = !hideNonSimRelevant;
    localStorage.setItem('gems_showOnlySimRelevant', JSON.stringify(hideNonSimRelevant));
    renderGemsPage(root);
  };
  const grid = document.getElementById('gemTreesGrid');
  Object.entries(window.GEM_TREES).forEach(([key, tree]) => {
    const state = store.gems[key];
    const card = document.createElement('div');
    card.className = 'bg-gray-900/80 border border-gray-700/50 rounded-xl hover:border-gray-500/50 transition-all duration-300 ease-in-out';
    card.innerHTML = `
      <div class="gem-header border-b border-gray-600/50 rounded-t-xl p-2 transition-all duration-300 ease-in-out">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <div class="w-4 h-4 rounded-full border border-gray-500" style="background:${tree.gradient}"></div>
            <h3 class="text-sm font-semibold text-white truncate">${tree.label}</h3>
          </div>
          <span class="text-xs text-white px-1.5 py-0.5 rounded-full font-mono border border-gray-500/50" style="background:${tree.gradient}">${state.level}/${tree.maxLevel}</span>
        </div>
        <div class="flex items-center gap-1">
          <button data-lvl-dec class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-l-md">${iconSvg('chevron-left', 14)}</button>
          <span class="flex-1 text-center text-white font-medium bg-gray-800 h-6 flex items-center justify-center border-y border-gray-600" data-lvl-val>${state.level}</span>
          <button data-lvl-inc class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-r-md">${iconSvg('chevron-right', 14)}</button>
        </div>
      </div>
      <div class="p-1 space-y-1">
        <div class="flex gap-1 mt-2 px-1" data-nodes></div>
        <div class="space-y-1" data-upgrades></div>
      </div>`;

    const setLevel = (v) => {
      const newLevel = Math.max(0, Math.min(tree.maxLevel, v));
      // Confirmed real: dropping a tree's level below a named field's unlock threshold
      // resets that field back to 0 (it's about to disappear from view).
      if (newLevel < state.level) {
        tree.upgradeKeys.forEach((upKey) => {
          if (newLevel < ((tree.unlocks && tree.unlocks[upKey]) || 1)) state.upgrades[upKey] = 0;
        });
        (tree.nonSimKeys || []).forEach((upKey) => {
          if (newLevel < ((tree.nonSimUnlocks && tree.nonSimUnlocks[upKey]) || 0)) state.upgrades[upKey] = 0;
        });
      }
      state.level = newLevel;
      // Confirmed real: dropping Exodus below 5 auto-untoggles any tier-2 (exodus-5-gated)
      // nodes across every OTHER tree, since they're about to become invisible/inaccessible
      // again. Exodus's OWN nodes are handled separately below since Exodus gates all 6 of
      // its own nodes on its own level (0 visible until maxed), not just nodes 4-6.
      if (key === 'exodus' && state.level < window.GEM_TREES.exodus.maxLevel) {
        Object.entries(store.gems).forEach(([gemKey, s]) => {
          if (gemKey === 'exodus') { s.nodes.fill(false); return; }
          for (let i = 3; i < s.nodes.length; i++) s.nodes[i] = false;
        });
      }
      saveStore();
      renderGemsPage(root);
    };
    card.querySelector('[data-lvl-dec]').onclick = () => setLevel(state.level - 1);
    card.querySelector('[data-lvl-inc]').onclick = () => setLevel(state.level + 1);

    const nodesWrap = card.querySelector('[data-nodes]');
    // Corrected against a real account (2026-07): the previous comment here ("nodes 4-6 of
    // every tree, including Exodus's own, unlock at Exodus level 5") was an unverified
    // assumption and wrong for Exodus specifically. Confirmed directly by maxing a real
    // account's Exodus tree: Exodus shows ZERO node buttons at any level below its own max,
    // then all 6 at once the instant it hits 5/5 -- it is NOT "3 always visible, 3 more once
    // Exodus is maxed" like every OTHER tree. Every other tree (Temporal/Innovation/Power/
    // Attraction/Creation/Evolution) does follow that shared "3, then 6 once Exodus is maxed"
    // rule -- only Exodus itself is self-gated on its own level instead.
    const exodusMaxed = store.gems.exodus.level >= window.GEM_TREES.exodus.maxLevel;
    const visibleNodeCount = key === 'exodus'
      ? (exodusMaxed ? tree.nodeCount : 0)
      : (exodusMaxed ? tree.nodeCount : Math.min(3, tree.nodeCount));
    const nodesClickable = state.level >= 1;
    for (let i = 0; i < visibleNodeCount; i++) {
      const btn = document.createElement('button');
      btn.textContent = String(i + 1);
      btn.className = `flex-1 py-1 text-xs rounded font-mono border border-gray-500 hover:scale-105 transition-all duration-200 ease-in-out ${state.nodes[i] ? 'text-white shadow-lg' : 'bg-gray-600/60 text-gray-300 hover:bg-gray-500/60'} ${nodesClickable ? '' : 'opacity-30 cursor-not-allowed'}`;
      if (state.nodes[i]) btn.style.background = tree.gradient;
      if (nodesClickable) btn.onclick = () => { state.nodes[i] = !state.nodes[i]; saveStore(); renderGemsPage(root); };
      else btn.disabled = true;
      nodesWrap.appendChild(btn);
    }

    const upgradesWrap = card.querySelector('[data-upgrades]');
    // Confirmed real: each named upgrade field only appears once this tree's own level
    // reaches its "unlock" threshold (e.g. Attraction's Knox Loot Bonus needs level 4) --
    // matches the live bundle's W()/getUpgrades() filter (`s>=e.unlock`) exactly.
    tree.upgradeKeys.filter((upKey) => state.level >= ((tree.unlocks && tree.unlocks[upKey]) || 1)).forEach((upKey) => {
      const label = (tree.labels && tree.labels[upKey]) || upKey;
      const color = (tree.fieldColors && tree.fieldColors[upKey]) || '#6b7280';
      const val = state.upgrades[upKey] || 0;
      const wrap = document.createElement('div');
      wrap.className = 'bg-gray-800/60 rounded-sm p-2 pt-1.5 hover:bg-gray-700/60 transition-colors border-l-3';
      wrap.style.borderLeftColor = color;
      wrap.innerHTML = `<div class="flex items-center justify-between mb-1"><span class="text-xs font-medium text-white truncate">${label}</span></div>
        <div class="flex items-center gap-1">
          <button data-dec class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-l-md">${iconSvg('chevron-left', 14)}</button>
          <span class="flex-1 text-center text-white text-sm font-medium bg-gray-800 h-6 flex items-center justify-center border-y border-gray-600" data-val>${val}</span>
          <button data-inc class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-r-md">${iconSvg('chevron-right', 14)}</button>
        </div>`;
      const setVal = (v) => { state.upgrades[upKey] = Math.max(0, v); saveStore(); renderGemsPage(root); };
      wrap.querySelector('[data-dec]').onclick = () => setVal(val - 1);
      wrap.querySelector('[data-inc]').onclick = () => setVal(val + 1);
      upgradesWrap.appendChild(wrap);
    });

    if (!hideNonSimRelevant) {
      // nonSimUnlocks mirrors upgradeKeys' own unlock-threshold gating (e.g. Exodus's 5 extra
      // bonus fields only appear once Exodus's own level is maxed) -- previously ungated,
      // showing every nonSimKey unconditionally regardless of whether the account could
      // actually see it yet.
      (tree.nonSimKeys || []).filter((upKey) => state.level >= ((tree.nonSimUnlocks && tree.nonSimUnlocks[upKey]) || 0)).forEach((upKey) => {
        const label = (tree.nonSimLabels && tree.nonSimLabels[upKey]) || upKey;
        const cap = (tree.nonSimCaps && tree.nonSimCaps[upKey]) ?? null;
        const val = state.upgrades[upKey] || 0;
        const wrap = document.createElement('div');
        wrap.className = 'bg-gray-800/60 rounded-sm p-2 pt-1.5 hover:bg-gray-700/60 transition-colors border-l-3';
        wrap.style.borderLeftColor = (tree.nonSimFieldColors && tree.nonSimFieldColors[upKey]) || '#6b7280';
        wrap.innerHTML = `<div class="flex items-center justify-between mb-1"><span class="text-xs font-medium text-white truncate">${label}</span>${cap !== null ? `<span class="text-[10px] text-gray-500">${cap}</span>` : ''}</div>
          <div class="flex items-center gap-1">
            <button data-dec class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-l-md">${iconSvg('chevron-left', 14)}</button>
            <span class="flex-1 text-center text-white text-sm font-medium bg-gray-800 h-6 flex items-center justify-center border-y border-gray-600" data-val>${val}</span>
            <button data-inc class="w-6 h-6 flex items-center justify-center bg-gray-700 hover:bg-gray-600 text-white rounded-r-md">${iconSvg('chevron-right', 14)}</button>
          </div>`;
        const setVal = (v) => { state.upgrades[upKey] = Math.max(0, cap !== null ? Math.min(cap, v) : v); saveStore(); renderGemsPage(root); };
        wrap.querySelector('[data-dec]').onclick = () => setVal(val - 1);
        wrap.querySelector('[data-inc]').onclick = () => setVal(val + 1);
        upgradesWrap.appendChild(wrap);
      });
    }
    grid.appendChild(card);
  });
}

// ==================== BUILD CREATOR MODAL ====================

function openBuildModal(build) {
  editingBuild = JSON.parse(JSON.stringify(build));
  if (!editingBuild.categoryId) editingBuild.categoryId = 'active';
  const nameEl = document.getElementById('modalHunterName');
  nameEl.textContent = currentHunter[0].toUpperCase() + currentHunter.slice(1);
  nameEl.className = `text-${HUNTER_ACCENTS[currentHunter]}-400`;
  document.getElementById('buildNameInput').value = editingBuild.name;
  document.getElementById('levelInput').value = editingBuild.level;
  renderBudgetHeader();
  renderTalents();
  renderAttributes();

  // "Load Scanned Values" prefills level + talents from the most recently imported save file
  // for this hunter (independent of any "<Hunter> Build (Scanned)" card) -- lets you pull
  // real values into ANY build you're editing, not just the auto-managed scanned one.
  const scan = window.__lastScan?.[currentHunter];
  const loadScannedBtn = document.getElementById('loadScannedBtn');
  loadScannedBtn.classList.toggle('hidden', !scan);
  loadScannedBtn.onclick = () => {
    if (!scan) return;
    if (scan.level !== undefined) editingBuild.level = scan.level;
    Object.entries(scan.talents || {}).forEach(([id, level]) => { editingBuild.talents[id] = level; });
    Object.entries(scan.attributes || {}).forEach(([id, level]) => { editingBuild.attributes[id] = level; });
    document.getElementById('levelInput').value = editingBuild.level;
    onBuildChanged();
  };

  document.getElementById('modalOverridesBtn').onclick = () => {
    openOverridesModal(editingBuild, (overrides) => { editingBuild.overrides = overrides; });
  };

  document.getElementById('buildModal').classList.remove('hidden');
}
function closeBuildModal() { document.getElementById('buildModal').classList.add('hidden'); editingBuild = null; }

function renderBudgetHeader() {
  const { talentBudget, attributeBudget } = budgetsForLevel(editingBuild.level);
  const talentSpent = defs().talents.reduce((s, t) => s + (editingBuild.talents[t.id] || 0), 0);
  const attrSpent = defs().attributes.reduce((s, a) => s + (editingBuild.attributes[a.id] || 0) * (a.cost || 1), 0);
  document.getElementById('levelInput').value = editingBuild.level;
  document.getElementById('talentBudgetDisplay').textContent = `${talentSpent}/${talentBudget}`;
  document.getElementById('attrBudgetDisplay').textContent = `${attrSpent}/${attributeBudget}`;
}

// Verbatim port of the live Build Creator's per-item card, captured via outerHTML from
// cifi-tools.com (see conversation history): a single chevron-left / progress-bar /
// chevron-right row (NOT a min/dec/inc/max quad -- the live site has no "jump to max/min"
// buttons), duplicated as a "hidden md:block" desktop layout and a "md:hidden" mobile
// layout, matching the real DOM's two parallel copies exactly (classes copied 1:1).
function renderStepperCard({ label, subLabel, level, maxLevel, accentColor, canInc, canDec, onInc, onDec }) {
  const maxed = maxLevel !== Infinity && level >= maxLevel;
  const pct = maxLevel === Infinity ? 0 : (level / maxLevel) * 100;
  const disabledAttrs = (enabled) => enabled ? '' : 'disabled style="opacity:.2;cursor:not-allowed"';
  const div = document.createElement('div');
  div.className = 'bg-gray-700 rounded-lg p-2 border border-gray-600 hover:border-gray-500 transition-colors';
  div.innerHTML = `
    <div class="hidden md:block">
      <div class="flex justify-between items-center mb-2">
        <div class="flex flex-col">
          <span class="text-xs sm:text-sm font-medium text-white">${label}</span>
          ${subLabel ? `<span class="text-xs text-gray-400">${subLabel}</span>` : ''}
        </div>
        <div class="flex items-center"><span class="text-base font-bold text-${accentColor}-400">${level}</span><span class="text-xs text-gray-500 ml-1"> /${maxLevel === Infinity ? '∞' : maxLevel}</span></div>
      </div>
      <div class="flex items-center justify-between mt-2">
        <button data-dec class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors ml-1 ${canDec ? '' : 'opacity-20 cursor-not-allowed hover:bg-gray-900'} p-2" ${disabledAttrs(canDec)} style="min-width:2.5rem;">${iconSvg('chevron-left', 18)}</button>
        <div class="w-full rounded-full overflow-hidden relative h-2 border border-${accentColor}-500/20 ${maxed ? 'progress-bar--maxed' : ''} flex-1 mx-1.5 h-5">
          <div class="absolute inset-0 bg-gray-800/90 rounded-full"></div>
          <div class="h-full relative rounded-full transition-all duration-300 overflow-hidden bg-gradient-to-r from-${accentColor}-700 via-${accentColor}-500 to-${accentColor}-400 ${maxed ? 'progress-fill--maxed' : ''}" style="width:${pct}%"></div>
        </div>
        <button data-inc class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors mr-1 ${canInc ? '' : 'opacity-20 cursor-not-allowed hover:bg-gray-900'} p-2" ${disabledAttrs(canInc)} style="min-width:2.5rem;">${iconSvg('chevron-right', 18)}</button>
      </div>
    </div>
    <div class="md:hidden">
      <div class="flex flex-col mb-1">
        <span class="text-xs font-medium text-white">${label}</span>
        ${subLabel ? `<span class="text-xs text-gray-400">${subLabel}</span>` : ''}
      </div>
      <div class="flex items-center justify-between mt-2">
        <button data-dec-m class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors ml-1 ${canDec ? '' : 'opacity-20 cursor-not-allowed hover:bg-gray-900'} p-1.5" ${disabledAttrs(canDec)} style="min-width:2rem;">${iconSvg('chevron-left', 16)}</button>
        <div class="flex items-center justify-center"><span class="text-base font-bold text-${accentColor}-400 pr-1">${level}</span><span class="text-xs text-gray-500"> /${maxLevel === Infinity ? '∞' : maxLevel}</span></div>
        <button data-inc-m class="flex justify-center items-center bg-gray-800 hover:bg-gray-700 rounded transition-colors mr-1 ${canInc ? '' : 'opacity-20 cursor-not-allowed hover:bg-gray-900'} p-1.5" ${disabledAttrs(canInc)} style="min-width:2rem;">${iconSvg('chevron-right', 16)}</button>
      </div>
    </div>`;
  if (canInc) { div.querySelector('[data-inc]').onclick = onInc; div.querySelector('[data-inc-m]').onclick = onInc; }
  if (canDec) { div.querySelector('[data-dec]').onclick = onDec; div.querySelector('[data-dec-m]').onclick = onDec; }
  return div;
}

// "Call Me Lucky Loot"'s cap is NOT static -- confirmed straight from the live bundle's own
// talent table (`getMaxValue`): it's 10 normally but 12 once the Attraction gem tree's 2nd
// node is unlocked (or the equivalent gem-node override is set on the build). Every other
// talent's cap is static.
function talentMaxLevel(t, build) {
  if (t.id === 'll') {
    const nodeActive = store.gems?.attraction?.nodes?.[1];
    const overrideActive = build?.overrides?.['upgrades.gems_nodes.attraction_gem2'];
    if (nodeActive || overrideActive) return 12;
  }
  return t.maxLevel;
}

// Verbatim port of the live site's advanced-talent visibility rule: a manual per-hunter
// "Show Advanced" toggle (store.settings.advancedTalents[hunter], set from the Settings
// page), which auto-flips true the moment ANY build for that hunter already has points in
// an advanced talent (confirmed directly in the live bundle's own store-init logic) -- so a
// build imported/scanned with real Ultima points immediately reveals the talent instead of
// silently hiding data the account actually has.
function shouldShowAdvancedTalents(hunter) {
  store.settings = store.settings || {};
  store.settings.advancedTalents = store.settings.advancedTalents || {};
  if (store.settings.advancedTalents[hunter]) return true;
  const d = window.HUNTER_DEFS[hunter];
  const advancedIds = d.talents.filter((t) => t.advanced).map((t) => t.id);
  const hasPoints = store[hunter].builds.some((b) => advancedIds.some((id) => (b.talents?.[id] || 0) > 0));
  if (hasPoints) { store.settings.advancedTalents[hunter] = true; saveStore(); }
  return hasPoints;
}

function renderTalents() {
  const grid = document.getElementById('talentsGrid');
  grid.innerHTML = '';
  const { talentBudget } = budgetsForLevel(editingBuild.level);
  const showAdvanced = shouldShowAdvancedTalents(currentHunter);
  defs().talents.filter((t) => !t.advanced || showAdvanced || (editingBuild.talents[t.id] || 0) > 0).forEach((t) => {
    const level = editingBuild.talents[t.id] || 0;
    const spent = defs().talents.reduce((s, tt) => s + (editingBuild.talents[tt.id] || 0), 0);
    const maxLevel = talentMaxLevel(t, editingBuild);
    const canInc = level < maxLevel && spent < talentBudget;
    const canDec = level > 0;
    const card = renderStepperCard({
      label: t.label, level, maxLevel, accentColor: HUNTER_ACCENTS[currentHunter], canInc, canDec,
      onInc: () => { editingBuild.talents[t.id] = level + 1; onBuildChanged(); },
      onDec: () => { editingBuild.talents[t.id] = level - 1; onBuildChanged(); },
    });
    grid.appendChild(card);
  });
}

function renderAttributes() {
  const grid = document.getElementById('attributesGrid');
  grid.innerHTML = '';
  const d = defs();
  const deps = d.attributeDependencies; const minVal = d.attributeMinValue;
  d.attributes.forEach((a) => {
    const level = editingBuild.attributes[a.id] || 0;
    const canInc = Optimizer.isEligible(a, d.attributes, deps, minVal, editingBuild.attributes)
      && costOfAttrs(d, editingBuild.attributes) + (a.cost || 1) <= budgetsForLevel(editingBuild.level).attributeBudget;
    const canDec = level > 0;
    const card = renderStepperCard({
      label: a.label, subLabel: `(Cost: ${a.cost || 1} point${(a.cost || 1) > 1 ? 's' : ''})`,
      level, maxLevel: a.maxLevel, accentColor: HUNTER_ACCENTS[currentHunter], canInc, canDec,
      onInc: () => { editingBuild.attributes[a.id] = level + 1; onBuildChanged(); },
      onDec: () => {
        editingBuild.attributes[a.id] = level - 1;
        Optimizer.clearInvalidDescendants(d.attributes, deps, minVal, editingBuild.attributes);
        onBuildChanged();
      },
    });
    grid.appendChild(card);
  });
}
function costOfAttrs(d, alloc) { return d.attributes.reduce((s, a) => s + (alloc[a.id] || 0) * (a.cost || 1), 0); }
function onBuildChanged() { renderBudgetHeader(); renderTalents(); renderAttributes(); }

document.getElementById('levelInput').addEventListener('input', (e) => {
  editingBuild.level = Math.max(1, Math.floor(Number(e.target.value) || 1));
  onBuildChanged();
});
document.getElementById('levelDecBtn').innerHTML = iconSvg('chevron-left', 14);
document.getElementById('levelIncBtn').innerHTML = iconSvg('chevron-right', 14);
document.getElementById('levelDecBtn').onclick = () => {
  editingBuild.level = Math.max(1, editingBuild.level - 1);
  document.getElementById('levelInput').value = editingBuild.level;
  onBuildChanged();
};
document.getElementById('levelIncBtn').onclick = () => {
  editingBuild.level = editingBuild.level + 1;
  document.getElementById('levelInput').value = editingBuild.level;
  onBuildChanged();
};

document.getElementById('updateBuildBtn').onclick = () => {
  editingBuild.name = document.getElementById('buildNameInput').value.trim() || 'Unnamed';
  if (!editingBuild.id) editingBuild.id = genBuildId();
  const builds = store[currentHunter].builds;
  const idx = builds.findIndex((b) => b.id === editingBuild.id);
  if (idx >= 0) builds[idx] = editingBuild; else builds.push(editingBuild);
  saveStore();
  closeBuildModal();
  renderCategoryTabs();
  renderBuildList();
};
document.getElementById('closeModalBtn').onclick = closeBuildModal;

// ==================== IMPORT / EXPORT ====================
// Build-sharing codes (see buildCode.js) -- byte-compatible with the real cifi-tools.com
// format, so a code generated here imports on the live site and vice versa.

// Verbatim port of the live "Share Build" modal (captured via outerHTML from
// cifi-tools.com) -- window.prompt() is unreliable/silently blocked inside sandboxed
// preview iframes, which is why the share button previously appeared to do nothing. The
// real site never uses prompt() at all: it's a proper modal with a Raw Code / Discord
// format toggle (Discord wraps the code in a ```-fenced block preceded by a
// "**Hunter** • Level N • 🔥 X Loot Score" line) and a separate shareable-link row.
const HUNTER_DISCORD_EMOJI = { borge: ':CIFI_EXPHuntBorge:', ozzy: ':CIFI_EXPHuntOzzy:', knox: ':CIFI_EXPHuntKnox:' };

async function exportBuildCode(build) {
  try {
    const code = await window.generateBuildCode(currentHunter, build, store[currentHunter].hunterStats, store.globalUpgrades, store.gems);
    const iterations = Number(document.getElementById('baseIterations')?.value) || 1000;
    let lootScore = 0;
    try {
      const r = await HunterSim.evaluate(currentHunter, {
        level: build.level, iterations, hunterStats: store[currentHunter].hunterStats,
        talents: build.talents, attributes: build.attributes, overrides: build.overrides || {},
        upgrades: window.buildNestedUpgrades(store.globalUpgrades),
        gemPlannerStore: { gemStates: store.gems },
      });
      lootScore = r.lootPerMin;
    } catch { /* share still works without a loot score line */ }
    openShareModal(build, code, lootScore);
  } catch (e) {
    alert('Failed to generate build code: ' + e.message);
  }
}

function openShareModal(build, code, lootScore) {
  const existing = document.getElementById('shareBuildModal');
  if (existing) existing.remove();
  const hunterName = currentHunter[0].toUpperCase() + currentHunter.slice(1);
  const discordText = `**${hunterName}**  •  ${HUNTER_DISCORD_EMOJI[currentHunter] || ''} Level ${build.level}  •  🔥 ${fmt(lootScore)} Loot Score\n\`\`\`\n${code}\n\`\`\``;
  const link = `${location.origin}${location.pathname.replace(/\/$/, '')}/${currentHunter}?code=${encodeURIComponent(code)}`;
  const overlay = document.createElement('div');
  overlay.id = 'shareBuildModal';
  overlay.className = 'fixed inset-0 z-50 overflow-y-auto bg-gray-900/80 flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-gray-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in border border-gray-700">
      <div class="bg-gradient-to-r from-gray-700 to-gray-800 p-4 border-b border-gray-600 flex justify-between items-center">
        <h2 class="text-xl font-bold text-white flex items-center">${iconSvg('share', 20, 'mr-2 text-blue-400')} Share Build </h2>
        <button data-close class="p-1.5 rounded-full hover:bg-gray-700 transition-colors text-gray-300 hover:text-white">${iconSvg('x', 18)}</button>
      </div>
      <div class="p-5">
        <p class="text-sm text-gray-300 mb-4"> Choose your sharing format: </p>
        <div class="mb-4"><textarea data-preview readonly class="w-full bg-gray-700 border border-gray-600 rounded-md p-3 text-white text-sm h-40 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none font-mono"></textarea></div>
        <div class="grid grid-cols-2 gap-3 mb-4">
          <button data-fmt="raw" class="p-2 rounded-md transition-colors flex flex-col justify-center items-center gap-1 text-white">
            <div class="flex items-center gap-1">${iconSvg('copy', 16)}<span class="text-xs font-medium">Raw Code</span></div>
            <span class="text-[10px] text-gray-300">Direct import</span>
          </button>
          <button data-fmt="discord" class="p-2 rounded-md transition-colors flex flex-col justify-center items-center gap-1 text-white">
            <div class="flex items-center gap-1">${iconSvg('share', 16)}<span class="text-xs font-medium">Discord</span></div>
            <span class="text-[10px] text-gray-300">Share formatted</span>
          </button>
        </div>
        <div class="p-3 bg-blue-900/20 border border-blue-500/30 rounded-md mb-4">
          <p class="text-xs text-blue-300 mb-1"><strong data-fmt-label></strong></p>
          <p class="text-xs text-gray-400" data-fmt-desc></p>
        </div>
        <div class="border-t border-gray-600 pt-4">
          <p class="text-sm text-gray-300 mb-3"> Or share this link: </p>
          <div class="flex">
            <input readonly class="flex-grow bg-gray-700 border border-gray-600 rounded-l-md p-2 text-white text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none" value="${escapeHtml(link)}">
            <button data-copy-link class="bg-blue-600 hover:bg-blue-700 px-3 rounded-r-md transition-colors text-white">${iconSvg('copy', 18)}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const preview = overlay.querySelector('[data-preview]');
  const rawBtn = overlay.querySelector('[data-fmt="raw"]');
  const discordBtn = overlay.querySelector('[data-fmt="discord"]');
  const setFmt = (fmt) => {
    const active = 'bg-blue-600 hover:bg-blue-700 ring-2 ring-blue-400';
    const inactive = 'bg-gray-600 hover:bg-gray-700';
    rawBtn.className = `p-2 rounded-md transition-colors flex flex-col justify-center items-center gap-1 text-white ${fmt === 'raw' ? active : inactive}`;
    discordBtn.className = `p-2 rounded-md transition-colors flex flex-col justify-center items-center gap-1 text-white ${fmt === 'discord' ? active : inactive}`;
    preview.value = fmt === 'discord' ? discordText : code;
    overlay.querySelector('[data-fmt-label]').textContent = fmt === 'discord' ? 'Discord Format:' : 'Raw Format:';
    overlay.querySelector('[data-fmt-desc]').textContent = fmt === 'discord'
      ? 'Includes build info and Discord code block formatting for easy sharing.'
      : 'Pure build code for direct import into the application.';
  };
  rawBtn.onclick = () => setFmt('raw');
  discordBtn.onclick = () => setFmt('discord');
  setFmt('raw');
  overlay.querySelector('[data-copy-link]').onclick = () => navigator.clipboard?.writeText(link).catch(() => {});
  overlay.querySelector('[data-close]').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
document.getElementById('exportBuildBtn').onclick = () => exportBuildCode(editingBuild);

document.getElementById('cancelImportBtn').onclick = () => resetImportModal();
function resetImportModal() {
  document.getElementById('importModal').classList.add('hidden');
  document.getElementById('importCodeInput').value = '';
  document.getElementById('importPreview').classList.add('hidden');
  window.__pendingImportPayload = null;
}

// Matches the live site's actual import flow (confirmed live: paste a code, it shows a
// "<Hunter> Build" preview, then two buttons -- "Import Build Only" (talents/attributes
// only) and "Import with Upgrades" (everything else too, except pure-loot upgrades since
// the live UI's own tooltip says those "don't affect loot score") -- rather than a single
// blind "Import" button with no choice.
document.getElementById('importCodeInput').addEventListener('input', async (e) => {
  const code = e.target.value.trim();
  const preview = document.getElementById('importPreview');
  if (!code) { preview.classList.add('hidden'); window.__pendingImportPayload = null; return; }
  try {
    const payload = await window.parseBuildCode(code);
    if (!payload) throw new Error('unrecognized');
    window.__pendingImportPayload = payload;
    document.getElementById('importPreviewName').textContent = `${payload.hunter[0].toUpperCase()}${payload.hunter.slice(1)} Build`;
    preview.classList.remove('hidden');
  } catch (err) {
    window.__pendingImportPayload = null;
    preview.classList.add('hidden');
  }
});

function applyImportedBuild(payload, includeUpgrades) {
  if (payload.hunter && payload.hunter !== currentHunter) switchHunter(payload.hunter);
  const build = newDraftBuild();
  // Must assign a real id before pushing directly into the store -- leaving it null and
  // relying on the "Save Build" handler to assign one later only works for drafts opened
  // via the modal (which aren't in the array yet). A null-id build already in the array
  // gets a DIFFERENT id assigned the first time it's edited and saved, so the update
  // handler's id-match lookup fails to find the original and pushes a second copy instead
  // of overwriting it -- this was the "editing creates a duplicate" bug.
  build.id = genBuildId();
  build.name = payload.name || 'Imported';
  build.level = payload.level || 1;
  Object.assign(build.talents, payload.talents || {});
  Object.assign(build.attributes, payload.attributes || {});
  if (includeUpgrades) {
    Object.assign(build.overrides, payload.overrides || {});
    Object.entries(payload.upgradeOverrides || {}).forEach(([key, val]) => {
      if (!window.isPureLootOverrideKey(key)) build.overrides[key] = val;
    });
  }
  store[currentHunter].builds.push(build);
  saveStore();
  resetImportModal();
  renderCategoryTabs(); renderBuildList();
}
document.getElementById('importBuildOnlyBtn').onclick = () => {
  if (window.__pendingImportPayload) applyImportedBuild(window.__pendingImportPayload, false);
};
document.getElementById('importWithUpgradesBtn').onclick = () => {
  if (window.__pendingImportPayload) applyImportedBuild(window.__pendingImportPayload, true);
};

// ==================== IMPORT SAVE FILE ====================
// Decodes the actual CIFI DATA.text/CifiBackup.text save (see saveImport.js for the fully
// reverse-engineered AES scheme) and maps confirmed fields onto the store. Two input paths:
// the local CIFI Bridge (ADB, auto-detected) or a directly dropped/selected file -- both feed
// the same decode+map+apply pipeline, so there's no server involved either way.

function openImportSaveModal() {
  document.getElementById('importSaveModal').classList.remove('hidden');
  document.getElementById('importSaveResult').innerHTML = '';
  const statusText = document.getElementById('importSaveBridgeText');
  const pullBtn = document.getElementById('importSaveBridgePullBtn');
  pullBtn.classList.add('hidden');
  statusText.textContent = 'Checking for local CIFI Bridge…';
  window.tryConnectCifiBridge().then((ws) => {
    if (ws) {
      statusText.textContent = 'CIFI Bridge detected — pull the save directly from your device.';
      window.checkCifiBridgeAdbStatus(ws).then((status) => {
        const desc = describeAdbDeviceStatus(status);
        if (desc) statusText.textContent = `CIFI Bridge detected (${desc}) — pull the save directly from your device.`;
      });
      pullBtn.classList.remove('hidden');
      pullBtn.onclick = async () => {
        pullBtn.disabled = true;
        statusText.textContent = 'Pulling save from device…';
        try {
          const rawText = await window.pullCifiSaveViaBridge(ws);
          await processImportedSaveText(rawText);
        } catch (e) {
          renderImportSaveResult(`Bridge pull failed: ${e.message}`, true);
        } finally {
          pullBtn.disabled = false;
          statusText.textContent = 'CIFI Bridge detected — pull the save directly from your device.';
        }
      };
    } else {
      statusText.textContent = 'No local CIFI Bridge detected — drop a save file below instead.';
    }
  });
}
document.getElementById('closeImportSaveBtn').onclick = () => document.getElementById('importSaveModal').classList.add('hidden');

function renderImportSaveResult(message, isError) {
  const el = document.getElementById('importSaveResult');
  el.innerHTML = `<div class="${isError ? 'text-red-400' : 'text-green-400'}">${message}</div>`;
}

async function processImportedSaveText(rawText) {
  renderImportSaveResult('Decoding save…');
  let save;
  try {
    save = await window.decodeCifiSaveText(rawText);
  } catch (e) {
    renderImportSaveResult(`Could not decode this file (${e.message}). Make sure it's an unmodified DATA.text or CifiBackup.text.`, true);
    return;
  }
  const mapped = window.mapCifiSaveToStore(save);

  Object.assign(store.globalUpgrades, mapped.globalUpgrades);
  Object.entries(mapped.gems).forEach(([treeKey, treeState]) => {
    if (!store.gems[treeKey]) return;
    store.gems[treeKey].level = treeState.level;
    treeState.nodes.forEach((on, i) => { store.gems[treeKey].nodes[i] = on; });
  });
  // Maintains one dedicated "<Hunter> Build (Scanned)" card per hunter that always reflects
  // the most recently scanned save -- rather than silently overwriting whatever build
  // happened to be first in the list. Only touches it (creating or updating) when the
  // scanned level/talents actually differ from what's already there, so re-importing the
  // same save repeatedly doesn't keep bumping it or spamming re-renders. Also caches the
  // raw scanned level/talents per hunter (window.__lastScan, persisted) so the build editor
  // can offer "load scanned values" independently of this auto-managed card.
  window.__lastScan = window.__lastScan || {};
  Object.entries(mapped.perHunter).forEach(([hunterKey, info]) => {
    if (!store[hunterKey]) return;
    window.__lastScan[hunterKey] = { level: info.level, talents: { ...(info.talents || {}) }, attributes: { ...(info.attributes || {}) } };
    const scanName = `${hunterKey[0].toUpperCase()}${hunterKey.slice(1)} Build (Scanned)`;
    const builds = store[hunterKey].builds;
    const existing = builds.find((b) => b.name === scanName);
    const sameKeys = (a, b) => Object.keys({ ...a, ...b }).every((k) => (a[k] || 0) === (b[k] || 0));
    const unchanged = existing && sameKeys(existing.talents, info.talents || {}) && sameKeys(existing.attributes, info.attributes || {})
      && existing.level === (info.level ?? existing.level);
    if (unchanged) return;
    if (existing) {
      if (info.level !== undefined) existing.level = info.level;
      Object.entries(info.talents || {}).forEach(([talentId, level]) => { existing.talents[talentId] = level; });
      Object.entries(info.attributes || {}).forEach(([attrId, level]) => { existing.attributes[attrId] = level; });
    } else {
      const build = newDraftBuild();
      build.id = genBuildId();
      build.name = scanName;
      if (info.level !== undefined) build.level = info.level;
      Object.entries(info.talents || {}).forEach(([talentId, level]) => { build.talents[talentId] = level; });
      Object.entries(info.attributes || {}).forEach(([attrId, level]) => { build.attributes[attrId] = level; });
      builds.push(build);
    }
  });
  localStorage.setItem('huntersim_last_scan', JSON.stringify(window.__lastScan));
  saveStore();
  renderGemsPage(document.getElementById('pageRoot'));
  if (currentRoute() === 'sim') { renderCategoryTabs(); renderBuildList(); }

  const skipped = mapped.unmapped.length
    ? `<div class="text-gray-400 text-xs mt-1">Not yet mapped (left unchanged): ${mapped.unmapped.join(', ')}</div>`
    : '';
  renderImportSaveResult(`Imported relics, inscryptions, diamond cards, gems, hunter level, talents, and attributes.${skipped}`);
}

const importSaveDropZone = document.getElementById('importSaveDropZone');
const importSaveFileInput = document.getElementById('importSaveFileInput');
importSaveDropZone.onclick = () => importSaveFileInput.click();
importSaveDropZone.ondragover = (e) => { e.preventDefault(); importSaveDropZone.classList.add('border-blue-500'); };
importSaveDropZone.ondragleave = () => importSaveDropZone.classList.remove('border-blue-500');
importSaveDropZone.ondrop = (e) => {
  e.preventDefault();
  importSaveDropZone.classList.remove('border-blue-500');
  const file = e.dataTransfer.files?.[0];
  if (file) readImportSaveFile(file);
};
importSaveFileInput.onchange = () => {
  const file = importSaveFileInput.files?.[0];
  if (file) readImportSaveFile(file);
};
function readImportSaveFile(file) {
  const reader = new FileReader();
  reader.onload = () => processImportedSaveText(String(reader.result));
  reader.onerror = () => renderImportSaveResult('Could not read that file.', true);
  reader.readAsText(file);
}

// ==================== OPTIMIZE FLOW ====================

document.getElementById('optimizeBtn').onclick = () => document.getElementById('optimizeSetupModal').classList.remove('hidden');
document.getElementById('cancelOptimizeSetup').onclick = () => document.getElementById('optimizeSetupModal').classList.add('hidden');

let cancelRequested = false;

document.getElementById('startOptimizeBtn').onclick = async () => {
  const mode = document.getElementById('optimizeMode').value;
  const targetEvals = Math.max(100, Number(document.getElementById('targetEvals').value) || 3000);
  document.getElementById('optimizeSetupModal').classList.add('hidden');
  document.getElementById('optimizeProgressModal').classList.remove('hidden');
  cancelRequested = false;

  const cfg = cfgFor(currentHunter, editingBuild);
  const historyKey = `${currentHunter}_${mode}_${editingBuild.level}`;
  const seedCandidates = loadHistory(historyKey);

  // Everything below used to run outside any try/catch: if beamSearchBrowser threw (e.g. a
  // worker failing to initialize) the progress modal was left open forever with no way to
  // close it and no feedback -- indistinguishable from "stuck at optimizing, cancel does
  // nothing", because Cancel only ever set a flag this code never got back around to reading.
  try {
    const result = await beamSearchBrowser(cfg, {
      mode, targetEvals, beamWidth: 8, neighborsPerMember: 3, searchIterations: 100, seedCandidates,
      shouldCancel: () => cancelRequested,
      onProgress: ({
        evalsDone, targetEvals: target, generation, bestScore, elapsedMs, phase,
        greedyStep, greedyStepsEstimate, polishRound, polishRoundsEstimate,
      }) => {
        // The greedy-seeding phase (see beamSearchBrowser.js) runs before any beam generations
        // and used to report nothing at all here -- on a large real-account budget it could look
        // completely frozen (0/target evaluations, "Generation 0") for a long stretch even
        // though it was actively working and Cancel was fully functional. Show its own step
        // count instead of leaving the bar/eval-count static during that phase.
        if (phase === 'greedy-seeding') {
          const pct = greedyStepsEstimate ? Math.min(100, (greedyStep / greedyStepsEstimate) * 100) : 0;
          document.getElementById('progressBar').style.width = `${pct}%`;
          document.getElementById('progressEvals').textContent = `Finding a strong starting point (${greedyStep} / ~${greedyStepsEstimate} steps)…`;
          document.getElementById('progressElapsed').textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
          document.getElementById('progressGen').textContent = '-';
          document.getElementById('progressBest').textContent = '-';
          return;
        }
        // Final exhaustive polish (see hillClimbPolish): runs after the beam search's normal
        // eval budget is spent, so it needs its own indicator instead of showing a stalled
        // "evalsDone / target" bar sitting at 100% while this still keeps working.
        if (phase === 'polish') {
          document.getElementById('progressBar').style.width = '100%';
          document.getElementById('progressEvals').textContent = polishRoundsEstimate
            ? `Verifying no single point-move improves this build (round ${polishRound} / up to ${polishRoundsEstimate})…`
            : 'Verifying no single point-move improves this build…';
          document.getElementById('progressElapsed').textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
          document.getElementById('progressGen').textContent = generation;
          document.getElementById('progressBest').textContent = fmt(bestScore);
          return;
        }
        document.getElementById('progressBar').style.width = `${Math.min(100, (evalsDone / target) * 100)}%`;
        document.getElementById('progressEvals').textContent = `${evalsDone} / ${target} evaluations`;
        document.getElementById('progressElapsed').textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
        document.getElementById('progressGen').textContent = generation;
        document.getElementById('progressBest').textContent = fmt(bestScore);
      },
    });

    saveHistory(historyKey, result.allSeen);

    if (result.beam.length) {
      const shortlist = result.beam.slice(0, 5);
      const currentIdx = shortlist.length;
      shortlist.push({ talentAlloc: editingBuild.talents, attrAlloc: editingBuild.attributes });
      // A single 1000-iteration evaluate() carries real Monte Carlo noise (fresh wasm RNG
      // state every call, see hunterSimBrowser.js) -- with only one sample per candidate, it
      // was possible for that noise alone to make a candidate that's actually no better than
      // (or even worse than) the build you started with LOOK like the winner, replacing your
      // build with a "downgrade" that only exists because of evaluation variance. Averaging 3
      // independent evaluate() calls per candidate shrinks that noise by ~sqrt(3) so the
      // comparison reflects the real difference between allocations, not RNG luck.
      const SAMPLES = 3;
      const scores = [];
      for (const c of shortlist) {
        let sum = 0;
        for (let i = 0; i < SAMPLES; i++) {
          const r = await HunterSim.evaluate(currentHunter, {
            level: editingBuild.level, iterations: 1000, hunterStats: store[currentHunter].hunterStats,
            talents: c.talentAlloc, attributes: c.attrAlloc, overrides: editingBuild.overrides || {},
            upgrades: window.buildNestedUpgrades(store.globalUpgrades),
            gemPlannerStore: { gemStates: store.gems },
          });
          sum += mode === 'push' ? r.avgStage : r.lootPerMin;
        }
        scores.push(sum / SAMPLES);
      }
      let bestIdx = 0;
      for (let i = 1; i < shortlist.length; i++) if (scores[i] > scores[bestIdx]) bestIdx = i;

      // The build you started with is always in the shortlist -- if nothing the search found
      // actually beats it (within noise), keep it as-is instead of silently swapping in a
      // same-or-worse allocation just because it happened to be a different candidate.
      if (bestIdx === currentIdx) {
        alert(`No improvement found (best candidate: ${fmt(scores[bestIdx])}, current: ${fmt(scores[currentIdx])}). Keeping your existing build unchanged.`);
      } else {
        editingBuild.talents = shortlist[bestIdx].talentAlloc;
        editingBuild.attributes = shortlist[bestIdx].attrAlloc;
        editingBuild.name = 'Optimized';
        document.getElementById('buildNameInput').value = editingBuild.name;
        onBuildChanged();
      }
    }
  } catch (err) {
    console.error('Optimizer failed', err);
    alert(`Optimizer failed to run: ${err.message || err}`);
  } finally {
    document.getElementById('optimizeProgressModal').classList.add('hidden');
  }
};
document.getElementById('cancelOptimizeRunBtn').onclick = () => { cancelRequested = true; };

function loadHistory(key) {
  try { return JSON.parse(localStorage.getItem(`huntersim_history_${key}`) || '[]'); } catch { return []; }
}
function saveHistory(key, candidates) {
  const top = [...candidates].sort((a, b) => b.score - a.score).slice(0, 20);
  localStorage.setItem(`huntersim_history_${key}`, JSON.stringify(top));
}

// ==================== INIT ====================

render();
