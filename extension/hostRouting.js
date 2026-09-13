'use strict';

// The native Vue router remains the only history owner. This adapter adds route records and
// uses the site's own UpgradesSidebar component, including its filtering, icons and active links.
// No native route record is replaced and no DOM child of a RouterView is hidden or removed.
(() => {
  const pages = window.CifiCompanionRoutes;
  const emit = (name) => document.dispatchEvent(new Event(`cifi-companion:${name}`));
  const fail = (error) => console.error('[cifi-companion] host integration failed:', error);
  async function start() {
    const app = document.getElementById('app')?.__vue_app__;
    if (!app?._container?._vnode?.component) return false;
    const router = app.config.globalProperties.$router;
    if (!router?.addRoute || !router?.afterEach) throw new Error('Native Vue Router API is unavailable');
    await router.isReady();
    const script = [...document.scripts].find(s => s.type === 'module' && /\/assets\/index-[^/]+\.js$/.test(s.src));
    if (!script) throw new Error('Native entry module is unavailable');
    const nativeSource = await (await fetch(script.src)).text();
    const workerUrls = [...new Set(nativeSource.match(/\/assets\/evaluationWorker-[A-Za-z0-9_-]+\.js/g) || [])];
    if (workerUrls.length !== 1) {
      throw new Error(`Native evaluation worker contract changed (found ${workerUrls.length})`);
    }
    // Import the already-loaded same-origin module; no third-party code is copied or hosted.
    const native = await import(script.src);
    if (native.__tla) await native.__tla;
    // Use the live site's own per-hunter resource definitions. The three modules are identified
    // by semantic currency labels, never by minified export names or revisioned asset hashes.
    const hunterModules=Object.values(native).filter(value=>value?.LOOT_ICONS && value?.CURRENCY_LABELS);
    const moduleFor=(label)=>hunterModules.find(value=>Object.values(value.CURRENCY_LABELS).includes(label));
    const resourceAssets={
      borge:moduleFor('Obsidian')?.LOOT_ICONS,
      ozzy:moduleFor('Farahite Ore')?.LOOT_ICONS,
      knox:moduleFor('Glacium')?.LOOT_ICONS,
    };
    if (Object.values(resourceAssets).some(icons=>!icons?.mat1 || !icons?.mat2 || !icons?.mat3)) {
      throw new Error('Native hunter resource asset contract changed');
    }
    const Sidebar = Object.values(native).find(value => value?.__name === 'UpgradesSidebar');
    const definitions = Object.values(native).find(value => Array.isArray(value?.upgradeCategories) && Array.isArray(value?.hunters));
    const hunterDefinitions = Object.values(native).find(value => Array.isArray(value)
      && value.length === 3 && value.every(hunter => hunter?.id && hunter?.image));
    // The host's lazy UpgradesLayout imports `f` as createVNode. Validate its result rather than
    // silently using a minified export with a different meaning after a site deployment.
    const vnode = native.f;
    if (!Sidebar || !definitions || typeof vnode !== 'function'
      || vnode('div').__v_isVNode !== true) throw new Error('Native component contract changed');
    const root = app._container._vnode.component;
    const utility = definitions.upgradeCategories.find(g => g.name === 'Utility Upgrades');
    const core = definitions.upgradeCategories.find(g => g.name === 'Core Upgrades');
    const premium = definitions.upgradeCategories.find(g => g.name === 'Premium');
    if (!utility || !core || !premium) throw new Error('Native upgrade category contract changed');
    const nativeLink = (page, icon) => ({label:page.label,path:page.path,icon});
    const relicIcon = core.links.find(l => l.path === '/upgrades/relics').icon;
    const milestoneIcon = utility.links.find(l => l.path === '/upgrades/shardmilestones').icon;
    const crownIcon = premium.links.find(l => l.path === '/upgrades/ultima').icon;
    const researchPage = pages.find(page => page.id === 'research');
    const badgesPage = pages.find(page => page.id === 'badges');
    const shipsPage = pages.find(page => page.id === 'ships');
    const gearPage = pages.find(page => page.id === 'gear');
    const fleetPage = pages.find(page => page.id === 'fleet');
    utility.links.push(nativeLink(researchPage, milestoneIcon), nativeLink(badgesPage, crownIcon));
    definitions.upgradeCategories.splice(definitions.upgradeCategories.indexOf(premium), 0, {
      name:'Fleet', links:[nativeLink(shipsPage, relicIcon),nativeLink(gearPage, crownIcon)],
    });

    // Native layouts instantiate this same component. Make one persistent instance at the app
    // layout level and let the route-local instances render nothing. Its original setup/render
    // still owns ALL category filtering and its subscriptions to the native gem store.
    // Do not add props to the already-mounted native definition: Vue caches normalized props
    // on first use, so direct /upgrades/* loads would reject them while /home loads accepted them.
    // Preserve the original options/setup under a fresh component identity before suppressing
    // route-local instances. Both boot orders now run exactly the same native implementation.
    const mountBridgeStatus = (aside) => {
      if (!(aside instanceof HTMLElement) || aside.querySelector('#bridgeStatusSidebar')) return;
      const status = document.createElement('div');
      status.id = 'bridgeStatusSidebar';
      status.className = 'hidden sticky bottom-0 mt-auto mx-3 mb-3 px-2.5 py-2 rounded-lg bg-gray-800 border border-gray-700/50 text-xs flex items-center gap-2 cursor-pointer z-10';
      status.title = 'Import save from device';
      status.setAttribute('role','button');
      status.tabIndex = 0;
      status.innerHTML = '<span id="bridgeStatusDot" class="inline-block w-2 h-2 rounded-full bg-gray-500"></span>'
        + '<span id="bridgeStatusText" class="flex flex-col min-w-0">'
        + '<span id="bridgeStatusConnection">CIFI Bridge</span><span id="bridgeStatusDevice"></span></span>';
      // The status belongs to the native sidebar it describes. A sibling below the sidebar had
      // its own layout and lifecycle, which made it visibly behave like a second overlapping bar.
      aside.append(status);
      status.onclick=()=>emit('import');
      status.onkeydown=(event)=>{ if(event.key==='Enter' || event.key===' '){event.preventDefault();emit('import');} };
      emit('sidebar-mounted');
    };
    const PersistentSidebar = {
      name:'CompanionNativeSidebar',
      props:{enabled:Boolean},
      mounted(){ mountBridgeStatus(this.$el); },
      updated(){ mountBridgeStatus(this.$el); },
      // Additions fall through to the original component's root <aside>; there is no parallel
      // wrapper or separately laid-out status panel.
      render(){ return vnode(Sidebar,{class:'cifi-native-sidebar',hidden:!this.enabled}); },
    };
    const originalRender = root.render;
    root.render = function(...args) {
      const tree = originalRender.apply(this,args);
      // App has one direct main RouterView. Preserve that VNode and its component identity;
      // Vue itself reconciles the added layout wrapper and native sidebar.
      if (!Array.isArray(tree.children)) throw new Error('Native App children changed');
      const at = tree.children.findIndex(child => child?.type === 'main');
      if (at < 0) throw new Error('Native App main outlet changed');
      tree.children = tree.children.slice();
      tree.children[at] = vnode('div',{class:'cifi-native-layout',key:'cifi-native-layout'},[
        vnode(PersistentSidebar,{key:'cifi-native-sidebar',enabled:
          router.currentRoute.value.path.startsWith('/companion/')
            && localStorage.getItem('huntersim_hunter_sidebar') !== 'false'}),tree.children[at],
      ]);
      // The compiled block tracks only the old children. A changed block must be fully patched
      // by Vue, otherwise its optimized path skips our wrapper on subsequent navigations.
      tree.dynamicChildren = null;
      return tree;
    };

    const navigation = document.createElement('script');
    navigation.id = 'cifi-companion-navigation';
    navigation.type = 'application/json';
    navigation.dataset.routes = JSON.stringify(pages);
    navigation.dataset.evaluationWorkerUrl = workerUrls[0];
    navigation.dataset.resourceAssets = JSON.stringify(resourceAssets);
    navigation.dataset.hunterAssets = JSON.stringify(Object.fromEntries((hunterDefinitions || []).map(hunter=>[hunter.id,hunter.image])));
    document.documentElement.append(navigation);
    const Page = (page) => ({
      name:`Companion_${page.id}`,
      mounted(){ emit('page-mounted'); },
      beforeUnmount(){ emit('page-unmounted'); },
      render(){ return vnode('div',{class:'cifi-companion'},[
        vnode('div',{id:'pageRoot','data-cifi-companion-page':page.id,class:'flex-1 min-w-0 px-0.5 pb-4'}),
      ]); },
    });
    for (const page of pages) {
      if (router.hasRoute(`cifi-${page.id}`)) throw new Error(`Route already registered: ${page.id}`);
      router.addRoute({path:page.path,name:`cifi-${page.id}`,component:Page(page)});
    }
    document.addEventListener('cifi-companion:navigate', () => {
      const path = navigation.textContent;
      if (!path.startsWith('/') || path.startsWith('//')) return;
      router.push(path).catch(fail);
    });
    document.addEventListener('click', event => {
      const link = event.target.closest?.('a[data-cifi-route]');
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      router.push(link.getAttribute('href')).catch(fail);
    });
    // Reuse the native Settings toggle and storage key, not a second preference.
    let sidebarPreference = localStorage.getItem('huntersim_hunter_sidebar');
    const syncSidebarVisibility = () => {
      const sidebar = document.querySelector('.cifi-native-sidebar');
      if (sidebar) sidebar.hidden = !router.currentRoute.value.path.startsWith('/companion/')
        || localStorage.getItem('huntersim_hunter_sidebar') === 'false';
    };
    const syncSidebarPreference = () => {
      const next = localStorage.getItem('huntersim_hunter_sidebar');
      if (next !== sidebarPreference) { sidebarPreference=next; syncSidebarVisibility(); }
    };
    document.addEventListener('click',()=>queueMicrotask(syncSidebarPreference));
    window.addEventListener('storage',syncSidebarPreference);

    // Header additions clone native link treatment; native anchors and their Vue listeners stay
    // intact. Reconciliation only visits our marked group, never every aside or routed page.
    function mountHeader() {
      const nav = document.querySelector('header nav');
      if (!nav) return;
      const template = nav.querySelector('a[href="/upgrades"]');
      if (!template) return;
      let group = nav.querySelector('[data-cifi-header-group]');
      if (!group) {
        group = template.parentElement.cloneNode(false);
        group.dataset.cifiHeaderGroup = '';
        const hunterPage = pages.find(page => page.id === 'sim');
        for (const page of [hunterPage,fleetPage]) {
          const link = template.cloneNode(true);
          // The deployed reference presents these two group labels without an upgrade icon.
          link.querySelector('svg')?.remove();
          link.href = page.path;
          link.dataset.cifiRoute = page.id;
          link.removeAttribute('aria-current');
          link.classList.remove('router-link-active','router-link-exact-active');
          const caption = link.querySelector('span');
          if (caption) caption.textContent = page.label;
          else { link.textContent = page.label; }
          group.append(link);
        }
        nav.insertBefore(group,template.parentElement);
      }
      // THE HIGHLIGHT MUST USE THE CLASSES THAT ACTUALLY PAINT IT. This only toggled
      // `router-link-active`, which on cifi-tools.com is a marker with no styling of its own: the
      // native nav's active look comes from a Vue class binding, measured on the live site as
      // `bg-gray-700 text-white shadow-sm` against `text-gray-300 hover:text-white` when inactive.
      // So Hunters and Fleet never visibly lit up. Both sets are toggled explicitly -- the clone's
      // template may itself have been the active link when it was copied.
      // Matching the standalone site: Hunters for the hunter page, Fleet for the Fleet page only.
      const ACTIVE = ['router-link-active','router-link-exact-active','bg-gray-700','text-white','shadow-sm'];
      const INACTIVE = ['text-gray-300','hover:text-white'];
      const path = router.currentRoute.value.path;
      for (const link of group.querySelectorAll('a')) {
        const active = path === link.getAttribute('href');
        ACTIVE.forEach((c) => link.classList.toggle(c, active));
        INACTIVE.forEach((c) => link.classList.toggle(c, !active));
      }
      const signIn = [...document.querySelectorAll('header button')].find(b => b.textContent.trim() === 'Sign In');
      if (signIn && !document.getElementById('cifi-import-button')) {
        const button = document.createElement('button');
        button.id = 'cifi-import-button';
        button.type = 'button';
        button.title = 'Import Save';
        button.setAttribute('aria-label','Import Save');
        button.className = 'flex items-center justify-center px-3 py-1.5 rounded-full bg-gradient-to-r from-green-600 to-green-800 text-white shadow-lg';
        button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2 M7 11l5 5l5 -5 M12 4l0 12"/></svg>';
        button.onclick = () => emit('import');
        signIn.parentElement.parentElement.insertBefore(button,signIn.parentElement);
      }
    }

    let queued = false;
    const scheduleHeader = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {queued=false;mountHeader();});
    };
    new MutationObserver(scheduleHeader).observe(document.querySelector('header'),{childList:true,subtree:true});
    router.afterEach(() => {
      // The persistent sidebar is enabled only for companion routes. The native root does not
      // otherwise depend on route state, so Vue has no reason to re-run this injected render
      // wrapper when moving between a native and companion page unless we request the update.
      root.update();
      requestAnimationFrame(syncSidebarVisibility);
      scheduleHeader();
    });
    document.addEventListener('cifi-companion:client-ready', () => {
      if (document.querySelector('[data-cifi-companion-page]')) emit('page-mounted');
      if (document.getElementById('bridgeStatusSidebar')) emit('sidebar-mounted');
    });
    root.update();
    requestAnimationFrame(syncSidebarVisibility);
    mountHeader();
    // Direct requests reach the server's SPA shell before our added route records exist. Rematch
    // only an exact added path. Native paths and their query strings remain untouched.
    if (pages.some(p => p.path === location.pathname)) await router.replace(location.pathname+location.search);
    document.documentElement.dataset.cifiRouterReady = 'true';
    return true;
  }
  // Host boot is asynchronous. A bounded observer waits for the app instance, then disconnects.
  let starting = false;
  const observer = new MutationObserver(tryStart);
  async function tryStart() {
    if (starting || !document.getElementById('app')?.__vue_app__?._container?._vnode?.component) return;
    starting = true;
    observer.disconnect();
    try { await start(); } catch(error) { fail(error); }
  }
  observer.observe(document.documentElement,{childList:true,subtree:true});
  tryStart();
})();
