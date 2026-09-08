// Fetches cifi-tools.com's simulation engine INTO THE USER'S OWN BROWSER, on demand.
//
// WHY THIS EXTENSION EXISTS. The companion site is our own work -- save import, fleet and ship
// optimization, the hunter UI -- but the simulator itself is cifi-tools.com's compiled
// `release.wasm`, which is theirs. Committing it to a public repo and serving it from GitHub Pages
// is redistribution, so this moves the fetch to where it belongs: the user's browser, talking to
// the origin that owns the file, exactly as if they had opened cifi-tools.com themselves. Nothing
// is copied, cached to a server, or handed on.
//
// WHY IT HAS TO BE AN EXTENSION AND NOT PAGE JAVASCRIPT. cifi-tools.com sends no
// `Access-Control-Allow-Origin` header on any path -- measured on GET and on OPTIONS preflight, on
// `/`, `/wasm/release.wasm` and `/assets/`. So a page on our origin is blocked by CORS before its
// code ever sees the bytes. An extension with `host_permissions` is not, because the user
// installed it and granted that access explicitly.
//
// ============================================================================================
// THIS FILE IS DELIBERATELY DUMB, AND MUST STAY THAT WAY.
//
// It relays bytes. It contains no game logic, no optimizer, no UI, and no knowledge of what the
// engine does -- all of that lives on the website, which deploys independently and instantly. An
// extension update should be a rare event, and nothing about iterating on the tool should require
// one.
//
// DO NOT MAKE IT FETCH AND RUN CODE. Manifest V3 exists to eliminate remotely-hosted code; the
// Chrome Web Store and AMO both reject or remove extensions that execute code fetched at runtime.
// "Serve the extension's logic from a server so users never update" is specifically the pattern
// the policy forbids. Store-published extensions already auto-update within hours, so the problem
// it would solve does not exist.
//
// THE URL SCOPE IS A PATTERN, NOT ONE FIXED PATH, and that is the durability trade. Pinning
// `/wasm/release.wasm` exactly would mean an extension update -- and a store review -- the day
// cifi-tools renames or moves the file. Instead the PAGE says which file it wants and this worker
// validates it: same origin, https, and a `.wasm` path, nothing else. So a rename is handled by a
// site deploy alone.
//
// It is still not an open proxy. The page may only reach ONE origin, may only ask for WASM, and
// only pages matching the content script's `matches` can ask at all. The alternative -- accepting
// an arbitrary URL -- would hand any script on our origin the cross-origin read that the
// same-origin policy exists to withhold.
// ============================================================================================
const ENGINE_ORIGIN = 'https://cifi-tools.com';
const DEFAULT_ENGINE_PATH = '/wasm/release.wasm';

function resolveEngineUrl(requested) {
  if (!requested) return ENGINE_ORIGIN + DEFAULT_ENGINE_PATH;
  let url;
  try {
    // Resolved against the engine origin so a bare path works and an absolute URL is still
    // checked. `new URL` also normalises `..` traversal before the origin test, which a string
    // prefix check would not.
    url = new URL(requested, ENGINE_ORIGIN);
  } catch {
    throw new Error(`not a usable engine URL: ${requested}`);
  }
  if (url.origin !== ENGINE_ORIGIN) throw new Error(`refused: ${url.origin} is not ${ENGINE_ORIGIN}`);
  if (!url.pathname.endsWith('.wasm')) throw new Error(`refused: ${url.pathname} is not a .wasm path`);
  return url.href;
}

// Base64 because `chrome.runtime.sendMessage` serializes as JSON, which does not preserve an
// ArrayBuffer -- it arrives as `{}`, silently, and the caller sees a zero-length engine rather
// than an error. A plain number array survives but costs ~5x the bytes.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;   // String.fromCharCode overflows the stack on a 94KB spread
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'cifi-companion:get-engine') return false;

  let url;
  try {
    url = resolveEngineUrl(msg.path);
  } catch (err) {
    sendResponse({ ok: false, error: String(err.message || err) });
    return false;
  }

  fetch(url, { cache: 'force-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`cifi-tools.com returned HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => {
      // A WASM MODULE STARTS WITH \0asm. Checked here so a captive-portal login page or a Netlify
      // 404 body -- both of which arrive as a cheerful HTTP 200 -- fail HERE with a clear message
      // rather than downstream as an unreadable "invalid magic number" from WebAssembly.compile.
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      const isWasm = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
      if (!isWasm) throw new Error(`response was not a WebAssembly module (${buf.byteLength} bytes)`);
      sendResponse({ ok: true, base64: toBase64(buf), bytes: buf.byteLength, url });
    })
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));

  return true;   // keeps the message channel open for the async sendResponse
});
