'use strict';
// ONE URL RESOLVER FOR OUR VISUAL ASSETS.
//
// The standalone app resolves relative `assets/...` paths beside index.html. A content script's
// DOM-relative path instead resolves beside cifi-tools.com's current route, which has none of our
// art. Embedded mode points at the already deployed app; artwork is not copied into extension/.
(function installAssetUrl(global) {
  global.assetUrl = function assetUrl(path) {
    if (typeof path !== 'string' || path.length === 0) throw new Error('assetUrl: path is required');
    const base = global.CIFI_ASSET_BASE || (typeof document !== 'undefined' ? document.baseURI : undefined);
    return new URL(path, base).href;
  };
})(typeof window !== 'undefined' ? window : globalThis);
