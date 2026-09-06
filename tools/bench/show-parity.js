'use strict';

// NOISE FLOOR, stated because a delta without one invites reading noise as signal:
//   a comparison of two FINAL_ITERATIONS scores carries ~0.3% (measured: 0.12% mean error each),
//   and the SEARCH varies ~7 percentage points across seeds -- one seed is ONE SAMPLE.
// A single-seed difference narrower than ~7 points is not evidence about a mechanism.
const rows = require(process.argv[2]);
rows.filter((r) => r.parity && r.parity !== 'match').forEach((r) => {
  console.log(`${r.hunter}/${r.set}#${r.index} lvl${r.level} ${r.mode} [${r.parity}]`);
  console.log(`   recorded ${r.expectedLootScore}`);
  console.log(`   clone    ${r.importLoot.toFixed(2)}   (${r.parityDeltaPct.toFixed(2)}%)`);
  console.log(`   note: ${r.note || '-'}`);
});
