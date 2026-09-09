// Real per-item formula data, extracted verbatim from main.js's `vA` upgrade table and
// cross-checked against the live site's own displayed effect previews (e.g. r7 level 8 ->
// "x1.48" matches 1.05^8 exactly; i3 level 8 -> "+48" matches 6*8 exactly; m0 level 70 ->
// "x4.00" matches 1.02^70 exactly). Used ONLY to render the same effect-preview text the
// real site shows on each upgrade card -- the actual simulation always goes through the
// real WASM module (hunterSim.js), never through these formulas.
window.UPGRADE_FORMULAS = {
  'relics.r4': { type: 'linear', value: .03, effects: [{ hunter: 'Borge', stat: 'Max HP' }, { hunter: 'Ozzy', stat: 'Max HP' }] },
  'relics.r7': { type: 'exponential', value: 1.05, effects: [{ hunter: 'Borge', stat: 'Loot Reward' }, { hunter: 'Ozzy', stat: 'Loot Reward' }] },
  'relics.r16': { type: 'linear', value: .03, effects: [{ hunter: 'Borge', stat: 'ATK Power' }] },
  'relics.r17': { type: 'linear', value: .03, effects: [{ hunter: 'Ozzy', stat: 'ATK Power' }] },
  'relics.r19': { type: 'exponential', value: 2, effects: [{ hunter: 'Borge', stat: 'EXP Gained' }] },
  'relics.t2r5': { type: 'exponential', value: 1.08, effects: [{ stat: 'Loot Reward' }] },
  'relics.t2r7': { type: 'exponential', value: 1.02, effects: [{ stat: 'ATK Power' }] },

  'shardmilestones.m0': { type: 'exponential', value: 1.02, effects: [{ hunter: 'Borge', stat: 'Loot Reward' }, { hunter: 'Ozzy', stat: 'Loot Reward' }] },

  'inscryptions.i3': { type: 'flat', value: 6, effects: [{ hunter: 'Borge', stat: 'Max HP' }] },
  'inscryptions.i4': { type: 'percent', value: .65, effects: [{ hunter: 'Borge', stat: 'Crit Chance' }] },
  'inscryptions.i11': { type: 'percent', value: 2, effects: [{ hunter: 'Borge', stat: 'Effect Chance' }] },
  'inscryptions.i13': { type: 'flat', value: 1, effects: [{ hunter: 'Borge', stat: 'ATK Power' }] },
  'inscryptions.i14': { type: 'exponential', value: 1.1, effects: [{ hunter: 'Borge', stat: 'Loot Reward' }] },
  'inscryptions.i23': { type: 'seconds', value: .04, effects: [{ hunter: 'Borge', stat: 'ATK Speed' }] },
  'inscryptions.i24': { type: 'percent', value: .4, effects: [{ hunter: 'Borge', stat: 'DMG Reduction' }] },
  'inscryptions.i27': { type: 'flat', value: 24, effects: [{ hunter: 'Borge', stat: 'Max HP' }] },
  'inscryptions.i31': { type: 'percent', value: .6, effects: [{ hunter: 'Ozzy', stat: 'Effect Chance' }] },
  'inscryptions.i32': { type: 'exponential', value: 1.5, effects: [{ hunter: 'Ozzy', stat: 'Loot Reward' }] },
  'inscryptions.i33': { type: 'exponential', value: 1.75, effects: [{ hunter: 'Ozzy', stat: 'XP Reward' }] },
  'inscryptions.i36': { type: 'seconds', value: .03, effects: [{ hunter: 'Ozzy', stat: 'ATK Speed' }] },
  'inscryptions.i37': { type: 'percent', value: 1.11, effects: [{ hunter: 'Ozzy', stat: 'DMG Reduction' }] },
  'inscryptions.i40': { type: 'percent', value: .5, effects: [{ hunter: 'Ozzy', stat: 'Multistrike Chance' }] },
  'inscryptions.i44': { type: 'exponential', value: 1.08, effects: [{ hunter: 'Borge', stat: 'Loot Reward' }] },
  'inscryptions.i60': { type: 'special', value: .03, statNames: ['ATK Power', 'Max HP', 'Loot Reward'], effects: [{ hunter: 'Borge', stat: 'Multi-Power' }] },
  'inscryptions.i80': { type: 'exponential', value: 1.1, effects: [{ hunter: 'Borge', stat: 'Loot Rewards' }] },
  'inscryptions.i81': { type: 'exponential', value: 1.1, effects: [{ hunter: 'Ozzy', stat: 'Loot Rewards' }] },
  'inscryptions.i84': { type: 'percent', value: 5, effects: [{ hunter: 'Borge', stat: 'Max HP' }] },
  'inscryptions.i86': { type: 'percent', value: .2, effects: [{ hunter: 'Ozzy', stat: 'DMG Reduction' }] },
  'inscryptions.i87': { type: 'exponential', value: 1.05, effects: [{ hunter: 'Borge', stat: 'ATK Power' }] },
  'inscryptions.i88': { type: 'percent', value: .4, effects: [{ hunter: 'Borge', stat: 'Crit Chance' }] },
  'inscryptions.i89': { type: 'percent', value: .2, effects: [{ hunter: 'Borge', stat: 'Effect Chance' }] },
  'inscryptions.i91': { type: 'percent', value: .2, effects: [{ hunter: 'Borge', stat: 'DMG Reduction' }] },
  'inscryptions.i92': { type: 'percent', value: .2, effects: [{ hunter: 'Ozzy', stat: 'Effect Chance' }] },
  'inscryptions.i103': { type: 'exponential', value: 1.08, effects: [{ hunter: 'Borge', stat: 'Loot Rewards' }] },
  'inscryptions.i104': { type: 'exponential', value: 1.08, effects: [{ hunter: 'Ozzy', stat: 'Loot Rewards' }] },
  'inscryptions.i105': { type: 'exponential', value: 1.08, effects: [{ hunter: 'Knox', stat: 'Loot Rewards' }] },

  'loopmods.trample': { type: 'boolean-effect', effects: [{ hunter: 'Borge', stat: 'Enables Borge Trample Effect' }] },
  'loopmods.scavenger': { type: 'exponential', value: 1.05, effects: [{ hunter: 'Borge', stat: 'Loot Rewards' }] },
  'loopmods.scavenger2': { type: 'exponential', value: 1.05, effects: [{ hunter: 'Ozzy', stat: 'Loot Rewards' }] },
  'loopmods.stelzi': { type: 'exponential', value: 1.02, effects: [{ hunter: 'Borge', stat: 'Loot Rewards' }, { hunter: 'Ozzy', stat: 'Loot Rewards' }, { hunter: 'Knox', stat: 'Loot Rewards' }] },

  'diamondspecials.hunterloot': { type: 'linear', value: .025, effects: [{ hunter: 'Borge', stat: 'Loot Reward' }, { hunter: 'Ozzy', stat: 'Loot Reward' }, { hunter: 'Knox', stat: 'Loot Reward' }] },
  'diamondspecials.reviveboost': { type: 'seconds-neg', value: 3, effects: [{ hunter: 'Borge', stat: 'Revive Boost' }, { hunter: 'Ozzy', stat: 'Revive Boost' }, { hunter: 'Knox', stat: 'Revive Boost' }] },

  'diamondcards.gaiden': { type: 'boolean-bonuses', bonuses: [{ stat: 'Max HP', value: 1.03 }, { stat: 'ATK Power', value: 1.03 }, { stat: 'HP Regen', value: 1.03 }, { stat: 'Loot Reward', value: 1.05 }] },
  'diamondcards.iridian': { type: 'boolean-bonuses', bonuses: [{ stat: 'Max HP', value: 1.03 }, { stat: 'ATK Power', value: 1.03 }, { stat: 'HP Regen', value: 1.03 }, { stat: 'Loot Reward', value: 1.05 }] },

  'iap.travpack': { type: 'boolean-bonuses', bonuses: [{ stat: 'Borge Loot Reward', value: 1.25 }, { stat: 'Ozzy Loot Reward', value: 1.25 }, { stat: 'Knox Loot Reward', value: 1.25 }] },

  'cms.cm46': { type: 'boolean-bonuses', bonuses: [{ stat: 'Hunter Loot Rewards', value: 1.03 }] },
  'cms.cm47': { type: 'boolean-bonuses', bonuses: [{ stat: 'Hunter Loot Rewards', value: 1.02 }] },
  'cms.cm48': { type: 'boolean-bonuses', bonuses: [{ stat: 'Hunter Loot Rewards', value: 1.07 }] },
  'cms.cm51': { type: 'boolean-bonuses', bonuses: [{ stat: 'Hunter Loot Rewards', value: 1.05 }] },
  'cms.cm53': { type: 'boolean-bonuses', bonuses: [{ stat: 'Hunter Loot Rewards', value: 1.02 }] },
  'cms.cm54': { type: 'boolean-bonuses', bonuses: [{ stat: 'Hunter Loot Rewards', value: 1.02 }] },
  'cms.cm57': { type: 'boolean-bonuses', bonuses: [{ stat: 'Hunter Loot Rewards', value: 1.1 }] },
  'cms.milestoneCount': { type: 'percent', value: 1.01, effects: [{ stat: 'Attack Speed' }] },
};

// Researches: exact tier tables (level -> per-hunter multiplier), real names, real
// unlock gates -- copied verbatim from main.js.
window.RESEARCH_TIERS = {
  res81: {
    name: 'Research #81', maxLevel: 6,
    tiers: [{ borge: 1, ozzy: 1, knox: 1 }, { borge: 1.1, ozzy: 1, knox: 1 }, { borge: 1.1, ozzy: 1.1, knox: 1 }, { borge: 1.1, ozzy: 1.1, knox: 1.1 }, { borge: 1.32, ozzy: 1.1, knox: 1.1 }, { borge: 1.32, ozzy: 1.32, knox: 1.1 }, { borge: 1.32, ozzy: 1.32, knox: 1.32 }],
  },
  res95: {
    name: 'Research #95', maxLevel: 6,
    tiers: [{ borge: 1, ozzy: 1, knox: 1 }, { borge: 1.02, ozzy: 1.02, knox: 1.02 }, { borge: 1.05, ozzy: 1.05, knox: 1.05 }, { borge: 1.09, ozzy: 1.09, knox: 1.09 }, { borge: 1.15, ozzy: 1.15, knox: 1.15 }, { borge: 1.21, ozzy: 1.21, knox: 1.21 }, { borge: 1.3, ozzy: 1.3, knox: 1.3 }],
  },
  res105: {
    name: 'Research #105', maxLevel: 6,
    tiers: [{ borge: 1, ozzy: 1, knox: 1 }, { borge: 1.2, ozzy: 1, knox: 1 }, { borge: 1.2, ozzy: 1.2, knox: 1 }, { borge: 1.2, ozzy: 1.2, knox: 1.2 }, { borge: 1.56, ozzy: 1.2, knox: 1.2 }, { borge: 1.56, ozzy: 1.56, knox: 1.2 }, { borge: 1.56, ozzy: 1.56, knox: 1.56 }],
  },
};

// Gadgets: real names + tiered formula params, confirmed against live displayed values by
// temporarily leveling Exodus to 4 (then reverting) and reading The Wrench of Gore's actual
// card at levels 1/2/3/13: multiplier = (1+baseValue)^level * tierMultiplier^floor(level/tierStep).
// e.g. level 13 Loot Rewards: (1.005)^13 * 1.02^1 = 1.0878 -> matches the live "x1.088" exactly.
window.GADGET_FORMULAS = {
  wrench: { name: 'The Wrench of Gore', stats: { loot: { label: 'Loot Rewards', baseValue: .005, tierStep: 10, tierMultiplier: 1.02 }, hp: { label: 'Max HP', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 }, attack: { label: 'ATK Power', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 }, regen: { label: 'HP Regen', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 } } },
  zaptron: { name: 'Zaptron-533 Bio-Repair Tool', stats: { loot: { label: 'Loot Rewards', baseValue: .005, tierStep: 10, tierMultiplier: 1.02 }, hp: { label: 'Max HP', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 }, attack: { label: 'ATK Power', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 }, regen: { label: 'HP Regen', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 } } },
  anchor: { name: 'The Anchor of Ages', stats: { loot: { label: 'Loot Rewards', baseValue: .005, tierStep: 10, tierMultiplier: 1.02 }, hp: { label: 'Max HP', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 }, attack: { label: 'ATK Power', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 }, regen: { label: 'HP Regen', baseValue: .001, tierStep: 10, tierMultiplier: 1.02 } } },
};

function fmtMult(v) { return `x${v.toFixed(2)}`; }
function fmtSigned(v, suffix) { return `${v >= 0 ? '+' : ''}${v}${suffix || ''}`; }

// Returns [{label, value}] display lines for a given fullKey ("relics.r4") at a level,
// matching the real site's own effect-preview format as closely as possible.
// hideHunterPrefix: the live site only shows the bare stat name ("Max HP", not "Borge Max
// HP") on pages where a hunter tab already establishes context (e.g. the Inscryptions page's
// Borge/Ozzy/Knox tabs) -- the prefix is only needed where a single card can affect more
// than one hunter at once with no tab to disambiguate (e.g. Relics, which has no tabs).
function computeEffectLines(fullKey, level, hideHunterPrefix) {
  const f = window.UPGRADE_FORMULAS[fullKey];
  if (!f || level <= 0) return [];
  const prefix = (e) => (e.hunter && !hideHunterPrefix ? `${e.hunter} ${e.stat}` : e.stat);
  switch (f.type) {
    case 'linear':
      return f.effects.map((e) => ({ label: prefix(e), value: fmtMult(1 + f.value * level) }));
    case 'exponential':
      return f.effects.map((e) => ({ label: prefix(e), value: fmtMult(f.value ** level) }));
    case 'flat':
      return f.effects.map((e) => ({ label: prefix(e), value: fmtSigned(f.value * level) }));
    case 'percent':
      return f.effects.map((e) => ({ label: prefix(e), value: `${fmtSigned(+(f.value * level).toFixed(2))}%` }));
    case 'seconds':
      return f.effects.map((e) => ({ label: prefix(e), value: `-${(f.value * level).toFixed(2)}s` }));
    case 'seconds-neg':
      return f.effects.map((e) => ({ label: prefix(e), value: `-${(f.value * level).toFixed(0)}s` }));
    case 'special':
      return f.statNames.map((s) => ({ label: hideHunterPrefix ? s : `${f.effects[0].hunter} ${s}`, value: fmtMult(1 + f.value * level) }));
    case 'boolean-effect':
      return f.effects.map((e) => ({ label: hideHunterPrefix ? e.stat : `${e.hunter} ${e.stat}`, value: 'Active' }));
    case 'boolean-bonuses':
      return f.bonuses.map((b) => ({ label: b.stat, value: fmtMult(b.value) }));
    default:
      return [];
  }
}
window.computeEffectLines = computeEffectLines;

// Confirmed real formula (see GADGET_FORMULAS comment above).
function computeGadgetLines(gadgetId, level) {
  const g = window.GADGET_FORMULAS[gadgetId];
  if (!g || level <= 0) return [];
  return Object.values(g.stats).map((s) => {
    const mult = (1 + s.baseValue) ** level * s.tierMultiplier ** Math.floor(level / s.tierStep);
    return { label: s.label, value: fmtMult(mult) };
  });
}
window.computeGadgetLines = computeGadgetLines;

function computeResearchLines(id, level) {
  const r = window.RESEARCH_TIERS[id];
  if (!r) return [];
  const tier = r.tiers[Math.max(0, Math.min(level, r.maxLevel))];
  return ['borge', 'ozzy', 'knox'].map((h) => ({ label: `${h[0].toUpperCase() + h.slice(1)} Loot Reward`, value: fmtMult(tier[h]) }));
}
window.computeResearchLines = computeResearchLines;
