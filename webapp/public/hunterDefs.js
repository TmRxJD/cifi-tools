// Shared build-rule data mirroring cifi-tools.com's own definitions (extracted from its
// client bundle). Keeping this as a plain data module (not hardcoded into app.js) makes it
// easy to patch in corrections as more of the site's rules get confirmed.
window.HUNTER_DEFS = {
  borge: {
    talents: [
      { id: 'revival', label: 'Death Is My Companion', maxLevel: 2 },
      { id: 'loth', label: 'Life of the Hunt', maxLevel: 5 },
      { id: 'ua', label: 'The Unfair Advantage', maxLevel: 5 },
      { id: 'impeccable', label: 'Impeccable Impacts', maxLevel: 10 },
      { id: 'omen', label: 'The Omen Of Defeat', maxLevel: 10 },
      { id: 'll', label: 'Call Me Lucky Loot', maxLevel: 10 },
      { id: 'pog', label: 'Presence Of A God', maxLevel: 15 },
      // Real, confirmed straight from the live bundle's own talent table and params.json
      // (EVAL_PARAMS already includes "ultima" for borge/ozzy -- the wasm has always
      // supported this talent's real effect, it just was never exposed in the UI talent
      // list before). Hidden by default (see `advanced` + shouldShowAdvancedTalents in
      // app.js) until the account is high-level enough to plausibly have points in it,
      // matching the live site's own advanced-talent gating exactly.
      { id: 'ultima', label: 'The Legacy of Ultima', maxLevel: 50, advanced: true },
      { id: 'tfow', label: 'The Fires of War', maxLevel: 15 },
    ],
    attributes: [
      { id: 'ares', label: 'Soul Of Ares', cost: 1, maxLevel: Infinity },
      { id: 'ylith', label: 'Essence Of Ylith', cost: 1, maxLevel: Infinity },
      { id: 'spartan', label: 'Spartan Lineage', cost: 2, maxLevel: 6 },
      { id: 'timeless', label: 'Timeless Mastery', cost: 3, maxLevel: 5 },
      { id: 'baal', label: 'Book Of Baal', cost: 3, maxLevel: 6 },
      { id: 'sensors', label: 'Superior Sensors', cost: 2, maxLevel: 6 },
      { id: 'htb', label: 'Helltouch Barrier', cost: 2, maxLevel: 10 },
      { id: 'lfin', label: 'Lifedrain Inhaler', cost: 2, maxLevel: 10 },
      { id: 'exp', label: 'Explosive Punches', cost: 3, maxLevel: 6 },
      { id: 'atlas', label: 'The Atlas Protocol', cost: 3, maxLevel: 6 },
      { id: 'weak', label: 'Weakspot Analysis', cost: 2, maxLevel: 6 },
      { id: 'battle', label: 'Born For Battle', cost: 5, maxLevel: 3 },
      { id: 'mino', label: 'Soul Of The Minotaur', cost: 2, maxLevel: 20 },
      { id: 'hermes', label: 'Soul Of Hermes', cost: 2, maxLevel: 20 },
      { id: 'athena', label: 'Soul Of Athena', cost: 15, maxLevel: 1 },
    ],
    attributeDependencies: {
      ylith: ['ares'], baal: ['ares'], htb: ['ares'], exp: ['htb'],
      spartan: ['ylith'], timeless: ['spartan'], sensors: ['baal'], lfin: ['htb'],
      atlas: ['sensors'], weak: ['exp'], battle: ['spartan'], athena: ['battle'],
      mino: ['atlas'], hermes: ['weak'],
    },
    attributeMinValue: {
      ares: 0, ylith: 0, spartan: 0, timeless: 0, baal: 0, sensors: 0, htb: 0, lfin: 0, exp: 0,
      atlas: 75, weak: 75, battle: 75, mino: 150, hermes: 150, athena: 180,
    },
    // hp/atk/regen are uncapped (players type in whatever their in-game sheet shows);
    // the rest are capped exactly like the real site's stat display.
    // Confirmed against main.js's own Borge stat-cap table (ZO, offset ~796231).
    statCaps: {
      hp: Infinity, atk: Infinity, regen: Infinity,
      dr: 40, evade: 50, effect: 50, critchance: 100, critpower: 100, atkspeed: 100, stage: Infinity,
    },
    baseStatKeys: ['hp', 'atk', 'regen', 'dr', 'evade', 'effect', 'critchance', 'critpower', 'atkspeed', 'stage'],
    globalUpgrades: {
      relics: {
        label: 'Relics', items: [
          { id: 'r4', label: '#4 The Disk of Dawn', maxLevel: 100 },
          { id: 'r7', label: '#7 Manifestation Core: Titan', maxLevel: 100 },
          { id: 'r16', label: '#16 The Long-Range Artillery Crawler', maxLevel: 100 },
          { id: 'r19', label: '#19 The Book of Mephisto', maxLevel: 8 },
          { id: 't2r7', label: "#7 Arthur's Sword", maxLevel: 100 },
        ],
      },
      inscryptions: {
        label: 'Inscryptions', items: [
          { id: 'i3', label: 'Inscryption #3', maxLevel: 8 },
          { id: 'i4', label: 'Inscryption #4', maxLevel: 6 },
          { id: 'i11', label: 'Inscryption #11', maxLevel: 3 },
          { id: 'i13', label: 'Inscryption #13', maxLevel: 8 },
          { id: 'i14', label: 'Inscryption #14', maxLevel: 5 },
          { id: 'i23', label: 'Inscryption #23', maxLevel: 5 },
          { id: 'i24', label: 'Inscryption #24', maxLevel: 8 },
          { id: 'i27', label: 'Inscryption #27', maxLevel: 10 },
          { id: 'i44', label: 'Inscryption #44', maxLevel: 10 },
          { id: 'i60', label: 'Inscryption #60', maxLevel: 10 },
          { id: 'i80', label: 'Inscryption #80', maxLevel: 10 },
          { id: 'i84', label: 'Inscryption #84', maxLevel: 10 },
          { id: 'i87', label: 'Inscryption #87', maxLevel: 10 },
          { id: 'i88', label: 'Inscryption #88', maxLevel: 7 },
          { id: 'i89', label: 'Inscryption #89', maxLevel: 7 },
          { id: 'i91', label: 'Inscryption #91', maxLevel: 7 },
          { id: 'i103', label: 'Inscryption #103', maxLevel: 8 },
        ],
      },
      loopmods: {
        label: 'Loop Mods', items: [
          { id: 'trample', label: 'Trample: Borge', maxLevel: 1, temporary: true },
          { id: 'scavenger', label: 'Scavengers Advantage', maxLevel: 25, temporary: true },
          { id: 'stelzi', label: 'Mutual Mining Agreement', maxLevel: 8, temporary: true },
        ],
      },
      shardmilestones: { label: 'Milestones', items: [{ id: 'm0', label: '#0 The Eternal Milestone', maxLevel: Infinity }] },
      researches: {
        label: 'Researches', items: [
          { id: 'res81', label: 'Research #81', maxLevel: 6 },
          { id: 'res95', label: 'Research #95', maxLevel: 6 },
          { id: 'res105', label: 'Research #105', maxLevel: 6 },
        ],
      },
      cms: {
        label: 'Construction Milestones', items: [
          { id: 'cm46', label: 'CM #46', maxLevel: 1 , temporary: true },
          { id: 'cm47', label: 'CM #47', maxLevel: 1 , temporary: true },
          { id: 'cm48', label: 'CM #48', maxLevel: 1 , temporary: true },
          { id: 'cm51', label: 'CM #51', maxLevel: 1 , temporary: true },
          { id: 'cm53', label: 'CM #53', maxLevel: 1 , temporary: true },
          { id: 'cm54', label: 'CM #54', maxLevel: 1 , temporary: true },
          { id: 'cm57', label: 'CM #57', maxLevel: 1 , temporary: true },
          { id: 'milestoneCount', label: 'Milestone Count', maxLevel: 75 , temporary: true },
        ],
      },
      diamondspecials: {
        label: 'Diamond Specials', items: [
          { id: 'hunterloot', label: 'Hunter Loot Booster', maxLevel: 10 },
          { id: 'reviveboost', label: 'Revive Boost', maxLevel: 10 },
        ],
      },
      diamondcards: { label: 'Diamond Cards', items: [{ id: 'gaiden', label: 'Gaiden Card', maxLevel: 1 }] },
      iap: { label: 'IAP', items: [{ id: 'travpack', label: 'Traversal Pack', maxLevel: 1 }] },
      ultima: { label: 'Diamond Ultima', items: [{ id: 'ulti', label: 'Ultima Hunter Loot Rewards Boost', maxLevel: Infinity }] },
      gadgets: { label: 'Gadgets', items: [{ id: 'wrench', label: 'The Wrench of Gore', maxLevel: Infinity }] },
      trinkets: {
        label: 'Trinkets', items: [
          { id: 'last_handbook', label: "The Lost Last Manufacturer's Handbook", maxLevel: Infinity },
          { id: 'transmission_amplifier', label: 'The Pocket Directive Transmission Amplifier', maxLevel: Infinity },
          { id: 'ouro_codex', label: 'The Ouroboros Recursive Codex', maxLevel: Infinity },
        ],
      },
      // Gem bonuses are NOT edited here -- gems are one shared account-wide tree (see
      // window.GEM_TREES / the Gems page), not per-hunter. resolveParam (hunterSimBrowser.js)
      // reads them straight from state.gemPlannerStore at evaluation time.
    },
  },

  ozzy: {
    talents: [
      { id: 'revival', label: 'Death Is My Companion', maxLevel: 2 },
      { id: 'boon', label: 'Tricksters Boon', maxLevel: 1 },
      { id: 'ua', label: 'The Unfair Advantage', maxLevel: 5 },
      { id: 'needles', label: 'Thousand Needles', maxLevel: 10 },
      { id: 'omen', label: 'The Omen Of Decay', maxLevel: 10 },
      { id: 'll', label: 'Call Me Lucky Loot', maxLevel: 10 },
      { id: 'crip', label: 'Crippling Shots', maxLevel: 15 },
      { id: 'ultima', label: 'The Legacy Of Ultima', maxLevel: 50, advanced: true },
      { id: 'echo', label: 'Echo Bullets', maxLevel: 20 },
    ],
    attributes: [
      { id: 'lotl', label: 'Living Off The Land', cost: 1, maxLevel: Infinity },
      { id: 'exo', label: 'Exo Piercers', cost: 1, maxLevel: Infinity },
      { id: 'scorp', label: 'Shimmering Scorpions', cost: 3, maxLevel: 5 },
      { id: 'timeless', label: 'Timeless Mastery', cost: 3, maxLevel: 5 },
      { id: 'ibu', label: 'Wings Of Ibu', cost: 2, maxLevel: 5 },
      { id: 'exterm', label: 'Extermination Protocol', cost: 2, maxLevel: 5 },
      { id: 'snek', label: 'Soul Of Snek', cost: 3, maxLevel: 5 },
      { id: 'vect', label: 'Vectid Elixir', cost: 2, maxLevel: 10 },
      { id: 'cycle', label: 'The Cycle Of Death', cost: 3, maxLevel: 5 },
      { id: 'deal', label: 'A Deal With Death', cost: 5, maxLevel: 3 },
      { id: 'medusa', label: 'Gift Of Medusa', cost: 3, maxLevel: 5 },
      { id: 'dance', label: 'Dance Of Dashes', cost: 3, maxLevel: 4 },
      { id: 'sisters', label: 'Blessing Of The Sisters', cost: 15, maxLevel: 1 },
      { id: 'scarab', label: 'Blessing Of The Scarab', cost: 2, maxLevel: 20 },
      { id: 'cat', label: 'Blessing Of The Cat', cost: 2, maxLevel: 20 },
    ],
    attributeDependencies: {
      exo: ['lotl'], ibu: ['lotl'], scorp: ['exo'], timeless: ['exo'], exterm: ['ibu'],
      snek: ['exterm'], vect: ['exterm'], cycle: ['snek'], deal: ['cycle'], medusa: ['exterm'],
      dance: ['scorp'], sisters: ['deal'], scarab: ['medusa'], cat: ['dance'],
    },
    attributeMinValue: {
      lotl: 0, exo: 0, scorp: 0, timeless: 0, ibu: 0, exterm: 0, snek: 0, vect: 0, cycle: 0,
      deal: 90, medusa: 90, dance: 90, sisters: 180, scarab: 150, cat: 150,
    },
    statCaps: {
      hp: Infinity, atk: Infinity, regen: Infinity,
      dr: 70, evade: 40, effect: 50, multichance: 100, multipower: 100, atkspeed: 100, stage: Infinity,
    },
    baseStatKeys: ['hp', 'atk', 'regen', 'dr', 'evade', 'effect', 'multichance', 'multipower', 'atkspeed', 'stage'],
    globalUpgrades: {
      relics: { label: 'Relics', items: [{ id: 'r4', label: '#4 The Disk of Dawn', maxLevel: 100 }, { id: 'r7', label: '#7 Manifestation Core: Titan', maxLevel: 100 }, { id: 'r17', label: "#17 The Bee-gone Companion Drone", maxLevel: 100 }, { id: 't2r7', label: "#7 Arthur's Sword", maxLevel: 100 }] },
      inscryptions: {
        label: 'Inscryptions', items: [
          { id: 'i31', label: 'Inscryption #31', maxLevel: 10 },
          { id: 'i32', label: 'Inscryption #32', maxLevel: 8 },
          { id: 'i33', label: 'Inscryption #33', maxLevel: 6 },
          { id: 'i36', label: 'Inscryption #36', maxLevel: 5 },
          { id: 'i37', label: 'Inscryption #37', maxLevel: 7 },
          { id: 'i40', label: 'Inscryption #40', maxLevel: 10 },
        ],
      },
      loopmods: { label: 'Loop Mods', items: [{ id: 'scavenger2', label: 'Scavengers Advantage 2', maxLevel: 25, temporary: true }, { id: 'stelzi', label: 'Mutual Mining Agreement', maxLevel: 8, temporary: true }] },
      shardmilestones: { label: 'Milestones', items: [{ id: 'm0', label: '#0 The Eternal Milestone', maxLevel: Infinity }] },
      researches: { label: 'Researches', items: [{ id: 'res81', label: 'Research #81', maxLevel: 6 }, { id: 'res95', label: 'Research #95', maxLevel: 6 }, { id: 'res105', label: 'Research #105', maxLevel: 6 }] },
      cms: { label: 'Construction Milestones', items: [{ id: 'cm46', label: 'CM #46', maxLevel: 1, temporary: true }, { id: 'cm47', label: 'CM #47', maxLevel: 1, temporary: true }, { id: 'cm48', label: 'CM #48', maxLevel: 1, temporary: true }, { id: 'cm51', label: 'CM #51', maxLevel: 1, temporary: true }, { id: 'cm53', label: 'CM #53', maxLevel: 1, temporary: true }, { id: 'cm54', label: 'CM #54', maxLevel: 1, temporary: true }, { id: 'cm57', label: 'CM #57', maxLevel: 1, temporary: true }, { id: 'milestoneCount', label: 'Milestone Count', maxLevel: 75, temporary: true }] },
      diamondspecials: { label: 'Diamond Specials', items: [{ id: 'hunterloot', label: 'Hunter Loot Booster', maxLevel: 10 }, { id: 'reviveboost', label: 'Revive Boost', maxLevel: 10 }] },
      diamondcards: { label: 'Diamond Cards', items: [{ id: 'iridian', label: 'Iridian Card', maxLevel: 1 }] },
      iap: { label: 'IAP', items: [{ id: 'travpack', label: 'Traversal Pack', maxLevel: 1 }] },
      ultima: { label: 'Diamond Ultima', items: [{ id: 'ulti', label: 'Ultima Hunter Loot Rewards Boost', maxLevel: Infinity }] },
      gadgets: { label: 'Gadgets', items: [{ id: 'zaptron', label: 'Zaptron-533 Bio-Repair Tool', maxLevel: Infinity }] },
      trinkets: {
        label: 'Trinkets', items: [
          { id: 'last_handbook', label: "The Lost Last Manufacturer's Handbook", maxLevel: Infinity },
          { id: 'transmission_amplifier', label: 'The Pocket Directive Transmission Amplifier', maxLevel: Infinity },
          { id: 'ouro_codex', label: 'The Ouroboros Recursive Codex', maxLevel: Infinity },
        ],
      },
    },
  },

  // Knox isn't unlocked on this account, so there's no real build/account data to seed or
  // validate against (unlike Borge/Ozzy, which were checked byte-for-byte against the live
  // site). Talents/attributes/costs/dependencies below ARE confirmed real (read directly
  // from the site's Knox Build Creator dialog + main.js's ATTRIBUTE_DEPENDENCIES table).
  // Global upgrade ids are confirmed real too (from Knox's actual 91-entry EVAL_PARAMS
  // list in params.json) but every maxLevel/default here is a SAFE ASSUMPTION inferred by
  // pattern-matching Borge/Ozzy's equivalents, not a verified value -- flagged inline.
  // Knox's params.json list also includes a cluster of params (glac/quartz/tess,
  // respec, bossLootRate, iterative, and "*1"-suffixed stats like hp1/atk1/time1) that look
  // like a second-form/evolution mechanic unique to Knox. There's no data on what these do,
  // so they're deliberately left OUT of the UI and resolve to 0 (an inert no-op default)
  // rather than guessing at a UI for a mechanic that can't be verified.
  knox: {
    talents: [
      { id: 'revival', label: 'Death Is My Companion', maxLevel: 2 },
      { id: 'calyp', label: "Calypso's Advantage", maxLevel: 5 },
      { id: 'ua', label: 'The Unfair Advantage', maxLevel: 5 },
      { id: 'ghost', label: 'Ghost Bullets', maxLevel: 15 },
      { id: 'omen', label: 'The Omen Of Defeat', maxLevel: 10 },
      { id: 'll', label: 'Call Me Lucky Loot', maxLevel: 10 },
      { id: 'pog', label: 'Presence Of A God', maxLevel: 10 },
      { id: 'finish', label: 'Finishing Move', maxLevel: 15 },
    ],
    attributes: [
      { id: 'kraken', label: 'Release The Kraken', cost: 1, maxLevel: Infinity },
      { id: 'soul', label: 'Soul Amplification', cost: 1, maxLevel: 100 },
      { id: 'dead', label: 'Dead Men Tell No Tales', cost: 2, maxLevel: 10 },
      { id: 'spa', label: 'Space Pirate Armory', cost: 2, maxLevel: 50 },
      { id: 'pl', label: 'A Pirates Life for Knox', cost: 3, maxLevel: 10 },
      { id: 'time', label: 'Timeless Mastery', cost: 3, maxLevel: 5 },
      { id: 'sear', label: 'Searious Efficiency', cost: 2, maxLevel: 5 },
      { id: 'pct', label: 'Passive Charge Tank', cost: 4, maxLevel: 10 },
      { id: 'kot', label: 'King Of Torpedos', cost: 5, maxLevel: 5 },
      { id: 'fe', label: 'Fortification Elixir', cost: 2, maxLevel: 10 },
      { id: 'sop', label: 'Shield of Poseidon', cost: 3, maxLevel: 10 },
    ],
    // Confirmed real (main.js ATTRIBUTE_DEPENDENCIES/ATTRIBUTE_MIN_VALUE for Knox) --
    // notably Knox has NO min-value thresholds at all, only dependency chains.
    attributeDependencies: {
      soul: ['kraken'], dead: ['soul'], spa: ['kraken'], pl: ['spa'], time: ['pl'],
      sear: ['kraken'], pct: ['sear'], kot: ['pct'], fe: ['kraken'], sop: ['fe'],
    },
    attributeMinValue: {
      kraken: 0, soul: 0, dead: 0, spa: 0, pl: 0, time: 0, sear: 0, pct: 0, kot: 0, fe: 0, sop: 0,
    },
    // Confirmed real (main.js's Knox stat-cap table, offset ~829900).
    statCaps: {
      hp: Infinity, atk: Infinity, regen: Infinity,
      dr: 50, block: 50, effect: 50, charge: 100, chargeGain: 100, reload: 100, proj: 5, stage: Infinity,
    },
    baseStatKeys: ['hp', 'atk', 'regen', 'dr', 'block', 'effect', 'charge', 'chargeGain', 'reload', 'proj', 'stage'],
    globalUpgrades: {
      // All confirmed exact against main.js's vA table (not assumptions).
      relics: { label: 'Relics', items: [{ id: 't2r5', label: '#5 The Gorgon Eye', maxLevel: 100 }, { id: 't2r7', label: "#7 Arthur's Sword", maxLevel: 100 }] },
      inscryptions: { label: 'Inscryptions', items: [{ id: 'i105', label: 'Inscryption #105', maxLevel: 8 }] },
      gadgets: { label: 'Gadgets', items: [{ id: 'anchor', label: 'The Anchor of Ages', maxLevel: Infinity }] },
      loopmods: { label: 'Loop Mods', items: [{ id: 'stelzi', label: 'Mutual Mining Agreement', maxLevel: 8, temporary: true }] },
      researches: { label: 'Researches', items: [{ id: 'res81', label: 'Research #81', maxLevel: 6 }, { id: 'res95', label: 'Research #95', maxLevel: 6 }, { id: 'res105', label: 'Research #105', maxLevel: 6 }] },
      cms: { label: 'Construction Milestones', items: [{ id: 'cm46', label: 'CM #46', maxLevel: 1, temporary: true }, { id: 'cm47', label: 'CM #47', maxLevel: 1, temporary: true }, { id: 'cm48', label: 'CM #48', maxLevel: 1, temporary: true }, { id: 'cm51', label: 'CM #51', maxLevel: 1, temporary: true }, { id: 'cm53', label: 'CM #53', maxLevel: 1, temporary: true }, { id: 'cm54', label: 'CM #54', maxLevel: 1, temporary: true }, { id: 'cm57', label: 'CM #57', maxLevel: 1, temporary: true }, { id: 'milestoneCount', label: 'Milestone Count', maxLevel: 75, temporary: true }] },
      diamondspecials: { label: 'Diamond Specials', items: [{ id: 'hunterloot', label: 'Hunter Loot Booster', maxLevel: 10 }, { id: 'reviveboost', label: 'Revive Boost', maxLevel: 10 }] },
      iap: { label: 'IAP', items: [{ id: 'travpack', label: 'Traversal Pack', maxLevel: 1 }] },
      ultima: { label: 'Diamond Ultima', items: [{ id: 'ulti', label: 'Ultima Hunter Loot Rewards Boost', maxLevel: Infinity }] },
      trinkets: {
        label: 'Trinkets', items: [
          { id: 'last_handbook', label: "The Lost Last Manufacturer's Handbook", maxLevel: Infinity },
          { id: 'transmission_amplifier', label: 'The Pocket Directive Transmission Amplifier', maxLevel: Infinity },
          { id: 'ouro_codex', label: 'The Ouroboros Recursive Codex', maxLevel: Infinity },
        ],
      },
    },
  },
};

// Level <-> point budget relationship, confirmed against real builds (Borge lvl39 ->
// 39 talent pts / 117=3*39 attribute pts; Ozzy lvl50 -> 50 / 150=3*50): talent budget
// equals character level, attribute budget is 3x character level.
window.talentBudgetForLevel = (level) => level;
window.attributeBudgetForLevel = (level) => 3 * level;

// Gems are ONE shared account-wide tree (not per-hunter). Level caps, node counts, and
// labels below were confirmed directly against the live site (cifi-tools.com/upgrades/gems)
// by temporarily maxing Exodus/Attraction/Creation to reveal their tier-2 fields, reading
// the real labels, then reverting the account back to its original values. Only fields that
// are BOTH read by a hunter's EVAL_PARAMS (params.json) AND reachable through the live
// site's actual UI are included -- e.g. Cells Bonus/Shards Bonus/Mech Bonus Cap are real
// fields but feed other planner tools, not hunter sims, so they're intentionally excluded
// here; galvTrinketsCount depends on a separate "Trinkets" category with no UI anywhere on
// the site currently, so it's permanently unreachable (stays 0) for every player, this tool
// included.
// Gradients + per-field border colors copied verbatim from the live bundle's gem config
// objects (dO/hO/pO/fO/gO/mO/vO in index-CBtvNH_D.js) so card headers/badges/accent bars
// match pixel-for-pixel instead of approximating with Tailwind palette classes.
window.GEM_TREES = {
  // nonSimKeys/nonSimLabels/nonSimCaps: fields the live site tracks per gem tree that don't
  // feed the sim at all (pure account bookkeeping) -- confirmed directly on cifi-tools.com
  // with its "Show only Sim relevant" toggle switched OFF. Hidden by default (toggle on),
  // shown when the user asks to see everything, matching the live page exactly.
  exodus: {
    label: 'Exodus', maxLevel: 5, nodeCount: 6, upgradeKeys: [], gradient: 'linear-gradient(135deg, #5a95f5 0%, #6326f1 40%, #ec4899 100%)',
    // Confirmed directly on a real account (2026-07): Exodus actually has 7 non-sim bonus
    // fields, not the 2 (Cells/Shards Bonus) this file previously listed -- 5 more (RP/MP/AP/
    // Materials/Orbs Bonus) only appear once Exodus's own level is maxed (5/5), matching the
    // same self-gating this file's node-visibility logic in app.js was just fixed for
    // (Exodus is the one tree that gates on its OWN max level, not "3 always + 3 more once
    // Exodus is maxed" like every other tree). Border colors copied verbatim from the live
    // DOM's computed styles. nonSimUnlocks mirrors upgradeKeys' own `unlocks` convention.
    nonSimKeys: ['cells-bonus', 'shards-bonus', 'rp-bonus', 'mp-bonus', 'ap-bonus', 'materials-bonus', 'orbs-bonus'],
    nonSimLabels: {
      'cells-bonus': 'Cells Bonus', 'shards-bonus': 'Shards Bonus', 'rp-bonus': 'RP Bonus',
      'mp-bonus': 'MP Bonus', 'ap-bonus': 'AP Bonus', 'materials-bonus': 'Materials Bonus', 'orbs-bonus': 'Orbs Bonus',
    },
    nonSimCaps: {
      'cells-bonus': 999, 'shards-bonus': 999, 'rp-bonus': 999, 'mp-bonus': 999, 'ap-bonus': 999,
      'materials-bonus': 999, 'orbs-bonus': 999,
    },
    nonSimUnlocks: { 'rp-bonus': 5, 'mp-bonus': 5, 'ap-bonus': 5, 'materials-bonus': 5, 'orbs-bonus': 5 },
    nonSimFieldColors: {
      'cells-bonus': '#39ff94', 'shards-bonus': '#39d3ff', 'rp-bonus': '#ec8e34', 'mp-bonus': '#ff3842',
      'ap-bonus': '#2a47cc', 'materials-bonus': '#8b5a3c', 'orbs-bonus': '#ba88fc',
    },
  },
  temporal: {
    label: 'Temporal', maxLevel: 3, nodeCount: 6, upgradeKeys: [], gradient: 'linear-gradient(135deg, #dc2626 0%, #e67b7b 100%)',
    nonSimKeys: ['mp-bonus-lms', 'mp-bonus-ticks'],
    nonSimLabels: { 'mp-bonus-lms': 'MP Bonus (LMs)', 'mp-bonus-ticks': 'MP Bonus (Ticks)' },
    nonSimCaps: { 'mp-bonus-lms': 50, 'mp-bonus-ticks': 50 },
  },
  innovation: {
    label: 'Innovation', maxLevel: 3, nodeCount: 6, upgradeKeys: [], gradient: 'linear-gradient(135deg, #ff9900 0%, #eeb077 100%)',
    nonSimKeys: ['studies-per-study'],
    nonSimLabels: { 'studies-per-study': 'Studies per Study' },
    nonSimCaps: { 'studies-per-study': 50 },
  },
  power: { label: 'Power', maxLevel: 3, nodeCount: 6, upgradeKeys: [], gradient: 'linear-gradient(135deg, #723af5 0%, #a78bfa 100%)' },
  attraction: {
    label: 'Attraction', maxLevel: 4, nodeCount: 6, gradient: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
    upgradeKeys: ['borge-loot-bonus', 'ozzy-loot-bonus', 'knox-loot-bonus', 'catch-up-power-borge-ozzy', 'catch-up-power-knox'],
    labels: { 'borge-loot-bonus': 'Borge Loot Bonus', 'ozzy-loot-bonus': 'Ozzy Loot Bonus', 'knox-loot-bonus': 'Knox Loot Bonus', 'catch-up-power-borge-ozzy': 'Catch Up Power', 'catch-up-power-knox': 'Catch-Up Power (Knox)' },
    // Each named field only appears once Attraction's own level reaches this threshold
    // (confirmed straight from the live bundle's gem-tree config: upgrades[].unlock).
    unlocks: { 'borge-loot-bonus': 1, 'ozzy-loot-bonus': 2, 'catch-up-power-borge-ozzy': 3, 'knox-loot-bonus': 4, 'catch-up-power-knox': 4 },
    fieldColors: { 'borge-loot-bonus': '#a3f15e', 'ozzy-loot-bonus': '#a3f15e', 'catch-up-power-borge-ozzy': '#5afff7', 'knox-loot-bonus': '#a3f15e', 'catch-up-power-knox': '#5afff7' },
  },
  creation: {
    label: 'Creation', maxLevel: 4, nodeCount: 6, gradient: 'linear-gradient(135deg, #bd5a14 0%, #f5994d 100%)',
    upgradeKeys: ['borge-stat-bonus', 'ozzy-stat-bonus', 'knox-stat-bonus'],
    labels: { 'borge-stat-bonus': 'Borge Stat Bonus', 'ozzy-stat-bonus': 'Ozzy Stat Bonus', 'knox-stat-bonus': 'Knox Stat Bonus' },
    unlocks: { 'borge-stat-bonus': 4, 'ozzy-stat-bonus': 4, 'knox-stat-bonus': 4 },
    fieldColors: { 'borge-stat-bonus': '#db6579', 'ozzy-stat-bonus': '#fffb8c', 'knox-stat-bonus': '#7bf7ff' },
    nonSimKeys: ['mech-bonus-cap'],
    nonSimLabels: { 'mech-bonus-cap': 'Mech Bonus Cap' },
    nonSimCaps: { 'mech-bonus-cap': 999 },
  },
  evolution: { label: 'Evolution', maxLevel: 1, nodeCount: 6, upgradeKeys: [], gradient: 'linear-gradient(135deg, #0a3814 0%, #16752a 100%)' },
};

// Confirmed straight from the live bundle's nav config (Ld.hunters / Ld.upgradeCategories):
// each entry is gated behind a specific gem tree reaching `lvl`, and optionally a specific
// node (1-based) being toggled on. Real isUnlocked() logic: level must be >= lvl, and if
// `node` is set that node must be active -- mirrored exactly in app.js's isGemUnlocked().
window.NAV_UNLOCKS = {
  hunters: { ozzy: { gem: 'exodus', lvl: 2 }, knox: { gem: 'exodus', lvl: 4 } },
  sidebarLinks: {
    gadgets: { gem: 'exodus', lvl: 4 },
    researches: { gem: 'innovation', lvl: 2 },
    cms: { gem: 'power', lvl: 2 },
    trinkets: { gem: 'creation', lvl: 4, node: 5 },
  },
};

function defaultGemState() {
  const state = {};
  Object.entries(window.GEM_TREES).forEach(([key, tree]) => {
    const upgrades = {};
    tree.upgradeKeys.forEach((k) => { upgrades[k] = 0; });
    (tree.nonSimKeys || []).forEach((k) => { upgrades[k] = 0; });
    state[key] = { level: 0, nodes: new Array(tree.nodeCount).fill(false), upgrades };
  });
  return state;
}
window.defaultGemState = defaultGemState;

// Canonical alias -> internal-upgrades-key table for gem-tree named upgrades (loot/stat
// bonuses, Attraction's catch-up-power nodes) -- the ONE source of truth for this mapping.
// Previously duplicated three times with real risk of drifting out of sync: this same table
// verbatim in hunterSimBrowser.js's resolveParam (the actual sim-facing consumer, reading
// "upgrades.gems_nodes.<gemName>_<alias>" params), an inverted "suffix -> alias" copy
// hand-built in app.js for the Overrides-panel Cost badge, and this file's own now-deleted
// gemsToParamMap() (which had become entirely dead code -- resolveParam reads gem state
// straight from state.gemPlannerStore, gemsToParamMap's flattened-map approach was never
// actually wired into any evaluate() call path). Both real consumers now reference this one
// table instead of keeping their own copies.
window.GEM_UPGRADE_ALIASES = {
  lootBorge: 'borge-loot-bonus', lootOzzy: 'ozzy-loot-bonus', lootKnox: 'knox-loot-bonus',
  catchUp: 'catch-up-power-borge-ozzy', catchUp2: 'catch-up-power-knox',
  borgeGU: 'borge-stat-bonus', ozzyGU: 'ozzy-stat-bonus', knoxGU: 'knox-stat-bonus',
};

// Real site's resolveParam (extracted verbatim from the live bundle's worker,
// evaluationWorker-BKbzsoAA.js -- the ACTUAL function used to compute Loot Score/Stage for
// the build list, not the step-simulation visualizer) expects a NESTED `upgrades` object for
// non-gem categories (e.g. upgrades.relics.r4) and reads ALL gem data separately from a
// `gemPlannerStore.gemStates` object (see hunterSimBrowser.js resolveParam), NOT from
// `upgrades.gems`. This only builds the non-gem nested shape; pass `store.gems` directly as
// gemPlannerStore.gemStates when calling HunterSim.evaluate/compileEvaluator.
function buildNestedUpgrades(globalUpgrades) {
  const nested = {};
  Object.entries(globalUpgrades || {}).forEach(([key, val]) => {
    const dot = key.indexOf('.');
    if (dot === -1) return;
    const cat = key.slice(0, dot);
    const field = key.slice(dot + 1);
    if (!nested[cat]) nested[cat] = {};
    nested[cat][field] = val;
  });
  return nested;
}
window.buildNestedUpgrades = buildNestedUpgrades;

// Relics/Inscryptions/Loop Mods/Milestones/Researches/CMs/Diamond stuff/IAP/Gadgets are ALL
// account-wide too (confirmed: the real site's hunter-data record has ONE shared `upgrades`
// object, not one per hunter -- each hunter's sim just reads whichever subset of ids is
// relevant to it). Matching that, this merges each category's items across all three
// hunters' defs into one canonical, deduplicated list -- this is what the site's top-level
// Relics/Inscryptions/etc. sidebar pages actually show (not hunter-scoped views).
window.ALL_UPGRADE_CATEGORIES = {};
['borge', 'ozzy', 'knox'].forEach((h) => {
  const gu = window.HUNTER_DEFS[h].globalUpgrades;
  Object.entries(gu).forEach(([catKey, cat]) => {
    if (!window.ALL_UPGRADE_CATEGORIES[catKey]) window.ALL_UPGRADE_CATEGORIES[catKey] = { label: cat.label, items: [] };
    cat.items.forEach((item) => {
      if (!window.ALL_UPGRADE_CATEGORIES[catKey].items.some((i) => i.id === item.id)) {
        window.ALL_UPGRADE_CATEGORIES[catKey].items.push(item);
      }
    });
  });
});
