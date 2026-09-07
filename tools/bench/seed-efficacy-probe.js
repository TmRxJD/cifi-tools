'use strict';
// IS THE SEED ACTUALLY WORKING? Start the climb FROM the import and see whether it stays.
//
//   node tools/bench/seed-efficacy-probe.js --only=borge@42
//
// THE QUESTION. borge@42 sits at -0.68% even when the search is seeded with real community builds.
// Either (a) the import is a local optimum our move set cannot reach from elsewhere, or (b) the
// seeding is not doing what it claims and the climb never gets near it. Those need opposite fixes,
// and a score alone cannot tell them apart.
//
// FOUR MEASUREMENTS, each of which isolates one link in the chain:
//
//   1. IS THE IMPORT A LOCAL OPTIMUM? Climb starting FROM the import. If the climb walks away and
//      ends LOWER, the objective or the move set is broken -- a hill climber must never leave a
//      point it cannot beat. If it stays, the import is a genuine local optimum.
//   2. HOW FAR IS THE BEST DONOR FROM THE IMPORT? Point-differences per node. A donor 80 moves away
//      is a different build; one 6 moves away that still loses says the climb is the problem.
//   3. WHAT DOES THE CLIMB ACTUALLY REACH from the donor, and where does it stop?
//   4. IS THE IMPORT REACHABLE from the donor at all -- does a monotone path exist, or is there a
//      valley between them?
//
// This is diagnosis. It prescribes nothing and prints what it finds.

const H = require('./harness.js');
const M = require('./measurement.js');
const R = require('./refit.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = opt('only', 'borge@42');
const ITERS = 1000;
const NEIGHBORHOODS = [1, 2, 8];

function capOf(d) { return d.maxLevel === null || d.maxLevel === undefined ? Infinity : d.maxLevel; }

(async () => {
  const known = H.loadKnownBuilds();
  const flat = Object.values(known).flat();

  for (const name of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
    const fx = H.findFixture(known, name);
    const build = await H.parseBuildCode(fx.code, fx.hunter);
    const cfg = H.cfgForImport(fx.hunter, build, { budgetMode: 'spend' });
    const mode = fx.mode || 'loot';
    const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
    const legal = (t, a) => M.legalityOf(H, cfg, t, a).ok;
    const pooled = await H.makePooledScorer(cfg, mode);

    try {
      const importScore = (await pooled.score([{ talentAlloc: build.talents, attrAlloc: build.attributes }], ITERS))[0];
      console.log(`=== ${name} (${mode}) ===`);
      console.log(`  import score ${importScore.toFixed(0)}`);

      // ---- the climb, from an arbitrary start ------------------------------------------------
      const climb = async (t0, a0, label) => {
        let cur = { t: { ...t0 }, a: { ...a0 } };
        cur.v = (await pooled.score([{ talentAlloc: cur.t, attrAlloc: cur.a }], ITERS))[0];
        const start = cur.v;
        let evals = 1;
        let k = 0;
        let moves = 0;
        while (k < NEIGHBORHOODS.length && evals < 4000) {
          const chunk = NEIGHBORHOODS[k];
          const cands = [];
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
                cands.push({ talentAlloc: pair.t, attrAlloc: pair.a });
              }
            }
          }
          if (!cands.length) { k++; continue; }
          const sc = await pooled.score(cands, ITERS);
          evals += cands.length;
          let bi = -1;
          for (let i = 0; i < sc.length; i++) if (sc[i] > cur.v + 1e-9 && (bi < 0 || sc[i] > sc[bi])) bi = i;
          if (bi < 0) { k++; continue; }
          cur = { t: cands[bi].talentAlloc, a: cands[bi].attrAlloc, v: sc[bi] };
          moves++;
          k = 0;
        }
        console.log(`  ${label.padEnd(28)} ${start.toFixed(0).padStart(12)} -> ${cur.v.toFixed(0).padStart(12)}`
          + `  (${(100 * (cur.v - importScore) / importScore).toFixed(2)}% vs import)  ${moves} move(s), ${evals} evals`);
        return cur;
      };

      // 1. FROM THE IMPORT ITSELF. A hill climber must never end below where it started.
      const fromImport = await climb(build.talents, build.attributes, 'climb FROM the import');
      if (fromImport.v < importScore - 1e-6) {
        console.log('  *** THE CLIMB LEFT THE IMPORT AND ENDED LOWER -- move set or objective is broken ***');
      } else if (fromImport.v > importScore * 1.003) {
        console.log('  => the import is NOT a local optimum: the climb improves on it from where it sits');
      } else {
        console.log('  => the import IS a local optimum under this move set');
      }

      // 2/3. From the best legal donor, and how far that donor is from the import.
      const donors = flat.filter((f) => f.hunter === fx.hunter && (f.mode || 'loot') === mode && f.uid !== fx.uid);
      let best = null;
      for (const d of donors) {
        let db; try { db = await H.parseBuildCode(d.code, d.hunter); } catch (e) { continue; }
        const a = R.refitTiered(cfg.ATTRIBUTES, minVal, cfg.ATTRIBUTE_BUDGET, db.attributes);
        const t = R.refitTalents(cfg.TALENTS, cfg.TALENT_BUDGET, db.talents);
        if (!a || !t || !legal(t, a)) continue;
        const v = (await pooled.score([{ talentAlloc: t, attrAlloc: a }], ITERS))[0];
        if (!best || v > best.v) best = { v, t, a, from: d.name || d.uid };
      }
      if (best) {
        const dist = (cur, goal, defs) => defs.reduce((n, dd) => n + Math.abs((cur[dd.id] || 0) - (goal[dd.id] || 0)), 0);
        const dA = dist(best.a, build.attributes, cfg.ATTRIBUTES);
        const dT = dist(best.t, build.talents, cfg.TALENTS);
        console.log(`  best donor ${best.from}: ${best.v.toFixed(0)} `
          + `(${(100 * (best.v - importScore) / importScore).toFixed(2)}% vs import), `
          + `${dA + dT} point-differences from the import (${dA} attr, ${dT} talent)`);
        await climb(best.t, best.a, 'climb FROM the best donor');
      }

      // 4. What does the import have that our answer does not?
      console.log(`  import attrs : ${JSON.stringify(build.attributes)}`);
      console.log(`  import talent: ${JSON.stringify(build.talents)}`);
      if (best) {
        console.log(`  donor  attrs : ${JSON.stringify(best.a)}`);
        console.log(`  donor  talent: ${JSON.stringify(best.t)}`);
      }
      console.log('');
    } finally { await pooled.destroy(); }
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
