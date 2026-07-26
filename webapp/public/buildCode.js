// Build-code encode/decode, byte-compatible with the real cifi-tools.com "Share Build"
// codes -- reverse-engineered from the live bundle's TX/kX classes: Base58 (Bitcoin
// alphabet) of a buffer [0x65, kind<<5|version] followed by the build's per-param values
// (in a dedicated ~74-entry per-hunter list, NOT the same order/set as the simulation's
// EVAL_PARAMS/params.json) packed 4-at-a-time -- each value gets a 2-bit tag (0 = value is
// 0, 1 = value is 1, 2 = fits in 1 byte, 3 = needs 2 bytes) packed into a control byte,
// followed by the raw bytes for tag 2/3 values.
//
// An earlier version of this file used a different, simplified format for OUR OWN codes
// (JSON containing only talents/attributes/stats) because a first attempt at decoding real
// codes appeared to corrupt trailing fields. That corruption turned out to be a false
// alarm: it came from comparing a share-code capture against an evaluate-payload capture
// taken at a slightly different moment, while the live account's own state had drifted
// in between (confirmed by re-capturing both at the same instant -- the "corruption"
// disappeared entirely). The pack/unpack algorithm itself round-trips perfectly. So this
// version uses the real format for both encode and decode -- one system, not two -- and a
// code generated here can be pasted into the live site and vice versa.
(function (global) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = ALPHABET.length;
  const BASE_MAP = new Uint8Array(256).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) BASE_MAP[ALPHABET.charCodeAt(i)] = i;
  const FACTOR = Math.log(BASE) / Math.log(256);
  const IFACTOR = Math.log(256) / Math.log(BASE);

  function base58Encode(source) {
    if (source.length === 0) return '';
    let psz = 0, zeroes = 0, length = 0;
    while (psz !== source.length && source[psz] === 0) { psz++; zeroes++; }
    const size = (((source.length - psz) * IFACTOR) + 1) >>> 0;
    const b58 = new Uint8Array(size);
    while (psz !== source.length) {
      let carry = source[psz];
      let i = 0;
      for (let it = size - 1; (carry !== 0 || i < length) && it !== -1; it--, i++) {
        carry += (256 * b58[it]) >>> 0;
        b58[it] = (carry % BASE) >>> 0;
        carry = (carry / BASE) >>> 0;
      }
      length = i;
      psz++;
    }
    let it = size - length;
    while (it !== size && b58[it] === 0) it++;
    let str = ALPHABET[0].repeat(zeroes);
    for (; it < size; it++) str += ALPHABET.charAt(b58[it]);
    return str;
  }

  function base58Decode(str) {
    if (str.length === 0) return new Uint8Array();
    let psz = 0, zeroes = 0, length = 0;
    while (str[psz] === ALPHABET[0]) { zeroes++; psz++; }
    const size = (((str.length - psz) * FACTOR) + 1) >>> 0;
    const b256 = new Uint8Array(size);
    while (psz !== str.length) {
      let carry = BASE_MAP[str.charCodeAt(psz)];
      if (carry === 255) throw new Error('invalid character in build code');
      let i = 0;
      for (let it = size - 1; (carry !== 0 || i < length) && it !== -1; it--, i++) {
        carry += (BASE * b256[it]) >>> 0;
        b256[it] = (carry % 256) >>> 0;
        carry = (carry / 256) >>> 0;
      }
      length = i;
      psz++;
    }
    let it = size - length;
    while (it !== size && b256[it] === 0) it++;
    const vch = new Uint8Array(zeroes + (size - it));
    let j = zeroes;
    while (it !== size) vch[j++] = b256[it++];
    return vch;
  }

  const HUNTER_TYPE_CODE = { borge: 1, ozzy: 3, knox: 6 };
  const HUNTER_BY_CODE = { 1: 'borge', 3: 'ozzy', 6: 'knox' };

  const CODE_PARAMS = {
    borge: ['revival', 'loth', 'ua', 'impeccable', 'omen', 'll', 'pog', 'tfow', 'ares', 'ylith', 'spartan', 'timeless', 'baal', 'sensors', 'htb', 'lfin', 'exp', 'atlas', 'weak', 'battle', 'hp', 'atk', 'regen', 'dr', 'evade', 'effect', 'critchance', 'critpower', 'atkspeed', 'upgrades.loopmods.trample', 'upgrades.relics.r4', 'upgrades.relics.r16', 'upgrades.relics.r19', 'upgrades.inscryptions.i3', 'upgrades.inscryptions.i4', 'upgrades.inscryptions.i11', 'upgrades.inscryptions.i13', 'upgrades.inscryptions.i23', 'upgrades.inscryptions.i24', 'upgrades.inscryptions.i27', 'upgrades.inscryptions.i60', 'upgrades.gems_nodes.creation_gem1', 'upgrades.gems_nodes.creation_gem2', 'upgrades.gems_nodes.creation_gem3', 'upgrades.gems_nodes.innovation_gem3', 'upgrades.gems_nodes.attraction_gem2', 'upgrades.gems_nodes.attraction_level', 'upgrades.gems_nodes.attraction_catchUp', 'upgrades.inscryptions.i84', 'upgrades.inscryptions.i87', 'upgrades.inscryptions.i88', 'upgrades.inscryptions.i89', 'upgrades.inscryptions.i91', 'ultima', 'athena', 'mino', 'hermes', 'upgrades.gadgets.wrench', 'upgrades.diamondcards.gaiden', 'upgrades.diamondspecials.reviveboost', 'upgrades.gems_nodes.creation_borgeGU', 'upgrades.gems_nodes.evolution_gem3', 'upgrades.gems_nodes.temporal_gem4', 'upgrades.loopmods.stelzi', 'upgrades.inscryptions.i103', 'upgrades.gems_nodes.exodus_gem3', 'upgrades.gems_nodes.exodus_gem4', 'upgrades.cms.milestoneCount', 'upgrades.gems_nodes.temporal_gem6', 'upgrades.gems_nodes.creation_gem4', 'upgrades.gems_nodes.creation_gem5', 'upgrades.gems_nodes.evolution_gem6', 'upgrades.relics.t2r7', 'upgrades.gems_nodes.power_level'],
    ozzy: ['revival', 'boon', 'ua', 'needles', 'omen', 'll', 'crip', 'echo', 'lotl', 'exo', 'scorp', 'timeless', 'ibu', 'exterm', 'snek', 'vect', 'cycle', 'deal', 'medusa', 'dance', 'hp', 'atk', 'regen', 'dr', 'evade', 'effect', 'multichance', 'multipower', 'atkspeed', 'upgrades.relics.r4', 'upgrades.relics.r17', 'upgrades.inscryptions.i31', 'upgrades.inscryptions.i36', 'upgrades.inscryptions.i37', 'upgrades.inscryptions.i40', 'upgrades.gems_nodes.innovation_gem2', 'upgrades.gems_nodes.innovation_gem3', 'upgrades.gems_nodes.attraction_level', 'upgrades.gems_nodes.attraction_catchUp', 'upgrades.inscryptions.i86', 'upgrades.inscryptions.i92', 'ultima', 'sisters', 'scarab', 'cat', 'upgrades.gadgets.zaptron', 'upgrades.diamondcards.iridian', 'upgrades.diamondspecials.reviveboost', 'upgrades.gems_nodes.creation_ozzyGU', 'upgrades.gems_nodes.evolution_gem3', 'upgrades.loopmods.stelzi', 'upgrades.gems_nodes.exodus_gem3', 'upgrades.gems_nodes.exodus_gem4', 'upgrades.cms.milestoneCount', 'upgrades.gems_nodes.temporal_gem6', 'upgrades.gems_nodes.creation_gem4', 'upgrades.gems_nodes.creation_gem5', 'upgrades.gems_nodes.creation_gem6', 'upgrades.gems_nodes.evolution_gem6', 'upgrades.relics.t2r7', 'upgrades.gems_nodes.power_level'],
    knox: ['revival', 'calyp', 'ua', 'ghost', 'omen', 'll', 'pog', 'finish', 'ultima', 'kraken', 'spa', 'pl', 'time', 'soul', 'dead', 'fe', 'sop', 'sear', 'pct', 'kot', 'hp', 'atk', 'regen', 'dr', 'block', 'effect', 'charge', 'chargeGain', 'reload', 'proj', 'upgrades.diamondspecials.reviveboost', 'stage', 'upgrades.gadgets.anchor', 'upgrades.gems_nodes.creation_knoxGU', 'upgrades.gems_nodes.evolution_gem3', 'upgrades.gems_nodes.exodus_gem4', 'upgrades.cms.milestoneCount', 'upgrades.gems_nodes.temporal_gem6', 'upgrades.gems_nodes.creation_gem4', 'upgrades.gems_nodes.creation_gem5', 'upgrades.gems_nodes.power_gem6', 'upgrades.gems_nodes.evolution_gem6', 'upgrades.gems_nodes.attraction_level', 'upgrades.gems_nodes.attraction_catchUp2', 'upgrades.relics.t2r7', 'upgrades.gems_nodes.power_level'],
  };

  // Fields the live site's own "Import with Upgrades" flow excludes, per its tooltip:
  // "except pure loot upgrades as they don't affect loot score" -- matches what we
  // separately confirmed empirically (zeroing these barely moves lootPerMin).
  const PURE_LOOT_KEYS = new Set([
    'upgrades.diamondspecials.hunterloot', 'upgrades.ultima.ulti', 'upgrades.iap.travpack',
    'upgrades.loopmods.scavenger', 'upgrades.loopmods.scavenger2',
    'upgrades.inscryptions.i14', 'upgrades.inscryptions.i44', 'upgrades.inscryptions.i80', 'upgrades.inscryptions.i103',
  ]);
  function isPureLootKey(key) {
    return PURE_LOOT_KEYS.has(key) || /loot(Borge|Ozzy|Knox)/.test(key);
  }
  global.isPureLootOverrideKey = isPureLootKey;

  function packLevels(levels) {
    const bytes = [];
    for (let g = 0; g < levels.length; g += 4) {
      const group = levels.slice(g, g + 4);
      while (group.length < 4) group.push(0);
      const tags = group.map((v) => (v === 0 ? 0 : v === 1 ? 1 : v <= 255 ? 2 : 3));
      let ctrl = 0;
      for (const t of tags) ctrl = (ctrl << 2) | t;
      bytes.push(ctrl);
      group.forEach((v, i) => {
        if (tags[i] === 2) bytes.push(v & 255);
        else if (tags[i] === 3) bytes.push((v >> 8) & 255, v & 255);
      });
    }
    return bytes;
  }

  function unpackLevels(bytes) {
    const levels = [];
    let i = 2;
    const readOne = (tag) => {
      if (tag < 2) levels.push(tag);
      else if (tag === 2) levels.push(bytes[i++] & 255);
      else { const hi = bytes[i++] & 255; const lo = bytes[i++] & 255; levels.push((hi << 8) | lo); }
    };
    while (i < bytes.length) {
      const ctrl = bytes[i++] & 255;
      readOne((ctrl >> 6) & 3);
      readOne((ctrl >> 4) & 3);
      readOne((ctrl >> 2) & 3);
      readOne(ctrl & 3);
    }
    return levels;
  }

  function extractParamValue(name, buildData, hunterStats, flatUpgrades, baseStatKeys) {
    if (buildData.overrides && name in buildData.overrides) return buildData.overrides[name] ?? 0;
    if (buildData.talents && name in buildData.talents) return buildData.talents[name] ?? 0;
    if (buildData.attributes && name in buildData.attributes) return buildData.attributes[name] ?? 0;
    if (baseStatKeys.includes(name)) return hunterStats?.[name] ?? 0;
    if (name === 'lvl') return buildData.level ?? 0;
    if (name.startsWith('upgrades.')) return flatUpgrades[name.slice('upgrades.'.length)] ?? 0;
    return 0;
  }

  // Builds the flat "category.field" / "gems_nodes.tree_field" map used to diff against for
  // encoding "upgrades.gems_nodes.X" params (the sim itself reads gems from gemPlannerStore
  // instead, but this flat shape is what the build-code system's field names expect).
  function buildFlatUpgrades(globalUpgrades, gems) {
    const flat = { ...globalUpgrades };
    Object.entries(gems || {}).forEach(([treeName, state]) => {
      flat[`gems_nodes.${treeName}_level`] = state.level || 0;
      (state.nodes || []).forEach((on, i) => { flat[`gems_nodes.${treeName}_gem${i + 1}`] = on ? 1 : 0; });
      Object.entries(state.upgrades || {}).forEach(([k, v]) => { flat[`gems_nodes.${treeName}_${k}`] = v || 0; });
    });
    return flat;
  }

  async function generateBuildCode(hunter, buildData, hunterStats, globalUpgrades, gems) {
    const names = CODE_PARAMS[hunter];
    if (!names) throw new Error(`Unknown hunter: ${hunter}`);
    const baseStatKeys = global.HUNTER_DEFS[hunter].baseStatKeys;
    const flatUpgrades = buildFlatUpgrades(globalUpgrades, gems);
    const levels = names.map((name) => extractParamValue(name, buildData, hunterStats, flatUpgrades, baseStatKeys));
    const kind = HUNTER_TYPE_CODE[hunter];
    const header = [0x65, (kind << 5) | (0 & 7)];
    const bytes = new Uint8Array(header.concat(packLevels(levels)));
    return base58Encode(bytes);
  }

  async function parseBuildCode(code) {
    const bytes = base58Decode(code.trim());
    if (bytes.length < 2 || bytes[0] !== 0x65) return null;
    const kind = bytes[1] >> 5;
    const hunter = HUNTER_BY_CODE[kind];
    if (!hunter) return null;
    const levels = unpackLevels(bytes);
    const names = CODE_PARAMS[hunter];
    const def = global.HUNTER_DEFS[hunter];
    const CODE_ONLY_TALENTS = { borge: ['ultima'], ozzy: ['ultima'], knox: ['ultima'] };
    const talentIds = new Set([...def.talents.map((t) => t.id), ...(CODE_ONLY_TALENTS[hunter] || [])]);
    const attrIds = new Set(def.attributes.map((a) => a.id));
    const baseStatKeys = new Set(def.baseStatKeys);

    const build = {
      hunterId: hunter, hunter, name: `${hunter[0].toUpperCase()}${hunter.slice(1)} Import`,
      level: 1, talents: {}, attributes: {}, overrides: {}, upgradeOverrides: {},
    };
    let sawLvlParam = false;
    levels.forEach((value, i) => {
      if (i >= names.length) return;
      const name = names[i];
      // "lvl" was falling through every branch below (it's not a base stat/talent/attribute/
      // upgrade key) and getting silently dropped, so every imported build kept the
      // newDraftBuild() default of level 1 no matter what level was actually encoded.
      if (name === 'lvl') { sawLvlParam = true; build.level = value || 1; return; }
      if (baseStatKeys.has(name)) { build.overrides[name] = value; return; }
      if (talentIds.has(name)) { build.talents[name] = value; return; }
      if (attrIds.has(name)) { build.attributes[name] = value; return; }
      if (name.startsWith('upgrades.') && value) { build.upgradeOverrides[name] = value; }
    });
    // No hunter's CODE_PARAMS table actually includes "lvl" -- share codes never encode
    // level directly -- so build.level silently stayed at the newDraftBuild() default of 1
    // for every import regardless of the account's real level. Confirmed against the live
    // site itself (which visibly displays the correct level right after import, e.g. a
    // Borge build whose talents summed to 41 showed "Level 41"): talentBudgetForLevel is the
    // identity function (1 talent point per level) for every hunter, so the level is
    // recoverable by summing the imported talent levels, assuming the account spent every
    // available talent point (true for any real, actively-played account). This matters more
    // for some hunters than others -- Borge/Ozzy's loot formula barely reacts to the "lvl"
    // wasm argument on its own (their computed stats already carry level's effect), but
    // Knox's does noticeably (confirmed empirically: a real Knox build's Loot Score was ~2-4%
    // off with level stuck at 1 vs. its real level).
    if (!sawLvlParam) {
      const talentPointsSpent = Object.values(build.talents).reduce((sum, v) => sum + (v || 0), 0);
      if (talentPointsSpent > 0) build.level = talentPointsSpent;
    }
    return build;
  }

  global.generateBuildCode = generateBuildCode;
  global.parseBuildCode = parseBuildCode;
})(typeof window !== 'undefined' ? window : globalThis);
