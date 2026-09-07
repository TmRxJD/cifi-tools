'use strict';
// WHAT, EXACTLY, SEPARATES OUR BUILD FROM A BOSS-KILLING ONE? A diagnosis, not a mechanism.
//
//   node tools/bench/boss-barrier-probe.js --only=borge@73
//
// WHY THIS EXISTS. Six mechanisms have been tried on the boss cliff (FI-MAP-Elites, bet-and-run,
// OCBA, a boss-damage descriptor axis, cross-seeding, corpus donors + VND) and every one was chosen
// before the barrier was measured. This measures the barrier. It produces facts about the build
// whichever way it comes out, and those facts CONSTRAIN which mechanisms are admissible at all.
//
// STEP 1 -- does a boss-KILLING structure exist among the corpus donors, after refit?
//   Every legal donor refit is evaluated and its bossKillRate recorded. Two opposite outcomes,
//   two opposite fixes:
//     some refits kill  -> the search DISCARDS killers; the defect is selection/objective.
//     no refit kills    -> refit itself destroys the killing property (it rescales the donor's
//                          largest node, which may be exactly what the kill depends on).
//
// STEP 2 -- how WIDE is the barrier?
//   Walk a minimal single-point path from our build to the import, evaluating every intermediate.
//   Reports: how many coordinated point-moves before bossKillRate leaves 0, how deep the loot
//   valley gets, and whether kill rate rises gradually or in one step.
//   If the crossing needs many simultaneous moves, NO pairwise or chunked local search can cross
//   it and that whole family should stop being proposed. If it needs few, the failure is selection.
//
// Legality comes from measurement.js -- caps, dependency edges, TIER THRESHOLDS and budget, with a
// cross-check against the shipped predicate. The first version of this probe hand-rolled that and
// omitted thresholds, so it accepted a refit that funded Borge's atlas/mino/athena without paying
// their 75/150/180 gates, scored it at -0.02% against the import, and produced a confident
// "borge@73 has no barrier" that was simply false. An illegal intermediate makes the whole path
// meaningless, and a second legality implementation is a second thing to get wrong.
//
// NOISE FLOOR: FINAL_ITERATIONS carries ~0.12% mean error, so a loot difference under ~0.3% is not
// a difference. bossKillRate is a rate in [0,100] and is read as a threshold indicator, not
// compared at fine resolution. No PRNG here: donor order and path order are fixed.

const H = require('./harness.js');
const M = require('./measurement.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@73');
const ITERS = Number(opt('iters', 1000));
if (!ONLY) throw new Error('--only= is required');

function capOf(d) { return d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel; }

function refit(defs, budget, donor) {
  const alloc = {};
  for (const d of defs) alloc[d.id] = Math.min(donor[d.id] || 0, capOf(d));
  const cost = () => H.Space.costOf(defs, alloc);
  let dump = null;
  for (const d of defs) {
    const v = (alloc[d.id] || 0) * (d.cost || 1);
    if (!dump || v > (alloc[dump.id] || 0) * (dump.cost || 1)) dump = d;
  }
  if (!dump) return null;
  let g = 100000;
  while (cost() > budget && (alloc[dump.id] || 0) > 0 && g-- > 0) alloc[dump.id] -= 1;
  while (cost() + (dump.cost || 1) <= budget && g-- > 0) {
    if ((alloc[dump.id] || 0) + 1 > capOf(dump)) break;
    alloc[dump.id] += 1;
  }
  if (cost() > budget) return null;
  for (const d of defs) if ((alloc[d.id] || 0) > capOf(d)) throw new Error(`refit broke cap on ${d.id}`);
  return alloc;
}

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  const fx = H.findFixture(known, ONLY);
  const build = await H.parseBuildCode(fx.code, fx.hunter);
  const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
  const mode = fx.mode || 'loot';
  const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};

  // LEGALITY COMES FROM THE ONE CANONICAL CHECKER, NOT A LOCAL COPY.
  //
  // The first version of this probe hand-rolled caps + edges + budget and OMITTED TIER THRESHOLDS.
  // Borge's atlas/weak/battle need 75 cost-weighted points below them, mino/hermes 150, athena 180.
  // A donor refit that funded all of them without paying the gates was therefore accepted, scored
  // -0.02% against the import, and produced a confident "borge@73 has no barrier" -- which was
  // wrong, and contradicted the bench that DID check thresholds. A second legality implementation
  // is a second thing to get wrong; there is now exactly one.
  const legalPair = (t, a) => M.legalityOf(H, cfg, t, a).ok;

  const imp = await H.evaluateAllocation(cfg, build.talents, build.attributes, ITERS);
  console.log(`${ONLY}  budgets talents ${cfg.TALENT_BUDGET} attrs ${cfg.ATTRIBUTE_BUDGET}  mode ${mode}`);
  console.log(`IMPORT   loot ${imp.loot.toFixed(0).padStart(12)}  kill ${(imp.bossKillRate || 0).toFixed(1).padStart(5)}  maxStage ${(imp.maxStage || 0).toFixed(1)}`);
  console.log('');

  // ---- STEP 1: does any legal donor refit KILL? -------------------------------------------------
  console.log('STEP 1 -- boss kill rate of every legal donor refit');
  const donors = flat.filter((f) => f.hunter === fx.hunter && (f.mode || 'loot') === mode && f.uid !== fx.uid);
  const rows = [];
  for (const d of donors) {
    let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
    const t = refit(cfg.TALENTS, cfg.TALENT_BUDGET, db.talents);
    const a = refit(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, db.attributes);
    if (!t || !a || !legalPair(t, a)) continue;
    const r = await H.evaluateAllocation(cfg, t, a, ITERS);
    rows.push({ from: d.name || d.uid, kill: r.bossKillRate || 0, loot: r.loot, stage: r.maxStage || 0, t, a });
  }
  if (!rows.length) { console.log('  NO LEGAL DONORS -- cannot measure'); process.exit(1); }
  const killers = rows.filter((r) => r.kill > 0).sort((x, y) => y.kill - x.kill);
  const best = [...rows].sort((x, y) => y.loot - x.loot)[0];
  console.log(`  ${rows.length} legal refits, ${killers.length} of them KILL a boss`);
  for (const k of killers.slice(0, 8)) {
    console.log(`    kill ${k.kill.toFixed(1).padStart(5)}  loot ${k.loot.toFixed(0).padStart(12)}  stage ${k.stage.toFixed(1).padStart(6)}  from ${k.from}`);
  }
  console.log(`  highest-LOOT refit: kill ${best.kill.toFixed(1)}  loot ${best.loot.toFixed(0)}  from ${best.from}`);
  console.log('');
  console.log(killers.length
    ? '  => a killing structure SURVIVES refit. If the search returns a non-killer, it is DISCARDING'
      + ' killers, and the defect is selection/objective -- not reachability.'
    : '  => NO refit kills. The corpus killers lose the property when rescaled, so refit itself is'
      + ' the suspect: it dumps the budget difference into the donor largest node.');
  console.log('');

  // ---- STEP 2: how wide is the barrier? ---------------------------------------------------------
  // Walk from the highest-loot NON-killing refit toward the import, one point at a time, always
  // reducing the largest remaining difference. Every intermediate is legality-checked.
  console.log('STEP 2 -- minimal single-point path from the best non-killer to the import');
  const start = { t: { ...best.t }, a: { ...best.a } };
  const goalT = build.talents; const goalA = build.attributes;
  const diffCount = (cur, goal, defs) => defs.reduce((n, d) => n + Math.abs((cur[d.id] || 0) - (goal[d.id] || 0)), 0);
  let cur = start;
  let step = 0;
  let firstKillStep = null;
  let minLoot = Infinity;
  const startLoot = best.loot;
  const total = diffCount(cur.t, goalT, cfg.TALENTS) + diffCount(cur.a, goalA, cfg.ATTRIBUTES);
  console.log(`  total point-differences to close: ${total}`);
  for (let guard = 0; guard < 400; guard++) {
    // pick the single largest remaining discrepancy and move ONE point toward the goal
    let bestMove = null;
    for (const [defs, key, goal] of [[cfg.ATTRIBUTES, 'a', goalA], [cfg.TALENTS, 't', goalT]]) {
      for (const d of defs) {
        const delta = (goal[d.id] || 0) - (cur[key][d.id] || 0);
        if (delta === 0) continue;
        const mag = Math.abs(delta);
        if (!bestMove || mag > bestMove.mag) bestMove = { defs, key, id: d.id, dir: Math.sign(delta), mag };
      }
    }
    if (!bestMove) break;
    const next = { t: { ...cur.t }, a: { ...cur.a } };
    next[bestMove.key][bestMove.id] = (next[bestMove.key][bestMove.id] || 0) + bestMove.dir;
    // Keep the allocation affordable by taking/giving a point at the node most over/under goal.
    const defs = bestMove.defs; const key = bestMove.key; const goal = bestMove.key === 'a' ? goalA : goalT;
    const budget = key === 'a' ? cfg.ATTRIBUTE_BUDGET : cfg.TALENT_BUDGET;
    let guard2 = 200;
    while (H.Space.costOf(defs, next[key]) > budget && guard2-- > 0) {
      let over = null;
      for (const d of defs) {
        const ex = (next[key][d.id] || 0) - (goal[d.id] || 0);
        if (ex > 0 && (!over || ex > over.ex)) over = { id: d.id, ex };
      }
      if (!over) break;
      next[key][over.id] -= 1;
    }
    if (!legalPair(next.t, next.a)) { cur = next; step++; continue; }
    const r = await H.evaluateAllocation(cfg, next.t, next.a, ITERS);
    step++;
    if (r.loot < minLoot) minLoot = r.loot;
    if (firstKillStep === null && (r.bossKillRate || 0) > 0) {
      firstKillStep = step;
      console.log(`  step ${String(step).padStart(3)}: FIRST KILL  kill ${(r.bossKillRate || 0).toFixed(1)}  loot ${r.loot.toFixed(0)}  stage ${(r.maxStage || 0).toFixed(1)}`);
    }
    if (step % 10 === 0 || step <= 3) {
      console.log(`  step ${String(step).padStart(3)}: kill ${(r.bossKillRate || 0).toFixed(1).padStart(5)}  loot ${r.loot.toFixed(0).padStart(12)}  stage ${(r.maxStage || 0).toFixed(1).padStart(6)}  remaining ${diffCount(next.t, goalT, cfg.TALENTS) + diffCount(next.a, goalA, cfg.ATTRIBUTES)}`);
    }
    cur = next;
  }
  console.log('');
  console.log(`  first kill appeared at step ${firstKillStep === null ? 'NEVER' : firstKillStep} of ${step}`);
  console.log(`  deepest loot along the path ${minLoot.toFixed(0)} vs start ${startLoot.toFixed(0)} and import ${imp.loot.toFixed(0)}`);
  const valley = 100 * (minLoot - Math.min(startLoot, imp.loot)) / Math.min(startLoot, imp.loot);
  console.log(`  valley depth relative to the lower endpoint: ${valley.toFixed(1)}%`);
  console.log('');
  console.log('READ THIS AS: if the first kill needs many coordinated moves AND the path dips well');
  console.log('below both endpoints, no pairwise or chunked local search can cross it -- stop');
  console.log('proposing them. If it needs few moves, the search can reach it and the defect is');
  console.log('selection. REPORT -- it prescribes nothing on its own.');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
