'use strict';
// Print the last sweep's results.json in a readable table. Optional filter: mode or hunter.
//   node tools/bench/show.js [push|loot|borge|ozzy|knox]
const results = require('./results.json');
const filter = process.argv[2];

for (const r of results) {
  if (filter && r.mode !== filter && r.hunter !== filter) continue;
  if (!r.ok) { console.log(`${r.hunter}/${r.set}#${r.index}: ERROR ${r.error.split('\n')[0]}`); continue; }
  const parityNote = r.parity === 'match' ? '' : `  [parity ${r.parity} vs recorded ${r.expectedLootScore}: ${r.parityDeltaPct.toFixed(2)}%]`;
  console.log(
    `${r.hunter}/${r.set}#${r.index} lvl${r.level} ${r.mode}`
    + `  loot ${r.importLoot.toFixed(2)} -> ${r.optimizedLoot.toFixed(2)} (${r.lootDeltaPct >= 0 ? '+' : ''}${r.lootDeltaPct.toFixed(2)}%)`
    + `  stage ${r.importStage.toFixed(2)} -> ${r.optimizedStage.toFixed(2)} (${r.stageDeltaPct >= 0 ? '+' : ''}${r.stageDeltaPct.toFixed(2)}%)`
    + parityNote,
  );
}
