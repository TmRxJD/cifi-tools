'use strict';
const H = require('./harness.js');
const Space = H.Space;

(async () => {
  const sb = H.browserSandbox();
  const d = H.hunterDefs().borge;
  const ctx = { gemPlannerStore: { gemStates: {} }, buildOverrides: {} };
  const talents = sb.resolveMaxLevels(d.talents.filter((t) => !t.advanced), ctx);
  const attrs = sb.resolveMaxLevels(d.attributes, ctx);

  const under = { revival: 2, loth: 5, ua: 5, impeccable: 10, omen: 0, ll: 0, pog: 15, tfow: 9 };
  const attrAlloc = { ares: 30, ylith: 3, spartan: 6, timeless: 5, baal: 4, sensors: 6, htb: 3,
    lfin: 9, exp: 6, atlas: 4, weak: 6, battle: 0, mino: 12, hermes: 0, athena: 0 };

  const cfg = {
    hunter: 'borge', level: 58, hunterStats: {}, globalUpgrades: {},
    gemPlannerStore: { gemStates: {} }, baseOverrides: {},
    TALENTS: talents, ATTRIBUTES: attrs,
    ATTRIBUTE_DEPENDENCIES: d.attributeDependencies, ATTRIBUTE_MIN_VALUE: d.attributeMinValue,
    TALENT_BUDGET: 58, ATTRIBUTE_BUDGET: Space.costOf(attrs, attrAlloc),
    currentTalents: under, currentAttrs: attrAlloc,
  };
  console.log(`incumbent talents: ${Space.costOf(talents, under)}/58`);

  const scorer = await H.makeScorer(cfg, 'loot');
  const res = await H.Optimizer.optimize(cfg, { mode: 'loot', scorer });
  const spentT = Space.costOf(talents, res.best.talentAlloc);
  const spentA = Space.costOf(attrs, res.best.attrAlloc);
  console.log(`result talents  : ${spentT}/58   attributes: ${spentA}/${cfg.ATTRIBUTE_BUDGET}`);
  console.log(`result alloc    : ${JSON.stringify(res.best.talentAlloc)}`);
  console.log(spentT < 57 ? '\n>>> REPRODUCED: the optimizer returned an under-spent talent build' : '\nfully spent');
  console.log('ranked finalists (talent spend):', res.ranked.slice(0, 6).map((r) => Space.costOf(talents, r.talentAlloc)).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
