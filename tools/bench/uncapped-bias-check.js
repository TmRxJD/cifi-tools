'use strict';
// IS THERE A STRUCTURAL BIAS TOWARD THE UNCAPPED ROOT NODE?
//
// THE THEORY UNDER TEST. A transfer INTO an uncapped node can never be rejected for hitting a cap;
// a transfer into a capped node can. If the move generator proposes targets uniformly, the
// uncapped node therefore ACCEPTS a larger share of what is proposed to it, and points accumulate
// there over thousands of variations -- a sink the search cannot help filling.
//
// WHY IT IS WORTH TESTING. The two largest quality failures measured share a shape:
//     ozzy@54  reference lotl 63   returned lotl 85     (lotl is Ozzy's uncapped root)
//     knox@26  reference kraken 1  returned kraken 14   (kraken is Knox's uncapped root)
// Both over-fund the uncapped root and drop capped nodes the reference funds. Two hunters, two
// levels, same shape.
//
// THIS BENCH DOES NOT ASSUME THE THEORY IS TRUE. It measures two things that must BOTH hold if it
// is, and reports a stated verdict either way:
//
//   TEST 1 (mechanism): over many proposed transfers drawn the way the archive draws them, compare
//     the ACCEPTANCE RATE of transfers targeting uncapped nodes against capped ones. No sim calls.
//
//   TEST 2 (outcome): across recorded gate results, compare the share of the attribute budget the
//     RETURNED build puts in uncapped roots against what the REFERENCE puts there -- split by
//     whether we beat or lost to the reference. A bias that only appears where we LOSE is
//     evidence; one that appears everywhere is just how good builds look.
//
//   node tools/bench/uncapped-bias-check.js --results=results-shipped.json

const path = require('path');
const fs = require('fs');
const H = require(path.join(__dirname, 'harness.js'));

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

// The archive's own PRNG, copied so the proposal distribution matches what the search really does.
function seededRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isUncapped = (d) => !Number.isFinite(d.maxLevel);

function mechanismTest(cfg, startAlloc, trials) {
  const Space = H.Space;
  const A = cfg.ATTRIBUTES;
  const deps = cfg.ATTRIBUTE_DEPENDENCIES;
  const minVal = cfg.ATTRIBUTE_MIN_VALUE;
  const rng = seededRng(0x9e3779b9);
  const stat = {
    uncapped: { proposed: 0, accepted: 0 },
    capped: { proposed: 0, accepted: 0 },
  };
  let alloc = { ...startAlloc };
  for (let i = 0; i < trials; i++) {
    const held = A.filter((d) => (alloc[d.id] || 0) > 0);
    if (!held.length) break;
    const from = held[Math.floor(rng() * held.length)];
    const to = A[Math.floor(rng() * A.length)];
    if (from.id === to.id) continue;
    const amount = 1 + Math.floor(rng() * Math.min(12, alloc[from.id] || 1));
    const bucket = isUncapped(to) ? stat.uncapped : stat.capped;
    bucket.proposed++;
    const next = Space.transfer(A, deps, minVal, cfg.ATTRIBUTE_BUDGET, alloc, from.id, to.id, amount);
    if (next) {
      bucket.accepted++;
      // Walk, so the state reflects where the search actually ends up rather than one fixed point.
      alloc = next;
    }
  }
  return stat;
}

const rootShare = (cfg, alloc) => {
  const A = cfg.ATTRIBUTES;
  let total = 0;
  let inUncapped = 0;
  for (const d of A) {
    const spend = (alloc[d.id] || 0) * (d.cost || 1);
    total += spend;
    if (isUncapped(d)) inUncapped += spend;
  }
  return total ? (inUncapped / total) * 100 : 0;
};

(async () => {
  const resultsFile = flag('results', 'results-shipped.json');
  const rows = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const all = H.loadKnownBuilds();

  console.log(`uncapped-bias-check: ${rows.length} row(s) from ${resultsFile}`);
  console.log('');

  // ---------------- TEST 1: mechanism ----------------
  console.log('=== TEST 1: transfer acceptance rate by target kind (no sim calls) ===');
  console.log('If a transfer into an uncapped node is accepted more often than into a capped one,');
  console.log('the move generator has a structural sink.');
  console.log('');
  const mechRows = [];
  for (const r of rows) {
    const uid = `${r.hunter}:${r.set}#${r.index}`;
    const entry = (all[r.hunter] || []).find((e) => e.uid === uid);
    if (!entry) continue;
    const build = await H.parseBuildCode(entry.code, r.hunter);
    const cfg = H.cfgForImport(r.hunter, build);
    const st = mechanismTest(cfg, build.attributes, 20000);
    const uRate = st.uncapped.proposed ? (st.uncapped.accepted / st.uncapped.proposed) * 100 : 0;
    const cRate = st.capped.proposed ? (st.capped.accepted / st.capped.proposed) * 100 : 0;
    mechRows.push({ label: entry.name, hunter: r.hunter, level: r.level, uRate, cRate, diff: uRate - cRate });
    console.log(`${String(entry.name).padEnd(14)} lvl${String(r.level).padStart(3)}`
      + `  into-uncapped ${uRate.toFixed(1)}%  into-capped ${cRate.toFixed(1)}%`
      + `  difference ${(uRate - cRate >= 0 ? '+' : '') + (uRate - cRate).toFixed(1)} pts`);
  }
  const meanDiff = mechRows.reduce((s, x) => s + x.diff, 0) / (mechRows.length || 1);
  console.log('');
  console.log(`mean acceptance difference (uncapped minus capped): ${meanDiff >= 0 ? '+' : ''}${meanDiff.toFixed(1)} points`);
  const MECH_THRESHOLD = 5;
  const mechanismHolds = meanDiff > MECH_THRESHOLD;
  console.log(mechanismHolds
    ? `TEST 1 RESULT: MECHANISM PRESENT -- uncapped targets accept ${meanDiff.toFixed(1)} points more often.`
    : `TEST 1 RESULT: MECHANISM ABSENT -- the difference (${meanDiff.toFixed(1)} points) is below the `
      + `${MECH_THRESHOLD}-point threshold, so acceptance rate does not favour uncapped targets.`);

  // ---------------- TEST 2: outcome ----------------
  console.log('');
  console.log('=== TEST 2: uncapped-root share of the attribute budget, returned vs reference ===');
  console.log('Split by whether we BEAT or LOST to the reference. A bias that appears only where we');
  console.log('LOSE is evidence; one that appears everywhere is just what good builds look like.');
  console.log('');
  const won = [];
  const lost = [];
  for (const r of rows) {
    if (!r.optimizedAttributes || !r.importAttributes) continue;
    const uid = `${r.hunter}:${r.set}#${r.index}`;
    const entry = (all[r.hunter] || []).find((e) => e.uid === uid);
    if (!entry) continue;
    const build = await H.parseBuildCode(entry.code, r.hunter);
    const cfg = H.cfgForImport(r.hunter, build);
    const refShare = rootShare(cfg, r.importAttributes);
    const gotShare = rootShare(cfg, r.optimizedAttributes);
    const rec = {
      label: entry.name, level: r.level, gapPct: r.lootDeltaPct,
      refShare, gotShare, delta: gotShare - refShare,
    };
    (r.lootDeltaPct < -0.2 ? lost : won).push(rec);
    console.log(`${String(entry.name).padEnd(14)} lvl${String(r.level).padStart(3)}`
      + `  gap ${(r.lootDeltaPct >= 0 ? '+' : '') + r.lootDeltaPct.toFixed(2)}%`.padEnd(14)
      + `  reference ${refShare.toFixed(1)}%  returned ${gotShare.toFixed(1)}%`
      + `  delta ${(rec.delta >= 0 ? '+' : '') + rec.delta.toFixed(1)} pts`);
  }
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x.delta, 0) / xs.length : null);
  const wonMean = mean(won);
  const lostMean = mean(lost);
  console.log('');
  console.log(`builds we BEAT or matched (${won.length}): mean delta `
    + `${wonMean === null ? 'n/a' : (wonMean >= 0 ? '+' : '') + wonMean.toFixed(1) + ' pts'}`);
  console.log(`builds we LOST   (${lost.length}): mean delta `
    + `${lostMean === null ? 'n/a' : (lostMean >= 0 ? '+' : '') + lostMean.toFixed(1) + ' pts'}`);

  console.log('');
  console.log('=== VERDICT ===');
  const OUTCOME_THRESHOLD = 5;
  const outcomeHolds = lostMean !== null && lostMean > OUTCOME_THRESHOLD
    && (wonMean === null || lostMean > wonMean + OUTCOME_THRESHOLD);
  if (mechanismHolds && outcomeHolds) {
    console.log('THEORY SUPPORTED. The move generator accepts transfers into uncapped nodes more '
      + 'often, AND the builds we lose on put measurably more of the budget there than the '
      + 'reference does, while the builds we win on do not.');
  } else if (!mechanismHolds && outcomeHolds) {
    console.log('THEORY PARTLY SUPPORTED, MECHANISM WRONG. Losing builds do over-fund the uncapped '
      + 'root, but acceptance rate is not why -- the cause is elsewhere and this bench does not '
      + 'identify it.');
  } else if (mechanismHolds && !outcomeHolds) {
    console.log('MECHANISM PRESENT BUT IT DOES NOT REACH THE OUTCOME. Uncapped targets do accept '
      + 'more often, yet the builds we lose on do not over-fund the root relative to the ones we '
      + 'win on. The bias exists and is not what costs the value.');
  } else {
    console.log('THEORY NOT SUPPORTED. Neither the acceptance-rate mechanism nor the outcome '
      + 'signature is present. The ozzy@54 / knox@26 root-heavy shape is not a general pattern.');
  }
})();
