'use strict';
// PRECOMPUTE A STARTING POPULATION FOR THE ARCHIVE -- STRUCTURES ONLY, NEVER SCORES.
//
// A build's score depends on the account's ~91 sim params, not on its level, which is why scoring
// a level-13 fixture under a maxed account read +237% when the truth was +35%. So this ships WHICH
// allocations to try; the user's own state decides what they are worth. Shipping a score here
// would institutionalise that bug.
//
// Stored as support set + per-node PROPORTIONS as well as raw levels, because budgets are near
// continuous and a library keyed to exact point counts would miss almost everyone. A consumer
// scales the shape to the user's budget.
//
//   node tools/bench/build-archive-seeds.js [--hunter=borge] [--out=...] [--effort=complete]
//
// RESUMABLE: writes after every fixture and skips what is already present, because this takes
// hours and long runs in this repo get killed part way through. Re-invoke the same command.
//
// NOTE ON ORDER: this does NOT fix borge@73. A seeded deep-and-killing build is discarded on the
// first generation for the same reason the search's own is -- boss damage is not a descriptor. The
// descriptor fix is a prerequisite for seeding to pay off, not an alternative to it.

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const HUNTER = opt('hunter', null);
const OUT = path.join(__dirname, '../..', opt('out', 'tools/reference/archive-seeds.json'));
const EFFORT = opt('effort', 'complete');

const support = (alloc) => Object.keys(alloc).filter((k) => (alloc[k] || 0) > 0).sort();
const proportions = (alloc) => {
  const total = Object.values(alloc).reduce((s, v) => s + (v || 0), 0) || 1;
  const out = {};
  for (const k of Object.keys(alloc)) if (alloc[k] > 0) out[k] = +(alloc[k] / total).toFixed(6);
  return out;
};

(async () => {
  let done = [];
  if (fs.existsSync(OUT)) {
    try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).seeds || []; } catch (e) { done = []; }
  }
  const seen = new Set(done.map((d) => d.uid));

  const known = H.loadKnownBuilds();
  const hunters = HUNTER ? [HUNTER] : ['borge', 'ozzy', 'knox'];
  const todo = [];
  for (const h of hunters) for (const fx of known[h]) if (!seen.has(fx.uid)) todo.push({ h, fx });

  console.log(`${todo.length} fixture(s) to do, ${done.length} already present -> ${OUT}`);

  for (const { h, fx } of todo) {
    const t0 = Date.now();
    let row;
    try {
      const build = await H.parseBuildCode(fx.code, h);
      const cfg = H.cfgForImport(h, build, { budgetMode: 'spend' });
      // No incumbent: the seed must be something the SEARCH found, not the user's own build handed
      // back. A library of imports would only teach the archive what it was already given.
      const bare = { ...cfg };
      delete bare.currentTalents;
      delete bare.currentAttrs;
      const pooled = await H.makePooledScorer(bare, fx.mode || 'loot');
      try {
        const res = await H.Optimizer.optimize(bare, { mode: fx.mode || 'loot', scorer: pooled.score, effort: EFFORT });
        const got = await H.evaluateAllocation(cfg, res.best.talentAlloc, res.best.attrAlloc);
        const d = H.Objective.describeRun(got);
        row = {
          uid: fx.uid, name: fx.name, hunter: h, level: build.level, mode: fx.mode || 'loot',
          talentBudget: cfg.TALENT_BUDGET, attributeBudget: cfg.ATTRIBUTE_BUDGET,
          talentSupport: support(res.best.talentAlloc), attrSupport: support(res.best.attrAlloc),
          talentAlloc: res.best.talentAlloc, attrAlloc: res.best.attrAlloc,
          talentProportions: proportions(res.best.talentAlloc),
          attrProportions: proportions(res.best.attrAlloc),
          // Regime, NOT score -- a regime is a property of the shape and travels; a score does not.
          regime: d.regime, killsBoss: d.killsBoss, reachesBoss: d.reachesBoss,
          secs: Math.round((Date.now() - t0) / 1000),
        };
      } finally { await pooled.destroy(); }
    } catch (e) {
      row = { uid: fx.uid, name: fx.name, hunter: h, error: String((e && e.message) || e) };
    }
    done.push(row);
    fs.writeFileSync(OUT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      note: 'STRUCTURES ONLY. Scores depend on account sim params and must never be shipped here.',
      effort: EFFORT, seeds: done,
    }, null, 1));
    console.log(`${row.name || row.uid} ${row.error ? 'ERR ' + row.error : (row.regime + ' ' + row.secs + 's')}  (${done.length})`);
  }
  console.log('done');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
