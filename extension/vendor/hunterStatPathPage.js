// Hunter "Effective Path" modals -- mirrors shipsPage.js's openLoadoutDetail
// checklist/confirm-up-to-here pattern, but split into one column PER MATERIAL RESOURCE
// (mat1/mat2/mat3, plus Ozzy's separate inscription currency HBM where relevant): these are
// independent currencies that never compete with each other, so each column is its own
// self-contained ordered queue of the next N recommended purchases, with its own confirm
// state, computed by greedyPurchasePath (hunterStatPathBrowser.js).
//
// Two entry points:
//  - openHunterStatPathModal(): from the Hunter Stats modal -- base stats only.
//  - openBuildEffectivePathModal(build): from a build card's toolbar -- base stats AND this
//    hunter's inscription levels, scored using THAT build's own talents/attributes as the sim
//    context.
(function () {
  const TARGET_STEPS = 10;

  // A build (or the no-build fallback) with no talent/attribute points actually spent is a
  // bare, untalented character -- none of a real account's talent/attribute loot multipliers
  // apply, so its simulated farm rate massively understates real income. Timing must be
  // withheld whenever this is true.
  function hasMeaningfulAllocation(talents, attributes) {
    return Object.values(talents || {}).some((v) => v > 0) || Object.values(attributes || {}).some((v) => v > 0);
  }

  // Allocations live per build, not per account. The user chooses which one to plan for;
  // silently using the first Active build used to make this a plan for an arbitrary loadout.
  function getBaselineBuild(build) {
    if (!build || !Number.isFinite(build.level)) throw new Error('Choose a saved build with a level before calculating a path.');
    const talents = structuredClone(build.talents);
    const attributes = structuredClone(build.attributes);
    // A purchase plan starts from owned account upgrades. Imported hypothetical overrides must
    // not become owned levels, either in scoring or in the farming rate used to price the plan.
    return { level: build.level, talents, attributes, overrides: {}, real: hasMeaningfulAllocation(talents, attributes) };
  }

  // Commit a confirmed purchase to the right place. Relics and inscriptions are ACCOUNT-wide
  // (store.globalUpgrades); only base stats are per-hunter. This used to be a two-branch
  // if/else where anything that wasn't an inscription fell through to hunterStats -- which
  // silently wrote confirmed RELIC levels into the hunter's stat sheet once relics joined the
  // path. Enumerate the kinds and throw on an unknown one instead of having a catch-all branch.
  function applyStepToStore(hunter, r) {
    if (r.kind === 'inscryption') { store.globalUpgrades[`inscryptions.${r.key}`] = r.level; return; }
    if (r.kind === 'relic') { store.globalUpgrades[`relics.${r.key}`] = r.level; return; }
    if (r.kind === 'stat') { store[hunter].hunterStats[r.key] = r.level; return; }
    throw new Error(`applyStepToStore: unknown purchase kind "${r.kind}"`);
  }

  // Widen the shared titledModal shell for this feature -- multiple columns of purchase rows
  // need more than the default max-w-5xl to avoid squeezing labels.
  function widenModal(overlay) {
    const box = overlay.firstElementChild;
    if (box) { box.classList.remove('max-w-5xl'); box.classList.add('max-w-7xl'); }
  }

  /**
   * At most ONE Effective Path computation per modal, cancelled when it stops being wanted.
   *
   * Two ways it stops being wanted, and both used to leak a running walk:
   *   - the user closes the modal (or reopens it, which replaces the overlay -- `titledModal`
   *     dispatches `modal-close` for that too);
   *   - the user picks a different objective, which supersedes the run already in progress.
   *
   * A leaked walk is invisible but not free: it keeps evaluating, competing with the visible run
   * for the main thread and for wasm instantiation, so each abandoned run makes the next one
   * slower. Returns a function that aborts the previous run and hands back a fresh signal.
   */
  function abortableRuns(overlay) {
    let current = null;
    overlay.addEventListener('modal-close', () => {
      if (current) current.abort();
      current = null;
    });
    return () => {
      if (current) current.abort();
      current = new AbortController();
      return current.signal;
    };
  }

  /** An abort is the user's own doing, so it is not an error to report to them. */
  const isAbort = (err) => window.HunterSim.isAbort(err);

  // Same visual language as the existing talent/attribute Optimize progress dialog
  // (#optimizeProgressModal in index.html: purple progress bar, gray-900/50 stat tiles) so
  // both features' "something is computing" states read as one consistent system.
  function renderProgressPanel(resources) {
    return `
    <div class="py-4">
      <div class="text-white font-semibold mb-3 text-center">Calculating Effective Path…</div>
      <div class="space-y-3 max-w-md mx-auto">
        ${resources.map((r) => `
        <div data-progress-row="${r}">
          <div class="flex justify-between text-xs text-gray-400 mb-1">
            <span data-progress-label></span>
          </div>
          <div class="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
            <div data-progress-fill class="bg-purple-500 h-3 transition-all" style="width:0%"></div>
          </div>
          <div class="text-xs text-gray-400 mt-1 text-right" data-progress-text>0 / ${TARGET_STEPS}</div>
        </div>`).join('')}
      </div>
    </div>`;
  }

  function bindProgressLabels(overlay, hunter, resources) {
    const CF = window.CostFormulas;
    resources.forEach((r) => {
      const label = overlay.querySelector(`[data-progress-row="${r}"] [data-progress-label]`);
      if (label) label.textContent = CF.resourceLabel(hunter, r) || r;
    });
  }

  function updateProgress(overlay, resource, done, total) {
    const row = overlay.querySelector(`[data-progress-row="${resource}"]`);
    if (!row) return;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    row.querySelector('[data-progress-fill]').style.width = `${pct}%`;
    row.querySelector('[data-progress-text]').textContent = `${done} / ${total}`;
  }

  // Renders one independent per-resource column with its own confirm state.
  function renderColumn(colEl, resource, colResult, rates, rowLabel, hunter, onChange, confirmedUpTo) {
    confirmedUpTo = confirmedUpTo ?? -1;
    const CF = window.CostFormulas;
    let cumHours = 0;
    const rows = colResult.steps.map((s, i) => {
      const hours = rates ? IncomeModel.hoursToAfford(s.cost, rates.perHour, resource) : null;
      cumHours = hours === null ? null : cumHours + hours;
      return { ...s, i, hours, cumHours };
    });

    const label = CF.resourceLabel(hunter, resource) || resource;

    const renderRows = () => rows.map((r) => {
      const rl = rowLabel(r);
      const confirmed = r.i <= confirmedUpTo;
      const timeHtml = r.hours === null ? ''
        : `<span title="Time to save for just this purchase">${IncomeModel.fmtHours(r.hours)}</span>
           <span class="text-gray-600">·</span>
           <span class="text-sky-400" title="Cumulative time from now">${IncomeModel.fmtHours(r.cumHours)}</span>`;
      return `
      <li data-path-item="${r.i}" class="py-1.5 px-2 rounded ${confirmed ? 'bg-emerald-900/20' : 'hover:bg-gray-700/40 cursor-pointer'} border-b border-gray-700/40 text-xs">
        <div class="flex items-start gap-1.5">
          <span class="text-gray-500 w-4 text-right shrink-0">${r.i + 1}</span>
          <span class="text-white font-medium">${escapeHtml(rl)} → ${r.level}</span>
        </div>
        ${r.metric ? `<div class="text-emerald-300 mt-1 pl-[22px]">${escapeHtml(r.metric)}${r.metric.endsWith('unlocked') || r.metric.endsWith('reached') ? '' : ` +${Number(r.gain).toPrecision(3)}`}</div>` : ''}
        <div class="flex items-center justify-between gap-1.5 mt-1 pl-[22px]">
          <span class="text-amber-400 font-medium">${CF.fmtBig(r.cost)}</span>
          <div class="flex items-center gap-1.5">
            <span class="text-gray-400 flex items-center gap-1.5">${timeHtml}</span>
            <button data-confirm-to="${r.i}" class="${confirmed ? '' : 'hidden'} w-5 h-5 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white items-center justify-center text-[10px]" title="I've bought up to here -- update my real levels">✓</button>
          </div>
        </div>
      </li>`;
    }).join('') || '<div class="text-gray-400 text-xs py-4 text-center">No measured improving purchase in this planning window. Several purchases together may behave differently.</div>';

    colEl.innerHTML = `
      <div class="flex items-center gap-1.5 mb-2 font-semibold text-white text-sm">${matIcon(resource)}${escapeHtml(label)}</div>
      ${!rates || !Number.isFinite(rates.perHour[resource]) || rates.perHour[resource] <= 0 ? '<p class="text-xs text-amber-300 mb-2">Income unknown: timing and the planning window cannot be applied to this currency.</p>' : ''}
      <ul data-rows class="space-y-0"></ul>`;
    const rowsEl = colEl.querySelector('[data-rows]');
    rowsEl.innerHTML = renderRows();

    // Click a row to reveal its confirm checkmark (only one revealed at a time, same pattern
    // as the ship Effective Path); clicking the checkmark commits every purchase up to and
    // including that row into real stored state.
    rowsEl.querySelectorAll('[data-path-item]').forEach((li) => {
      const i = Number(li.dataset.pathItem);
      if (i <= confirmedUpTo) return; // already confirmed rows keep their checkmark visible, no toggling
      li.onclick = () => {
        rowsEl.querySelectorAll('[data-confirm-to]').forEach((b) => { if (Number(b.dataset.confirmTo) > confirmedUpTo) { b.classList.add('hidden'); b.classList.remove('flex'); } });
        const btn = li.querySelector('[data-confirm-to]');
        btn.classList.remove('hidden');
        btn.classList.add('flex');
      };
    });
    rowsEl.querySelectorAll('[data-confirm-to]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const upTo = Number(btn.dataset.confirmTo);
        rows.slice(0, upTo + 1).forEach((r) => { if (r.i > confirmedUpTo) applyStepToStore(hunter, r); });
        saveStore();
        onChange();
      };
    });
  }

  // The Effective Path answers "what should I buy next", and that depends entirely on what the
  // player is trying to do. The modes come from the optimizer's own MODES table (via
  // pathModes()), so a path recommendation and an Optimize result can never be chasing
  // different definitions of the same goal -- which is the whole reason boss mode exists here.
  const PATH_MODE_STORE_KEY = 'effectivePathMode';

  function currentPathMode() {
    const modes = window.OptimizerObjective.pathModes();
    const saved = store[PATH_MODE_STORE_KEY];
    return modes[saved] ? saved : 'loot';
  }

  // The subtitle has to say which objective produced the ranking. A boss-mode list that still
  // reads "ranked by effect on loot/min" would be actively misleading -- the whole point of boss
  // mode is that it deliberately ignores loot until the kill is secured.
  const PATH_MODE_SUBTITLE = {
    loot: 'ranked by effect on simulated loot/min',
    push: 'ranked by effect on average stage reached',
    boss: 'ranked by boss reach, damage and kill chance; loot bonuses do not count',
  };

  function pathSubtitle(mode) {
    const how = PATH_MODE_SUBTITLE[mode];
    if (!how) throw new Error(`pathSubtitle: no description for mode "${mode}"`);
    return `Up to ${TARGET_STEPS} improving purchases per currency, ${how}. Each currency is planned separately, with the other columns held at current levels. Farming times start from zero saved currency and use the current rate.`;
  }

  function currentHorizonDays() {
    const days = store.effectivePathHorizonDays;
    if (!StoreSchema.PATH_HORIZON_DAYS.includes(days)) {
      throw new Error(`effectivePathHorizonDays is ${days}, expected one of ${StoreSchema.PATH_HORIZON_DAYS.join(', ')}`);
    }
    return days;
  }

  // Rates for every currency the path can price. Materials come from the simulated run;
  // fragments come from the player's own per-day entry (the sim does not produce them), so the
  // relic column is timed only once that rate is set -- an unset rate stays unknown, never instant.
  function pathRates(simRates, fragsPerDay) {
    return { ...simRates, perHour: { ...simRates.perHour, frags: fragsPerDay / 24 } };
  }

  // The time preference handed to greedyPurchasePath; null ranks by gain-per-cost alone, which is
  // what "No limit" means and all that is possible without a real build's income.
  function timingFor(rates, days) {
    return rates && days ? { perHour: rates.perHour, horizonHours: days * 24 } : null;
  }

  const horizonLabel = (d) => (d === 0 ? 'No limit' : d === 1 ? '1 day' : d === 365 ? '1 year' : `${d} days`);

  function modePickerHtml(selected) {
    const modes = window.OptimizerObjective.pathModes();
    const days = currentHorizonDays();
    return `
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <label for="pathModeSelect" class="text-sm text-gray-300">Goal</label>
        <select id="pathModeSelect" class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white">
          ${Object.entries(modes).map(([key, spec]) => `<option value="${key}"${key === selected ? ' selected' : ''}>${escapeHtml(spec.label)}</option>`).join('')}
        </select>
        <label for="pathHorizonSelect" class="text-sm text-gray-300 ml-2">Planning window</label>
        <select id="pathHorizonSelect" class="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white">
          ${StoreSchema.PATH_HORIZON_DAYS.map((d) => `<option value="${d}"${d === days ? ' selected' : ''}>${horizonLabel(d)}</option>`).join('')}
        </select>
      </div>`;
  }

  function renderColumnsModal(overlay, columns, rates, rowLabel, hunter, subtitle) {
    widenModal(overlay);
    const body = overlay.querySelector('[data-path-results]');
    const resources = Object.keys(columns);
    body.innerHTML = `
      ${subtitle ? `<div class="text-xs text-gray-500 mb-3">${subtitle}</div>` : ''}
      <p class="text-xs text-gray-300 mb-3">Each row shows cost, then time for that purchase · total saving time.</p>
      <div class="grid grid-cols-1 md:grid-cols-${Math.min(resources.length, 4)} gap-3">
        ${resources.map((r) => `<div data-col="${r}" class="bg-gray-900/40 rounded-lg p-2 max-h-[60vh] overflow-y-auto"></div>`).join('')}
      </div>`;
    const onChange = () => {
      if (typeof renderStatsModalBody === 'function') renderStatsModalBody();
      if (typeof renderBuildList === 'function') renderBuildList();
      body.innerHTML = '<p class="text-gray-300 py-4">Account updated. Calculate again to plan the remaining purchases.</p>';
    };
    resources.forEach((r) => {
      renderColumn(body.querySelector(`[data-col="${r}"]`), r, columns[r], rates, rowLabel, hunter, onChange);
    });
  }

  // RECALCULATING AN UNCHANGED PATH IS INSTANT. A path is ~10-20s of full-fidelity evaluation and is a
  // pure function of its inputs, so a repeat view with nothing changed is served from memory. The
  // key is EVERYTHING the result depends on: the account state and baseline build (both inside
  // cfg), the candidate pool, the objective, the planning horizon and the fragment rate. Any edit
  // -- including confirming a recommended purchase, which writes the store -- changes the key, so a
  // stale path cannot be shown. In memory only: a reload recomputes, never trusts an old answer.
  // Entries are cloned both ways so a render that mutates its columns cannot corrupt the cache.
  const pathCache = new Map();
  const PATH_CACHE_LIMIT = 12;
  async function cachedPath(overlay, hunter, baseline, includeAccountUpgrades, mode, signal) {
    const cfg = structuredClone(statPathCfgFor(hunter, baseline));
    const days = currentHorizonDays();
    const fragsPerDay = store.fragments.perDay || 0;
    const key = JSON.stringify({
      hunter, includeAccountUpgrades, mode, steps: TARGET_STEPS,
      horizon: days, fragsPerDay, real: baseline.real, cfg,
    });
    const hit = pathCache.get(key);
    if (hit) return structuredClone(hit);
    // SEQUENTIAL, not Promise.all: the ranking needs the income rates (time-to-afford), so they
    // must exist before the walk starts. They cost ~150ms against a walk of seconds.
    const rates = baseline.real ? pathRates(await IncomeModel.currentRates(hunter, cfg, HunterOptimizer.FINAL_ITERATIONS, signal), fragsPerDay) : null;
    const result = await greedyPurchasePath(hunter, cfg, TARGET_STEPS, includeAccountUpgrades, mode,
      (resource, done, total) => updateProgress(overlay, resource, done, total), signal, timingFor(rates, days));
    if (!signal.aborted) {
      pathCache.delete(key);
      pathCache.set(key, structuredClone({ result, rates }));
      if (pathCache.size > PATH_CACHE_LIMIT) pathCache.delete(pathCache.keys().next().value);
    }
    return { result, rates };
  }

  // One row label for both entry points: they plan the same purchase pool (stats, inscriptions,
  // relics), so a stats-only labeler shows raw ids like "r4" for everything that is not a stat.
  const pathRowLabel = (r) => (r.kind === 'stat' ? (STAT_LABELS[r.key] || r.key) : (r.label || r.key));

  function openEffectivePathModal(build = null) {
    if (window.HUNTERSIM_EMBEDDED) window.refreshStoreFromNative();
    const hunter = currentHunter;
    const choices = store[hunter].builds;
    const title = build ? `Effective Path: ${escapeHtml(build.name || 'Unnamed')}` : 'Effective Path';
    const setup = `
      <form data-path-setup>
        ${build ? `<p class="text-sm text-white mb-3">Build: ${escapeHtml(build.name || 'Unnamed')} · Level ${build.level}</p>` : `
          <label for="pathBuildSelect" class="block text-sm text-gray-300 mb-1">Build to plan for</label>
          <select id="pathBuildSelect" required class="bg-gray-700 border border-gray-600 rounded px-3 py-2 mb-3 text-sm text-white">
            <option value="">Choose a build</option>
            ${choices.map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name || 'Unnamed')} · Level ${b.level}</option>`).join('')}
          </select>`}
        ${modePickerHtml(currentPathMode())}
        <p class="text-xs text-gray-400 mb-3">Uses this build’s level, talents and attributes with your current account stats and upgrades. Build overrides are excluded. Choose your goal and window before calculating.</p>
        <button type="submit" data-calculate-path class="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded text-white text-sm">Calculate path</button>
      </form>
      <div data-path-results aria-live="polite" class="mt-4"><p class="text-sm text-gray-400">${!build && !choices.length ? 'Create or import a build first.' : 'Ready when you are.'}</p></div>`;
    const overlay = titledModal('chart-arrows-vertical', title, setup, build ? 'buildEffectivePathModal' : 'hunterStatPathModal');
    widenModal(overlay);
    const nextSignal = abortableRuns(overlay);
    const form = overlay.querySelector('[data-path-setup]');
    const resultsEl = overlay.querySelector('[data-path-results]');
    const button = overlay.querySelector('[data-calculate-path]');
    const buildSelect = overlay.querySelector('#pathBuildSelect');
    const invalidate = () => {
      nextSignal();
      button.disabled = !build && !buildSelect.value;
      resultsEl.innerHTML = '<p class="text-sm text-gray-400">Calculate to see a path for these choices.</p>';
    };
    form.onchange = invalidate;
    button.disabled = !build;
    form.onsubmit = async event => {
      event.preventDefault();
      const signal = nextSignal();
      button.disabled = true;
      try {
        if (window.HUNTERSIM_EMBEDDED) window.refreshStoreFromNative();
        const selected = build || store[hunter].builds.find(b => b.id === buildSelect.value);
        const baseline = getBaselineBuild(selected);
        const mode = overlay.querySelector('#pathModeSelect').value;
        store[PATH_MODE_STORE_KEY] = mode;
        store.effectivePathHorizonDays = Number(overlay.querySelector('#pathHorizonSelect').value);
        saveStore();
        const resources = window.resourcesFor(hunter, true, store.gems);
        resultsEl.innerHTML = renderProgressPanel(resources);
        bindProgressLabels(overlay, hunter, resources);
        const { result, rates } = await cachedPath(overlay, hunter, baseline, true, mode, signal);
        if (signal.aborted) return;
        const timingNote = baseline.real ? '' : ' No allocated points: income and timing are unavailable.';
        renderColumnsModal(overlay, result.columns, rates, pathRowLabel, hunter,
          `${pathSubtitle(mode)}${timingNote}`);
      } catch (err) {
        if (isAbort(err) || signal.aborted) return;
        resultsEl.innerHTML = `<p class="text-red-400 py-4">Failed to compute Effective Path: ${escapeHtml(err.message || String(err))}</p>`;
      } finally {
        if (!signal.aborted) button.disabled = false;
      }
    };
  }

  const openHunterStatPathModal = () => openEffectivePathModal();
  const openBuildEffectivePathModal = build => openEffectivePathModal(build);

  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'openStatPathBtn') openHunterStatPathModal();
  });

  window.openBuildEffectivePathModal = openBuildEffectivePathModal;
})();
