// Real in-game upgrade-cost formulas, extracted directly from cifi-tools.com's production
// bundle (assets/index-CBtvNH_D.js) via `fetch` + string search for the minified `iV`
// (base stat cost), `cV`/`dV` (relic cost + range sum), and `mV`/`vV`/`yV` (inscryption
// cost + range sum) functions, plus the `oD`/`sD` resource-assignment tables. Every formula
// below is a direct, un-approximated transcription -- not a guess -- verified by
// cross-checking the sums this file produces against the live "Override Costs" modal's
// displayed per-stat Cost figures for a real account build (HP Regen 120->128 = 5.20b Obs,
// Evade 35->36 = 3.55b Beh, ATK Speed 26->27 = 1.15b HBM, Inscryption #60 0->1 = 4.00b HBM).
(function (global) {
  // Each hunter has its OWN 3 stat-upgrade resources (different in-game materials, different
  // art assets) plus two resources shared account-wide: Fragments (relics) and, for
  // Borge/Ozzy, Hellish-Biomatter (inscriptions -- for Borge this doubles as its own 3rd
  // stat resource; for Ozzy it's a 4th, separate resource). Knox has no known
  // relic/inscription resource in the live bundle's cost-modal code (its override panel
  // doesn't show a priced Relics/Inscryptions section), so those are left unmodeled for Knox
  // rather than guessed. Transcribed directly from the live bundle's per-hunter resource
  // tables: `oD`/`sD` (Borge), `xD`/`_D` (Ozzy), `LD`/`ND` (Knox).
  const HUNTER_RESOURCES = {
    borge: {
      label: { mat1: 'Obsidian', mat2: 'Behlium', mat3: 'Hellish-Biomatter', frags: 'Fragments' },
      abbr: { mat1: 'Obs', mat2: 'Beh', mat3: 'HBM', frags: 'Frags' },
      baseStatResource: {
        hp: 'mat1', atk: 'mat1', regen: 'mat1',
        dr: 'mat2', evade: 'mat2', effect: 'mat2',
        critchance: 'mat3', critpower: 'mat3', atkspeed: 'mat3',
      },
      relicResource: 'frags',
      inscryptionResource: 'mat3',
    },
    ozzy: {
      label: { mat1: 'Farahite Ore', mat2: 'Galvarium', mat3: 'Vectid Crystals', hbm: 'Hellish Biomatter', frags: 'Fragments' },
      abbr: { mat1: 'Fara', mat2: 'Galv', mat3: 'Vectid', hbm: 'HBM', frags: 'Frags' },
      baseStatResource: {
        hp: 'mat1', atk: 'mat1', regen: 'mat1',
        dr: 'mat2', evade: 'mat2', effect: 'mat2',
        critchance: 'mat3', critpower: 'mat3', atkspeed: 'mat3', // stored under critchance/critpower/atkspeed keys even though the UI labels them Multistrike Chance/Power
      },
      relicResource: 'frags',
      inscryptionResource: 'hbm',
    },
    knox: {
      label: { mat1: 'Glacium', mat2: 'Aquarius Quartz', mat3: 'Tesseracts' },
      abbr: { mat1: 'Glac', mat2: 'Quartz', mat3: 'Tess' },
      baseStatResource: {
        hp: 'mat1', atk: 'mat1', regen: 'mat1',
        dr: 'mat2', evade: 'mat2', effect: 'mat2', // evade alias not used by Knox (it's "block"), kept for completeness
        block: 'mat2',
        critchance: 'mat3', critpower: 'mat3', atkspeed: 'mat3', // charge/chargeGain/reload aliases
        charge: 'mat3', chargeGain: 'mat3', reload: 'mat3',
      },
      relicResource: null, // no priced relic section found for Knox in the live bundle
      inscryptionResource: null, // ditto for inscriptions
    },
  };

  function resourceLabel(hunter, resKey) { return (HUNTER_RESOURCES[hunter] || {}).label?.[resKey] || resKey; }
  function resourceAbbr(hunter, resKey) { return (HUNTER_RESOURCES[hunter] || {}).abbr?.[resKey] || resKey; }
  function baseStatResource(hunter, key) { return (HUNTER_RESOURCES[hunter] || {}).baseStatResource?.[key] || null; }
  function relicResource(hunter) { return (HUNTER_RESOURCES[hunter] || {}).relicResource || null; }
  function inscryptionResource(hunter) { return (HUNTER_RESOURCES[hunter] || {}).inscryptionResource || null; }

  // iV(key, level, hunter): cost of buying the single next level `level` of a base stat.
  function baseStatCostAtLevel(key, level, hunter) {
    if (level <= 0) return 0;
    const n = level - 1;
    switch (key) {
      case 'hp':
        if (hunter === 'knox') { const e = Math.min(n, 110); return Math.ceil(1 * Math.pow(1.054 + 27e-5 * e, n)); }
        if (hunter === 'ozzy') { const t = Math.min(n, 130); return Math.ceil(2 * Math.pow(1.061 + 285e-6 * t, n)); }
        { const r = Math.min(n, 130); return Math.ceil(Math.pow(1.061 + 28e-5 * r, n)); }
      case 'atk':
        if (hunter === 'knox') { const e = Math.min(n, 100); return Math.ceil(2 * Math.pow(1.068 + 27e-5 * e, n)); }
        if (hunter === 'ozzy') { const t = Math.min(n, 120); return Math.ceil(3 * Math.pow(1.076 + 285e-6 * t, n)); }
        { const r = Math.min(n, 120); return Math.ceil(3 * Math.pow(1.082 + 28e-5 * r, n)); }
      case 'regen':
        if (hunter === 'knox') { const e = Math.min(n, 70); return Math.ceil(4 * Math.pow(1.09 + 27e-5 * e, n)); }
        if (hunter === 'ozzy') { const t = Math.min(n, 80); return Math.ceil(5 * Math.pow(1.11 + 285e-6 * t, n)); }
        { const r = Math.min(n, 65); return Math.ceil(6 * Math.pow(1.143 + 278e-6 * r, n)); }
      case 'dr':
        if (hunter === 'knox') {
          const t = Math.ceil(2 * Math.pow(0.008 * n + 1.12, n));
          return Math.ceil(0.9 * t * Math.pow(1.2, Math.max(n - 9, 0)) * Math.pow(1.5, Math.max(n - 19, 0)) * Math.pow(2, Math.max(n - 29, 0)) * Math.pow(3, Math.max(n - 34, 0)) * Math.pow(4, Math.max(n - 39, 0)) * Math.pow(5, Math.max(n - 44, 0)));
        }
        if (hunter === 'ozzy') {
          if (n <= 50) {
            const e = Math.ceil(3 * Math.pow(0.008 * n + 1.2, n)), t = Math.pow(2, Math.max(n - 49, 0)), r = Math.pow(3, Math.max(n - 51, 0)), i = Math.pow(4, Math.max(n - 53, 0)), a = Math.pow(5, Math.max(n - 55, 0)), o = Math.pow(6, Math.max(n - 57, 0));
            return Math.ceil(e * t * r * i * a * o);
          }
          const DR_OZZY_HIGH = { 50: 9642e7, 51: 3979e8, 52: 215e10, 53: 1175e10, 54: 906e11, 55: 70428e10, 56: 828e13, 57: 9821e13, 58: 188e16, 59: 3625e16, 60: 12e20, 61: 3996e19, 62: 242e22, 63: 14739999999999999e10, 64: 1723e25, 65: 202e28, 66: 48e31, 67: 114e33, 68: 577e35, 69: 292e38 };
          return DR_OZZY_HIGH[n] !== undefined ? Math.ceil(DR_OZZY_HIGH[n]) : undefined;
        }
        {
          const r = Math.ceil(5 * Math.pow(0.024 * n + 1.17, n)), i = Math.pow(3, Math.max(n - 34, 0)), a = Math.pow(4, Math.max(n - 35, 0)), o = Math.pow(6, Math.max(n - 36, 0)), s = Math.pow(8, Math.max(n - 37, 0)), l = Math.pow(100, Math.max(n - 38, 0));
          return Math.ceil(r * i * a * o * s * l);
        }
      case 'evade': case 'block':
        if (hunter === 'knox') {
          const e = Math.ceil(3 * Math.pow(0.028 * n + 1.18, n));
          return Math.ceil(0.9 * e * Math.pow(1.2, Math.max(n - 9, 0)) * Math.pow(1.5, Math.max(n - 19, 0)) * Math.pow(2, Math.max(n - 29, 0)) * Math.pow(3, Math.max(n - 34, 0)) * Math.pow(4, Math.max(n - 39, 0)) * Math.pow(5, Math.max(n - 44, 0)));
        }
        if (hunter === 'ozzy') {
          const t = Math.ceil(5 * Math.pow(0.028 * n + 1.3, n)), r = Math.pow(2, Math.max(n - 34, 0)), i = Math.pow(3, Math.max(n - 35, 0)), a = Math.pow(4, Math.max(n - 36, 0)), o = Math.pow(5, Math.max(n - 37, 0)), s = Math.pow(10, Math.max(n - 38, 0));
          return Math.ceil(t * r * i * a * o * s);
        }
        {
          const l = Math.ceil(Math.pow(0.015 * n + 1.23, n)), u = Math.pow(1.5, Math.max(n - 39, 0)), c = Math.pow(2, Math.max(n - 41, 0)), d = Math.pow(2.5, Math.max(n - 43, 0)), h = Math.pow(3, Math.max(n - 45, 0)), p = Math.pow(10, Math.max(n - 47, 0));
          return 10 * Math.ceil(l * u * c * d * h * p);
        }
      case 'effect':
        if (hunter === 'knox') {
          const e = Math.ceil(50 * Math.pow(0.018 * n + 1.2, n));
          return Math.ceil(0.9 * e * Math.pow(1.2, Math.max(n - 9, 0)) * Math.pow(1.5, Math.max(n - 19, 0)) * Math.pow(2, Math.max(n - 29, 0)) * Math.pow(3, Math.max(n - 34, 0)) * Math.pow(4, Math.max(n - 39, 0)) * Math.pow(5, Math.max(n - 44, 0)));
        }
        if (hunter === 'ozzy') {
          const t = Math.ceil(7 * Math.pow(0.018 * n + 1.22, n)), r = Math.pow(1.5, Math.max(n - 39, 0)), i = Math.pow(2, Math.max(n - 41, 0)), a = Math.pow(2.5, Math.max(n - 43, 0)), o = Math.pow(3, Math.max(n - 45, 0)), s = Math.pow(10, Math.max(n - 47, 0));
          return Math.ceil(t * r * i * a * o * s);
        }
        {
          const l = Math.ceil(3 * Math.pow(0.0095 * n + 1.32, n)), u = Math.pow(1.5, Math.max(n - 39, 0)), c = Math.pow(2, Math.max(n - 41, 0)), d = Math.pow(2.5, Math.max(n - 43, 0)), h = Math.pow(3, Math.max(n - 45, 0)), p = Math.pow(10, Math.max(n - 47, 0));
          return 10 * Math.ceil(l * u * c * d * h * p);
        }
      case 'critchance': case 'multichance': case 'charge':
        if (hunter === 'knox') {
          const e = Math.ceil(1 * Math.pow(0.016 * n + 1.18, n));
          return Math.ceil(0.9 * e * Math.pow(1.05, Math.max(n - 9, 0)) * Math.pow(1.05, Math.max(n - 19, 0)) * Math.pow(1.2, Math.max(n - 29, 0)) * Math.pow(1.3, Math.max(n - 39, 0)) * Math.pow(1.4, Math.max(n - 49, 0)) * Math.pow(1.5, Math.max(n - 59, 0)));
        }
        if (hunter === 'ozzy') {
          const t = Math.ceil(1 * Math.pow(0.016 * n + 1.18, n)), r = Math.pow(1.05, Math.max(n - 59, 0)), i = Math.pow(1.2, Math.max(n - 69, 0)), a = Math.pow(1.3, Math.max(n - 79, 0)), o = Math.pow(1.4, Math.max(n - 89, 0));
          return 10 * Math.ceil(t * r * i * a * o);
        }
        {
          const s = Math.ceil(5 * Math.pow(0.004 * n + 1.19, n)), l = Math.pow(1.05, Math.max(n - 59, 0)), u = Math.pow(1.2, Math.max(n - 69, 0)), c = Math.pow(1.3, Math.max(n - 79, 0)), d = Math.pow(1.4, Math.max(n - 89, 0));
          return Math.ceil(s * l * u * c * d);
        }
      case 'critpower': case 'multipower': case 'chargeGain':
        if (hunter === 'knox') {
          const e = Math.ceil(1 * Math.pow(0.025 * n + 1.35, n));
          return Math.ceil(0.9 * e * Math.pow(1.05, Math.max(n - 9, 0)) * Math.pow(1.05, Math.max(n - 19, 0)) * Math.pow(1.2, Math.max(n - 29, 0)) * Math.pow(1.3, Math.max(n - 39, 0)) * Math.pow(1.4, Math.max(n - 49, 0)) * Math.pow(1.5, Math.max(n - 59, 0)));
        }
        if (hunter === 'ozzy') {
          const t = Math.ceil(1.1 * Math.pow(0.025 * n + 1.4, n)), r = Math.pow(1.1, Math.max(n - 59, 0)), i = Math.pow(1.2, Math.max(n - 69, 0)), a = Math.pow(1.3, Math.max(n - 79, 0)), o = Math.pow(1.4, Math.max(n - 89, 0));
          return 10 * Math.ceil(t * r * i * a * o);
        }
        {
          const s = Math.ceil(8 * Math.pow(0.004 * n + 1.22, n)), l = Math.pow(1.05, Math.max(n - 59, 0)), u = Math.pow(1.2, Math.max(n - 69, 0)), c = Math.pow(1.3, Math.max(n - 79, 0)), d = Math.pow(1.4, Math.max(n - 89, 0));
          return Math.ceil(s * l * u * c * d);
        }
      case 'atkspeed': case 'reload':
        if (hunter === 'knox') {
          const e = Math.ceil(2 * Math.pow(0.035 * n + 1.24, n));
          return Math.ceil(0.9 * e * Math.pow(1.02, Math.max(n - 9, 0)) * Math.pow(1.05, Math.max(n - 19, 0)) * Math.pow(1.2, Math.max(n - 29, 0)) * Math.pow(1.3, Math.max(n - 39, 0)) * Math.pow(1.4, Math.max(n - 49, 0)) * Math.pow(1.5, Math.max(n - 59, 0)) * Math.pow(1.6, Math.max(n - 69, 0)) * Math.pow(1.7, Math.max(n - 79, 0)) * Math.pow(1.8, Math.max(n - 89, 0)));
        }
        if (hunter === 'ozzy') {
          const t = Math.ceil(1.2 * Math.pow(0.035 * n + 1.24, n)), r = Math.pow(1.06, Math.max(n - 39, 0)), i = Math.pow(1.07, Math.max(n - 49, 0)), a = Math.pow(1.08, Math.max(n - 59, 0)), o = Math.pow(1.1, Math.max(n - 69, 0));
          return 10 * Math.ceil(t * r * i * a * o);
        }
        {
          const s = Math.ceil(Math.pow(0.032 * n + 1.21, n)), l = Math.pow(1.05, Math.max(n - 39, 0)), u = Math.pow(1.06, Math.max(n - 49, 0)), c = Math.pow(1.07, Math.max(n - 59, 0)), d = Math.pow(1.08, Math.max(n - 69, 0));
          return Math.ceil(s * l * u * c * d * 10);
        }
      default:
        return 0;
    }
  }
  function baseStatCostRange(key, fromLevel, toLevel, hunter) {
    if (toLevel <= fromLevel) return 0;
    let sum = 0;
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
      const c = baseStatCostAtLevel(key, lvl, hunter);
      if (c === undefined) return undefined; // formula table ran out (e.g. DR beyond level 69 on ozzy)
      sum += c;
    }
    return sum;
  }

  // cV(relicId, level): single-level relic upgrade cost (only relics that appear in our
  // Overrides panel are transcribed: r4, r7, r16, r19; others included since they were
  // captured alongside in the same bundle function).
  function relicCostAtLevel(relicId, level) {
    if (level <= 0) return 0;
    switch (relicId) {
      case 'relic04': case 'r4': {
        const t = (0.8 + 0.4 * (level - 1)) * Math.pow(1.12, level - 1) * Math.pow(1.02, Math.max(0, level - 10)) * Math.pow(1.015, Math.max(0, level - 20));
        return level < 10 ? t : Math.floor(t);
      }
      case 'relic07': case 'r7': {
        const t = (2 + 1.8 * (level - 1)) * Math.pow(1.14, level - 1) * Math.pow(1.01, Math.max(0, level - 10)) * Math.pow(1.02, Math.max(0, level - 20));
        return Math.floor(t);
      }
      case 'relic09': case 'r9': {
        const t = (8 + 1.8 * (level - 1)) * Math.pow(1.18, level - 1) * Math.pow(1.03, Math.max(0, level - 10)) * Math.pow(1.08, Math.max(0, level - 20));
        return Math.floor(t);
      }
      case 'relic16': case 'r16': {
        const t = (40 + 5 * (level - 1)) * Math.pow(1.08, level - 1) * Math.pow(1.028, Math.max(0, level - 10));
        return Math.floor(t);
      }
      case 'relic17': case 'r17': {
        const t = (50 + 6 * (level - 1)) * Math.pow(1.1, level - 1) * Math.pow(1.037, Math.max(0, level - 10));
        return Math.floor(t);
      }
      case 'relic19': case 'r19': {
        const t = (666 + 111 * (level - 1)) * Math.pow(1.66, level - 1);
        return Math.floor(t);
      }
      case 't2r5': {
        const t = level - 1;
        let n = (13e5 + 3e5 * t) * Math.pow(1.35, t), r = 0;
        for (let i = 0; 5 * i <= t; i++) r += t - (5 * i - 1);
        n *= Math.pow(1.04, r);
        return Math.floor(n);
      }
      case 't2r7': {
        const t = level - 1;
        let n = (3e5 + 85e4 * t) * Math.pow(1.71, t);
        if (t >= 8) n *= Math.pow(1.09, t - 8 + 1);
        return Math.floor(n);
      }
      case 't2r4': {
        const t = level - 1;
        let n = (3e6 + 5e4 * t) * Math.pow(1.2, t), r = 0;
        for (let i = 0; 4 * i <= t; i++) r += t - (4 * i - 1);
        n *= Math.pow(1.08, r);
        return Math.floor(n);
      }
      case 't2r8': {
        const t = level - 1;
        let n = (21e5 + 84e4 * t) * Math.pow(1.42, t), r = 0;
        for (let i = 0; 4 * i <= t; i++) r += t - (4 * i - 1);
        n *= Math.pow(1.21, r);
        return Math.floor(n);
      }
      case 't2r10': {
        const t = level - 1;
        let n = (6e6 + 8e4 * t) * Math.pow(15, t);
        if (t >= 1) n *= Math.pow(21, t - 1 + 1);
        return Math.floor(n);
      }
      default:
        return 0;
    }
  }
  function relicCostRange(relicId, fromLevel, toLevel) {
    if (toLevel <= fromLevel) return 0;
    let sum = 0;
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) sum += relicCostAtLevel(relicId, lvl);
    return sum;
  }

  // mV (startValue/multiplier per inscription id) + vV (geometric cost at a level): cost(L)
  // = startValue * multiplier^(L-1). Table transcribed directly from the live bundle's `mV`
  // object; i3 has no entry in the live table (its cost isn't modeled by this formula on the
  // real site either -- it may be a flat/free unlock), so it's intentionally omitted rather
  // than guessed.
  //
  // i4 (Borge's Inscryption #4, visible in the UI and imported from real saves) is ALSO
  // missing here, but unlike i3 that gap was never confirmed/explained -- flagging it rather
  // than silently treating it the same as a verified free unlock. Until a real cost is
  // transcribed, baseStatCostAtLevel-style callers (inscryptionCostAtLevel) return `undefined`
  // for it, which the build-card Effective Path allocator already skips as "unpriceable"
  // rather than guessing a number.
  const INSCRYPTION_TABLE = {
    i11: { startValue: 70, multiplier: 4 }, i13: { startValue: 310, multiplier: 1.2419354838709675 },
    i14: { startValue: 600, multiplier: 1.7 }, i23: { startValue: 3200, multiplier: 1.4 },
    i24: { startValue: 3400, multiplier: 1.2 }, i27: { startValue: 35000, multiplier: 1.05 },
    i31: { startValue: 86000, multiplier: 1.3 }, i32: { startValue: 90000, multiplier: 3 },
    i33: { startValue: 91200, multiplier: 5 }, i36: { startValue: 93500, multiplier: 1.4 },
    i37: { startValue: 95000, multiplier: 1.3 }, i40: { startValue: 100000, multiplier: 1.6 },
    i44: { startValue: 777000, multiplier: 1.75 }, i52: { startValue: 3e7, multiplier: 2.4 },
    i58: { startValue: 2e9, multiplier: 5 }, i60: { startValue: 4e9, multiplier: 4 },
    i78: { startValue: 1e16, multiplier: 8 }, i80: { startValue: 3e16, multiplier: 6 },
    i81: { startValue: 4e16, multiplier: 6 }, i84: { startValue: 1e17, multiplier: 4 },
    i86: { startValue: 3e17, multiplier: 3 }, i87: { startValue: 4e17, multiplier: 8 },
    i88: { startValue: 5e17, multiplier: 3 }, i89: { startValue: 6e17, multiplier: 3 },
    i91: { startValue: 2e18, multiplier: 3 }, i92: { startValue: 3e18, multiplier: 3 },
    i101: { startValue: 1e20, multiplier: 4 }, i102: { startValue: 2e20, multiplier: 4 },
    i103: { startValue: 3e20, multiplier: 3 }, i104: { startValue: 4e20, multiplier: 3 },
    i105: { startValue: 5e20, multiplier: 3 }, i106: { startValue: 6e20, multiplier: 3 },
    i107: { startValue: 7e20, multiplier: 3 }, i108: { startValue: 8e20, multiplier: 3 },
    i109: { startValue: 9e20, multiplier: 3 }, i110: { startValue: 1e21, multiplier: 10 },
  };
  function inscryptionCostAtLevel(id, level) {
    if (level <= 0) return 0;
    const cfg = INSCRYPTION_TABLE[id];
    if (!cfg) return undefined;
    return level <= 1 ? cfg.startValue : cfg.startValue * Math.pow(cfg.multiplier, level - 1);
  }
  function inscryptionCostRange(id, fromLevel, toLevel) {
    if (toLevel <= fromLevel) return 0;
    let sum = 0;
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
      const c = inscryptionCostAtLevel(id, lvl);
      if (c === undefined) return undefined;
      sum += c;
    }
    return sum;
  }

  // Verbatim port of the live bundle's `pV` (gadget per-level cost). Only wrench/zaptron/
  // anchor are ever reachable from this app's 3 hunters, but every case is transcribed
  // as-is (g1-g14/oogadget/campfragdet included) rather than trimmed to "what we use" --
  // this is a direct copy, not a reimplementation.
  function gadgetCostAtLevel(id, level) {
    if (level <= 0) return 0;
    const t = Math.floor((level - 1) / 10);
    const e = level - 1;
    switch (id) {
      case 'g1': case 'g2': case 'g3': return Math.ceil(1 * Math.pow(1.025, e) * Math.pow(1.15, t));
      case 'oogadget': case 'g4': return Math.ceil(2 * Math.pow(1.14, e) * Math.pow(1.6, t));
      case 'wrench': case 'g5': return Math.ceil(3 * Math.pow(1.1, e) * Math.pow(1.35, t));
      case 'zaptron': case 'g6': return Math.ceil(4 * Math.pow(1.1, e) * Math.pow(1.35, t));
      case 'g7': return Math.ceil(5 * Math.pow(1.04, e) * Math.pow(1.15, t));
      case 'g8': return Math.ceil(6 * Math.pow(1.1, e) * Math.pow(1.35, t));
      case 'g9': return Math.ceil(7 * Math.pow(1.08, e) * Math.pow(1.25, t));
      case 'g10': return Math.ceil(400 * Math.pow(1.1, e) * Math.pow(1.25, t));
      case 'g11': return Math.ceil(1000 * Math.pow(1.07, e) * Math.pow(1.23, t));
      case 'g12': return Math.ceil(6e4 * Math.pow(1.28, e) * Math.pow(1.4, t));
      case 'g13': return Math.ceil(6e4 * Math.pow(1.1, e) * Math.pow(1.28, t));
      case 'campfragdet': case 'g14': return Math.ceil(6e4 * Math.pow(1.12, e) * Math.pow(1.38, t));
      case 'anchor': case 'g15': return Math.ceil(6e4 * Math.pow(1.1, e) * Math.pow(1.35, t));
      default: return 0;
    }
  }
  function gadgetCostRange(id, fromLevel, toLevel) {
    if (toLevel <= fromLevel) return 0;
    let sum = 0;
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) sum += gadgetCostAtLevel(id, lvl);
    return sum;
  }

  // Verbatim port of the live bundle's `_V` (gem-tree named-upgrade per-level cost: the
  // per-hunter loot-bonus and stat-bonus nodes, plus Attraction's catch-up-power nodes).
  function gemAliasCostAtLevel(alias, level) {
    if (level <= 0) return 0;
    const e = level - 1;
    switch (alias) {
      case 'lootBorge': return Math.floor(5 * Math.pow(2.5, e) * Math.pow(1.2, Math.max(0, e - 9)) * Math.pow(1.3, Math.max(0, e - 19)) * Math.pow(1.4, Math.max(0, e - 29)) * Math.pow(2, Math.max(0, e - 39)));
      case 'lootOzzy': return Math.floor(20 * Math.pow(2.5, e) * Math.pow(1.3, Math.max(0, e - 9)) * Math.pow(1.4, Math.max(0, e - 19)) * Math.pow(1.5, Math.max(0, e - 29)) * Math.pow(1.5, Math.max(0, e - 39)));
      case 'lootKnox': return Math.floor(12e10 * Math.pow(3, e) * Math.pow(1.2, Math.max(0, e - 9)) * Math.pow(1.3, Math.max(0, e - 19)) * Math.pow(1.4, Math.max(0, e - 29)) * Math.pow(2, Math.max(0, e - 39)));
      case 'catchUp': return Math.floor(1 * Math.pow(100, e));
      case 'catchUp2': return Math.floor(4e10 * Math.pow(100, e));
      case 'borgeGU': return Math.floor(1e11 * Math.pow(10, e));
      case 'ozzyGU': return Math.floor(1e6 * Math.pow(10, e));
      case 'knoxGU': return Math.floor(1e11 * Math.pow(10, e));
      default: return 0;
    }
  }
  function gemAliasCostRange(alias, fromLevel, toLevel) {
    if (toLevel <= fromLevel) return 0;
    let sum = 0;
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) sum += gemAliasCostAtLevel(alias, lvl);
    return sum;
  }

  // Verbatim port of the live bundle's `oV` number formatter -- costs here can run past
  // 1e21 (inscryption tiers), well beyond fmt()'s billion cap in app.js.
  const SUFFIXES = ['', 'k', 'm', 'b', 't', 'qa', 'qu', 'sx', 'sp', 'oc', 'n', 'd'];
  function fmtBig(n) {
    if (typeof n !== 'number' || Number.isNaN(n) || n === 0) return '0';
    const mag = Math.floor(Math.log10(n) / 3);
    if (mag < 0 || n < 1000) return n.toFixed(2);
    if (mag >= SUFFIXES.length) return n.toExponential(2).replace('e+', 'e');
    return `${(n / Math.pow(10, 3 * mag)).toFixed(2)}${SUFFIXES[mag]}`;
  }

  // Knox's "Projectiles Per Salvo" (proj) is a multi-currency stat: each level costs ALL
  // THREE of Knox's resources simultaneously (RD.proj.currencies in the live bundle), each
  // with its own base cost but a shared x1000-per-level multiplier (nV/rV in the live
  // bundle). Returns a per-resource cost map instead of a single number.
  const KNOX_PROJ_BASE_COST = { mat1: 80, mat2: 120, mat3: 90 };
  function projCostAtLevel(level) {
    if (level <= 0) return { mat1: 0, mat2: 0, mat3: 0 };
    const out = {};
    Object.entries(KNOX_PROJ_BASE_COST).forEach(([res, base]) => { out[res] = base * Math.pow(1000, level - 1); });
    return out;
  }
  function projCostRange(fromLevel, toLevel) {
    const total = { mat1: 0, mat2: 0, mat3: 0 };
    if (toLevel <= fromLevel) return total;
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
      const c = projCostAtLevel(lvl);
      Object.keys(total).forEach((res) => { total[res] += c[res]; });
    }
    return total;
  }

  // Collection Time (as shown in the live "Override Costs" modal) is inferred, not a stored
  // game value: it's the cost divided by how fast the account collects that resource, i.e.
  // the same per-resource "per day" rate our build cards already compute from
  // HunterSim.evaluate's r.mat1/r.mat2/r.mat3 (per-run) * runsPerDay. minutesPerDay=1440.
  function collectionTimeMinutes(cost, perDayRate) {
    if (!cost || !perDayRate) return null;
    return (cost / perDayRate) * 1440;
  }

  global.CostFormulas = {
    HUNTER_RESOURCES, resourceLabel, resourceAbbr, baseStatResource, relicResource, inscryptionResource,
    baseStatCostAtLevel, baseStatCostRange, relicCostRange, inscryptionCostAtLevel, inscryptionCostRange,
    gadgetCostRange, gemAliasCostRange, projCostRange, collectionTimeMinutes, fmtBig,
  };
})(window);
