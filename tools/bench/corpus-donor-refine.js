'use strict';
// CORPUS DONOR + DETERMINISTIC DEPTH HILL-CLIMB. The whole proposed optimizer, in miniature.
//
//   node tools/bench/corpus-donor-refine.js --only=knox@30,borge@73 [--band=0] [--top=5]
//
// Step 1: every OTHER community build, refit to this build's budget, evaluated.  (structure)
// Step 2: hill-climb the best few by moving ONE point between nodes, keeping strict improvements.
//         (depth -- the half Knox needs, since refitting knox@31 onto knox@30 gets the support
//          exactly right and the depth wrong, taking kill rate 89% -> 19.6%.)
//
// Fully deterministic: no PRNG anywhere, fixed iteration order. Same input, same answer, always.
// Leave-one-out: the target is never its own donor. --band=N also excludes nearby levels.
//
// NOISE FLOOR. Seed variance is ZERO here -- that is the point of the method, and it is why a
// difference between two runs of THIS bench is real rather than a sample. What remains is
// EVALUATION noise: FINAL_ITERATIONS carries ~0.12% mean error (worst 0.35%), so a comparison of
// two scores carries roughly 0.2-0.3%. Anything under ~0.3% is not a difference. The archive
// search this replaces additionally varied ~7 points across seeds; that term is gone.

const fs = require('fs');
const H = require('./harness.js');
const R = require('./refit.js');
const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', null);
const BAND = Number(opt('band', 0));
// ONE DONOR, NOT THREE. Ablated: top1 returns the IDENTICAL build to top3 on both borge@73
// (+2.37%) and knox@30 (+1.33%), at 780 evals/59s against 2254/156s and 751/33s against 1879/80s.
// The extra seeds cost 2-3x the runtime and changed nothing, on the two hardest builds in the set.
const TOP = Number(opt('top', 1));
const ITERS = 1000;
// DONOR SCREENING FIDELITY -- DEFAULTS TO FULL, because a cheap ruler that DISCARDS is deciding.
//
// This defaulted to 250 with a comment claiming "the cheap ruler narrows and never decides". That
// was wrong: only the top few donors survive screening, so a mis-rank at 250 iterations removes a
// donor permanently. It removed borge@74 -- the one donor whose refit reaches the boss regime --
// and the bench reported borge@73 at -38.26% with nothing killing, while the donor pool actually
// contained a killer at -19.69%.
//
// It also optimised the wrong stage: screening ~80 donors costs ~80 evaluations against ~1500 for
// the climb. That is the SAIL finding from this project's own notes -- surrogating the cheap tenth
// of the work -- repeated four hours after reading it.
const SCREEN = Number(opt('screen', 1000));
// BUDGET IS AN EVALUATION COUNT, NOT SECONDS -- AND THAT DISTINCTION IS LOAD-BEARING.
//
// It was wall-clock first, and that silently destroyed the method's one real advantage. borge@42 at
// an IDENTICAL configuration returned +78.80% and then +62.72%: the algorithm is deterministic, but
// a deadline is not, because how much gets done in 300s depends on what else the machine is doing.
// So every "same input, same answer" claim was false exactly where the budget bit -- on the Borge
// builds, which is where the numbers were largest and least checked.
//
// An evaluation cap is deterministic AND still bounds runtime, because evaluation IS the runtime
// (~87% of wall clock). `--maxevals` therefore replaces `--budget`; the seconds figure is still
// PRINTED so a regression in cost is visible, it just no longer decides anything.
// SIZED FROM MEASURED CONVERGENCE, NOT GUESSED. With top=1 the climb converges on its own well
// inside this, on every build measured -- and none of them truncated:
//     knox@30  752 evals (climb 717, last gain @495)    borge@32  489 (412, @236)
//     knox@37  463 evals (climb 430, last gain @198)    borge@42  381 (304, @125)
//     borge@73 781 evals (climb 704, last gain @415)
// So 2000 is ~2.5x the worst observed and exists only to bound a pathological case. The previous
// default was 12000 -- 15-30x actual usage -- which is not "safe", it is a cap that can never bind
// and therefore reports nothing. A budget that never fires cannot tell you the search is stuck.
//
// NOTE ON SCALING: this is an EVALUATION count, and evaluation count is driven by the search space
// (one VND sweep is O(n^2) in nodes: Borge 15 attrs + 9 talents against Knox's 11 + 8), NOT by
// level. Level multiplies the COST PER evaluation (~11ms at level 12, ~60ms at 79) and so the wall
// clock, but not how many evaluations convergence needs -- borge@73 and knox@30 converge within
// 30 evals of each other. A per-level budget table would be fitting the wrong variable.
// ADAPTIVE, AND KEYED ON THE SEARCH SPACE RATHER THAN THE LEVEL.
//
// A fixed 2000 was overfit to five builds that converged in 381-781 evals. Across all 195 fixtures
// it BINDS -- 7 Borge builds truncated, and borge@31 lost 12.3 points to it (-12.61% capped,
// -0.33% uncapped). A cap sized from a five-build sample is a sample statistic, not a bound.
//
// LEVEL IS THE WRONG VARIABLE, MEASURED. Evaluation count is driven by the SEARCH SPACE -- one VND
// sweep is O(n^2) in nodes -- not by level: borge@73 and knox@30 converge within 30 evaluations of
// each other across a 43-level gap. Level multiplies the COST PER evaluation (~11ms at level 12,
// ~60ms at 79) and therefore wall clock, but not how many evaluations convergence needs. A
// per-level table would fit the wrong axis, which is why this scales on sweep size instead.
//
// THE MULTIPLIER IS FROM THE DATA, not a round number. One sweep is roughly
// (attrs*(attrs-1) + talents*(talents-1)) * |neighborhoods|:
//     borge ~846   ozzy ~798   knox ~498
// Observed convergence: borge@73 1115 (1.3 sweeps), knox@30 752 (1.5). Worst observed need:
// borge@31 2880 (3.4 sweeps), ozzy@42 3155 (4.0). CAP_SWEEPS=8 is ~2x the worst observed, so it
// bounds a pathological case without binding on a real one -- which is the entire job of a cap.
const NEIGHBORHOOD_COUNT = (opt('neighborhoods', '1,2,8')).split(',').filter(Boolean).length;
const CAP_SWEEPS = Number(opt('capsweeps', 8));
function adaptiveMaxEvals(cfg) {
  const n = (defs) => defs.length * Math.max(1, defs.length - 1);
  const sweep = (n(cfg.ATTRIBUTES) + n(cfg.TALENTS)) * NEIGHBORHOOD_COUNT;
  return Math.max(2000, Math.round(sweep * CAP_SWEEPS));
}
// An explicit --maxevals still wins, so a bench can pin it for an A/B.
const MAX_EVALS_OVERRIDE = args.some((a) => a.startsWith('--maxevals=')) ? Number(opt('maxevals', 0)) : null;
// Cross-block pass width: pair the best JOINT attribute moves with the best JOINT talent moves
// after the block-wise VND converges. 0 = off (default, so nothing changes until measured).
const JOINT = Number(opt('joint', 0));
// Donor recombination width: cross the top-K donors' talent and attribute blocks. 0 = off.
const RECOMBINE = Number(opt('recombine', 0));
// WHICH BUDGET THE OPTIMIZER IS GIVEN, and the two modes test different things.
//
// 'spend'  -- budget = what the import actually spent. The honest apples-to-apples test of
//             ALLOCATION QUALITY, since neither side gets more points than the other.
// 'level'  -- budget from the level formula. WHAT THE APP ACTUALLY DOES.
//
// They are not interchangeable. No share code encodes `lvl`, so level is INFERRED from spend --
// which makes budget and spend identical in 'spend' mode and an under-spent build structurally
// unconstructible. This project has a documented case of exactly that blindness: an under-spend
// bug reached a user while the gate reported 182/182 "as good or better", because every fixture
// was tested in the mode where the failure cannot exist.
const BUDGET_MODE = opt('budgetmode', 'spend');
// --all sweeps every fixture; --hunter= restricts it. --only= still takes an explicit list.
// A sweep is RESUMABLE via --out=: completed builds are skipped, because this project has never
// once got a full sweep through in a single attempt.
const ALL = args.includes('--all');
const HUNTER = opt('hunter', null);
const OUT = opt('out', null);
if (!ONLY && !ALL) throw new Error('--only= or --all is required');

function capOf(d) { return d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel; }

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();
  // Sweep by UID, never by the friendly level name: `knox@35` is ambiguous across two fixtures
  // (hence knox@35b), and findFixture THROWS on an ambiguous name -- which would abort a sweep
  // partway for a reason that has nothing to do with the search.
  let names;
  let done = {};
  if (ALL) {
    names = flat.filter((f) => (!HUNTER || f.hunter === HUNTER)).map((f) => f.uid);
    if (OUT && fs.existsSync(OUT)) {
      try {
        done = JSON.parse(fs.readFileSync(OUT, 'utf8'));
        const before = names.length;
        names = names.filter((u) => !done[u]);
        console.log(`resuming ${OUT}: ${before - names.length} already done, ${names.length} to run`);
      } catch (e) { console.log(`could not read ${OUT} (${e.message}) -- starting fresh`); }
    }
  } else {
    names = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  }
  console.log(`corpus donors + deterministic depth hill-climb, band +-${BAND}, top ${TOP}, judged at ${ITERS}`);
  console.log('');

  for (const name of names) {
    const t0 = Date.now();
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: BUDGET_MODE });
    const mode = fx.mode || 'loot';
    const primary = (r) => (mode === 'push' ? r.stage : r.loot);
    const target = primary(await H.evaluateAllocation(cfg, build.talents, build.attributes, ITERS));
    let evals = 1;

    // ARGUMENT ORDER IS (defs, deps, minVal, ALLOC, BUDGET). Passing budget before alloc made
    // costOf() sum over a number (0) and isHeld() read a number as the allocation, so isLegal
    // returned TRUE UNCONDITIONALLY -- dependency legality went unchecked and a build with
    // `time 2` under `pl 0` was scored and reported as a +7.50% win. Caps and budget were checked
    // separately, which is why it looked plausible.
    //
    // The edge check below does NOT trust isLegal: it walks the declared dependency edges directly.
    // A funded child under an unfunded parent is impossible in the game, and this project has now
    // watched isLegal wave through two different illegal builds in one day.
    const edgesHold = (a) => {
      const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
      for (const child of Object.keys(deps)) {
        if ((a[child] || 0) <= 0) continue;
        for (const parent of deps[child]) if ((a[parent] || 0) <= 0) return false;
      }
      return true;
    };
    const legal = (a) => H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE, a, cfg.ATTRIBUTE_BUDGET)
      && edgesHold(a)
      && cfg.ATTRIBUTES.every((d) => (a[d.id] || 0) <= capOf(d))
      && H.Space.costOf(cfg.ATTRIBUTES, a) <= cfg.ATTRIBUTE_BUDGET;
    const legalT = (t) => cfg.TALENTS.every((d) => (t[d.id] || 0) <= capOf(d))
      && H.Space.costOf(cfg.TALENTS, t) <= cfg.TALENT_BUDGET;

    // DONOR DIRECTION. `above` descends from a higher-level build, `below` ascends from a lower
    // one, `both` (default) is the existing behaviour and lets score decide.
    //
    // THESE ARE NOT SYMMETRIC, WHICH IS WHY THE FLAG EXISTS. Descending TRIMS a mature structure
    // that already pays its tier gates, and refitTiered preserves structure while removing points.
    // Ascending must GROW structure the donor never had, via a refill that sorts by donor value --
    // and this project has already measured that path losing `athena` (cost 15, donor value 1, so
    // last in the queue) and with it borge@73's boss kill. Expensive low-count nodes are where the
    // gates and the kills live, and they are exactly what an ascending refill funds last.
    const DONOR_DIR = opt('donordir', 'both');
    if (!['both', 'above', 'below'].includes(DONOR_DIR)) throw new Error(`--donordir must be both|above|below, got "${DONOR_DIR}"`);
    const donors = flat.filter((f) => {
      if (f.hunter !== fx.hunter || (f.mode || 'loot') !== mode || f.uid === fx.uid) return false;
      const dl = (f.level || 0) - (fx.level || 0);
      if (Math.abs(dl) <= BAND) return false;
      if (DONOR_DIR === 'above') return dl > 0;
      if (DONOR_DIR === 'below') return dl < 0;
      return true;
    });
    // Deterministic stopping rule: the same input always stops at the same place.
    // Per-build, because the search space differs per hunter -- knox has 11+8 nodes against
    // borge's 15+9, and a single number cannot be right for both.
    const MAX_EVALS = MAX_EVALS_OVERRIDE !== null ? MAX_EVALS_OVERRIDE : adaptiveMaxEvals(cfg);
    const outOfTime = () => evals >= MAX_EVALS;
    let truncated = false;
    let lastImproveEval = 0;
    let improvements = 0;
    let jointGains = 0;
    let gomGains = 0;
    let relinkGains = 0;
    let gradGains = 0;
    let screenEvals = 0;
    // WHICH NEIGHBORHOOD ACTUALLY PAYS? VND escalates N_1..N_32 and each failed sweep is pure
    // termination cost. If the large chunks never produce an improvement they are a tax on every
    // build, paid to prove something already known.
    const gainsBy = {};
    const costBy = {};

    const pooled = await H.makePooledScorer(cfg, mode);
    let best = null;
    let beforeRefine = null;
    let winner = null;
    let donorSplit = null;
    try {
      // DONOR SCREENING AT LOW FIDELITY, IN ONE BATCH.
      // Screening 87 Borge donors at 1000 iterations serially was minutes of the budget before the
      // climb even started. They are screened at SCREEN in a single parallel batch instead; only
      // the survivors are ever measured at full fidelity, so the cheap ruler narrows and never decides.
      const shaped = [];
      for (const d of donors) {
        let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
        // THE CANONICAL REFIT, not a local copy. The naive form absorbed the budget difference in
        // the donor's single largest node, which strips the sub-threshold points paying a gated
        // build's unlock gates: borge@74's refit came out ILLEGAL that way and the whole donor pool
        // topped out at -39.27% with nothing killing a boss. The tiered form preserves the donor's
        // structure and pays the gates, and reaches -19.69% WITH the kill.
        const t = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, db.talents);
        const a = R.refitTiered(cfg.ATTRIBUTES, cfg.ATTRIBUTE_MIN_VALUE || {}, cfg.ATTRIBUTE_BUDGET, db.attributes);
        if (!t || !a || !legal(a) || !legalT(t)) continue;
        shaped.push({
          t, a, from: d.name || d.uid, donorLevel: d.level || 0,
          // Which DIRECTION the winning donor came from. Recorded because "descending beats
          // ascending" is answerable from any ordinary run once this is in the output, and does not
          // need a dedicated A/B to ask the first time.
          dir: (d.level || 0) > (fx.level || 0) ? 'above' : 'below',
          pair: { talentAlloc: t, attrAlloc: a },
        });
      }
      // No explicit destroy here: `continue` runs the finally below, so destroying here too would
      // tear the pool down twice. A leaked pool is a WASM module per worker, and a double-destroy
      // is a throw inside a cleanup path -- both worth avoiding, and exactly one owner is correct.
      if (!shaped.length) { console.log(`${name}: no legal donors`); continue; }
      const cheap = await pooled.score(shaped.map((s) => s.pair), SCREEN);
      evals += shaped.length;
      screenEvals = shaped.length;
      shaped.forEach((s, i) => { s.cheap = cheap[i]; });
      shaped.sort((x, y) => y.cheap - x.cheap);

      // ---- DONOR RECOMBINATION: talents from one donor, attributes from another ----------------
      //
      // A cross-block move for free. The confirmed barrier on the converged shortfalls is a
      // talent/attribute COUPLING that no single-block move can cross; the joint pass crosses it by
      // SEARCHING for the pair at 2.8x cost, while recombination simply starts from a build that
      // already has blocks from different sources. Deterministic: fixed donor order, no PRNG.
      //
      // Measured donor-quality gains over the best pure donor, before any climbing:
      //     borge@44 +0.43%   borge@35 +1.27%   ozzy@46 +3.95%   knox@35b +1.60%
      // and on the two builds where the winner MIXED level directions, it took TALENTS FROM BELOW
      // and ATTRIBUTES FROM ABOVE in both cases. Plausible mechanism: talent budget is ~level while
      // attributes are ~3x level, so talents saturate their caps early and a lower donor's talent
      // shape fits a smaller budget cleanly, while a higher donor's attributes carry depth structure
      // a lower one has not grown into.
      //
      // TOP-K, NOT ALL PAIRS. All-pairs was 7,482 combinations on borge@44 -- ~10x the work of the
      // whole optimization run, none of it memoizable -- and answered a question nobody asked.
      // Ranking is the RIGHT filter here (unlike the joint MOVE pass, which needs individually-bad
      // halves): we want a strong pairing, so the strong donors are the ones worth crossing.
      if (RECOMBINE > 0 && shaped.length > 1) {
        const top = shaped.slice(0, RECOMBINE);
        const combos = []; const cmeta = [];
        for (const ti of top) {
          for (const aj of top) {
            if (ti.from === aj.from) continue; // that is the pure donor, already in `shaped`
            if (!legal(aj.a) || !legalT(ti.t)) continue;
            combos.push({ talentAlloc: ti.t, attrAlloc: aj.a });
            cmeta.push({ ti, aj });
          }
        }
        if (combos.length) {
          const cs = await pooled.score(combos, SCREEN);
          evals += combos.length;
          screenEvals += combos.length;
          combos.forEach((pair, i) => {
            shaped.push({
              t: pair.talentAlloc, a: pair.attrAlloc, pair, cheap: cs[i],
              from: `${cmeta[i].ti.from}+${cmeta[i].aj.from}`,
              donorLevel: cmeta[i].aj.donorLevel,
              // A recombination MIXES directions when its two halves came from opposite sides.
              dir: cmeta[i].ti.dir === cmeta[i].aj.dir ? cmeta[i].ti.dir : 'mixed',
            });
          });
          shaped.sort((x, y) => y.cheap - x.cheap);
        }
      }

      const cands = shaped.slice(0, TOP);
      const exact = await pooled.score(cands.map((s) => s.pair), ITERS);
      evals += cands.length;
      cands.forEach((s, i) => { s.v = exact[i]; });
      cands.sort((x, y) => y.v - x.v);
      beforeRefine = cands[0].v;
      winner = cands[0];
      // How the whole donor pool splits, so a single build's winner is not read as a trend.
      const above = shaped.filter((s) => s.dir === 'above');
      const below = shaped.filter((s) => s.dir === 'below');
      const bestOf = (xs) => (xs.length ? Math.max(...xs.map((s) => s.cheap)) : null);
      donorSplit = {
        above: above.length, below: below.length,
        bestAbove: bestOf(above), bestBelow: bestOf(below), winnerDir: winner.dir,
      };

      // ORDERED VARIABLE NEIGHBORHOOD DESCENT (Hansen & Mladenovic).
      //
      // Neighborhood N_k moves k points between two nodes. VND explores them IN ORDER: run N_1 to a
      // local optimum, escalate to N_2 only when stuck, and RESTART AT N_1 on any improvement. Its
      // justification is exactly our landscape -- "different neighborhood structures usually have
      // different local minima, so the local optima trap may be solved by deterministic change of
      // neighborhoods" -- and the literature also reports the pattern we measured directly, that
      // fine-grained operators dominate early while disruptive moves pay off once the landscape
      // plateaus (single-point climbing stalls at -20.69%; chunks reach +6.02%).
      //
      // WHY ORDERED RATHER THAN ALL-AT-ONCE: scoring every chunk size in every sweep is ~10x the
      // evaluations per sweep, and borge@32 blew a 5-minute budget doing it. Most sweeps improve in
      // N_1, so the large neighborhoods are only ever built when they are actually needed.
      // NEIGHBORHOODS SIZED FROM MEASURED GAINS, NOT FROM A ROUND NUMBER.
      //
      // Every accepted improvement across five builds, by neighborhood:
      //     N1   12 gains   the workhorse
      //     N2    3 gains   and the reason borge@73 works at all -- N1-only scores -14.11%
      //     N8    1 gain    knox@30
      //     N3 N4 N6 N12 N16 N24 N32   ZERO gains on every build, 180-265 evals each run
      // Those seven were 25-50% of every run, spent proving something already known: VND must
      // sweep a neighborhood and find nothing before it may stop, so a dead neighborhood is a tax
      // paid on every build forever.
      //
      // KEPT BECAUSE THEY EARN IT, not because the ladder looked tidy. N2 is retained on one
      // build's evidence and N8 on one build's -- both are cheap and both are load-bearing where
      // they fire. `--neighborhoods=` overrides, so the trim can be re-measured rather than trusted.
      //
      // LIMIT, STATED: five builds is the evidence. A sixth build could need N4. The trim is
      // verified behaviour-preserving on these five (byte-identical results); beyond them it is an
      // assumption, and the override exists so it can be tested rather than argued about.
      const NEIGHBORHOODS = (opt('neighborhoods', '1,2,8')).split(',').map(Number);
      // Multi-source move shape. Defaults reproduce the pair-only move set exactly.
      const SOURCES = Number(opt('sources', 2));   // how many nodes may fund one raise
      const RAISE = Number(opt('raise', 1));       // how many levels the destination may gain
      const TAKE_CAP = Number(opt('takecap', 8));  // max levels drawn from any single source
      // Combinatorial guard. K=3 over 15 attributes is ~455 source-triples per destination per
      // raise amount, and an unbounded sweep can emit tens of thousands of candidates -- each of
      // which costs a full evaluation. The cap makes the cost knowable; enumeration order is
      // deterministic (index order, minimal takes) so a capped sweep is reproducible, not arbitrary.
      const MOVE_CAP = Number(opt('movecap', 4000));
      for (const seed of cands) {
        if (outOfTime()) { truncated = true; break; }
        let cur = { t: { ...seed.t }, a: { ...seed.a }, v: seed.v };
        let k = 0;
        while (k < NEIGHBORHOODS.length) {
          if (outOfTime()) { truncated = true; break; }
          const chunk = NEIGHBORHOODS[k];
          const moves = [];
          let emitted = 0; // multi-source candidates only, against MOVE_CAP
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
                const pair = key === 'a'
                  ? { talentAlloc: cur.t, attrAlloc: next }
                  : { talentAlloc: next, attrAlloc: cur.a };
                if (!legal(pair.attrAlloc) || !legalT(pair.talentAlloc)) continue;
                moves.push(pair);
              }
            }
          }
          // MULTI-SOURCE MOVES: raise ONE node, funded by taking from a PAIR of others.
          //
          // The single-source move set cannot express "take from two nodes to fund one", and that
          // is not a rare corner. borge@42's best donor sits FOUR points from the import and loses
          // 0.68%, and the gap is exactly this shape:
          //     donor   ares 2, htb 3, battle 2      costs: ares 1, htb 2, battle 5
          //     import  ares 1, htb 1, battle 3
          // Funding battle 2->3 costs 5. Dropping ares frees 1, dropping htb frees 4 -- NEITHER
          // alone pays, only both together. Chunking does not help: it scales how much comes from
          // ONE source. Every mechanism this project has tried (MAP-Elites, FI, bet-and-run, OCBA,
          // VND) navigates with `Space.transfer`, which is one source to one destination, so this
          // transition was inexpressible to all of them.
          //
          // A FIRST ATTEMPT USED GREEDY CHEAPEST-FIRST SOURCING AND DID NOT FIX IT: to fund battle
          // it drained `ares` to 0, while the answer keeps ares at 1 and takes two levels of htb.
          // Greedy yields ONE candidate per target; the needed pairing was not among them. So the
          // pair is enumerated instead, and the amount taken from each source is minimal.
          // GENERALISED TO K SOURCES AND AN M-LEVEL RAISE, because 2->1 has two hard limits that
          // both bite hardest on high-level builds:
          //   - the destination went up by exactly ONE level. A tier threshold that needs a node
          //     several levels deeper is unreachable in one move however many sources fund it.
          //   - two sources cannot pay for an expensive node once the cheap donors are already
          //     drained, which is the normal state late in a climb.
          // Defaults are K=2, M=1 -- byte-identical to the pair-only version -- so this changes
          // nothing until --sources/--raise say otherwise. Do not raise them on theory: the cost
          // is combinatorial and this project has already measured richer move sets LOSING
          // (depth moves raised coverage and lowered champion quality).
          for (const [defs, key, budget] of [[cfg.ATTRIBUTES, 'a', cfg.ATTRIBUTE_BUDGET], [cfg.TALENTS, 't', cfg.TALENT_BUDGET]]) {
            const funded = defs.filter((d) => (cur[key][d.id] || 0) > 0);
            const slack = budget - H.Space.costOf(defs, cur[key]);
            for (const to of defs) {
              const have = cur[key][to.id] || 0;
              for (let m = 1; m <= RAISE; m++) {
                if (have + m > capOf(to)) break;
                const need = m * (to.cost || 1) - slack;
                if (need <= 0) continue; // affordable already; single-source moves cover it
                // Choose sources in INDEX ORDER so the enumeration is deterministic, and take the
                // minimum from each: the first K-1 sources are swept, the last covers the shortfall
                // exactly. That is the pair logic, recursed.
                const pick = (start, chosen, freed, maxDepth) => {
                  if (emitted >= MOVE_CAP) return;
                  const remaining = need - freed;
                  for (let i = start; i < funded.length; i++) {
                    const s = funded[i];
                    if (s.id === to.id) continue;
                    const c = s.cost || 1;
                    const avail = cur[key][s.id] || 0;
                    const depth = chosen.length + 1;
                    if (depth >= maxDepth) {
                      // Last permitted source must finish the job on its own.
                      const n = Math.ceil(remaining / c);
                      if (n < 1 || n > avail || n > TAKE_CAP) continue;
                      const next = { ...cur[key] };
                      for (const [id, cnt] of chosen) next[id] -= cnt;
                      next[s.id] -= n;
                      next[to.id] = have + m;
                      if (H.Space.costOf(defs, next) > budget) continue;
                      const cand = key === 'a'
                        ? { talentAlloc: cur.t, attrAlloc: next }
                        : { talentAlloc: next, attrAlloc: cur.a };
                      if (!legal(cand.attrAlloc) || !legalT(cand.talentAlloc)) continue;
                      moves.push(cand); emitted++;
                      if (emitted >= MOVE_CAP) return;
                    } else {
                      const lim = Math.min(avail, TAKE_CAP);
                      for (let n = 1; n <= lim; n++) {
                        // Once this source alone covers the shortfall it is a shallower move and
                        // has already been generated at a smaller depth. Stop rather than duplicate.
                        if (n * c >= remaining) break;
                        chosen.push([s.id, n]);
                        pick(i + 1, chosen, freed + n * c, maxDepth);
                        chosen.pop();
                        if (emitted >= MOVE_CAP) return;
                      }
                    }
                  }
                };
                for (let k2 = 2; k2 <= SOURCES; k2++) {
                  // Depth-limited sweep: k2=2 reproduces the original pair moves exactly.
                  pick(0, [], 0, k2);
                  if (emitted >= MOVE_CAP) break;
                }
              }
            }
          }

          if (!moves.length) { k++; continue; }
          const scores = await pooled.score(moves, ITERS);
          evals += moves.length;
          costBy[chunk] = (costBy[chunk] || 0) + moves.length;
          let bi = -1;
          for (let i = 0; i < scores.length; i++) if (scores[i] > cur.v + 1e-9 && (bi < 0 || scores[i] > scores[bi])) bi = i;
          if (bi < 0) { k++; continue; }
          // WHERE DOES THE WORK STOP PAYING? Recording the evaluation index of the LAST accepted
          // improvement is what turns "the budget is 1500" into "it converged at 620 and the other
          // 880 were tail". Without it, a budget is a guess that can only be raised.
          lastImproveEval = evals;
          improvements += 1;
          gainsBy[chunk] = (gainsBy[chunk] || 0) + 1;
          cur = { t: moves[bi].talentAlloc, a: moves[bi].attrAlloc, v: scores[bi] };

          // A MOVE CAN LEAVE BUDGET UNSPENT, AND AN UNDER-SPENT BUILD IS A DEFECT HERE.
          // A move takes `chunk` points out of one node and puts `min(room, cap-current)` into
          // another; when the source costs more than the destination the remainder is simply lost.
          // borge@32 came back at attrs 95/96 that way -- one point on the table, which this
          // project treats as a hard error ("Optimizer left N point(s) unspent").
          for (const [defs, key, budget] of [[cfg.ATTRIBUTES, 'a', cfg.ATTRIBUTE_BUDGET], [cfg.TALENTS, 't', cfg.TALENT_BUDGET]]) {
            let guardFill = 10000;
            let filled = true;
            while (filled && guardFill-- > 0) {
              filled = false;
              for (const d of defs) {
                if ((cur[key][d.id] || 0) >= capOf(d)) continue;
                if (H.Space.costOf(defs, cur[key]) + (d.cost || 1) > budget) continue;
                const next2 = { ...cur[key] };
                next2[d.id] = (next2[d.id] || 0) + 1;
                const pair2 = key === 'a' ? { t: cur.t, a: next2 } : { t: next2, a: cur.a };
                if (!legal(pair2.a) || !legalT(pair2.t)) continue;
                cur = { t: pair2.t, a: pair2.a, v: cur.v };
                filled = true;
              }
            }
          }
          // The top-up changed the build, so its score is stale -- re-measure before comparing.
          cur.v = (await pooled.score([{ talentAlloc: cur.t, attrAlloc: cur.a }], ITERS))[0];
          evals += 1;

          k = 0; // improvement: back to the smallest neighborhood, per VND
        }

        // ---- CROSS-BLOCK PASS: change TALENTS AND ATTRIBUTES AT THE SAME TIME ------------------
        //
        // EVERY move above touches ONE block. The attribute sweep holds talents fixed and the talent
        // sweep holds attributes fixed, so a transition needing both is unreachable however many
        // nodes a single-block move may touch -- which is why widening moves WITHIN a block (K
        // sources, M-level raises) returned a byte-identical build on all three builds tried.
        //
        // ozzy@11 is the reproducer: converged, fully spent, legal, 2.02% below its community build,
        // and only 8 point-differences from it --
        //     ours   lotl:1 exo:7 exterm:4 | revival:1
        //     import lotl:2 exo:4 exterm:5 | needles:1
        // It needs exo-3/lotl+1/exterm+1 AND revival-1/needles+1 TOGETHER. If either half is
        // downhill alone, neither is ever taken. This is the same one-way talent/attribute coupling
        // this project already recorded from the other side ("talents are NOT learnable from a flat
        // attribute fill").
        //
        // THE PAIRING IS THE POINT, so the candidates deliberately include INDIVIDUALLY DOWNHILL
        // moves -- an uphill pair made of two downhill halves is exactly what a block-wise climber
        // cannot see. Bounded at JOINT^2 combinations and run ONLY after the ordinary VND has
        // converged, so a build that never gets stuck pays nothing for it.
        if (JOINT > 0) {
          let jointGuard = 20;
          for (;;) {
            if (jointGuard-- <= 0 || outOfTime()) break;
            const half = async (defs, key, budget) => {
              const out = [];
              for (const from of defs) {
                for (const chunk of [1, 2]) {
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
                    out.push(next);

                    // ONE SOURCE -> TWO DESTINATIONS. Every move elsewhere sends the freed points
                    // to a SINGLE destination, so `exo -3` split across `lotl +1` and `exterm +1`
                    // -- the attribute half of the ozzy@11 transition, measured uphill when paired
                    // with its talent half -- was never a candidate. Without this the cross-block
                    // pass has nothing to pair, which is exactly why --joint alone moved 0.02%.
                    if (add >= 2) {
                      for (const to2 of defs) {
                        if (to2.id === to.id || to2.id === from.id) continue;
                        const split = { ...next };
                        split[to.id] -= 1;
                        const room2 = Math.floor((budget - H.Space.costOf(defs, split)) / (to2.cost || 1));
                        const add2 = Math.min(room2, capOf(to2) - (split[to2.id] || 0));
                        if (add2 < 1) continue;
                        split[to2.id] = (split[to2.id] || 0) + add2;
                        if (H.Space.costOf(defs, split) > budget) continue;
                        out.push(split);
                      }
                    }
                  }
                }
              }
              return out;
            };
            const aMoves = await half(cfg.ATTRIBUTES, 'a', cfg.ATTRIBUTE_BUDGET);
            const tMoves = await half(cfg.TALENTS, 't', cfg.TALENT_BUDGET);
            if (!aMoves.length || !tMoves.length) break;
            // Rank each block's moves on their own, then pair the best JOINT of each. Ranking is
            // what keeps this bounded; including losers in the ranking is what makes it work.
            // RANKING IS THE DOMINANT COST, AND IT IS RANKING ONLY -- so it runs at SCREEN fidelity.
            // Borge's half-move set is thousands of candidates once one-to-many splits are included
            // (15 sources x 2 chunks x 14 destinations x 13 split targets), and scoring all of them
            // at 1000 iterations was minutes before a single pair was tried. Unlike DONOR screening
            // -- where a mis-rank at low fidelity permanently removed borge@74 because only the top
            // 1 survived -- this keeps a WIDE slice and every surviving PAIR is re-evaluated at full
            // fidelity, so a cheap mis-rank costs a candidate slot rather than the answer.
            const aScores = await pooled.score(aMoves.map((a) => ({ talentAlloc: cur.t, attrAlloc: a })), SCREEN);
            const tScores = await pooled.score(tMoves.map((t) => ({ talentAlloc: t, attrAlloc: cur.a })), SCREEN);
            evals += aMoves.length + tMoves.length;
            // STRATIFIED, NOT TOP-K. The halves this pass exists to find are INDIVIDUALLY DOWNHILL
            // -- ozzy@11's attribute half measures -7.77% -- so ranking by score puts them last and
            // a top-K slice excludes precisely the moves being looked for. That is measured, not
            // theoretical: top-K at K=8/16/32 returned +0.02% while a wide slice returned +2.2%.
            // Half the budget goes to the best moves (ordinary improvements still matter) and half
            // is spread evenly across the whole distribution so the downhill tail is represented.
            const stratify = (ranked, k) => {
              if (ranked.length <= k) return ranked;
              const head = ranked.slice(0, Math.ceil(k / 2));
              const rest = ranked.slice(head.length);
              const want = k - head.length;
              const step = rest.length / want;
              for (let i = 0; i < want; i++) head.push(rest[Math.floor(i * step)]);
              return head;
            };
            const topA = stratify(aMoves.map((a, i) => ({ a, s: aScores[i] })).sort((x, y) => y.s - x.s), JOINT);
            const topT = stratify(tMoves.map((t, i) => ({ t, s: tScores[i] })).sort((x, y) => y.s - x.s), JOINT);
            const combos = [];
            for (const A of topA) {
              for (const T of topT) {
                if (!legal(A.a) || !legalT(T.t)) continue;
                combos.push({ talentAlloc: T.t, attrAlloc: A.a });
              }
            }
            if (!combos.length) break;
            const cScores = await pooled.score(combos, ITERS);
            evals += combos.length;
            let bj = -1;
            for (let i = 0; i < cScores.length; i++) if (cScores[i] > cur.v + 1e-9 && (bj < 0 || cScores[i] > cScores[bj])) bj = i;
            if (bj < 0) break; // converged jointly too
            cur = { t: combos[bj].talentAlloc, a: combos[bj].attrAlloc, v: cScores[bj] };
            jointGains += 1;
            lastImproveEval = evals;
            improvements += 1;
            // A joint move can strand budget exactly as a single-block one can; re-enter the
            // ordinary VND, which owns the top-up and the under-spend guarantee.
            k = 0;
            while (k < NEIGHBORHOODS.length && !outOfTime()) k++; // fall through to the report
            break;
          }
        }

        if (!best || cur.v > best.v) best = cur;
      }
    } finally { await pooled.destroy(); }
    if (!best) { console.log(`${name}: no candidate survived`); continue; }

    const secs = (Date.now() - t0) / 1000;
    const pct = (v) => (100 * (v - target) / target).toFixed(2);

    // PRINT THE REGIME, DO NOT INFER IT. A large delta on a boss-walled build is either "we crossed
    // the wall" or "something is wrong", and those look identical in a loot number alone. This
    // project has drawn a wrong conclusion four times from a measurement that could not see the
    // deciding field (relic-sweep watching loot while r7 doubled MATERIALS; sim-gate-probe missing
    // XP; "no wasm argument" read as inert; nine methods agreeing on ~6,900 because bossKillRate
    // was dropped from the harness result).
    // ASSERT THE WINNER, not just the candidates. A reported build that cannot exist in the game is
    // worse than no answer, and the filter that was supposed to prevent it silently passed
    // everything for an entire session.
    if (!legal(best.a) || !legalT(best.t)) {
      throw new Error(`${name}: the WINNING allocation is illegal -- ${JSON.stringify(best.a)}`);
    }
    // UNDER-SPEND IS A DEFECT, NOT A STYLE ISSUE. Every hunter has an uncapped cost-1 attribute and
    // all talents cost 1, so a point is essentially always spendable; the shipped optimizer THROWS
    // on an under-spent build for exactly that reason. This printed `attrs 95/96` on borge@32 and I
    // nearly read past it, which is what an unasserted qualifier gets you.
    const tSpend = H.Space.costOf(cfg.TALENTS, best.t);
    const aSpend = H.Space.costOf(cfg.ATTRIBUTES, best.a);
    if (tSpend < cfg.TALENT_BUDGET || aSpend < cfg.ATTRIBUTE_BUDGET) {
      throw new Error(`${name}: the WINNING allocation is UNDER-SPENT -- talents ${tSpend}/${cfg.TALENT_BUDGET}, `
        + `attrs ${aSpend}/${cfg.ATTRIBUTE_BUDGET}. A move that frees more cost than it spends leaves `
        + 'a remainder; top up after every accepted move.');
    }
    const ours = await H.evaluateAllocation(cfg, best.t, best.a, ITERS);
    const theirs = await H.evaluateAllocation(cfg, build.talents, build.attributes, ITERS);
    const d = (r) => H.Objective.describeRun(r);
    console.log(`${name.padEnd(10)} donors-only ${pct(beforeRefine).padStart(8)}%  `
      + `+VND ${pct(best.v).padStart(8)}%   evals ${String(evals).padStart(5)}  ${secs.toFixed(0).padStart(4)}s`
      + (truncated ? `  TRUNCATED at ${MAX_EVALS} evals -- best-so-far, NOT converged` : ''));
    // BUDGET ACCOUNTING. `screen` is the donor pass, `climb` the VND, `lastImprove` the evaluation
    // at which the answer last changed, and `tail` everything spent after that -- pure waste on
    // this build. A budget is only defensible against these numbers.
    console.log(`${' '.repeat(11)}budget: screen ${screenEvals}  climb ${evals - screenEvals}`
      + `  improvements ${improvements}  lastImprove@${lastImproveEval}`
      + `  TAIL ${Math.max(0, evals - lastImproveEval)} eval(s) after the last gain`
      + `  (${(100 * Math.max(0, evals - lastImproveEval) / Math.max(1, evals)).toFixed(0)}% of the run)`);
    const nb = Object.keys(costBy).map(Number).sort((a, b) => a - b)
      .map((c) => `N${c}:${gainsBy[c] || 0}gain/${costBy[c]}ev`).join('  ');
    console.log(`${' '.repeat(11)}neighborhoods: ${nb}`);
    console.log(`${' '.repeat(11)}import: ${d(theirs).regime.padEnd(21)} stage ${(theirs.maxStage || 0).toFixed(1).padStart(6)}  kill ${(theirs.bossKillRate || 0).toFixed(1).padStart(5)}`);
    console.log(`${' '.repeat(11)}ours:   ${d(ours).regime.padEnd(21)} stage ${(ours.maxStage || 0).toFixed(1).padStart(6)}  kill ${(ours.bossKillRate || 0).toFixed(1).padStart(5)}`);

    // PRINT THE WINNING ALLOCATION AND RE-DERIVE THE DELTA FROM AN INDEPENDENT EVALUATION.
    //
    // `best.v` comes from the pooled scorer during the climb. `ours` is a fresh evaluateAllocation
    // of the same build. They must agree -- scorer-scale-check asserts the two are the same
    // quantity, and this asserts it again on the ACTUAL winner rather than on a fixture. A headline
    // computed from one ruler and validated by another is how a +103.60% cap bug got reported here.
    const reDelta = 100 * (primary(ours) - target) / target;
    const drift = Math.abs(reDelta - Number(pct(best.v)));
    console.log(`${' '.repeat(11)}spend:  talents ${H.Space.costOf(cfg.TALENTS, best.t)}/${cfg.TALENT_BUDGET}`
      + `  attrs ${H.Space.costOf(cfg.ATTRIBUTES, best.a)}/${cfg.ATTRIBUTE_BUDGET}`
      + `  re-measured ${reDelta.toFixed(2)}%` + (drift > 0.5 ? `  <-- DISAGREES with the climb by ${drift.toFixed(2)} pts` : ''));
    console.log(`${' '.repeat(11)}talents ${JSON.stringify(best.t)}`);
    console.log(`${' '.repeat(11)}attrs   ${JSON.stringify(best.a)}`);

    // PERSIST AFTER EVERY BUILD, not at the end. A sweep that only writes on completion loses
    // everything to the kill that this project's sweeps have never once avoided.
    if (OUT) {
      done[fx.uid] = {
        uid: fx.uid, name: fx.name, hunter: fx.hunter, level: fx.level, mode,
        deltaPct: reDelta, donorsOnlyPct: Number(pct(beforeRefine)), evals,
        donorFrom: winner && winner.from, donorLevel: winner && winner.donorLevel, donorDir: winner && winner.dir, donorSplit,
        seconds: Math.round((Date.now() - t0) / 1000), truncated: !!truncated,
        talents: best.t, attrs: best.a,
      };
      fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
    }
  }

  if (OUT && ALL) {
    const rows = Object.values(done);
    const ds = rows.map((r) => r.deltaPct).sort((a, b) => a - b);
    const short = rows.filter((r) => r.deltaPct < -0.3); // below the measured 0.3% noise floor
    console.log('');
    console.log('='.repeat(74));
    console.log(`${rows.length} build(s)   worst ${ds[0].toFixed(2)}%   median ${ds[Math.floor(ds.length / 2)].toFixed(2)}%`
      + `   best ${ds[ds.length - 1].toFixed(2)}%`);
    console.log(`met or beat (>= -0.3%): ${rows.length - short.length}/${rows.length}`);
    console.log(`total evals ${rows.reduce((s, r) => s + r.evals, 0)}  `
      + `total ${Math.round(rows.reduce((s, r) => s + r.seconds, 0) / 60)} min  `
      + `truncated ${rows.filter((r) => r.truncated).length}`);
    for (const r of short.sort((a, b) => a.deltaPct - b.deltaPct)) {
      console.log(`  SHORT ${String(r.name || r.uid).padEnd(12)} ${r.mode.padEnd(4)} ${r.deltaPct.toFixed(2)}%`
        + `  (${r.evals} evals, ${r.seconds}s${r.truncated ? ', TRUNCATED' : ''})`);
    }
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
