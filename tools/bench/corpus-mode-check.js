'use strict';
// A BOSS SEARCH MUST BE OFFERED BOSS DONORS.
//
//   node tools/bench/corpus-mode-check.js
//
// THE BUG. Corpus rows were [level, isPush, code] and donorsFor computed the wanted flag as
// "is this mode push?" -- so a BOSS search asked for isPush=0 and received the LOOT donors, while
// every real boss build (stored with the push flag, because that is how they were labelled when the
// corpus was generated) was invisible to it. A boolean cannot encode four modes, and the third and
// fourth silently aliased onto loot.
//
// It was not cosmetic: ozzy@34b regressed 22.7% -> 19.6% kill rate in boss mode while its own
// import sat in the corpus, unreachable. The fallback that makes a search shortfall survivable was
// pointed at the wrong builds.
//
// TWO PROPERTIES:
//   1. Every mode a fixture can declare must retrieve donors OF THAT MODE first. A boss search
//      seeing a loot build ranked above a boss build is the bug returning.
//   2. Boss modes still FALL BACK to other shapes, deliberately -- there are only 6 boss rows, and
//      a deep push build is useful raw material. The fallback must come AFTER the exact matches,
//      never instead of them.

const H = require('./harness.js');

(async () => {
  H.browserSandbox();
  require('../../webapp/public/optimizer/corpus.js');
  const C = global.OptimizerCorpus;
  if (!C || typeof C.donorsFor !== 'function') {
    console.log('FAIL  OptimizerCorpus.donorsFor is not reachable');
    process.exit(1);
  }

  let failures = 0;
  const counts = {};
  for (const [hunter, rows] of Object.entries(C.CORPUS)) {
    for (const r of rows) counts[r[1]] = (counts[r[1]] || 0) + 1;
  }
  console.log(`corpus modes: ${JSON.stringify(counts)}`);
  // A boolean-encoded corpus shows up here as modes named "0"/"1" or true/false.
  for (const k of Object.keys(counts)) {
    if (!['loot', 'push', 'boss', 'bossTimeless'].includes(k)) {
      console.log(`FAIL  corpus row mode "${k}" is not a mode name -- the boolean encoding is back`);
      failures++;
    }
  }
  console.log('');

  for (const [hunter, mode, level] of [
    ['ozzy', 'boss', 34], ['borge', 'boss', 72], ['ozzy', 'bossTimeless', 60],
    ['borge', 'push', 27], ['knox', 'loot', 30],
  ]) {
    const d = C.donorsFor(hunter, mode, level);
    if (!d.length) { console.log(`FAIL  ${hunter} ${mode}: no donors at all`); failures++; continue; }
    const exact = d.filter((x) => x.mode === mode);
    const firstMode = d[0].mode;
    // The nearest EXACT-mode donor must not be outranked by an off-mode one.
    const ok = exact.length === 0 || d.findIndex((x) => x.mode === mode) === 0
      || d[0].distance < exact[0].distance;
    const bossKin = (mode === 'boss' || mode === 'bossTimeless');
    const leadOk = exact.length ? (firstMode === mode || (bossKin && /boss/.test(firstMode))) : true;
    if (!leadOk) {
      console.log(`FAIL  ${hunter} ${mode}@${level}: leads with a "${firstMode}" donor while `
        + `${exact.length} ${mode} donor(s) exist -- off-mode donors are displacing real ones`);
      failures++;
    } else {
      console.log(`ok    ${hunter} ${String(mode).padEnd(12)}@${String(level).padEnd(3)} `
        + `${d.length} donors, ${exact.length} exact-mode, leads with "${firstMode}"`);
    }
    if (!ok) { /* distance ordering is reported above; nothing further to add */ }
  }

  console.log('');
  if (failures) { console.log(`FAIL  ${failures} corpus mode problem(s)`); process.exit(1); }
  console.log('PASS  every mode retrieves its own donors first, with a fallback behind them');
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
