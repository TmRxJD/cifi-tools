'use strict';
// WHERE THE SIMULATION ENGINE COMES FROM, per hosting mode.
//
//   node tools/bench/engine-source-check.js
//
// `release.wasm` is cifi-tools' build output, not ours. The contract:
//
//   1. website (not embedded) -> fetches release.wasm from our own origin; a failed fetch THROWS
//      naming the URL rather than falling back to anything.
//   2. embedded in cifi-tools.com (the extension) -> NO engine is fetched or compiled at all.
//      Every evaluation goes to the site's own evaluation worker. This replaced "fetch THEIR wasm
//      and compile it" on 2026-09-13 for two measured reasons: the Chrome Web Store counts remotely
//      loaded wasm as remote code, and the site's live engine takes 106/94/99 arguments against our
//      params.json's 101/89/91 -- so that path was feeding their engine misaligned inputs.
//
// Case 2 asserts on what was REQUESTED and POSTED, not on the numbers returned: the question is
// "did the extension run an engine of its own", and output cannot answer it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const PUBLIC = path.join(__dirname, '..', '..', 'webapp', 'public');
const WORKER_URL = '/assets/evaluationWorker-TEST.js';
// Shape measured from the live worker on 2026-09-13 (Borge, 9 final stats).
const NATIVE_BORGE = {
  lootPerMin: 5, avgStage: 10, avgTime: 2, minStage: 9, maxStage: 11, bossHpPercent: 0, bossKillRate: 0,
  mat1: 1, mat2: 2, mat3: 3, xp: 7, minXp: 6, maxXp: 8, deathDistribution: [],
  stats: '43,3,0.02,0,0.01,0.04,0.05,1.3,5',
  stageDistribution: [{ stage: 10, count: 4, percentage: 100 }],
};
const STATE = {
  level: 30, iterations: 100, hunterStats: {}, talents: {}, attributes: {}, overrides: {},
  upgrades: { loopmods: { roe: 20000 } }, gemPlannerStore: { gemStates: {} },
};

function scenario({ embedded = false, failFetch = false, registry = true, nativeResult = NATIVE_BORGE }) {
  const fetched = [];
  const posted = [];
  const compiled = [];
  const workers = [];
  const sandbox = {
    console, URL, setTimeout, clearTimeout, queueMicrotask,
    HUNTERSIM_ASSET_BASE: 'https://huntersim.local/',
    location: { href: 'https://huntersim.local/', origin: 'https://huntersim.local' },
    fetch: async (url) => {
      const u = String(url);
      fetched.push(u);
      if (failFetch) return { ok: false, status: 503 };
      const file = path.join(PUBLIC, u.replace('https://huntersim.local/', '').split('?')[0]);
      if (!fs.existsSync(file)) return { ok: false, status: 404 };
      const buf = fs.readFileSync(file);
      return { ok: true, status: 200,
        json: async () => JSON.parse(buf.toString('utf8')),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    },
    document: {
      getElementById: (id) => (registry && id === 'cifi-companion-navigation'
        ? { dataset: { evaluationWorkerUrl: WORKER_URL } } : null),
    },
    Worker: class {
      constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; workers.push(this); }
      postMessage(msg) {
        posted.push({ url: this.url, msg });
        queueMicrotask(() => this.onmessage({ data: { id: msg.id, type: 'RAW', value: nativeResult } }));
      }
      terminate() {}
    },
    WebAssembly: { compile: async (buf) => { compiled.push(buf.byteLength); return { stub: true }; } },
  };
  if (embedded) sandbox.HUNTERSIM_EMBEDDED = true;
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  for (const f of ['hunterDefs.js', 'hunterSimBrowser.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), sandbox, { filename: f });
  }
  return { HunterSim: sandbox.HunterSim, fetched, posted, compiled, workers };
}

const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e); } };

(async () => {
  // ---- 1. the website: our own copy, loudly ---------------------------------------------------
  {
    const s = scenario({});
    await s.HunterSim.loadWasmModule();
    check('website: fetches our own release.wasm',
      s.fetched.some((u) => u.startsWith('https://huntersim.local/') && u.includes('release.wasm')), JSON.stringify(s.fetched));
    check('website: engineSource reports "local"', s.HunterSim.engineSource() === 'local', s.HunterSim.engineSource());
  }
  {
    const s = scenario({ failFetch: true });
    const threw = await rejects(() => s.HunterSim.loadWasmModule());
    check('website: a failed engine fetch THROWS', threw !== null);
    check('website: the error names the url it tried', !!threw && threw.includes('release.wasm'), threw);
  }

  // ---- 2. embedded: the site's own worker, and no engine of ours ------------------------------
  {
    const s = scenario({ embedded: true });
    const loadErr = await rejects(() => s.HunterSim.loadWasmModule());
    check('embedded: loading a local engine THROWS', loadErr !== null && loadErr.includes('own worker'), loadErr);

    const r = await s.HunterSim.evaluate('borge', STATE);
    check('embedded: evaluate posts to the site\'s evaluation worker',
      s.posted.length === 1 && s.posted[0].url === WORKER_URL && s.posted[0].msg.path[0] === 'evaluate',
      JSON.stringify(s.posted.map((p) => [p.url, p.msg.path])));
    const args = s.posted[0] && s.posted[0].msg.argumentList.map((a) => a.value);
    check('embedded: hunter, build and iterations reach the worker',
      !!args && args[0] === 'borge' && args[1].level === 30 && args[2].hunterIterations.borge === 100,
      JSON.stringify(args && [args[0], args[1], args[2].hunterIterations]));
    check('embedded: XP is NOT re-multiplied (the worker already applies roe)', r.xp === 7, `xp ${r.xp}`);
    check('embedded: loot passes through unchanged', r.lootPerMin === 5, `lootPerMin ${r.lootPerMin}`);

    const d = await s.HunterSim.evaluateDetailed('borge', STATE);
    check('embedded: final stats map by the worker\'s getter order',
      d.finalStats.MaxHp === 43 && d.finalStats.CritRate === 0.05 && d.finalStats.CritPower === 1.3 && d.finalStats.Reload === 5,
      JSON.stringify(d.finalStats));
    check('embedded: stage distribution keeps stage and count',
      d.stageDistribution.length === 1 && d.stageDistribution[0].stage === 10 && d.stageDistribution[0].count === 4,
      JSON.stringify(d.stageDistribution));

    check('embedded: no wasm was fetched', !s.fetched.some((u) => u.includes('.wasm')), JSON.stringify(s.fetched));
    check('embedded: nothing was compiled', s.compiled.length === 0, `${s.compiled.length} compile(s)`);
    check('embedded: engineSource reports "native"', s.HunterSim.engineSource() === 'native', s.HunterSim.engineSource());
    check('embedded: our params.json is never fetched', !s.fetched.some((u) => u.includes('params.json')), JSON.stringify(s.fetched));
    const paramsErr = await rejects(() => s.HunterSim.loadParams());
    check('embedded: loading params.json THROWS', !!paramsErr && paramsErr.includes('params.json'), paramsErr);
  }

  // ---- 2b. embedded card evaluations overlap, within a bound ---------------------------------
  {
    const s = scenario({ embedded: true });
    const four = await Promise.all([1, 2, 3, 4].map(() => s.HunterSim.evaluate('borge', STATE)));
    check('embedded: concurrent evaluations spread over at most 3 workers',
      four.every((r) => r.lootPerMin === 5) && s.workers.length === 3, `${s.workers.length} worker(s)`);
    await s.HunterSim.evaluate('borge', STATE);
    check('embedded: an idle pool is reused, not grown', s.workers.length === 3, `${s.workers.length} worker(s)`);
  }

  // ---- 3. embedded failures are loud -----------------------------------------------------------
  {
    const s = scenario({ embedded: true, nativeResult: { ...NATIVE_BORGE, stats: '1,2' } });
    const threw = await rejects(() => s.HunterSim.evaluateDetailed('borge', STATE));
    check('embedded: a final-stat count mismatch THROWS', !!threw && threw.includes('2 final stats'), threw);
  }
  {
    const s = scenario({ embedded: true });
    const threw = await rejects(() => s.HunterSim.evaluate('borge', { ...STATE, iterations: undefined }));
    check('embedded: missing iterations THROWS', !!threw && threw.includes('iterations'), threw);
  }
  {
    const s = scenario({ embedded: true, registry: false });
    const threw = await rejects(() => s.HunterSim.evaluate('borge', STATE));
    check('embedded: no worker registry THROWS', !!threw && threw.includes('worker URL is unavailable'), threw);
  }

  console.log('');
  if (failures) {
    console.log(`FAIL  ${failures} problem(s): the engine source contract is broken.`);
    process.exit(1);
  }
  console.log('PASS  the website loads its own copy loudly; the extension runs no engine of its own');
})().catch((e) => { console.error(e); process.exit(1); });
