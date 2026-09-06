'use strict';
// ARE CAPPED NODES STARVED WHILE THE UNCAPPED ROOT IS OVER-FUNDED?
//
// THIS IS A REPORT, NOT A GATE. It exits 0 whatever it finds, because it tests a HYPOTHESIS
// and 'theory not supported' is a useful outcome rather than a failure. Declared explicitly so
// bench-integrity-check can tell it apart from a gate that silently cannot fail -- which is the
// far more dangerous thing and looks identical from the outside.
//
// The project owner's rule, stated twice: uncapped nodes are for OVERFLOW -- points go there once
// the other nodes have reached their useful level, not instead of them. With the caveat, also
// stated, that sometimes the uncapped node is genuinely the best buy (Ozzy especially), so this
// must not become a hard "fill capped first" policy.
//
// This bench tests the rule DIRECTLY rather than through the aggregate root-share proxy used so
// far. Starvation has a precise meaning here: a capped node that the RETURNED build funds BELOW
// its cap while the REFERENCE funds it higher, at the same time as the returned build holds more
// in the uncapped root. If the rule is being violated, those two facts co-occur.
//
// No simulator calls -- this is arithmetic over recorded allocations.
//
//   node tools/bench/starvation-check.js --results=results-shipped.json


// NOISE FLOOR, stated because a delta without one invites reading noise as signal:
//   a comparison of two FINAL_ITERATIONS scores carries ~0.3% (measured: 0.12% mean error each),
//   and the SEARCH varies ~7 percentage points across seeds -- one seed is ONE SAMPLE.
// A single-seed difference narrower than ~7 points is not evidence about a mechanism.
const path = require('path');
const fs = require('fs');
const H = require(path.join(__dirname, 'harness.js'));

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const isUncapped = (d) => !Number.isFinite(d.maxLevel);

(async () => {
  const rows = JSON.parse(fs.readFileSync(flag('results', 'results-shipped.json'), 'utf8'));
  const all = H.loadKnownBuilds();

  console.log('starvation-check: capped nodes funded BELOW the reference while the root is funded ABOVE it');
  console.log('(no simulator calls -- arithmetic over the recorded allocations)');
  console.log('');

  const summary = [];
  for (const r of rows) {
    if (!r.optimizedAttributes || !r.importAttributes) continue;
    const uid = `${r.hunter}:${r.set}#${r.index}`;
    const entry = (all[r.hunter] || []).find((e) => e.uid === uid);
    if (!entry) continue;
    const build = await H.parseBuildCode(entry.code, r.hunter);
    const cfg = H.cfgForImport(r.hunter, build);
    const A = cfg.ATTRIBUTES;

    let rootSpendGot = 0;
    let rootSpendRef = 0;
    let totalGot = 0;
    let totalRef = 0;
    const starved = [];
    let cappedHeadroomGot = 0;   // unused capacity in capped nodes, cost-weighted

    for (const d of A) {
      const cost = d.cost || 1;
      const got = r.optimizedAttributes[d.id] || 0;
      const ref = r.importAttributes[d.id] || 0;
      totalGot += got * cost;
      totalRef += ref * cost;
      if (isUncapped(d)) {
        rootSpendGot += got * cost;
        rootSpendRef += ref * cost;
      } else {
        cappedHeadroomGot += Math.max(0, d.maxLevel - got) * cost;
        // Starved: below its cap AND below what the reference gives it.
        if (got < d.maxLevel && got < ref) starved.push({ id: d.id, got, ref, cap: d.maxLevel });
      }
    }

    const rootPctGot = totalGot ? (rootSpendGot / totalGot) * 100 : 0;
    const rootPctRef = totalRef ? (rootSpendRef / totalRef) * 100 : 0;
    const rootOverFunded = rootPctGot - rootPctRef;
    const starvedPoints = starved.reduce((s, x) => s + (x.ref - x.got) * ((A.find((d) => d.id === x.id).cost) || 1), 0);

    const rec = {
      label: entry.name, level: r.level, gapPct: r.lootDeltaPct,
      rootOverFundedPts: rootOverFunded, starvedNodes: starved.length, starvedPoints,
      violatesRule: rootOverFunded > 5 && starvedPoints > 0,
      starved,
    };
    summary.push(rec);

    console.log(`${String(entry.name).padEnd(13)} lvl${String(r.level).padStart(3)}`
      + `  gap ${(r.lootDeltaPct >= 0 ? '+' : '') + r.lootDeltaPct.toFixed(2)}%`.padEnd(14)
      + `  root ${rootOverFunded >= 0 ? '+' : ''}${rootOverFunded.toFixed(1)} pts vs ref`
      + `  starved ${starved.length} node(s) / ${starvedPoints} budget`
      + (rec.violatesRule ? '   <-- VIOLATES OVERFLOW RULE' : ''));
    if (rec.violatesRule) {
      console.log(`               starved: ${starved.map((x) => `${x.id} ${x.got}/${x.cap} (ref ${x.ref})`).join(', ')}`);
    }
  }

  console.log('');
  console.log('=== VERDICT ===');
  const lost = summary.filter((s) => s.gapPct < -0.2);
  const won = summary.filter((s) => s.gapPct >= -0.2);
  const violLost = lost.filter((s) => s.violatesRule).length;
  const violWon = won.filter((s) => s.violatesRule).length;
  console.log(`builds we LOST (${lost.length}): ${violLost} violate the overflow rule`);
  console.log(`builds we WON/matched (${won.length}): ${violWon} violate the overflow rule`);
  console.log('');
  if (lost.length && violLost === lost.length && violWon === 0) {
    console.log('RULE VIOLATION EXACTLY PREDICTS FAILURE. Every build we lose on over-funds the '
      + 'uncapped root while leaving capped nodes below both their cap and the reference; no build '
      + 'we win on does. The overflow rule is being broken precisely where value is lost.');
  } else if (violLost > violWon) {
    console.log('RULE VIOLATION IS ASSOCIATED WITH FAILURE but is not exclusive to it '
      + `(${violLost}/${lost.length} losing vs ${violWon}/${won.length} winning).`);
  } else if (violLost === 0) {
    console.log('NO VIOLATION IN THE FAILING BUILDS. The gaps are not explained by starving capped '
      + 'nodes for the uncapped root; that rule is being respected where we lose.');
  } else {
    console.log('VIOLATION IS NOT PREDICTIVE -- it appears as often in builds we win as ones we lose.');
  }
})();
