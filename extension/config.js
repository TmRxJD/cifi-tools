'use strict';
// Companion runtime configuration. This is the FIRST content script so every vendored file sees
// embedded mode before it initialises. Keep engine bytes on cifi-tools.com's own origin: the
// extension must never ship, proxy, or fall back to this project's copy of release.wasm.
window.HUNTERSIM_EMBEDDED = true;
window.HUNTERSIM_ASSET_BASE = chrome.runtime.getURL('vendor/');
window.HUNTERSIM_ENGINE_URL = 'https://cifi-tools.com/wasm/release.wasm';
window.CIFI_ASSET_BASE = 'https://tmrxjd.github.io/cifi-tools/';
