'use strict';
// WHICH RELICS ACTUALLY REACH THE EVALUATOR?
//
// costFormulas.js can now price every relic in the game. That is necessary but not sufficient
// for putting relics into an effective path: pricing a relic the wasm ignores would produce a
// confident, wrong recommendation. So ask the evaluator directly -- hold everything else fixed,
// move one relic, and see whether the outputs move.
//
// Same method that settled Timeless Mastery and attraction_lootKnox: change one input, compare
// bit-for-bit. The evaluator is exactly deterministic given a fresh instance, so a difference is
// real and an identity is real.
//
// RUN THIS AGAINST REAL BUILDS, NOT A SYNTHETIC ONE. A build with no hunter stats scores in the
// tens of loot per minute and dies around stage 5; a relic that only bites once other multipliers
// exist reads as "ignored" there. Every fixture below is a real recorded account build, and a
// relic is only reported as ignored if it fails to move ANY of them.
//
//   node tools/bench/relic-sweep.js [hunter]

const H = require('./harness.js');

const HUNTERS = process.argv[2] ? [process.argv[2]] : ['borge', 'ozzy', 'knox'];
const ITERATIONS = 300;
const BUILDS_PER_HUNTER = 3;

(async () => {
  const sb = H.browserSandbox();
  const known = H.loadKnownBuilds();

  for (const hunter of HUNTERS) {
    console.log(`\n=================== ${hunter.toUpperCase()} ===================`);
    const defs = sb.HUNTER_DEFS[hunter];
    const relicItems = (defs.globalUpgrades.relics && defs.globalUpgrades.relics.items) || [];
    if (!relicItems.length) { console.log('  (no relics declared for this hunter)'); continue; }

    // Take the highest-level fixtures -- relics matter most where the rest of the build is real.
    const fixtures = known[hunter].slice(-BUILDS_PER_HUNTER);
    const verdict = new Map(relicItems.map((i) => [i.id, { moved: false, best: 0, note: '' }]));

    for (const fx of fixtures) {
      const b = await H.parseBuildCode(fx.code);
      if (!b) continue;
      const cfg = H.cfgForImport(hunter, b, { budgetMode: 'level' });
      const baseOverrides = { ...cfg.baseOverrides };

      const evalWith = async (overrides) => {
        const evalFast = await sb.HunterSim.compileEvaluator(hunter, { ...cfg, baseOverrides: overrides });
        return evalFast(b.talents, b.attributes, ITERATIONS);
      };

      const base = await evalWith(baseOverrides);
      console.log(`\n  level ${String(b.level).padStart(2)}  baseline loot ${base.lootPerMin.toExponential(4)}  stage ${base.avgStage.toFixed(2)}  killRate ${base.bossKillRate}`);

      for (const item of relicItems) {
        const key = `upgrades.relics.${item.id}`;
        const current = Number(baseOverrides[key] || 0);
        // Move it somewhere it is NOT already, in whichever direction has room.
        const cap = item.maxLevel || 8;
        const probe = current > 0 ? 0 : Math.min(cap, 8);
        if (probe === current) continue;

        const r = await evalWith({ ...baseOverrides, [key]: probe });
        const dLoot = r.lootPerMin - base.lootPerMin;
        const dStage = r.avgStage - base.avgStage;
        const dKill = (r.bossKillRate || 0) - (base.bossKillRate || 0);
        const moved = dLoot !== 0 || dStage !== 0 || dKill !== 0;
        const pct = base.lootPerMin ? (dLoot / base.lootPerMin) * 100 : 0;

        const v = verdict.get(item.id);
        if (moved) {
          v.moved = true;
          if (Math.abs(pct) > Math.abs(v.best)) { v.best = pct; v.note = `${current}->${probe} at level ${b.level}`; }
        }
        console.log(
          `    ${moved ? 'moves  ' : 'no-op  '} ${item.id.padEnd(6)} ${current}->${String(probe).padEnd(3)} `
          + `loot ${pct >= 0 ? '+' : ''}${pct.toFixed(4)}%  stage ${dStage >= 0 ? '+' : ''}${dStage.toFixed(3)}  kill ${dKill >= 0 ? '+' : ''}${dKill.toFixed(1)}`,
        );
      }
    }

    console.log(`\n  --- ${hunter} verdict ---`);
    for (const item of relicItems) {
      const v = verdict.get(item.id);
      console.log(`  ${v.moved ? 'REACHES THE SIM ' : 'NEVER MOVED IT '} ${item.id.padEnd(6)} `
        + (v.moved ? `best ${v.best >= 0 ? '+' : ''}${v.best.toFixed(3)}% loot (${v.note})` : '(across every fixture tried)')
        + `   ${item.label}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
