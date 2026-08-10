'use strict';
// Does a relic override actually reach the wasm ARGUMENT VECTOR?
//
// relic-sweep.js found that r7 (Borge and Ozzy), r19 (Borge) and t2r5 (Knox) leave every output
// bit-identical. That has two very different explanations:
//   (a) the value is passed and the game genuinely does not use it for these outputs, or
//   (b) our param resolver silently drops it, and the relic is simply unwired.
// (b) would be our bug. Distinguish them by diffing the argument vector itself.
//
//   node tools/bench/relic-arg-probe.js

const H = require('./harness.js');

(async () => {
  const sb = H.browserSandbox();
  let problems = 0;

  for (const hunter of ['borge', 'ozzy', 'knox']) {
    const defs = sb.HUNTER_DEFS[hunter];
    const items = (defs.globalUpgrades.relics && defs.globalUpgrades.relics.items) || [];
    console.log(`\n${hunter}:`);
    for (const item of items) {
      const key = `upgrades.relics.${item.id}`;
      const state = { hunterStats: {}, talents: {}, attributes: {}, upgrades: {}, overrides: {}, level: 60 };
      const a = await sb.HunterSim.buildArgs(hunter, { ...state, overrides: { [key]: 0 } });
      const b = await sb.HunterSim.buildArgs(hunter, { ...state, overrides: { [key]: 7 } });
      const changed = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
      const ok = changed.length === 1;
      if (!ok) problems++;
      console.log(`  ${ok ? 'passed to wasm' : 'NOT PASSED   '}  ${item.id.padEnd(6)} `
        + `arg indices changed: [${changed.join(', ')}]  (expected exactly one)`);
    }
  }

  console.log(`\n${problems ? `${problems} relic(s) never reach the argument vector -- that is a wiring bug`
    : 'every declared relic reaches the wasm argument vector'}`);
  process.exit(problems ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
