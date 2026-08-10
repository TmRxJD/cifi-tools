'use strict';
// CIFI save file import: decode DATA.text/CifiBackup.text entirely client-side (no server,
// no ADB/Frida needed at runtime) and map it onto this tool's store shape.
//
// Format (fully reverse-engineered via IL2CPP metadata analysis + disassembly + live
// instrumentation of com.OctocubeGamesCompany.CIFI -- see project notes):
//   - File is ASCII text: one giant base64 blob (may contain embedded newlines) plus a few
//     short unrelated base64 tokens (small encrypted metadata, not needed here).
//   - The blob decodes to [16-byte IV][AES-128-CBC ciphertext, PKCS7-padded].
//   - The AES-128 key is a UNIVERSAL CONSTANT (not per-device/account): sum the char codes of
//     the game's hardcoded literal "1for2for3for4two" (=1529), seed .NET/Mono's classic
//     subtractive System.Random with that sum, take NextBytes(16). Verified byte-for-byte
//     against a live-captured key.
//   - Plaintext is JSON matching the game's `SaveData` C# class (flat, thousands of fields).
//   - Anti-cheat "obscured" numeric fields serialize as
//     { currentCryptoKey, hiddenValue, fakeValue, fakeValueActive, inited } -- `fakeValue` is
//     already the real number.
//   - Currency/XP totals serialize as BigDouble { mantissa, exponent }.

// ---- Deterministic AES-128 key derivation (portable, no device info needed) ----

class DotNetRandom {
  constructor(seed) {
    const MSEED = 161803398;
    const MBIG = 2147483647;
    this.MBIG = MBIG;
    this.SeedArray = new Array(56).fill(0);
    const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed);
    let mj = MSEED - subtraction;
    this.SeedArray[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.SeedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.SeedArray[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        this.SeedArray[i] -= this.SeedArray[1 + (i + 30) % 55];
        if (this.SeedArray[i] < 0) this.SeedArray[i] += MBIG;
      }
    }
    this.inext = 0;
    this.inextp = 21;
  }
  InternalSample() {
    let locINext = this.inext;
    let locINextp = this.inextp;
    if (++locINext >= 56) locINext = 1;
    if (++locINextp >= 56) locINextp = 1;
    let retVal = this.SeedArray[locINext] - this.SeedArray[locINextp];
    if (retVal === this.MBIG) retVal--;
    if (retVal < 0) retVal += this.MBIG;
    this.SeedArray[locINext] = retVal;
    this.inext = locINext;
    this.inextp = locINextp;
    return retVal;
  }
  NextBytes(n) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = this.InternalSample() % 256;
    return buf;
  }
}

const EDITOR_NAME = '1for2for3for4two';
function computeAesKeyBytes() {
  let seed = 0;
  for (const c of EDITOR_NAME) seed += c.charCodeAt(0);
  return new DotNetRandom(seed).NextBytes(16);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function decodeSaveText(rawText) {
  const mainB64 = rawText.split('\n')[0].trim();
  const blob = base64ToBytes(mainB64);
  const iv = blob.slice(0, 16);
  const ciphertext = blob.slice(16);
  const keyBytes = computeAesKeyBytes();
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
  const text = new TextDecoder('utf-8').decode(plainBuf);
  return JSON.parse(text);
}
window.decodeCifiSaveText = decodeSaveText;

// ---- Field mapping: decoded save JSON -> this tool's store shape ----
//
// Confidence notes (see project notes for full reverse-engineering detail):
//   HIGH: gems (tree level + 6 nodes), relics tier 1 (AOR{n}Level) + tier 2
//     (AORTier2Levels[] obscured array), inscryptions (IS{n}Level), diamond cards
//     (GaidenCardPurchased/IridianCardPurchased), hunter level/highest stage, talents
//     (Skill{n}Level, positional per hunter's own talent order).
//   PATTERN-CONFIRMED (field name matches the established RU{id}Level / {Name}Level
//     conventions exactly, but reads 0 on every account checked so far -- no live nonzero
//     diff yet): hunter researches (#81/#95/#105 -> RU81/95/105Level), Diamond Ultima
//     (-> DiamondUltimaLevel).
//   NOT MAPPED (left untouched on import): hunter base stats (HP/ATK/etc -- the save only
//     stores upgrade-LEVEL ints, not the final displayed stat number, and the level->stat
//     formula isn't reverse-engineered yet), attributes (no per-attribute field exists in
//     the save at all, only an aggregate spent-points counter), Crew Motivation modules
//     (CM1-26 booleans exist but their in-game meaning is unconfirmed), loop mods (per-mod
//     LM{n}Level fields exist but the id->wiki-mod offset isn't confirmed -- see shipSchema.js),
//     diamond specials, IAP, trinkets, and gem named-upgrade fields (GU-index order
///    unconfirmed) -- these need a save with nonzero values in each to pin down exactly.

function realNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'fakeValue' in v) return v.fakeValue;
  if (typeof v === 'object' && 'mantissa' in v) return v; // BigDouble -- kept as-is, not needed raw
  return v;
}

const RELIC_TIER1_IDS = { r4: 4, r7: 7, r16: 16, r17: 17, r19: 19 };
const RELIC_TIER2_INDEX = { t2r5: 4, t2r7: 6 }; // 0-based index into AORTier2Levels[]

const INSCRYPTION_IDS = [3, 4, 11, 13, 14, 23, 24, 27, 31, 32, 33, 36, 37, 40, 44, 60, 80, 81, 84, 86, 87, 88, 89, 91, 92, 103, 104, 105];
// Ship/Fleet-related inscriptions (Free Rank-Up / Free Crew per ship) -- same `IS${n}Level`
// save field convention as the hunter-relevant ids above, just never added to that list since
// they're consumed by shipsPage.js's Fleet Boost items instead of a hunter's upgrade page.
const FLEET_INSCRYPTION_IDS = [48, 49, 50, 51, 53, 54, 55, 56, 64, 65, 67, 68];

const GEM_TREE_SAVE_PREFIX = {
  exodus: 'Exodus', temporal: 'Temporal', innovation: 'Innovation', power: 'Power',
  attraction: 'Attraction', creation: 'Creation', evolution: 'Evolution',
};

// Borge and Ozzy each have a 9th "advanced" talent (ultima) that HUNTER_DEFS lists between
// the 7th talent and the final one (tfow/echo) -- it occupies its own Skill{n}Level slot in
// the save just like every other talent, so it must be included here in position even though
// it's hidden from the UI by default. Omitting it (as a prior version of this list did) shifts
// every talent read after it by one slot, which is why the last talent (tfow for Borge, echo
// for Ozzy) was silently reading the wrong field and importing as 0.
const HUNTER_TALENT_ORDER = {
  borge: ['revival', 'loth', 'ua', 'impeccable', 'omen', 'll', 'pog', 'ultima', 'tfow'],
  ozzy: ['revival', 'boon', 'ua', 'needles', 'omen', 'll', 'crip', 'ultima', 'echo'],
  knox: ['revival', 'calyp', 'ua', 'ghost', 'omen', 'll', 'pog', 'finish'],
};

// Attribute allocations ARE in the save after all -- stored as 15 positional fields per
// hunter under an internal codename (POM0..14Level for Borge, POI0..14 for Ozzy, POK0..14
// for Knox; found via the il2cpp class dump's SaveData fields). Confirmed against a live
// account by pulling a fresh save and matching POM0-14 exactly to the account's known
// attribute spread (ares=1,ylith=1,spartan=6,timeless=5,baal=6,sensors=6,htb=4,lfin=10,
// exp=6,atlas=0,weak=6,...) -- note the save's positional order puts "weak" (Weakspot
// Analysis) at index 9 and "atlas" (Atlas Protocol) at index 10, the REVERSE of the order
// they're listed in HUNTER_DEFS.borge.attributes. Ozzy/Knox use the same POI/POK field
// names and were originally best-effort matched to HUNTER_DEFS order, then live-verified
// (2026-07) against a real pulled save by checking every value against each attribute's
// maxLevel cap and its attributeDependencies prerequisite chain in hunterDefs.js. That
// confirmed TWO reversed pairs for Ozzy, both mirroring Borge's pattern: index 6/7 hold
// "vect" (Vectid Elixir) then "snek" (Soul Of Snek), and index 8/9 hold "deal" (A Deal With
// Death, maxLevel 3) then "cycle" (The Cycle Of Death, maxLevel 5) -- the unswapped order
// put a value of 4 into "deal" (impossible, exceeds its max of 3) and broke the
// cycle-requires-snek dependency chain; this order satisfies both. Knox's order still isn't
// verified against a real account (it has no talents/attributes on the account this was
// checked against).
const HUNTER_ATTR_SAVE_PREFIX = { borge: 'POM', ozzy: 'POI', knox: 'POK' };
const HUNTER_ATTR_ORDER = {
  borge: ['ares', 'ylith', 'spartan', 'timeless', 'baal', 'sensors', 'htb', 'lfin', 'exp', 'weak', 'atlas', 'battle', 'mino', 'hermes', 'athena'],
  ozzy: ['lotl', 'exo', 'scorp', 'timeless', 'ibu', 'exterm', 'vect', 'snek', 'deal', 'cycle', 'medusa', 'dance', 'sisters', 'scarab', 'cat'],
  // Knox only has 11 released attributes vs 15 save slots -- mapping the first 11
  // positionally and leaving the remaining POK11-14 slots unused/unverified.
  knox: ['kraken', 'soul', 'dead', 'spa', 'pl', 'time', 'sear', 'pct', 'kot', 'fe', 'sop'],
};
const HUNTER_SAVE_PREFIX = { borge: 'Borge', ozzy: 'Ozzy', knox: 'Knox' };

// Base stat UPGRADE LEVELS -- `<Hunter>Upgrade<Stat>Level`.
//
// A previous note here said base stats were unmappable because "the save only stores upgrade-LEVEL
// ints, not the final displayed stat number, and the level->stat formula isn't reverse-engineered".
// That reasoning was backwards: the wasm takes the LEVEL and derives the stat itself, so the level
// is exactly what the tool wants. No formula needed.
//
// The naming is the game's, not ours, and three of the mappings are non-obvious:
//   - Ozzy's Multistrike Chance/Power are stored under the CRIT names, matching how HUNTER_DEFS
//     already keys them (multichance/multipower -> CritChance/CritPower).
//   - Knox's "Reload" is the attack-speed analogue -> AtkSpeed.
//   - Knox's "Projectiles Per Salvo" -> SalvoSize.
const BASE_STAT_SAVE_FIELD = {
  borge: {
    hp: 'MaxHP', atk: 'AtkPower', regen: 'HPRegen', dr: 'DmgReduction', evade: 'EvadeChance',
    effect: 'EffectChance', critchance: 'CritChance', critpower: 'CritPower', atkspeed: 'AtkSpeed',
  },
  ozzy: {
    hp: 'MaxHP', atk: 'AtkPower', regen: 'HPRegen', dr: 'DmgReduction', evade: 'EvadeChance',
    effect: 'EffectChance', multichance: 'CritChance', multipower: 'CritPower', atkspeed: 'AtkSpeed',
  },
  knox: {
    hp: 'MaxHP', atk: 'AtkPower', regen: 'HPRegen', dr: 'DmgReduction', block: 'BlockChance',
    effect: 'EffectChance', charge: 'ChargeChance', chargeGain: 'ChargeGained',
    reload: 'AtkSpeed', proj: 'SalvoSize',
  },
};

// Returns { globalUpgrades: {...}, gems: {...}, perHunter: { borge: {level, talents, highestStage}, ... },
//           unmapped: [category names not imported] }
function mapSaveToStore(save) {
  const globalUpgrades = {};
  const unmapped = [];

  // Relics
  Object.entries(RELIC_TIER1_IDS).forEach(([key, n]) => {
    const v = save[`AOR${n}Level`];
    if (v !== undefined) globalUpgrades[`relics.${key}`] = realNum(v);
  });
  if (Array.isArray(save.AORTier2Levels)) {
    Object.entries(RELIC_TIER2_INDEX).forEach(([key, idx]) => {
      const v = save.AORTier2Levels[idx];
      if (v !== undefined) globalUpgrades[`relics.${key}`] = realNum(v);
    });
  }

  // Inscryptions -- the raw save field for "Inscryption #N" (as labeled in this app and
  // in-game) is IS{N+12}Level, NOT IS{N}Level. Confirmed directly against a real account:
  // its #58/#59/#60/#61/#62 levels (2/1/3/1/0) matched IS70/IS71/IS72/IS73/IS74Level exactly,
  // five-for-five, while IS58-62Level themselves were all 0 (why #60 always imported as 0
  // regardless of the account's real level -- every id was silently reading the wrong slot,
  // consistently 12 short). The save's IS-array is evidently a denser internal registry that
  // starts 12 entries before this app's own inscription numbering, not a 1:1 index into it.
  const INSCRYPTION_SAVE_OFFSET = 12;
  [...INSCRYPTION_IDS, ...FLEET_INSCRYPTION_IDS].forEach((n) => {
    const v = save[`IS${n + INSCRYPTION_SAVE_OFFSET}Level`];
    if (v !== undefined) globalUpgrades[`inscryptions.i${n}`] = realNum(v);
  });

  // Diamond cards (boolean)
  if (save.GaidenCardPurchased !== undefined) globalUpgrades['diamondcards.gaiden'] = save.GaidenCardPurchased ? 1 : 0;
  if (save.IridianCardPurchased !== undefined) globalUpgrades['diamondcards.iridian'] = save.IridianCardPurchased ? 1 : 0;

  // Milestone #0 -> SU0Level (confirmed via a fresh ADB pull + direct value match: the account
  // holder's real in-game level was 80, and SU0Level was the only field in the whole save
  // holding exactly 80). "SU" is a distinct, separately-indexed-from-0 shard-upgrade registry --
  // NOT the same thing as the regular Milestone1-57Progress fields (those are a different,
  // 1-indexed system) or either Ouro-prefixed field tried earlier (both wrong).
  if (save.SU0Level !== undefined) {
    globalUpgrades['shardmilestones.m0'] = realNum(save.SU0Level);
  }

  // Hunter Researches (#81/#95/#105) -> the same RU{id}Level registry already confirmed for
  // Fleet Research (RU68/RU78) and every per-ship install node -- these three ids just happen
  // to be hunter-facing instead of ship-facing. Field exists and reads 0 on the account this
  // was checked against (matches the in-game state: none of the three had been leveled), so
  // this is pattern-confirmed but not yet value-diff-confirmed against a nonzero real number.
  if (save.RU81Level !== undefined) globalUpgrades['researches.res81'] = realNum(save.RU81Level);
  if (save.RU95Level !== undefined) globalUpgrades['researches.res95'] = realNum(save.RU95Level);
  if (save.RU105Level !== undefined) globalUpgrades['researches.res105'] = realNum(save.RU105Level);

  // Diamond Ultima -> DiamondUltimaLevel. Exact name match to the "Diamond Ultima" upgrade
  // page, same {Name}Level convention as every other confirmed field -- reads 0 on the account
  // this was checked against (matches in-game state), so pattern-confirmed, not yet
  // value-diff-confirmed against a nonzero real number.
  if (save.DiamondUltimaLevel !== undefined) globalUpgrades['ultima.ulti'] = realNum(save.DiamondUltimaLevel);

  unmapped.push('cms', 'loopmods', 'diamondspecials', 'iap', 'trinkets');

  // Gems: tree level + 6 boolean nodes per tree. Every tree except Exodus stores its nodes
  // as individual `${prefix}GemNode{n}Level` fields; Exodus alone stores them as a single
  // `ExodusGemNodeLevels` array (confirmed against a live save -- `ExodusGemNode1Level` etc.
  // don't exist at all for Exodus, so reading them the same way as the other 6 trees always
  // silently returned "unallocated" regardless of the account's real Exodus node levels).
  const gems = {};
  Object.entries(GEM_TREE_SAVE_PREFIX).forEach(([treeKey, prefix]) => {
    const level = save[`${prefix}QualityLevel`];
    const nodes = [];
    const arrKey = `${prefix}GemNodeLevels`;
    if (Array.isArray(save[arrKey])) {
      for (let i = 0; i < 6; i++) nodes.push(!!realNum(save[arrKey][i]));
    } else {
      for (let i = 1; i <= 6; i++) {
        const n = save[`${prefix}GemNode${i}Level`];
        nodes.push(!!realNum(n));
      }
    }
    gems[treeKey] = { level: level !== undefined ? realNum(level) : 0, nodes };
  });

  // Per-hunter: level, highest stage, talents (positional Skill1..8Level)
  const perHunter = {};
  Object.entries(HUNTER_SAVE_PREFIX).forEach(([hunterKey, prefix]) => {
    const level = save[`${prefix}Level`];
    const highestStage = save[`${prefix}HighestStage`];
    const talents = {};
    (HUNTER_TALENT_ORDER[hunterKey] || []).forEach((talentId, i) => {
      const v = save[`${prefix}Skill${i + 1}Level`];
      if (v !== undefined) talents[talentId] = realNum(v);
    });
    const attributes = {};
    const attrPrefix = HUNTER_ATTR_SAVE_PREFIX[hunterKey];
    (HUNTER_ATTR_ORDER[hunterKey] || []).forEach((attrId, i) => {
      const v = save[`${attrPrefix}${i}Level`];
      if (v !== undefined) attributes[attrId] = realNum(v);
    });
    // Base stat levels. 'stage' is deliberately not in the table -- it is the account's highest
    // stage, already carried separately as highestStage, not an upgrade the player buys.
    const hunterStats = {};
    for (const [statKey, saveField] of Object.entries(BASE_STAT_SAVE_FIELD[hunterKey] || {})) {
      const v = save[`${prefix}Upgrade${saveField}Level`];
      if (v !== undefined) hunterStats[statKey] = realNum(v);
    }

    perHunter[hunterKey] = {
      level: level !== undefined ? realNum(level) : undefined,
      highestStage: highestStage !== undefined ? realNum(highestStage) : undefined,
      talents,
      attributes,
      hunterStats,
    };
  });

  // Gadgets. The save's Gadget<N>Level numbering matches costFormulas' own g<N> aliases, which is
  // what makes this a lookup rather than a guess -- CONFIRMED against the account directly: the
  // player reported wrench 50 / zaptron 40 in game, and the save reads Gadget5Level 50 /
  // Gadget6Level 40. (Gadget7Level is also 90, which coincidentally matched a `wrench: 90` in an
  // unrelated build code; that near-miss is why this waited for confirmation instead of guessing.)
  // Corroborating: our g1/g2/g3 share one cost formula and the save's Gadget1/2/3 are identical.
  const GADGET_SAVE_INDEX = { wrench: 5, zaptron: 6, anchor: 15 };
  Object.entries(GADGET_SAVE_INDEX).forEach(([id, n]) => {
    const v = save[`Gadget${n}Level`];
    if (v !== undefined) globalUpgrades[`gadgets.${id}`] = realNum(v);
  });

  // NOTE: fleet data (generator tiers, gear levels, ship ranks, badges, fleet research) is NOT
  // mapped here. shipSchema.js already owns it -- mapSaveToUnlockedGens, mapSaveToGearLevels,
  // mapSaveToFleetBadges and friends, applied via applyImportedShipData() -- and those are
  // better sourced than anything added here would be: gear comes from per-piece
  // `{Color}Item{N}Level` (giving LEVELS, not just ownership), and the badge indices were
  // verified against a live save. A second mapping here would be a duplicate of the kind this
  // project keeps deleting.

  // Fragments. The save stores the CURRENT BALANCE as a BigDouble ({mantissa, exponent}); it has
  // no earn-rate field, because rate is not a thing the game persists -- it falls out of campaign
  // and boss content. So this fills `current` and stamps `currentAt`, and leaves `perDay` for the
  // user. That is the honest split: the balance is known, the rate is not.
  let fragments;
  const rawFrags = save.RelicFragments;
  if (rawFrags && typeof rawFrags === 'object' && 'mantissa' in rawFrags) {
    const value = Number(rawFrags.mantissa) * Math.pow(10, Number(rawFrags.exponent) || 0);
    if (Number.isFinite(value) && value >= 0) fragments = { current: value, currentAt: Date.now() };
  } else if (typeof rawFrags === 'number' && rawFrags >= 0) {
    fragments = { current: rawFrags, currentAt: Date.now() };
  }
  if (!fragments) unmapped.push('fragments');

  return { globalUpgrades, gems, perHunter, fragments, unmapped };
}
window.mapCifiSaveToStore = mapSaveToStore;

// ---- Bridge client (ws://127.0.0.1:43791, same protocol shape as tracker-bridge) ----

const BRIDGE_PORT = 43791;
function tryConnectBridge(timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(null); } }, timeoutMs);
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'PING' })); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'HELLO' || msg.type === 'PONG') {
          if (!settled) { settled = true; clearTimeout(timer); resolve(ws); }
        }
      } catch {}
    };
    ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } };
    ws.onclose = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } };
  });
}
window.tryConnectCifiBridge = tryConnectBridge;

// Queries the bridge's ADB device list (CHECK_ADB -> ADB_STATUS) so the UI can show whether
// it's just reachable vs. actually seeing a connected emulator/device. Uses addEventListener
// (not ws.onmessage=) so it composes with other listeners already attached to this socket
// (e.g. the sidebar's HELLO listener from tryConnectBridge, or a 'close' listener) instead of
// clobbering them.
function checkBridgeAdbStatus(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { resolve(null); return; }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      resolve(result);
    };
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ADB_STATUS') finish(msg);
      else if (msg.type === 'ERROR') finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.addEventListener('message', onMsg);
    try { ws.send(JSON.stringify({ type: 'CHECK_ADB' })); } catch { finish(null); }
  });
}
window.checkCifiBridgeAdbStatus = checkBridgeAdbStatus;

function pullSaveViaBridge(ws, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bridge pull timed out.')), timeoutMs);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'SUCCESS') {
        clearTimeout(timer);
        const bin = atob(msg.data);
        resolve(bin);
      } else if (msg.type === 'ERROR') {
        clearTimeout(timer);
        reject(new Error(msg.message || 'Bridge pull failed.'));
      }
    };
    ws.send(JSON.stringify({ type: 'PULL_SAVE' }));
  });
}
window.pullCifiSaveViaBridge = pullSaveViaBridge;
