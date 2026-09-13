// Runs in cifi-tools.com's MAIN world, not the extension's isolated world.
//
// The site owns its account state in Pinia (`hunter-data`) and its gem planner state in
// `gemPlanner_store`.  Writing the companion's private localStorage key made an import look
// successful while every native cifi-tools input remained zero.  This bridge deliberately calls
// the site's own Pinia actions, then lets their persistence plugin save the canonical stores.
'use strict';

function piniaStore(id) {
  // Vue attaches its app context to #app. The Pinia injection token is a Symbol, so do not depend
  // on a private symbol description or a bundle-local variable name.
  const app = document.querySelector('#app')?.__vue_app__;
  const provides = app?._context?.provides;
  if (!provides) return null;
  const pinia = Reflect.ownKeys(provides)
    .map((key) => provides[key])
    .find((value) => value && value._s && typeof value._s.get === 'function');
  return pinia?._s.get(id) || null;
}

const HOST_STATE_ID = 'cifi-companion-host-state';
const HUNTERS = ['borge','ozzy','knox'];
const LEGACY_STORE_KEY = 'cifi-companion:store';
// Pinia exposes Vue reactive proxies, which structuredClone rejects. The bridge contract is JSON
// by design (it crosses isolated/main worlds through script text), so clone via that contract.
const jsonClone = value => JSON.parse(JSON.stringify(value));

function flattenUpgrades(upgrades) {
  const flat = {};
  for (const [category, values] of Object.entries(upgrades || {})) {
    for (const [id, value] of Object.entries(values || {})) flat[`${category}.${id}`] = value;
  }
  return flat;
}

function canonicalStoreFromNative(hunter, gems) {
  const extra = hunter.$state.cifiCompanion;
  if (!extra) return null;
  const canonical = jsonClone(extra);
  canonical.globalUpgrades = flattenUpgrades(hunter.upgrades);
  canonical.gems = jsonClone(gems.gemStates || {});
  for (const id of HUNTERS) {
    canonical[id] = {...(canonical[id] || {}),
      builds:jsonClone(hunter.hunterBuilds?.[id] || []),
      hunterStats:jsonClone(hunter.hunterStats?.[id] || {}),
      iterations:hunter.hunterIterations?.[id] ?? 1000,
    };
  }
  return canonical;
}

function applyCanonicalStore(hunter, gems, canonical) {
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new Error('Canonical companion state must be an object');
  }
  const extra = jsonClone(canonical);
  delete extra.globalUpgrades;
  delete extra.gems;
  for (const id of HUNTERS) {
    const state = canonical[id];
    if (!state) throw new Error(`Canonical companion state is missing ${id}`);
    hunter.hunterBuilds[id] = jsonClone(state.builds || []);
    hunter.hunterStats[id] = jsonClone(state.hunterStats || {});
    hunter.hunterIterations[id] = state.iterations;
    delete extra[id];
  }
  const nested = {};
  for (const [key,value] of Object.entries(canonical.globalUpgrades || {})) {
    const dot=key.indexOf('.');
    if(dot<=0) throw new Error(`Invalid canonical upgrade key: ${key}`);
    const category=key.slice(0,dot), id=key.slice(dot+1);
    (nested[category] ||= {})[id]=value;
  }
  for (const category of Object.keys(hunter.upgrades || {})) hunter.upgrades[category] = jsonClone(nested[category] || {});
  for (const [category,values] of Object.entries(nested)) if (!(category in hunter.upgrades)) hunter.upgrades[category]=jsonClone(values);
  for (const [tree,state] of Object.entries(canonical.gems || {})) gems.gemStates[tree]=jsonClone(state);
  hunter.$patch({cifiCompanion:extra});
  hunter.$persist();
  gems.saveToStorage?.();
}

function migrateLegacyStore() {
  const raw=localStorage.getItem(LEGACY_STORE_KEY);
  if (!raw) return;
  const hunter=piniaStore('hunter'), gems=piniaStore('gemPlanner');
  if (!hunter || !gems) throw new Error('Native stores unavailable during companion migration');
  applyCanonicalStore(hunter,gems,JSON.parse(raw));
  localStorage.removeItem(LEGACY_STORE_KEY);
  indexedDB.deleteDatabase('cifi-companion-backup');
}

function publishHostState() {
  const hunter = piniaStore('hunter');
  const gems = piniaStore('gemPlanner');
  if (!hunter || !gems) return false;
  const flatUpgrades = flattenUpgrades(hunter.upgrades);
  const el = document.getElementById(HOST_STATE_ID)
    || document.documentElement.appendChild(Object.assign(document.createElement('script'), {
      id: HOST_STATE_ID, type: 'application/json', hidden: true,
    }));
  el.textContent = JSON.stringify({
    hunterStats: hunter.hunterStats || {},
    hunterBuilds: hunter.hunterBuilds || {},
    hunterIterations: hunter.hunterIterations || {},
    globalUpgrades: flatUpgrades,
    gems: gems.gemStates || {},
    canonicalStore: canonicalStoreFromNative(hunter,gems),
  });
  document.dispatchEvent(new Event('cifi-companion:host-state'));
  return true;
}

// The save mapper is a PARTIAL projection (only supported GU fields). The native planner owns
// complete states: initializeGemState creates {level,nodes,upgrades:{}} and Gems reads
// state.upgrades[id] directly. Replacing that state with the projection blanked the native page.
function mergeHostGemState(tree, previous, incoming) {
  if (!incoming || !Number.isFinite(incoming.level) || !Array.isArray(incoming.nodes)) {
    throw new Error(`Invalid imported gem state: ${tree}.level/nodes`);
  }
  for (const state of [previous,incoming]) {
    if (state && Object.hasOwn(state,'upgrades') && (!state.upgrades || typeof state.upgrades !== 'object' || Array.isArray(state.upgrades))) {
      throw new Error(`Invalid gem state: ${tree}.upgrades`);
    }
  }
  // Omitted GU fields mean "not mapped", not zero: preserve native values we did not import.
  return {...previous,...incoming,upgrades:{...previous?.upgrades,...incoming.upgrades}};
}

function repairImportedGemStates() {
  const raw = localStorage.getItem('gemPlanner_store');
  if (!raw) return 0;
  const saved = JSON.parse(raw);
  if (!saved.gemStates) return 0;
  const planner = piniaStore('gemPlanner');
  const missing = Object.entries(saved.gemStates).filter(([,state])=>state && !Object.hasOwn(state,'upgrades'));
  if (!missing.length) return 0;
  // Keep the exact pre-migration payload. Only add the required empty map; never reset levels,
  // nodes, existing upgrade values, plans or any other native account data.
  const backup = 'cifi-companion:gem-store-before-upgrades-repair';
  if (localStorage.getItem(backup) === null) localStorage.setItem(backup,raw);
  for (const [tree,state] of missing) {
    saved.gemStates[tree] = mergeHostGemState(tree,planner?.gemStates?.[tree],state);
    if (planner?.gemStates?.[tree] && !Object.hasOwn(planner.gemStates[tree],'upgrades')) {
      planner.gemStates[tree].upgrades = saved.gemStates[tree].upgrades;
    }
  }
  localStorage.setItem('gemPlanner_store',JSON.stringify(saved));
  return missing.length;
}

function writeGemStates(gems) {
  if (!Object.keys(gems).length) return false;
  const raw = localStorage.getItem('gemPlanner_store');
  const saved = raw ? JSON.parse(raw) : {};
  const planner = piniaStore('gemPlanner');
  const next = { ...(saved.gemStates || {}) };
  for (const [tree, state] of Object.entries(gems)) {
    next[tree] = mergeHostGemState(tree,planner?.gemStates?.[tree] ?? next[tree],state);
  }
  localStorage.setItem('gemPlanner_store', JSON.stringify({ ...saved, gemStates: next }));

  // Keep an already-open Gem Planner reactive as well. Its own save function has already been
  // bypassed above only because it is bundle-private; this assignment is the equivalent state
  // transition for the live component.
  if (planner?.gemStates) {
    for (const tree of Object.keys(gems)) planner.gemStates[tree] = next[tree];
  }
  return true;
}

document.addEventListener('cifi-companion:write-native-store', () => {
  const result=document.getElementById('cifi-companion-native-store-result')
    || document.body.appendChild(Object.assign(document.createElement('div'),{id:'cifi-companion-native-store-result',hidden:true}));
  try {
    const request=document.getElementById('cifi-companion-native-store-write');
    applyCanonicalStore(piniaStore('hunter'),piniaStore('gemPlanner'),JSON.parse(request?.textContent || ''));
    result.dataset.value=JSON.stringify({ok:true});
    publishHostState();
  } catch(error) {
    result.dataset.value=JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)});
  }
  document.dispatchEvent(new Event('cifi-companion:native-store-written'));
});

// Repair prior versions' persisted partial states before the routing adapter mounts native pages.
repairImportedGemStates();
migrateLegacyStore();
document.addEventListener('cifi-companion:request-host-state', publishHostState);
publishHostState();
