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
  // `null` marks a save slot the GAME has but this tool does not model, so the positions after it
  // keep lining up. Knox's slot 8 is its Ultima signature talent (authored cap 50), which is
  // deliberately unmodelled -- params.json exposes no `ultima` argument for Knox, so an input there
  // would reach nothing. Omitting it from this list entirely, as an earlier version did, shifted
  // `finish` down onto the Ultima slot: it read KnoxSkill8Level (Ultima) instead of
  // KnoxSkill9Level. Harmless on the current save, where both read 0, and silently wrong on any
  // account that has bought either.
  //
  // The Skill families are 1-INDEXED in the game (BorgeSkill1..9), which is why `Skill${i + 1}Level`
  // is the right field for our index i -- Borge and Ozzy match the game's authored caps 9/9 that
  // way. tools/bench/attr-save-order-check.js asserts it.
  knox: ['revival', 'calyp', 'ua', 'ghost', 'omen', 'll', 'pog', null, 'finish'],
};

// Attribute allocations ARE in the save after all -- stored as 15 positional fields per
// hunter under an internal codename (POM0..14Level for Borge, POI0..14 for Ozzy, POK0..14 for
// Knox; found via the il2cpp class dump's SaveData fields).
//
// THIS ORDER IS DERIVED FROM THE GAME, NOT HAND-MATCHED, and the previous hand-matched version was
// wrong in FIFTEEN places -- two for Borge, eight for Ozzy, five for Knox. Its own comment
// described being "best-effort matched to HUNTER_DEFS order, then live-verified" by eyeballing caps
// and dependency chains; that method got Borge's obvious reversals right and quietly mis-assigned
// the rest.
//
// The symptom, and why this went unnoticed: a positional mapping that is wrong is SILENT. Every
// value still lands in some attribute, and the point total still looks plausible. It surfaced only
// when the real save's Ozzy build was pushed through cifi-tools.com, which rejected it outright --
// "This Build is invalid. Please check the attributes." -- because `POI12Level = 7` had been loaded
// into `sisters`, whose cap is 1. POI12 is a Cost 2 / MaxLevel 20 slot; 7 belongs to `scarab`.
//
// The game pins each slot without guessing: every `PO?<n>` carries an authored Cost and MaxLevel
// (tools/reference/scene-defs.json) and the dependency edges are recovered in
// tools/reference/attribute-tree.json, so a node's index follows from (tree shape, cost, cap).
// `tools/bench/attr-save-order-check.js` derives it that way and fails if this list drifts.
// Regenerate with `node tools/bench/attr-save-order-check.js --print`.
const HUNTER_ATTR_SAVE_PREFIX = { borge: 'POM', ozzy: 'POI', knox: 'POK' };
const HUNTER_ATTR_ORDER = {
  borge: ['ares', 'ylith', 'spartan', 'timeless', 'baal', 'sensors', 'htb', 'lfin', 'exp', 'weak', 'atlas', 'battle', 'hermes', 'mino', 'athena'],
  ozzy: ['lotl', 'exo', 'ibu', 'timeless', 'scorp', 'exterm', 'vect', 'snek', 'cycle', 'dance', 'medusa', 'deal', 'scarab', 'cat', 'sisters'],
  // Knox has 11 released attributes; the game's POK11 is authored all-zero (unreleased), so there
  // is nothing to map past index 10.
  knox: ['kraken', 'spa', 'pl', 'time', 'soul', 'dead', 'sear', 'pct', 'kot', 'fe', 'sop'],
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
/**
 * Every upgrade id the TOOL offers in a category, across all hunters.
 *
 * The importer used to carry hand-written copies of these lists, which is a mirror of another
 * module's data and drifts the moment an id is added -- silently, because a missing mapping just
 * leaves an input blank rather than throwing. `researches.res112` and `cms.cm58` were both lost
 * that way. Reading HUNTER_DEFS makes the tool's own surface the single source.
 *
 * Categories are account-wide but declared per hunter, so ids are unioned across all three.
 */
function upgradeIdsFor(category) {
  const defs = (typeof window !== 'undefined' ? window : globalThis).HUNTER_DEFS;
  if (!defs) throw new Error('upgradeIdsFor: HUNTER_DEFS is not loaded (check index.html script order)');
  const ids = new Set();
  for (const hunter of Object.keys(defs)) {
    const group = ((defs[hunter] || {}).globalUpgrades || {})[category];
    for (const item of (group && group.items) || []) ids.add(item.id);
  }
  return [...ids];
}

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

  // Inscryptions -- "Inscryption #N" (as labeled in this app and in-game) is stored as
  // IS{slot}Level, where the slot is NOT N and the difference is NOT a constant.
  //
  // The game's own scene settles this without inference: each shop row is a GameObject named
  // `ChrystosEmporiumUpgrade<slot>`, and for every row the developers renamed, the name also
  // carries the displayed id -- `ChrystosEmporiumUpgrade72-ID60` is slot 72 shown as "#60". The
  // slot half is cross-checked against MultiverseMarket's own `IS<slot>IDText` reference, so the
  // pair is confirmed from two directions. See tools/bench/extract-inscryption-slots.js, which
  // regenerates tools/reference/inscryption-slots.json; INSCRYPTION_SLOT below is asserted equal
  // to it by tools/bench/inscryption-slot-test.js.
  //
  // What that shows, and why the previous rule was half right:
  //   #57-#62   live at slots 69-74  (+12)  <- exactly the five-for-five value match that the
  //                                            earlier +12 rule was (correctly) drawn from
  //   #75-#110  live at slots 75-110 ( +0)  <- where the blanket +12 was wrong
  //
  // The +12 was therefore generalised from a range where it held to ranges where it does not.
  // Two consequences that were silently corrupting imports:
  //   - #103/#104/#105 read IS115/116/117Level, which do not exist (the registry stops at 110),
  //     so those three NEVER imported at all regardless of the account.
  //   - #80-#92 read a slot 12 too high, i.e. another inscryption's level.
  //
  // The rows the developers did not rename (#1-#56, #63-#74) carry no displayed id in the scene,
  // but they are pinned by exhaustion rather than left to a guess. The shop has exactly one row
  // family (`ChrystosEmporiumUpgrade<N>`, 110 rows -- there is no second inscryption shop, so the
  // fleet inscryptions #64/#65/#67/#68 that shipsPage.js consumes must live in this one). 110
  // slots therefore carry 110 displayed ids, and the mapping is a bijection. Removing the proven
  // pairs leaves displays {1-56, 63-74} for slots {1-56, 57-68} -- two contiguous blocks, so
  // displays 1-56 sit at slots 1-56 and displays 63-74 at slots 57-68.
  //
  // The reference account confirms that reading and refutes the blanket +12 outright:
  //   - slots 1-12 are leveled 5,10,8,6,3,7,10,3,6,9,3,5. Under +12 no displayed id maps to them
  //     at all, i.e. twelve leveled slots owned by nothing. Under the bijection they are #1-#12.
  //   - the level profile becomes monotone in exactly the way progression is: slots 1-56 mean
  //     7.05 (#1-#56 finished), slots 69-74 mean 2.00 (#57-#62 in progress), slots 57-68 mean
  //     0.33 (#63-#74 barely started), slots 75-110 all zero (#75+ not reached).
  //   - the fleet inscryptions read 8,10,8,7,7,5,4,5 for the early ships instead of all zero,
  //     which is what an account with six ranked-up ships should look like.
  //
  // So: identity everywhere except the 57-74 block, which is permuted -- #57-#62 sit AFTER
  // #63-#74 in slot order.
  const INSCRYPTION_SLOT = (n) => {
    if (n >= 1 && n <= 56) return n;         // identity (by exhaustion + account profile)
    if (n >= 57 && n <= 62) return n + 12;   // PROVEN by the scene's -ID<n> row names
    if (n >= 63 && n <= 74) return n - 6;    // by exhaustion: the only slots left
    if (n >= 75 && n <= 110) return n;       // PROVEN by the scene's -ID<n> row names
    throw new Error(`inscryption #${n} is outside the game's 1-110 registry`);
  };

  INSCRYPTION_IDS.forEach((n) => {
    const v = save[`IS${INSCRYPTION_SLOT(n)}Level`];
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
  // Researches: `res<N>` -> `RU<N>Level`, DERIVED from the ids the tool actually offers rather
  // than a hand-written list. The list used to be three literals (81/95/105), so `res112` -- which
  // the tool exposes and the save carries as `RU112Level` -- was silently never imported. A
  // hardcoded mirror of another module's data is a gap waiting to happen: it only breaks when
  // someone adds an id, and then it fails silently rather than loudly.
  for (const id of upgradeIdsFor('researches')) {
    const n = /^res(\d+)$/.exec(id);
    if (!n) continue;
    const v = save[`RU${n[1]}Level`];
    if (v !== undefined) globalUpgrades[`researches.${id}`] = realNum(v);
  }

  // DIAMOND ULTIMA IS DELIBERATELY NOT IMPORTED, AND MAPPING IT WAS ACTIVELY DESTRUCTIVE.
  //
  // `upgrades.ultima.ulti` IS NOT A LEVEL. The stored value is the loot MULTIPLIER itself -- the
  // original tool's Ultima page renders it `display-as-multiplier`, as a 1.0000-10.0000 value with
  // step 0.0001 labelled "Current Multiplier x", and our own card at app.js says the same.
  //
  // This line wrote `DiamondUltimaLevel` into it. That field is a small integer (1 on the reference
  // account), so every save import silently reset a user's real multiplier -- x1.1989 in game --
  // back to 1.0000, i.e. no boost at all. It reads as "Diamond Ultima isn't being scanned", and it
  // is worse than not importing: a level of 7 would have been fed to the evaluator as x7 loot.
  // The name matched the {Name}Level convention, which is exactly why it looked confirmed.
  //
  // WHAT THE GAME ACTUALLY SAYS, so the next attempt starts further along. `DiamondShop` computes
  // `DiamondUltimaBonus = Pow(UltimaMilestoneExponent, DiamondUltimaLevel)` with the authored
  // `UltimaMilestoneExponent = 1.05` (`UltimaMilestoneExponent2 = 1.02`, `UltimaMilestoneGoal = 50`).
  // But that is NOT the number on screen: a save pulled the same day the player reported x1.1989
  // carries `DiamondUltimaLevel = 1` and `DiamondUltimaProgress = 19`, and no integer power of 1.05
  // or 1.02 reaches 1.1989 (3.72 and 9.16 respectively). The hunter game contexts carry a separate
  // `DiamondUltimaRewardsBonus` (BigDouble) beside `AllDiamondUltimas` (int), and neither the DU
  // level family (sums to 165) nor anything else in the save produces 1.1989. So the derivation is
  // UNRESOLVED, and the original tool does not derive it either -- its input is typed by the user.
  //
  // Leaving it to the user's own input is therefore the honest behaviour, not a gap. Do not restore
  // a mapping here without a value-diff proof that the field reproduces the displayed multiplier.

  // Mats Exchange -> `TysconDrives`. Exact-name match on the same {Name} convention as the rest,
  // and the only Tyscon-shaped field that is a plain count: the save also carries
  // `TysconDriveProgress` (progress toward the next one) and `TysconDriveMultiplierLevel` (a
  // separate multiplier upgrade), neither of which is the number this input wants. Reads 0 on this
  // account, which matches the tool showing it empty.
  if (save.TysconDrives !== undefined) globalUpgrades['mats_exchange.tysconDrives'] = realNum(save.TysconDrives);

  // Loop mods: the 4 tool inputs are 4 completely different save fields, not one array -- each
  // found via a NEW extraction technique (2026-09) that needed no save diffing and no live
  // device access:
  //   1. tools/save/unity-strings.js scans the raw Unity-serialized asset bytes for the exact
  //      length-prefixed-string shape, in file order (display text is asset data, not a C#
  //      string literal -- verified absent from stringliteral.json, present in level0's raw
  //      bytes at a fixed offset).
  //   2. A button's own onClick target (`LoopModifiers, Assembly-CSharp` + `BuyLM<N>` or
  //      `BuyLMOuro<N>`) is serialized as a plain string close to its label in that same byte
  //      stream, which is what actually pins the index -- proximity alone isn't proof, so every
  //      id is sanity-checked against extract-loopmods.js's real MaxLevel for that slot.
  //   trample    -> LMOuro20 ("Trample: Borge" is a VERBATIM dump.cs [Header] comment on
  //     LoopModifiers -- the strongest kind of confirmation, no proximity guess involved).
  //   scavenger  -> LM229 (MaxLevel 25 in the scene, matching hunterDefs.js's cap exactly;
  //     "BuyLM229" sits immediately after the "SCAVENGERS ADVANTAGE" label with only fixed
  //     Button-state boilerplate strings between them).
  //   scavenger2 -> LMOuro18 (MaxLevel 25 matches; its own dump.cs Header reads "Base Hunt Loot
  //     Rewards Bonus (Ozzy)" -- Ozzy-themed like scavenger2, and no other Ouroboros mod shares
  //     that exact cap. Weaker than the other two: no literal text match, and proximity alone
  //     was ambiguous for this one specifically -- re-confirm if a live account ever disagrees).
  //   stelzi     -> LM279 (already known -- see tools/reference/loopmod-names.json -- but was
  //     never actually wired into the importer until now).
  if (save.LMOuro20Level !== undefined) globalUpgrades['loopmods.trample'] = realNum(save.LMOuro20Level);
  if (save.LM229Level !== undefined) globalUpgrades['loopmods.scavenger'] = realNum(save.LM229Level);
  if (save.LMOuro18Level !== undefined) globalUpgrades['loopmods.scavenger2'] = realNum(save.LMOuro18Level);
  if (save.LM279Level !== undefined) globalUpgrades['loopmods.stelzi'] = realNum(save.LM279Level);

  // Trinkets. The blocking question (does the consumer want a COUNT of owned trinkets or a SUM
  // of their levels?) is now settled from cifi-tools.com's own live evaluationWorker bundle
  // (2026-09) -- despite the UI labeling this param "Galvarium Trinkets Count", its actual
  // fallback code is `Object.values(upgrades.trinkets).reduce((a,b) => a+(b||0), 0)`, i.e. SUM,
  // gated behind Creation Gem Node 5 (`creation_gem5`) -- matching hunterSimBrowser.js's existing
  // resolveParam exactly, byte for byte. So the "Count" name was just a misleading UI label on
  // the site, not evidence our sum implementation was wrong.
  // Per-trinket IDENTITY (which of the 3 save fields is last_handbook/transmission_amplifier/
  // ouro_codex) does NOT need settling, because the consumer sums all three regardless of id --
  // an arbitrary but harmless assignment below reproduces the exact same total either way.
  const TRINKET_SAVE_FIELD = { last_handbook: 'T1F', transmission_amplifier: 'T2F', ouro_codex: 'T3F' };
  Object.entries(TRINKET_SAVE_FIELD).forEach(([id, prefix]) => {
    const v = save[`${prefix}Level`];
    if (v !== undefined) globalUpgrades[`trinkets.${id}`] = realNum(v);
  });

  // IAP: Traversal Pack -> OuroDevicePurchased. Found by disassembling Cifi.OfflineHunt.
  // Simulator$$CreateOzzyContext (capstone against libil2cpp.so directly; this machine's
  // Application Control policy was disabled by the time this was done) and locating the write to
  // OzzyGameContext's `TraversalPack` backing field (offset 0xDC): `mov al, [rax+0x3442]` then
  // `mov [rbx+0xDC], al` -- 0x3442 is dump.cs's own `OuroDevicePurchased`, exactly. The name
  // mismatch is real, not a mistake: this game calls a Loop Reset a "Traversal" throughout its own
  // UI (TraversalsCounterText, TimeInTraversal, etc.), so an "Ouro[boros] Device" IAP pack -- which
  // grants Ouroboros-cycle rewards -- is naturally what this tool's param list calls the
  // "Traversal Pack". Untested against a real nonzero value: no available account owns this real-
  // money purchase, same as every other IAP search in this file has found.
  if (save.OuroDevicePurchased !== undefined) globalUpgrades['iap.travpack'] = save.OuroDevicePurchased ? 1 : 0;

  // Gems: tree level + 6 boolean nodes per tree. Every tree except Exodus stores its nodes
  // as individual `${prefix}GemNode{n}Level` fields; Exodus alone stores them as a single
  // `ExodusGemNodeLevels` array (confirmed against a live save -- `ExodusGemNode1Level` etc.
  // don't exist at all for Exodus, so reading them the same way as the other 6 trees always
  // silently returned "unallocated" regardless of the account's real Exodus node levels).
  //
  // Named "GU" upgrades (Attraction/Creation only -- confirmed straight from the live bundle's
  // own gem-tree config, see hunterDefs.js's GEM_TREES comment, that every OTHER tree's GU
  // fields are non-sim bookkeeping). The save carries these as `{prefix}GU{n}Level` and, until
  // now, saveImport.js never read them at all -- meaning any account with real Attraction/
  // Creation gem investment had those bonuses silently ignored by the evaluator on every
  // import, exactly the same class of bug as the loopmods/trinkets/iap gap fixed earlier.
  //
  // GU-index -> named-upgrade order for BOTH trees is now CONFIRMED directly from the live
  // cifi-tools.com bundle's own gem-tree config array (`index-*.js`, each tree's literal
  // `upgrades:[...]` list) -- not inferred from gating alone. Cross-checked against a real
  // account both ways:
  //   Attraction: array is [borge-loot-bonus(unlock1), ozzy-loot-bonus(2), catch-up-power-
  //     borge-ozzy(3), knox-loot-bonus(4), catch-up-power-knox(4), ship-evo-bonus(4)] -- 6
  //     entries, matching AttractionGU1-6 exactly. The account's real AttractionQualityLevel
  //     is 2, and exactly GU1/GU2 (the two upgrades reachable at level 2) are non-zero.
  //   Creation: array is [mech-bonus-cap(1), hardware-bonus(2), software-bonus(2), cells-
  //     bonus(3), mp-bonus(3), shards-bonus(3), rp-bonus(3), f-trinket-tier-bonus(4), borge-
  //     stat-bonus(4), ozzy-stat-bonus(4), knox-stat-bonus(4)] -- 11 entries, matching
  //     CreationGU1-11 exactly. The account's real CreationQualityLevel is 1, and GU1
  //     (mech-bonus-cap, the ONLY upgrade reachable at level 1) is exactly the one non-zero
  //     slot -- which also proves the earlier guess (that GU1-3 might be Borge/Ozzy/Knox Stat
  //     Bonus) would have been wrong: those three are actually GU9-11.
  //   Only the fields the live bundle itself marks `hunter:true` are hunter-sim-relevant and
  //   wired in here. The rest (hardware/software/cells/mp/shards/rp-bonus, f-trinket-tier-
  //   bonus, mech-bonus-cap, Attraction's ship-evo-bonus) affect fleet/economy systems this
  //   tool doesn't model yet -- out of scope for the Hunter Sim, not a mapping gap.
  const ATTRACTION_GU_ORDER = ['borge-loot-bonus', 'ozzy-loot-bonus', 'catch-up-power-borge-ozzy', 'knox-loot-bonus', 'catch-up-power-knox']; // GU6 ship-evo-bonus omitted: not hunter-relevant
  const CREATION_GU_ORDER = [null, null, null, null, null, null, null, null, 'borge-stat-bonus', 'ozzy-stat-bonus', 'knox-stat-bonus']; // GU1-8 omitted: not hunter-relevant
  const GU_ORDER_BY_TREE = { attraction: ATTRACTION_GU_ORDER, creation: CREATION_GU_ORDER };
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
    const guOrder = GU_ORDER_BY_TREE[treeKey];
    if (guOrder) {
      const upgrades = {};
      guOrder.forEach((key, i) => {
        if (!key) return;
        const v = save[`${prefix}GU${i + 1}Level`];
        if (v !== undefined) upgrades[key] = realNum(v);
      });
      if (Object.keys(upgrades).length) gems[treeKey].upgrades = upgrades;
    }
  });

  // Per-hunter: level, highest stage, talents (positional Skill1..8Level)
  const perHunter = {};
  Object.entries(HUNTER_SAVE_PREFIX).forEach(([hunterKey, prefix]) => {
    const level = save[`${prefix}Level`];
    const highestStage = save[`${prefix}HighestStage`];
    const talents = {};
    (HUNTER_TALENT_ORDER[hunterKey] || []).forEach((talentId, i) => {
      if (!talentId) return;   // a game slot this tool does not model; see the note above
      const v = save[`${prefix}Skill${i + 1}Level`];
      if (v !== undefined) talents[talentId] = realNum(v);
    });
    const attributes = {};
    const attrPrefix = HUNTER_ATTR_SAVE_PREFIX[hunterKey];
    (HUNTER_ATTR_ORDER[hunterKey] || []).forEach((attrId, i) => {
      const v = save[`${attrPrefix}${i}Level`];
      if (v !== undefined) attributes[attrId] = realNum(v);
    });
    // Base stat levels. 'stage' is not in that table because it is not an upgrade the player buys
    // -- it is the account's highest stage reached, which the save stores as `<Hunter>HighestStage`.
    const hunterStats = {};
    for (const [statKey, saveField] of Object.entries(BASE_STAT_SAVE_FIELD[hunterKey] || {})) {
      const v = save[`${prefix}Upgrade${saveField}Level`];
      if (v !== undefined) hunterStats[statKey] = realNum(v);
    }
    // AND IT MUST LAND IN hunterStats.stage, WHICH IS WHERE THE SIM READS IT.
    //
    // This used to be returned only as `perHunter.highestStage`, described as "carried separately"
    // -- but nothing consumed that field anywhere in the app, so it was dead output and the sim's
    // `stage` argument kept its default of 1 forever.
    //
    // That is not a cosmetic input. `stage` is a POWER MULTIPLIER, not a cosmetic record of
    // progress: holding one build fixed and varying only this value moves boss kill rate 0 -> 99.4
    // and loot by more than an order of magnitude (measured, see CLAUDE.md). So every loot number
    // the app displayed was computed for an account that had never cleared a stage. On this save
    // the real values are Borge 262, Ozzy 201, Knox 100 against the 1 the tool was using.
    // `resolveParam('stage')` reads `hunterStats.stage`; the Overrides panel's "Highest Stage
    // Reached" input is the same field, so importing it also fills that box.
    if (highestStage !== undefined) hunterStats.stage = realNum(highestStage);

    perHunter[hunterKey] = {
      level: level !== undefined ? realNum(level) : undefined,
      highestStage: highestStage !== undefined ? realNum(highestStage) : undefined,
      talents,
      attributes,
      hunterStats,
    };
  });

  // Diamond specials -- the DiamondShop's DU<N>Level family.
  //
  // Identified by EFFECT COEFFICIENT, which makes it a proof rather than a positional guess. The
  // IL2CPP dump names the slots semantically (DU21Hunt*, DU22Loot*, DU23Loot*) and the scene
  // carries their bonus values; those values match the coefficients our own resolveParam already
  // uses:
  //   DU21 "Hunt"  bonus 3      -> reviveboost, which resolveParam computes as 3 * value
  //   DU22 "Loot"  bonus 0.025  -> hunterloot,  which resolveParam computes as 1 + 0.025 * value
  // Both cap at 10 and both read 10 on an account the player confirmed has them maxed.
  //
  // DU23 is a THIRD loot booster (bonus 0.01, cap 10) that this tool does not model, and it also
  // reads 10 -- which is exactly why picking "the slot whose level is 10" would not have worked.
  const DIAMOND_SPECIAL_SLOT = { reviveboost: 21, hunterloot: 22 };
  Object.entries(DIAMOND_SPECIAL_SLOT).forEach(([id, n]) => {
    const v = save[`DU${n}Level`];
    if (v !== undefined) globalUpgrades[`diamondspecials.${id}`] = realNum(v);
  });

  // Construction Milestones. `Milestone<N>Acquired`, N = the milestone's own number, which is the
  // SAME numbering our cms ids use (cm46 -> Milestone46Acquired).
  //
  // Identified by shape rather than by name: the account owns milestones up to ~20 and the save
  // reads Milestone1..19 true and 20..57 false -- a clean "owned up to N" prefix. The save ALSO
  // has a `CM<N>` boolean family (1-26), but every one of those is false on an account that owns
  // 20 milestones, so `CM<N>` is something else entirely (a claim or notification flag) and is
  // deliberately not used. Shard milestones are a third, separate family
  // (AllTimeHighestShardMilestoneLevels et al) and are not these either.
  // Derived from the tool's own cms ids, not a literal list -- the literal list stopped at cm57
  // and so never imported `cm58`, which the save does carry (`Milestone58Acquired`). The save's
  // family runs to Milestone60 on this build, so the tool can grow into it without a code change.
  //
  // `cm_ultima` and `cm_ultimas` are DELIBERATELY NOT MAPPED. The only plausible field family is
  // `MilestoneU<N>Level`, and there are THREE of those against the tool's TWO inputs, all reading
  // 0 on this account -- so nothing distinguishes which is which. Guessing a mapping that happens
  // to look right on an all-zero account is exactly how `Gadget7Level = 90` nearly became a
  // confident wrong mapping (see CLAUDE.md). Leave them for the user to type until one of the
  // three moves in a save diff.
  for (const id of upgradeIdsFor('cms')) {
    const n = /^cm(\d+)$/.exec(id);
    if (!n) continue;
    const v = save[`Milestone${n[1]}Acquired`];
    if (v !== undefined) globalUpgrades[`cms.${id}`] = v ? 1 : 0;
  }
  // milestoneCount is a real sim parameter (upgrades.cms.milestoneCount) -- how many are owned,
  // not which. Derived by counting, since the save stores no total.
  const milestoneAcquired = Object.keys(save)
    .filter((k) => /^Milestone\d+Acquired$/.test(k) && save[k]).length;
  if (milestoneAcquired > 0) globalUpgrades['cms.milestoneCount'] = milestoneAcquired;

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
