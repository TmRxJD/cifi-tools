'use strict';

// This world owns ONLY the added tool contents. The MAIN-world adapter owns integration with
// Vue Router. Native pages never pass through the copied website router or its page root.
(() => {
  // The MAIN-world registry crosses worlds as inert JSON, like the import-store bridge.
  const pages = () => {
    const registry = document.getElementById('cifi-companion-navigation')?.dataset.routes;
    if (!registry) throw new Error('Host route registry is not ready');
    return JSON.parse(registry);
  };
  let mounted = null;
  function renderPage() {
    const panel = document.querySelector('[data-cifi-companion-page]');
    if (!panel) { mounted = null; return; }
    const page = panel.dataset.cifiCompanionPage;
    const definition = pages().find(p => p.id === page);
    const name = definition?.renderer;
    if (!name || typeof window[name] !== 'function') throw new Error(`Companion renderer unavailable: ${page}`);
    mounted = panel;
    window.HUNTERSIM_ROUTE = definition.route;
    window.refreshStoreFromNative?.();
    panel.replaceChildren();
    try { window[name](panel); }
    catch (error) {
      console.error('[cifi-companion] render failed', page, error);
      panel.textContent = `Unable to render ${page}: ${error.message}`;
    }
  }
  document.addEventListener('cifi-companion:page-mounted', renderPage);
  document.addEventListener('cifi-companion:page-unmounted', () => { mounted = null; });
  window.refreshEmbeddedCompanionPage = () => {
    if (mounted?.isConnected) renderPage();
  };
  window.navigateEmbeddedCompanion = (route) => {
    const nativePaths = {gems:'/upgrades/gems',settings:'/settings'};
    const path = pages().find(p => p.route === route)?.path || nativePaths[route]
      || (route.startsWith('upgrades/') ? `/${route}` : null);
    if (!path) throw new Error(`Unknown embedded destination: ${route}`);
    const request = document.getElementById('cifi-companion-navigation');
    if (!request) throw new Error('Host router adapter is not ready');
    request.textContent = path;
    document.dispatchEvent(new Event('cifi-companion:navigate'));
  };
  document.addEventListener('cifi-companion:import', () => window.openCompanionSaveImport());
  document.addEventListener('cifi-companion:sidebar-mounted', () => window.startCompanionBridgeStatus());
  document.dispatchEvent(new Event('cifi-companion:request-host-state'));
  // Handshake also covers a MAIN-world mount that completed before these scripts finished.
  document.dispatchEvent(new Event('cifi-companion:client-ready'));
})();
