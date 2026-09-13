'use strict';
// Companion runtime configuration. This is the FIRST content script so every vendored file sees
// embedded mode before it initialises. Embedded mode evaluates only through cifi-tools' own
// evaluation worker (HunterSim.createNativeEvaluator): the extension never fetches, compiles,
// ships, or proxies any copy of release.wasm.
window.HUNTERSIM_EMBEDDED = true;
window.CIFI_ASSET_BASE = 'https://tmrxjd.github.io/cifi-tools/';
