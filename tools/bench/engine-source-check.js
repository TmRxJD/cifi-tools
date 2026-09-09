'use strict';
// WHERE THE SIMULATION ENGINE IS LOADED FROM.
//
//   node tools/bench/engine-source-check.js
//
// WHY THIS MATTERS MORE THAN IT LOOKS. `release.wasm` is cifi-tools' build output, not ours. The
// companion extension exists so their page loads their engine from their own server -- if that
// selection regresses, nothing breaks visibly: the app keeps working and quietly serves the very
// copy the extension exists to avoid redistributing. A silent fallback to the wrong source is
// exactly the failure that goes unnoticed for months, so it is pinned here.
//
// Replaces `engine-bridge-check.js`, which tested a postMessage bridge that no longer exists. That
// design put a content script on OUR origin and relayed their wasm across origins to defeat CORS;
// running inside cifi-tools.com makes their engine same-origin, so the relay was deleted rather
// than maintained. The CONTRACT under test is what survived:
//
//   1. no override        -> fetches release.wasm from our own origin (the website)
//   2. HUNTERSIM_ENGINE_URL set -> fetches THAT, and release.wasm is NEVER requested (embedded)
//   3. the fetch fails    -> throws naming the URL, rather than silently falling back
//
// Case 2 asserts on WHICH URL WAS REQUESTED, not on the bytes returned: two sources handing back
// the same engine are indistinguishable by their output, and "did we serve their file" is the
// entire question.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const PUBLIC = path.join(__dirname, '..', '..', 'webapp', 'public');
const THEIR_URL = 'https://cifi-tools.com/wasm/release.wasm';
// Distinguishable stand-in bytes. Not a real module -- nothing here compiles one, because what is
// under test is the SOURCE SELECTION rather than WebAssembly.
const THEIR_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0xBB, 0xBB, 0xBB, 0xBB]);

function scenario({ engineUrl, failFetch }) {
  const fetched = [];
  const sandbox = {
    console, TextEncoder, TextDecoder, URL, URLSearchParams, performance,
    setTimeout, clearTimeout,
    HUNTERSIM_ASSET_BASE: 'https://huntersim.local/',
    location: { href: 'https://huntersim.local/', origin: 'https://huntersim.local' },
    document: { documentElement: { dataset: {} } },
    fetch: async (url) => {
      const u = String(url);
      fetched.push(u);
      if (failFetch) return { ok: false, status: 503 };
      if (u === THEIR_URL) {
        return { ok: true, status: 200,
          arrayBuffer: async () => THEIR_BYTES.buffer.slice(0, THEIR_BYTES.length) };
      }
      const name = u.replace('https://huntersim.local/', '').split('?')[0];
      const file = path.join(PUBLIC, name);
      if (!fs.existsSync(file)) return { ok: false, status: 404 };
      const buf = fs.readFileSync(file);
      return { ok: true, status: 200,
        json: async () => JSON.parse(buf.toString('utf8')),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    },
  };
  if (engineUrl) sandbox.HUNTERSIM_ENGINE_URL = engineUrl;
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  let compiled = null;
  sandbox.WebAssembly = { compile: async (buf) => { compiled = Buffer.from(buf); return { stub: true }; } };

  vm.createContext(sandbox);
  for (const f of ['hunterDefs.js', 'hunterSimBrowser.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, fetched, compiled: () => compiled };
}

(async () => {
  // ---- 1. the website: no override -----------------------------------------------------------
  {
    const s = scenario({});
    await s.sandbox.HunterSim.loadWasmModule();
    check('no override: fetches our own release.wasm',
      s.fetched.some((u) => u.includes('release.wasm') && u.startsWith('https://huntersim.local/')),
      JSON.stringify(s.fetched));
    check('no override: engineSource reports "local"',
      s.sandbox.HunterSim.engineSource() === 'local', s.sandbox.HunterSim.engineSource());
  }

  // ---- 2. embedded: their origin serves it ----------------------------------------------------
  {
    const s = scenario({ engineUrl: THEIR_URL });
    await s.sandbox.HunterSim.loadWasmModule();
    check('override set: fetches THEIR url', s.fetched.includes(THEIR_URL), JSON.stringify(s.fetched));
    check('override set: OUR release.wasm is NEVER requested',
      !s.fetched.some((u) => u.startsWith('https://huntersim.local/') && u.includes('release.wasm')),
      JSON.stringify(s.fetched));
    check('override set: those bytes are what gets compiled',
      s.compiled() && s.compiled().equals(THEIR_BYTES), `${s.compiled() && s.compiled().length} bytes`);
    check('override set: engineSource reports "origin"',
      s.sandbox.HunterSim.engineSource() === 'origin', s.sandbox.HunterSim.engineSource());
  }

  // ---- 3. failure is LOUD, not a silent fallback ----------------------------------------------
  // A fallback here would re-serve our copy the moment their server hiccuped -- quietly undoing the
  // entire point of the extension. It must fail instead.
  {
    const s = scenario({ engineUrl: THEIR_URL, failFetch: true });
    let threw = null;
    try { await s.sandbox.HunterSim.loadWasmModule(); } catch (e) { threw = String(e.message || e); }
    check('a failed engine fetch THROWS rather than falling back', threw !== null);
    check('the error names the url it tried', !!threw && threw.includes(THEIR_URL), threw);
    check('no fallback request to our own origin was made',
      !s.fetched.some((u) => u.startsWith('https://huntersim.local/') && u.includes('release.wasm')),
      JSON.stringify(s.fetched));
  }

  console.log('');
  if (failures) {
    console.log(`FAIL  ${failures} problem(s): the engine source selection is wrong.`);
    process.exit(1);
  }
  console.log('PASS  the override is honoured, our copy is never fetched under it, failure is loud');
})().catch((e) => { console.error(e); process.exit(1); });
