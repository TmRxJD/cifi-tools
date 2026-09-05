'use strict';
// HOW GOOD IS THE SEARCH ITSELF, with no incumbent to lean on?
//
//   node tools/bench/search-quality-check.js [--sample=N] [--seed=N] [--hunter=borge] [--list]
//
// THE 182-BUILD GATE CANNOT ANSWER THIS, AND THAT IS WHY THIS FILE EXISTS. It hands the optimizer
// the user's own build as an incumbent, which competes as a finalist and is returned unchanged
// when nothing beats it. So "34/34 met or beat the import" is satisfied whenever the incumbent
// survives Stage 3 -- it measures that the optimizer does not DOWNGRADE a build, which is a real
// property, but says nothing about whether the search could FIND that build.
//
// The difference is not academic. On KNOWN_KNOX_BUILDS#22 (level 31) the optimizer returns the
// import exactly when handed the incumbent, and 6,916 against an import of 64,031 -- 89% worse --
// when it is not, with the import fully inside the budget it was given. The gate scored that build
// as a pass.
//
// So: the same fixtures, the same budgets, the incumbent REMOVED. The import becomes a target the
// search has to reach on its own. Budgets are the import's own spend (not the level-derived
// budget) so the import is always exactly reachable and a shortfall can only be the search.
//
// This is a REPORT by default -- it prints the distribution and exits 0 -- because the honest
// current state is that the search is weaker than the incumbent path on some builds, and a gate
// that fails on a known-open problem is a gate people learn to ignore. Pass --max-shortfall=N to
// make it a gate once the distribution is good enough to hold a line.

const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const SAMPLE = Number(opt('sample', 8));
const SEED = Number(opt('seed', Math.floor(Math.random() * 1e6)));
const HUNTER = opt('hunter', null);
const LIST = args.includes('--list');
const MAX_SHORTFALL = opt('max-shortfall', null);
// `--only=borge#16,knox#22` runs exactly those, bypassing the sample. For re-checking a build the
// sweep flagged without paying for the whole sweep again.
const ONLY = opt('only', null);

// Deterministic PRNG so a run is replayable from its printed seed -- same contract as run.js.
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stratify by level band so a sample spans the range instead of clustering in the cheap builds.
function stratify(fixtures, n, rand) {
  const bands = new Map();
  for (const f of fixtures) {
    const band = Math.floor((f.level || 0) / 10);
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(f);
  }
  const keys = [...bands.keys()].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (out.length < n && keys.length) {
    const k = keys[i % keys.length];
    const pool = bands.get(k);
    if (pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    else keys.splice(i % keys.length, 1);
    i++;
    if (!keys.length) break;
  }
  return out;
}

(async () => {
  const known = H.loadKnownBuilds();
  const hunters = HUNTER ? [HUNTER] : ['borge', 'ozzy', 'knox'];
  const rand = mulberry(SEED);

  const pool = [];
  for (const hunter of hunters) {
    for (const fx of known[hunter].filter((f) => f.mode === 'loot')) {
      pool.push({ hunter, fx });
    }
  }
  // Levels live on the parsed build, so resolve them before stratifying.
  const withLevels = [];
  for (const p of pool) {
    const build = await H.parseBuildCode(p.fx.code);
    if (build) withLevels.push({ ...p, build, level: build.level });
  }
  let picks;
  if (ONLY) {
    const wanted = ONLY.split(',').map((t) => t.trim());
    picks = wanted.map((w) => {
      // Resolved through the shared strict resolver: a name matching more than one fixture is
      // rejected rather than guessed. Borge's loot fixtures collide over indices 0-10 across two
      // sets, so "borge#2" names three builds and picking the first would investigate the wrong one.
      const target = H.findFixture(known, w);
      const hit = withLevels.find((p) => p.fx.uid === target.uid);
      if (!hit) throw new Error(`--only: ${target.uid} is not a loot fixture in this pool`);
      return hit;
    });
  } else {
    picks = stratify(withLevels, SAMPLE, rand);
  }

  console.log(`seed ${SEED} -- replay with --seed=${SEED}`);
  console.log(`${picks.length} build(s): ${picks.map((p) => p.fx.name).join(' ')}`);
  if (LIST) return;
  console.log('');

  const rows = [];
  for (const p of picks) {
    // Budget == the import's own spend, so the import is exactly reachable by construction.
    const cfg = H.cfgForImport(p.hunter, p.build, { budgetMode: 'spend' });
    const importScore = (await H.evaluateAllocation(cfg, p.build.talents, p.build.attributes)).loot;

    // No incumbent: the search must find it unaided.
    const bare = { ...cfg };
    delete bare.currentTalents;
    delete bare.currentAttrs;
    const scorer = await H.makeScorer(bare, 'loot');
    let res;
    try {
      res = await H.Optimizer.optimize(bare, { mode: 'loot', scorer });
    } catch (err) {
      console.log(`ERR  ${p.hunter}#${p.fx.index} lvl${p.level}: ${err.message}`);
      rows.push({ ...p, err: err.message });
      continue;
    }
    const found = (await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc)).loot;
    const delta = 100 * (found - importScore) / importScore;
    rows.push({ ...p, importScore, found, delta, evals: res.evals });
    const tag = delta >= -0.5 ? 'ok  ' : (delta >= -10 ? 'near' : 'MISS');
    console.log(`${tag} ${p.fx.name.padEnd(14)} lvl${String(p.level).padEnd(3)} `
      + `found ${found.toFixed(2).padStart(12)}  import ${importScore.toFixed(2).padStart(12)}  `
      + `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%   ${res.evals} evals`);
  }

  const scored = rows.filter((r) => r.delta !== undefined);
  if (!scored.length) { console.log('\nnothing scored'); process.exit(1); }
  const deltas = scored.map((r) => r.delta).sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const worst = deltas[0];
  const met = scored.filter((r) => r.delta >= -0.5).length;
  const badly = scored.filter((r) => r.delta < -10);

  console.log('');
  console.log(`matched or beat the import (within 0.5%): ${met}/${scored.length}`);
  console.log(`median ${median.toFixed(2)}%   worst ${worst.toFixed(2)}%`);
  if (badly.length) {
    console.log(`\n${badly.length} build(s) more than 10% short WITHOUT the incumbent:`);
    for (const b of badly) {
      console.log(`  ${b.fx.name} lvl${b.level}  ${b.delta.toFixed(2)}%`
        + `  -- diagnose with: node tools/bench/underspend-diagnose.js ${b.fx.name}`);
    }
    console.log('  These are builds the optimizer only gets right because the user already had '
      + 'them. A fresh account, or a heavily respecced one, would not.');
  }

  if (MAX_SHORTFALL !== null) {
    const limit = -Math.abs(Number(MAX_SHORTFALL));
    const fails = scored.filter((r) => r.delta < limit);
    console.log(`\ngate: ${fails.length} build(s) below ${limit}%`);
    process.exit(fails.length ? 1 : 0);
  }
  console.log('\n(report only -- pass --max-shortfall=N to fail on builds below -N%)');
})().catch((e) => { console.error(e); process.exit(1); });
