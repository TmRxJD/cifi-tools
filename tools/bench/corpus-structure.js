'use strict';
// WHAT DO THE KNOWN-GOOD BUILDS ACTUALLY LOOK LIKE? Pure analysis of the build corpus.
//   node tools/bench/corpus-structure.js [--hunter=knox]
// No evaluations, no search, no randomness. Reads every fixture's decoded allocation and reports
// the STRUCTURE the community actually plays, per hunter, ordered by level.
const H = require('./harness.js');
const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY_HUNTER = opt('hunter', null);

(async () => {
  const known = H.loadKnownBuilds();
  const all = Object.values(known).flat();
  if (!all.length) throw new Error('corpus-structure: zero fixtures loaded -- an empty comparison is a failure');
  const byHunter = {};
  for (const fx of all) {
    if (ONLY_HUNTER && fx.hunter !== ONLY_HUNTER) continue;
    (byHunter[fx.hunter] = byHunter[fx.hunter] || []).push(fx);
  }
  for (const hunter of Object.keys(byHunter)) {
    const rows = [];
    for (const fx of byHunter[hunter]) {
      let b;
      try { b = await H.parseBuildCode(fx.code, fx.hunter); } catch (e) { continue; }
      rows.push({ name: fx.name, mode: fx.mode || 'loot', level: fx.level, t: b.talents, a: b.attributes });
    }
    rows.sort((x, y) => x.level - y.level);
    console.log(`=== ${hunter}  (${rows.length} builds, levels ${rows[0].level}-${rows[rows.length - 1].level}) ===`);
    const attrIds = [...new Set(rows.flatMap((r) => Object.keys(r.a)))];
    const talIds = [...new Set(rows.flatMap((r) => Object.keys(r.t)))];
    console.log('lvl  mode  ' + talIds.map((k) => k.slice(0, 5).padStart(6)).join('') + ' |'
      + attrIds.map((k) => k.slice(0, 5).padStart(6)).join(''));
    for (const r of rows) {
      console.log(String(r.level).padStart(3) + '  ' + r.mode.padEnd(5) + ' '
        + talIds.map((k) => String(r.t[k] || 0).padStart(6)).join('') + ' |'
        + attrIds.map((k) => String(r.a[k] || 0).padStart(6)).join(''));
    }
    console.log('');
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
