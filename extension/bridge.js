// The page cannot talk to the extension directly, and the extension cannot be reached from page
// JavaScript, so this content script sits between them and relays exactly one request.
//
// IT ANNOUNCES ITSELF IN THE CONSOLE, ON PURPOSE. "Nothing in the console" was previously
// indistinguishable from "the content script never ran", which is the single most likely thing to
// go wrong with an unpacked extension (wrong URL, wrong profile, not reloaded after install). One
// line at startup makes that unambiguous.
console.info('[cifi-bridge] companion content script active on', location.origin);

// THE MARKER MUST SURVIVE `document_start`, AND THE FIRST VERSION DID NOT.
//
// At document_start the script runs "before any other DOM is constructed", so
// `document.documentElement` can still be NULL -- and `document.documentElement.dataset = ...`
// then throws, killing the whole content script before the message listener is even registered.
// The page sees no marker and no bridge, which looks exactly like "the extension is not
// installed".
//
// `document.documentElement` is used rather than a `window` property because a content script runs
// in an ISOLATED WORLD: anything it assigns to `window` is invisible to the page. That part was
// right; the timing was not.
function mark() {
  const el = document.documentElement;
  if (!el) return false;
  el.dataset.cifiCompanionBridge = '1';
  return true;
}

if (!mark()) {
  // <html> does not exist yet. Watch for it rather than guessing at a delay -- a fixed timeout
  // would race the page's own first engine request on a fast load.
  const obs = new MutationObserver(() => { if (mark()) obs.disconnect(); });
  obs.observe(document, { childList: true, subtree: true });
  // Belt and braces: if the observer somehow misses it, these still fire before the page's
  // scripts run far enough to ask for the engine.
  document.addEventListener('readystatechange', mark, { once: false });
  document.addEventListener('DOMContentLoaded', mark, { once: true });
}

// Registered UNCONDITIONALLY and before anything that can throw, so a marker failure can never
// also cost us the listener.
window.addEventListener('message', (event) => {
  // Only this page, only our own request shape. A content script listens to every message the page
  // receives, including ones from embedded frames and other extensions.
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.type !== 'cifi-companion:get-engine' || typeof msg.id !== 'string') return;

  // The PATH comes from the page so a rename on cifi-tools' side is a site deploy rather than an
  // extension update. The background worker validates it against the one allowed origin -- the
  // page can choose WHICH wasm, never WHERE from.
  chrome.runtime.sendMessage({ type: 'cifi-companion:get-engine', path: msg.path }, (res) => {
    // A dead service worker or a revoked permission surfaces here as lastError with no response;
    // reporting it as a failed reply lets the app fall back rather than hang forever.
    const err = chrome.runtime.lastError;
    if (err) console.warn('[cifi-bridge] background worker did not answer:', err.message);
    window.postMessage({
      type: 'cifi-companion:engine',
      id: msg.id,
      ...(err ? { ok: false, error: err.message } : res),
    }, window.location.origin);
  });
});
