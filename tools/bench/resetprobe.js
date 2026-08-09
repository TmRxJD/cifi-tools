'use strict';
// Can one instance be reset to its pristine state by restoring linear memory, instead of
// re-instantiating? If yes, evaluation stays exactly deterministic without churning through
// thousands of WASM instances (each of which reserves a large guard region and OOMs the
// browser at high levels).
const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

(async () => {
  const sb = H.browserSandbox();
  const code = process.argv[2] || '2gtWM2cw3G1rc6ejDzAJTm1Yk7Kt212cW8w5E1R3efugcPnbYzpocBUeK1';
  const build = await H.parseBuildCode(code);
  const cfg = H.cfgForImport(build.hunter, build);
  const args = await sb.HunterSim.buildArgs(build.hunter, {
    level: cfg.level, hunterStats: cfg.hunterStats, talents: build.talents,
    attributes: build.attributes, overrides: cfg.baseOverrides,
    upgrades: cfg.globalUpgrades, gemPlannerStore: cfg.gemPlannerStore, iterations: 1000,
  });
  const exportName = { borge: 'EVALBORGE_WASM', ozzy: 'EVALOZZY_WASM', knox: 'EVALKNOX_WASM' }[build.hunter];

  const buf = fs.readFileSync(path.join(__dirname, '../../webapp/public/release.wasm'));
  const mod = await WebAssembly.compile(buf);
  const imp = { env: { abort: () => { throw new Error('abort'); } } };

  // Ground truth: fresh instance every call.
  const fresh = [];
  for (let i = 0; i < 4; i++) {
    const inst = await WebAssembly.instantiate(mod, imp);
    fresh.push(inst.exports[exportName](...args));
  }

  // Candidate: one instance, memory snapshot restored before each call.
  const inst = await WebAssembly.instantiate(mod, imp);
  const snapshot = new Uint8Array(inst.exports.memory.buffer.slice(0));
  const restored = [];
  for (let i = 0; i < 4; i++) {
    try {
      if (i > 0) {
        const mem = new Uint8Array(inst.exports.memory.buffer);
        mem.fill(0);
        mem.set(snapshot);
      }
      restored.push(inst.exports[exportName](...args));
    } catch (err) {
      restored.push(`ABORT@${i}:${err.message}`);
      break;
    }
  }

  // Control: one instance, no reset at all.
  const inst2 = await WebAssembly.instantiate(mod, imp);
  const drifting = [];
  for (let i = 0; i < 4; i++) drifting.push(inst2.exports[exportName](...args));

  console.log('fresh instance :', fresh.join(' | '));
  console.log('memory-restored:', restored.join(' | '));
  console.log('no reset       :', drifting.join(' | '));
  const allSame = (a) => a.every((v) => v === a[0]);
  console.log('\nfresh deterministic       :', allSame(fresh));
  console.log('restored deterministic    :', allSame(restored));
  console.log('restored matches fresh    :', restored[0] === fresh[0]);
})().catch((e) => { console.error(e); process.exit(1); });
