// The page cannot talk to the extension directly, and the extension cannot be reached from page
// JavaScript, so this content script sits between them and relays exactly one request.
//
// It announces itself SYNCHRONOUSLY at document_start by setting a marker on the page's own
// window, so the app can decide which engine source to use without waiting on a round trip that
// may never be answered. `document.documentElement.dataset` is used rather than a `window`
// property because a content script's `window` is an ISOLATED WORLD -- assigning
// `window.cifiCompanionBridge` here would be invisible to the page, which is the classic way this
// pattern silently does nothing.
document.documentElement.dataset.cifiCompanionBridge = '1';

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
    window.postMessage({
      type: 'cifi-companion:engine',
      id: msg.id,
      ...(err ? { ok: false, error: err.message } : res),
    }, window.location.origin);
  });
});
