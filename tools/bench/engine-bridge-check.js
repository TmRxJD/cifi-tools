'use strict';
// THE PAGE HALF OF THE COMPANION EXTENSION PROTOCOL.
//
//   node tools/bench/engine-bridge-check.js
//
// WHY THIS EXISTS AND WHY IT MATTERS MORE THAN IT LOOKS. `engineFromExtension()` decides where the
// simulation engine comes from: the companion extension (the user's own browser fetching
// cifi-tools' file) or a local copy served from our origin. If it regresses, the app does not
// break -- it silently falls back and serves the very copy the extension exists to avoid
// redistributing. A silent fallback to the wrong source is exactly the failure that would go
// unnoticed for months.
//
// The EXTENSION half (a CORS-exempt fetch from a service worker) cannot be tested here or in the
// Browser pane -- neither has extension support, and `chrome.runtime` does not exist. That half
// needs a real Chrome with the unpacked extension loaded. What IS ours and IS testable is the
// protocol the page speaks, so that is pinned here:
//
//   1. bridge present and answering  -> the engine comes from the BRIDGE, and release.wasm is
//                                       never fetched
//   2. bridge absent                 -> falls back to the local file
//   3. bridge present but failing    -> falls back rather than throwing
//
// Every case asserts on WHETHER release.wasm WAS FETCHED, not just on the bytes returned. Two
// sources that hand back the same engine are indistinguishable by their output -- and "did we
// serve their file" is the entire question this check exists to answer.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -- ${detail}`}`);
};

const PUBLIC = path.join(__dirname, '..', '..', 'webapp', 'public');
const WASM = fs.readFileSync(path.join(PUBLIC, 'release.wasm'));

// A distinguishable stand-in for "the bytes the extension handed us". It is NOT a real module --
// nothing here compiles it -- because what is under test is the SOURCE SELECTION, not WebAssembly.
const BRIDGE_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0xBB, 0xBB, 0xBB, 0xBB]);

/**
 * Load hunterSimBrowser.js under a fake window/document and drive the bridge protocol.
 * `bridge` is null (not installed), or a function returning the reply the content script would
 * post back.
 */
function scenario({ bridge }) {
  const fetched = [];
  const listeners = [];
  let cachedInner = null;
  const innerWindow = () => (cachedInner || (cachedInner = vm.runInContext('window', sandbox)));
  const sandbox = {
    console, WebAssembly, TextEncoder, TextDecoder, URL, URLSearchParams, performance,
    setTimeout, clearTimeout,
    HUNTERSIM_ASSET_BASE: 'https://huntersim.local/',
    location: { href: 'https://huntersim.local/', origin: 'https://huntersim.local' },
    // Records every asset the page asks OUR origin for -- the observation the checks below rest on.
    fetch: async (url) => {
      const name = String(url).replace('https://huntersim.local/', '').split('?')[0];
      fetched.push(name);
      const file = path.join(PUBLIC, name);
      if (!fs.existsSync(file)) return { ok: false, status: 404 };
      const buf = fs.readFileSync(file);
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(buf.toString('utf8')),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    // The marker lives on document.documentElement.dataset because a content script runs in an
    // ISOLATED WORLD -- a `window` property it sets is invisible to the page. Modelling that
    // faithfully is the point; a fake that used `window` would pass while the real thing failed.
    document: { documentElement: { dataset: bridge ? { cifiCompanionBridge: '1' } : {} } },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.addEventListener = (type, fn) => { if (type === 'message') listeners.push(fn); };
  sandbox.removeEventListener = (type, fn) => {
    const i = listeners.indexOf(fn);
    if (type === 'message' && i !== -1) listeners.splice(i, 1);
  };
  sandbox.postMessage = (data) => {
    // The page posts its request; a content script would relay it and post the reply back. Async,
    // because the real one crosses a process boundary and a synchronous fake would hide ordering
    // bugs.
    if (!bridge || !data || data.type !== 'cifi-companion:get-engine') return;
    const reply = bridge(data);
    if (!reply) return;
    setTimeout(() => {
      // `source` MUST be the context's OWN `window`, not the outer sandbox object.
      // `vm.createContext` wraps the sandbox in a global proxy, so the two are NOT identical --
      // measured: passing the outer object gives `s === window` false, passing the inner one gives
      // true. The page's first guard is `if (event.source !== window) return;`, so a fake that
      // passes the outer object is silently ignored and the whole bridge path reads as broken.
      // That cost an investigation into correct code.
      listeners.slice().forEach((fn) => fn({ source: innerWindow(), data: reply }));
    }, 0);
  };

  vm.createContext(sandbox);
  for (const f of ['hunterDefs.js', 'hunterSimBrowser.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, fetched };
}

const okReply = (req) => ({
  type: 'cifi-companion:engine',
  id: req.id,
  ok: true,
  base64: BRIDGE_BYTES.toString('base64'),
});

(async () => {
  // ---- 1. bridge present and answering -------------------------------------------------------
  {
    const { sandbox, fetched } = scenario({ bridge: okReply });
    let sourceBytes = null;
    // compile is stubbed so the check can assert on the BYTES CHOSEN rather than needing a real
    // module -- the decision is what is under test.
    sandbox.WebAssembly = { compile: async (buf) => { sourceBytes = Buffer.from(buf); return { stub: true }; } };
    await sandbox.HunterSim.loadWasmModule();
    check('bridge present: engine comes from the BRIDGE',
      sourceBytes && sourceBytes.equals(BRIDGE_BYTES), `got ${sourceBytes && sourceBytes.length} bytes`);
    check('bridge present: release.wasm is NEVER fetched from our origin',
      !fetched.includes('release.wasm'), `fetched ${JSON.stringify(fetched)}`);
  }

  // ---- 2. bridge absent ----------------------------------------------------------------------
  {
    const { sandbox, fetched } = scenario({ bridge: null });
    let sourceBytes = null;
    sandbox.WebAssembly = { compile: async (buf) => { sourceBytes = Buffer.from(buf); return { stub: true }; } };
    await sandbox.HunterSim.loadWasmModule();
    check('no bridge: falls back to the local file',
      fetched.includes('release.wasm'), `fetched ${JSON.stringify(fetched)}`);
    check('no bridge: the local file is what gets compiled',
      sourceBytes && sourceBytes.length === WASM.length, `got ${sourceBytes && sourceBytes.length}`);
  }

  // ---- 3. bridge present but failing ----------------------------------------------------------
  // An installed extension whose fetch failed (offline, cifi-tools down, permission revoked) must
  // DEGRADE, not throw -- the user still has a working tool, just from the local copy.
  {
    const { sandbox, fetched } = scenario({
      bridge: (req) => ({ type: 'cifi-companion:engine', id: req.id, ok: false, error: 'simulated failure' }),
    });
    sandbox.WebAssembly = { compile: async () => ({ stub: true }) };
    let threw = null;
    try { await sandbox.HunterSim.loadWasmModule(); } catch (e) { threw = String(e.message || e); }
    check('bridge fails: does not throw', threw === null, threw);
    check('bridge fails: falls back to the local file', fetched.includes('release.wasm'),
      `fetched ${JSON.stringify(fetched)}`);
  }

  // ---- 4. the reply must be MATCHED, not merely received --------------------------------------
  // A stale or unrelated `cifi-companion:engine` message (another tab's reply, a second in-flight
  // request) must be ignored, or a slow response could be satisfied by the wrong bytes.
  {
    const { sandbox } = scenario({
      bridge: (req) => ({ type: 'cifi-companion:engine', id: `${req.id}-WRONG`, ok: true,
        base64: BRIDGE_BYTES.toString('base64') }),
    });
    let sourceBytes = null;
    sandbox.WebAssembly = { compile: async (buf) => { sourceBytes = Buffer.from(buf); return { stub: true }; } };
    // The mismatched id is ignored, so this resolves only via the 15s timeout falling back.
    const settled = await Promise.race([
      sandbox.HunterSim.loadWasmModule().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still waiting'), 1500)),
    ]);
    check('a reply with a mismatched id is ignored', settled === 'still waiting',
      `resolved early from ${sourceBytes && sourceBytes.length} bytes`);
  }

  console.log('');
  if (failures) {
    console.log(`FAIL  ${failures} problem(s): the engine source selection is wrong.`);
    process.exit(1);
  }
  console.log('PASS  the bridge is preferred, absence and failure both fall back, ids are matched');
})().catch((e) => { console.error(e); process.exit(1); });
