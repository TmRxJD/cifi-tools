'use strict';
// Isolate where the scorer's cost actually goes: raw wasm outside the vm, vs the same call
// made through the browser sandbox.
const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const PUBLIC = path.join(__dirname, '../../webapp/public');

(async () => {
  const sb = H.browserSandbox();
  const known = H.loadKnownBuilds().borge;
  const build = await H.parseBuildCode(known[0].code);
  const cfg = H.cfgForImport('borge', build);

  // Args built by the canonical resolver, then called two ways.
  const state = {
    level: cfg.level, iterations: 100, hunterStats: cfg.hunterStats,
    talents: build.talents, attributes: build.attributes,
    overrides: cfg.baseOverrides, upgrades: cfg.globalUpgrades,
    gemPlannerStore: cfg.gemPlannerStore,
  };
  const args = await sb.HunterSim.buildArgs('borge', state);

  const buf = fs.readFileSync(path.join(PUBLIC, 'release.wasm'));
  const modOutside = await WebAssembly.compile(buf);
  const imp = { env: { abort: () => { throw new Error('abort'); } } };

  let t = Date.now();
  for (let i = 0; i < 200; i++) {
    const inst = await WebAssembly.instantiate(modOutside, imp);
    inst.exports.EVALBORGE_WASM(...args);
  }
  console.log(`raw node, fresh instance each call: ${((Date.now() - t) / 200).toFixed(2)} ms`);

  const inst = await WebAssembly.instantiate(modOutside, imp);
  t = Date.now();
  for (let i = 0; i < 200; i++) inst.exports.EVALBORGE_WASM(...args);
  console.log(`raw node, reused instance:          ${((Date.now() - t) / 200).toFixed(2)} ms`);

  const evalFast = await sb.HunterSim.compileEvaluator('borge', cfg);
  t = Date.now();
  for (let i = 0; i < 200; i++) await evalFast(build.talents, build.attributes, 100);
  console.log(`sandbox compileEvaluator:           ${((Date.now() - t) / 200).toFixed(2)} ms`);
})().catch((e) => { console.error(e); process.exit(1); });
