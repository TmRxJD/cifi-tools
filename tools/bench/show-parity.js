'use strict';
const rows = require(process.argv[2]);
rows.filter((r) => r.parity && r.parity !== 'match').forEach((r) => {
  console.log(`${r.hunter}/${r.set}#${r.index} lvl${r.level} ${r.mode} [${r.parity}]`);
  console.log(`   recorded ${r.expectedLootScore}`);
  console.log(`   clone    ${r.importLoot.toFixed(2)}   (${r.parityDeltaPct.toFixed(2)}%)`);
  console.log(`   note: ${r.note || '-'}`);
});
