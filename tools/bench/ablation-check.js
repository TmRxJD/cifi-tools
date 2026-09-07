'use strict';
// WHICH PARTS OF THIS ACTUALLY EARN THEIR KEEP? Turn each one off and measure.
//
//   node tools/bench/ablation-check.js --only=borge@73,knox@30,borge@42
//
// WHY. The method is now: corpus donors -> tiered (gate-aware) refit -> ordered VND climb. Three of
// those were measured to matter; the rest were assumed. This project's whole recent history is
// mechanisms stacked without ablation, so before anything ships, each part is removed in turn and
// the cost is measured. A component that costs nothing to remove is removed.
//
// ARMS
//   full        donors + tiered refit + VND (chunked, ordered)      -- the candidate
//   naive-refit donors + NAIVE refit + VND                          -- is gate-awareness needed?
//   no-climb    donors + tiered refit, no VND                       -- is the climb needed?
//   single-pt   donors + tiered refit + VND with N_1 only           -- are chunked moves needed?
//   flat-start  NO corpus: canonical fill + VND                     -- is the corpus needed?
//   top1        donors + tiered refit + VND, only the best donor    -- is top=3 needed?
//   gated-flat  NO corpus: GATE-PAYING fill (breadth) + VND         -- can the corpus be replaced?
//   gated-deep  NO corpus: GATE-PAYING fill (concentrated) + VND    -- same, biased to depth
//
// THE PARKED EXPERIMENT -- the one that decides whether this generalises. Run it when there is
// budget for ~20 minutes of compute:
//
//   node tools/bench/ablation-check.js --only=borge@73,knox@30 --maxevals=3000 \
//        --arms=gated-flat,gated-deep,full
//
// WHAT IT SETTLES. The corpus measured "essential" (flat-start: borge@73 -42.90%, knox@30 -84.13%,
// kill 0.0 on both), but that is a property of the FILL, not of the corpus: `canonicalFill` spreads
// points evenly and so never accumulates the 75/150/180 cost-weighted points that unlock the gated
// nodes where the boss damage lives, leaving every climb outside the kills-boss regime. The donors
// were only ever useful because they already pay those gates -- which is also why excluding donors
// within 5 levels collapses borge@73 to -41.09% and knox@30 to -84.13%.
//   If gated-flat or gated-deep reaches the boss regime, the corpus dependency and the band=5
//   collapse both disappear, and the method becomes general instead of an interpolator.
//   If neither does, the corpus is supplying something beyond gate payment, and THAT is the next
//   thing to identify -- rather than reaching for another metaheuristic.
//
// Every arm is judged at the same fidelity on the fixture's own mode, every winner is checked for
// legality and full spend, and the delta is measured against the community build. A result WORSE
// than the community build is called out explicitly: the product bar is that the sim must never be
// measurably worse than a build a player already has.
//
// Deterministic: no PRNG in any arm. Budget is an EVALUATION COUNT, never wall clock -- a
// time-based stop made an identical configuration return +78.80% and +62.72% earlier in this work.

const H = require('./harness.js');
const M = require('./measurement.js');
const R = require('./refit.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const MAX_EVALS = Number(opt('maxevals', 3000));
const ITERS = 1000;
const ARMS = (opt('arms', 'full,naive-refit,no-climb,single-pt,top1')).split(',');
if (!ONLY) throw new Error('--only= is required; name exact fixtures');

function capOf(d) { return d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel; }

async function runArm(H2, cfg, mode, build, arm, pooled) {
  const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
  const legal = (t, a) => M.legalityOf(H, cfg, t, a).ok;
  let evals = 0;
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  const fxUid = build.__uid;

  // ---- candidate structures ---------------------------------------------------------------
  let cands = [];
  if (arm === 'prior') {
    // A STATISTICAL PRIOR OVER THE WHOLE CORPUS, NOT A NEAREST NEIGHBOUR.
    //
    // Three rule-based constructions were falsified -- gate-paying fill (-46.32%/-84.47%),
    // exhaustive enumeration of all 360 supports (-45.20%/-84.17%), and enumeration with the
    // remainder concentrated (-46.36%/-88.17%). All legal, all correctly gated, all kill 0.0.
    // What they cannot know is which nodes are worth CAPPING: knox@30's winner holds `dead` at its
    // cap of 10 and `sear` at 5, while a cost-and-gate rule leaves both at 1.
    //
    // That knowledge is in the corpus, and it is not neighbour-specific: across all 35 Knox builds
    // from level 12 to 40, dead=10 and sear=5 and spa=1 and pl=1 are near-invariant. Taking the
    // MEDIAN of every node across every donor gives a synthetic build carrying that knowledge
    // without copying any one neighbour -- which is the part that should survive a band=5
    // exclusion and work at a level the corpus does not cover at all.
    const donors = flat.filter((f) => f.hunter === build.__hunter && (f.mode || 'loot') === mode && f.uid !== fxUid);
    const attrVals = {}; const talVals = {};
    for (const d of donors) {
      let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
      for (const def of cfg.ATTRIBUTES) (attrVals[def.id] = attrVals[def.id] || []).push(db.attributes[def.id] || 0);
      for (const def of cfg.TALENTS) (talVals[def.id] = talVals[def.id] || []).push(db.talents[def.id] || 0);
    }
    const median = (xs) => {
      if (!xs || !xs.length) return 0;
      const v = [...xs].sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    const medAttrs = {}; for (const def of cfg.ATTRIBUTES) medAttrs[def.id] = median(attrVals[def.id]);
    const medTalents = {}; for (const def of cfg.TALENTS) medTalents[def.id] = median(talVals[def.id]);
    // Re-fit the synthetic median to THIS build's budget with the same gate-aware refit the donor
    // path uses, so the only difference from `full` is where the shape came from.
    const a = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, medAttrs);
    const t = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, medTalents);
    if (!a || !t || !legal(t, a)) return null;
    cands = [{ t, a, from: 'corpus-median' }];
  } else if (arm === 'enumerate' || arm === 'enum-conc') {
    // NO CORPUS, AND NOT ONE STARTING POINT BUT ALL OF THEM.
    //
    // `enumerateSupports` is exact, exhaustive and cheap -- it has always been in this codebase and
    // was never the weak link. What was broken is the FILL: `canonicalFill` spreads points evenly
    // and never accumulates the 75/150/180 cost-weighted points that unlock the gated nodes where
    // the boss damage lives, so every archive start sat outside the kills-boss regime.
    //
    // Pairing the enumeration with the gate-paying fill gives 360 legal starting points on
    // borge@73 (of 361 supports), 288 on ozzy@43, 144 on knox@30 -- 4-5x what the corpus offers,
    // constructed from the rules rather than copied from a neighbour. That is the difference
    // between an optimizer and an interpolator, and it is what the band=5 collapse demands.
    //
    // Distinct from gated-flat/gated-deep, which build ONE fill over all attributes. A failure
    // there says nothing about this: one starting point is not 360.
    const supports = H.Space.enumerateSupports(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES || {}, cfg.ATTRIBUTE_BUDGET);
    const t = {}; for (const d of cfg.TALENTS) t[d.id] = 0;
    let guardT = 100000; let addedT = true;
    while (addedT && guardT-- > 0) {
      addedT = false;
      for (const d of cfg.TALENTS) {
        if ((t[d.id] || 0) >= capOf(d)) continue;
        if (H.Space.costOf(cfg.TALENTS, t) + (d.cost || 1) > cfg.TALENT_BUDGET) continue;
        t[d.id] += 1; addedT = true;
      }
    }
    const shaped = [];
    for (const s of supports) {
      const ids = new Set(s.ids || s);
      const restricted = cfg.ATTRIBUTES.filter((d) => ids.has(d.id));
      if (!restricted.length) continue;
      const partial = R.gatePayingFill(restricted, minVal, cfg.ATTRIBUTE_BUDGET,
        { deps: cfg.ATTRIBUTE_DEPENDENCIES || {}, concentrate: arm === 'enum-conc' });
      if (!partial) continue;
      const a = {}; for (const d of cfg.ATTRIBUTES) a[d.id] = partial[d.id] || 0;
      if (!legal(t, a)) continue;
      shaped.push({ t, a, from: 'enum', pair: { talentAlloc: t, attrAlloc: a } });
    }
    if (!shaped.length) return null;
    const scored = await pooled.score(shaped.map((x) => x.pair), ITERS);
    evals += shaped.length;
    shaped.forEach((x, i) => { x.v = scored[i]; });
    shaped.sort((x, y) => y.v - x.v);
    cands = shaped.slice(0, 1);
  } else if (arm === 'gated-flat' || arm === 'gated-deep') {
    // NO CORPUS AT ALL. The corpus measured "essential" only because its donors already pay the
    // tier gates -- a flat canonical fill never accumulates the 75/150/180 cost-weighted points
    // that unlock the gated nodes where the boss damage lives, so the climb starts outside the
    // kills-boss regime and cannot cross (borge@73 -42.90%, knox@30 -84.13%, kill 0.0 both).
    // These arms build the same shape from the RULES instead of copying a neighbour. If either
    // reaches the boss regime, the corpus dependency -- and with it the band=5 collapse -- is gone.
    const a = R.gatePayingFill(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, { deep: arm === 'gated-deep', deps: cfg.ATTRIBUTE_DEPENDENCIES || {} });
    const t = {}; for (const d of cfg.TALENTS) t[d.id] = 0;
    let guardT = 100000; let addedT = true;
    while (addedT && guardT-- > 0) {
      addedT = false;
      for (const d of cfg.TALENTS) {
        if ((t[d.id] || 0) >= capOf(d)) continue;
        if (H.Space.costOf(cfg.TALENTS, t) + (d.cost || 1) > cfg.TALENT_BUDGET) continue;
        t[d.id] += 1; addedT = true;
      }
    }
    if (!a || !legal(t, a)) return null;
    cands = [{ t, a, from: arm }];
  } else if (arm === 'flat-start') {
    // No corpus at all: the canonical round-robin fill over every node, which is what the shipped
    // archive seeds from.
    const a = {}; for (const d of cfg.ATTRIBUTES) a[d.id] = 0;
    const t = {}; for (const d of cfg.TALENTS) t[d.id] = 0;
    let guard = 100000;
    let added = true;
    while (added && guard-- > 0) {
      added = false;
      for (const d of cfg.ATTRIBUTES) {
        if ((a[d.id] || 0) >= capOf(d)) continue;
        if (H.Space.costOf(cfg.ATTRIBUTES, a) + (d.cost || 1) > cfg.ATTRIBUTE_BUDGET) continue;
        const nx = { ...a }; nx[d.id] += 1;
        if (!legal(t, nx)) continue;
        a[d.id] += 1; added = true;
      }
      for (const d of cfg.TALENTS) {
        if ((t[d.id] || 0) >= capOf(d)) continue;
        if (H.Space.costOf(cfg.TALENTS, t) + (d.cost || 1) > cfg.TALENT_BUDGET) continue;
        t[d.id] += 1; added = true;
      }
    }
    cands = [{ t, a, from: 'canonical-fill' }];
  } else {
    const donors = flat.filter((f) => f.hunter === build.__hunter && (f.mode || 'loot') === mode && f.uid !== fxUid);
    const shaped = [];
    for (const d of donors) {
      let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
      const t = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, db.talents);
      const a = arm === 'naive-refit'
        ? R.refitNaive(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, db.attributes)
        : R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, db.attributes);
      if (!t || !a || !legal(t, a)) continue;
      shaped.push({ t, a, from: d.name || d.uid, pair: { talentAlloc: t, attrAlloc: a } });
    }
    if (!shaped.length) return null;
    const scored = await pooled.score(shaped.map((s) => s.pair), ITERS);
    evals += shaped.length;
    shaped.forEach((s, i) => { s.v = scored[i]; });
    shaped.sort((x, y) => y.v - x.v);
    cands = shaped.slice(0, arm === 'top1' ? 1 : 3);
  }

  // ---- climb --------------------------------------------------------------------------------
  // Same trimmed ladder the tuned method uses: N1/N2/N8 produced all 16 gains across five builds,
  // the other seven produced zero while costing 25-50% of every run. Verified byte-identical.
  const NEIGHBORHOODS = arm === 'single-pt' ? [1] : [1, 2, 8];
  let best = null;
  for (const seed of cands) {
    let cur = { t: { ...seed.t }, a: { ...seed.a } };
    cur.v = (await pooled.score([{ talentAlloc: cur.t, attrAlloc: cur.a }], ITERS))[0];
    evals += 1;
    if (arm !== 'no-climb') {
      let k = 0;
      while (k < NEIGHBORHOODS.length && evals < MAX_EVALS) {
        const chunk = NEIGHBORHOODS[k];
        const moves = [];
        for (const [defs, key, budget] of [[cfg.ATTRIBUTES, 'a', cfg.ATTRIBUTE_BUDGET], [cfg.TALENTS, 't', cfg.TALENT_BUDGET]]) {
          for (const from of defs) {
            if ((cur[key][from.id] || 0) < chunk) continue;
            for (const to of defs) {
              if (to.id === from.id) continue;
              const next = { ...cur[key] };
              next[from.id] -= chunk;
              const room = Math.floor((budget - H.Space.costOf(defs, next)) / (to.cost || 1));
              const add = Math.min(room, capOf(to) - (next[to.id] || 0));
              if (add < 1) continue;
              next[to.id] = (next[to.id] || 0) + add;
              if (H.Space.costOf(defs, next) > budget) continue;
              const pair = key === 'a' ? { t: cur.t, a: next } : { t: next, a: cur.a };
              if (!legal(pair.t, pair.a)) continue;
              moves.push({ talentAlloc: pair.t, attrAlloc: pair.a });
            }
          }
        }
        if (!moves.length) { k++; continue; }
        const sc = await pooled.score(moves, ITERS);
        evals += moves.length;
        let bi = -1;
        for (let i = 0; i < sc.length; i++) if (sc[i] > cur.v + 1e-9 && (bi < 0 || sc[i] > sc[bi])) bi = i;
        if (bi < 0) { k++; continue; }
        cur = { t: moves[bi].talentAlloc, a: moves[bi].attrAlloc, v: sc[bi] };
        // top up any budget the move failed to spend
        for (const [defs, key, budget] of [[cfg.ATTRIBUTES, 'a', cfg.ATTRIBUTE_BUDGET], [cfg.TALENTS, 't', cfg.TALENT_BUDGET]]) {
          let g2 = 10000; let filled = true;
          while (filled && g2-- > 0) {
            filled = false;
            for (const d of defs) {
              if ((cur[key][d.id] || 0) >= capOf(d)) continue;
              if (H.Space.costOf(defs, cur[key]) + (d.cost || 1) > budget) continue;
              const nx = { ...cur[key] }; nx[d.id] += 1;
              const pr = key === 'a' ? { t: cur.t, a: nx } : { t: nx, a: cur.a };
              if (!legal(pr.t, pr.a)) continue;
              cur = { t: pr.t, a: pr.a, v: cur.v }; filled = true;
            }
          }
        }
        cur.v = (await pooled.score([{ talentAlloc: cur.t, attrAlloc: cur.a }], ITERS))[0];
        evals += 1;
        k = 0;
      }
    }
    if (!best || cur.v > best.v) best = cur;
  }
  if (!best) return null;
  return { best, evals };
}

(async () => {
  const known = H.loadKnownBuilds();
  const names = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`ablation -- maxevals ${MAX_EVALS}, judged at ${ITERS}, arms: ${ARMS.join(' ')}`);
  console.log('');
  const worseThanCommunity = [];

  for (const name of names) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    build.__uid = fx.uid; build.__hunter = fx.hunter;
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const imp = await M.measure({ H, cfg, mode, fidelity: ITERS, talents: build.talents, attrs: build.attributes, label: 'import' });
    console.log(`${name}  mode ${mode}  import ${imp.primary.toFixed(0)}  kill ${(imp.bossKillRate || 0).toFixed(1)}  ${imp.regime}`);

    for (const arm of ARMS) {
      const pooled = await H.makePooledScorer(cfg, mode);
      try {
        const t0 = Date.now();
        const res = await runArm(H, cfg, mode, build, arm, pooled);
        if (!res) { console.log(`  ${arm.padEnd(12)} NO CANDIDATE`); continue; }
        const m = await M.measure({ H, cfg, mode, fidelity: ITERS, talents: res.best.t, attrs: res.best.a, label: arm });
        const pct = 100 * (m.primary - imp.primary) / imp.primary;
        const spent = m.legality.fullySpent ? '' : '  UNDER-SPENT';
        const flag = pct < -M.NOISE_FLOOR_PCT ? '  <-- WORSE THAN THE COMMUNITY BUILD' : '';
        if (pct < -M.NOISE_FLOOR_PCT) worseThanCommunity.push(`${name}/${arm} ${pct.toFixed(2)}%`);
        console.log(`  ${arm.padEnd(12)} ${pct.toFixed(2).padStart(8)}%  kill ${(m.bossKillRate || 0).toFixed(1).padStart(5)}`
          + `  ${m.regime.padEnd(21)} evals ${String(res.evals).padStart(5)}  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`
          + `  legal ${m.legality.ok}${spent}${flag}`);
      } finally { await pooled.destroy(); }
    }
    console.log('');
  }

  console.log('THE PRODUCT BAR: never measurably worse than a build the player already has.');
  if (worseThanCommunity.length) {
    console.log(`  ${worseThanCommunity.length} arm/build combination(s) fail it:`);
    for (const w of worseThanCommunity) console.log(`    ${w}`);
  } else {
    console.log('  no arm was measurably worse than its community build');
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
