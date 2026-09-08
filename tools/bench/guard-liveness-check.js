'use strict';
// EVERY GUARD MUST ACTUALLY FIRE. NO GUARD MAY BE A NO-OP.
//
// WHY THIS EXISTS, stated plainly because it was an expensive mistake. A guard was added to
// AccountState.build rejecting one hunter's stats handed to another, and it was described as making
// that failure "structurally impossible" because "every path funnels through this one constructor".
// That was never verified. tools/bench/cfgForImport -- the builder EVERY bench uses -- does not
// call AccountState at all, so the guard was dead on the only path where the mistake had actually
// happened. Building a check and not proving it fires is worse than not building it: it converts
// an open risk into a false sense of safety.
//
// So: for every guard in the codebase, construct the input it exists to reject and assert it
// throws. A guard that does not fire here is reported as DEAD.
//
//   node tools/bench/guard-liveness-check.js

const path = require('path');
const H = require(path.join(__dirname, 'harness.js'));

const results = [];
// A TEST THAT THROWS DURING SETUP IS NOT A GUARD FIRING. The first version of this file counted
// any exception as success, and one case "passed" because the function under test was not exported
// -- the setup threw, never reaching the guard. That is precisely the no-op-that-looks-alive this
// bench exists to catch, committed inside the bench itself. Setup failures are now reported as
// UNTESTED, which is a finding, not a pass.
class SetupFailure extends Error {}
async function guard(name, where, trigger) {
  let outcome;
  try {
    await trigger();
    outcome = { name, where, status: 'DEAD', detail: 'no throw -- this guard cannot fire' };
  } catch (e) {
    outcome = e instanceof SetupFailure
      ? { name, where, status: 'UNTESTED', detail: e.message.slice(0, 90) }
      : { name, where, status: 'FIRED', detail: e.message.slice(0, 90) };
  }
  results.push(outcome);
}

(async () => {
  const sb = H.browserSandbox();
  const all = H.loadKnownBuilds();
  const fx = H.findFixture(all, 'knox@13');
  const build = await H.parseBuildCode(fx.code, 'knox');
  const cfg = H.cfgForImport('knox', build);
  const scorer = await H.makeScorer(cfg, 'loot');

  // 1. AccountState rejects another hunter's stats.
  await guard('cross-hunter hunterStats', 'AccountState.build', () => {
    sb.AccountState.build({
      hunter: 'knox',
      build,
      hunterStats: { multichance: 5, evade: 3 },   // Ozzy's vocabulary
      globalUpgrades: {},
      gems: {},
      showAdvancedTalents: false,
    });
  });

  // 1b. AccountState rejects a build with no level.
  //
  // `level` becomes the wasm `lvl` argument, so an absent one evaluates the build at level 0 --
  // a legal-looking number, no undefined anywhere, and a plausible score for a build nobody has.
  // That is why it must THROW rather than default: the same-account parity harness omitted it and
  // reported borge@61 as 50% below cifi-tools, which was then investigated as a product defect
  // through gem ablation, category ablation and a relic probe before anyone dumped the argument
  // vector. Supplying the level put all three hunters within 0.24% of the live site.
  await guard('build with no level', 'AccountState.build', () => {
    const { level, ...noLevel } = build;
    sb.AccountState.build({
      hunter: 'knox',
      build: noLevel,
      hunterStats: {},
      globalUpgrades: {},
      gems: {},
      showAdvancedTalents: false,
    });
  });

  // 2. AccountState.workerCfg refuses to drop a field a worker needs.
  await guard('workerCfg missing field', 'AccountState.workerCfg', () => {
    const broken = { ...cfg };
    delete broken.baseOverrides;
    sb.AccountState.workerCfg(broken);
  });

  // 3. optimize() rejects an option it does not accept.
  await guard('unknown optimize option', 'HunterOptimizer.optimize', () => H.Optimizer.optimize(cfg, {
    mode: 'loot', scorer, scorerFor: () => {},
  }));

  // 4. optimize() requires a scorer.
  await guard('missing scorer', 'HunterOptimizer.optimize', () => H.Optimizer.optimize(cfg, { mode: 'loot' }));

  // 5. optimize() rejects an unknown effort level.
  await guard('unknown effort level', 'HunterOptimizer.optimize', () => H.Optimizer.optimize(cfg, {
    mode: 'loot', scorer, effort: 'turbo',
  }));

  // 6. describeRun refuses a malformed result rather than describing it.
  await guard('malformed run result', 'Objective.describeRun', () => {
    H.Objective.describeRun({ avgStage: 1 });
  });

  // 7. describeRun refuses a missing result entirely.
  await guard('null run result', 'Objective.describeRun', () => {
    H.Objective.describeRun(null);
  });

  // 8. The objective rejects an unknown mode.
  await guard('unknown objective mode', 'Objective.modeOrThrow', () => {
    H.Objective.modeOrThrow('sideways');
  });

  // 9. storeSchema will not invent a default effort if the optimizer is unavailable.
  await guard('store default with no optimizer', 'StoreSchema.optimizeEffort', () => {
    const saved = sb.HunterOptimizer;
    try {
      sb.HunterOptimizer = undefined;
      sb.StoreSchema.freshStore();
    } finally {
      sb.HunterOptimizer = saved;
    }
  });

  // 10. Space.enumerateSupports rejects a dependency naming a node that does not exist.
  await guard('dependency on unknown node', 'Space.enumerateSupports', () => {
    const deps = { ...cfg.ATTRIBUTE_DEPENDENCIES, [cfg.ATTRIBUTES[1].id]: ['nope'] };
    H.Space.enumerateSupports(cfg.ATTRIBUTES, deps, cfg.ATTRIBUTE_BUDGET);
  });

  // 10b. Space.isLegal refuses a MIS-ORDERED call instead of answering it.
  //
  // The order is (defs, deps, minVal, alloc, budget). Swapping the last two used to return `true`
  // for every input -- costOf() summed over a number and isHeld() read a number as the allocation.
  // Two benches called it that way for a session, so dependency legality was never checked and an
  // impossible Knox build (`time 2` under `pl 0`) scored as a +7.50% win. Caps, budget, an
  // independent re-measurement and a determinism test all passed it; none of them looks at edges.
  await guard('isLegal called with alloc/budget swapped', 'Space.isLegal', () => {
    H.Space.isLegal(cfg.ATTRIBUTES, cfg.ATTRIBUTE_DEPENDENCIES, cfg.ATTRIBUTE_MIN_VALUE,
      cfg.ATTRIBUTE_BUDGET, {});
  });

  // 11. The relic cost table refuses an unknown relic rather than pricing it at zero.
  await guard('unknown relic id', 'CostFormulas.relicCostAtLevel', () => {
    const CF = sb.CostFormulas;
    if (!CF || typeof CF.relicCostAtLevel !== 'function') {
      throw new SetupFailure('CostFormulas.relicCostAtLevel is not available in the sandbox');
    }
    CF.relicCostAtLevel('r_does_not_exist', 1);
  });

  // 12. The archive refuses to form cells without boss metadata (a scorer that dropped it).
  //     Triggered end to end: a scorer returning bare numbers has no `.boss`.
  await guard('archive without boss metadata', 'search.cellOf', async () => {
    const bareScorer = async (pairs) => pairs.map(() => 1);
    await H.Optimizer.optimize(cfg, {
      mode: 'loot',
      scorer: bareScorer,
      effort: { label: 'g', archiveEvals: 96, refineSupports: 0, archiveOnly: true, seeds: [1] },
    });
  });

  const pad = (v, n) => String(v).padEnd(n);
  console.log('guard-liveness-check: every guard must reject the input it exists to reject');
  console.log('');
  for (const r of results) {
    console.log(`${pad(r.status, 9)} ${pad(r.name, 32)} ${pad(r.where, 34)} ${r.detail}`);
  }
  const dead = results.filter((r) => r.status === 'DEAD');
  const untested = results.filter((r) => r.status === 'UNTESTED');
  const fired = results.filter((r) => r.status === 'FIRED');
  console.log('');
  console.log(`${fired.length} fired, ${dead.length} dead, ${untested.length} untested `
    + `(of ${results.length})`);
  if (dead.length || untested.length) {
    console.log('');
    for (const d of dead) console.log(`  DEAD     ${d.name} (${d.where}) -- a check that cannot fail`);
    for (const u of untested) console.log(`  UNTESTED ${u.name} (${u.where}) -- ${u.detail}`);
    process.exitCode = 1;
  } else {
    console.log('no dead or untested guards: every check rejects what it claims to reject');
  }
})();
