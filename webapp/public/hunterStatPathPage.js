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

  // This tool is a build-comparison planner, not a live account mirror -- there's no single
  // "current real build" on store[hunter] itself, only a list of user-created builds
  // (talents/attributes live per-build). The "Active" category is what the rest of the app
  // treats as the player's real, in-use loadouts, so the first one there is the best available
  // stand-in for "my actual current talents/attributes." Falls back to an all-zero allocation
  // if the player hasn't created any build yet, rather than erroring.
  function getBaselineBuild(hunter) {
    const h = store[hunter];
    const active = (h.builds || []).filter((b) => (b.categoryId || 'active') === 'active');
    const build = active[0] || h.builds?.[0];
    const talents = build?.talents || {};
    const attributes = build?.attributes || {};
    return { level: build?.level || h.level || 1, talents, attributes, real: hasMeaningfulAllocation(talents, attributes) };
  }

  function applyStepToStore(hunter, r) {
    if (r.kind === 'inscryption') store.globalUpgrades[`inscryptions.${r.key}`] = r.level;
    else store[hunter].hunterStats[r.key] = r.level;
  }

  // Widen the shared titledModal shell for this feature -- multiple columns of purchase rows
  // need more than the default max-w-5xl to avoid squeezing labels.
  function widenModal(overlay) {
    const box = overlay.firstElementChild;
    if (box) { box.classList.remove('max-w-5xl'); box.classList.add('max-w-7xl'); }
  }

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
        <div class="flex items-center justify-between gap-1.5 mt-1 pl-[22px]">
          <span class="text-amber-400 font-medium">${CF.fmtBig(r.cost)}</span>
          <div class="flex items-center gap-1.5">
            <span class="text-gray-400 flex items-center gap-1.5">${timeHtml}</span>
            <button data-confirm-to="${r.i}" class="${confirmed ? '' : 'hidden'} w-5 h-5 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white items-center justify-center text-[10px]" title="I've bought up to here -- update my real levels">✓</button>
          </div>
        </div>
      </li>`;
    }).join('') || '<div class="text-gray-500 text-xs py-4 text-center">No purchases available for this resource right now.</div>';

    colEl.innerHTML = `
      <div class="flex items-center gap-1.5 mb-2 font-semibold text-white text-sm">${matIcon(resource)}${escapeHtml(label)}</div>
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
        renderColumn(colEl, resource, colResult, rates, rowLabel, hunter, onChange, Math.max(confirmedUpTo, upTo));
      };
    });
  }

  function renderColumnsModal(overlay, columns, rates, rowLabel, hunter, subtitle) {
    widenModal(overlay);
    const body = overlay.querySelector('.p-5');
    const resources = Object.keys(columns);
    body.innerHTML = `
      ${subtitle ? `<div class="text-xs text-gray-500 mb-3">${subtitle}</div>` : ''}
      <div class="grid grid-cols-1 md:grid-cols-${Math.min(resources.length, 4)} gap-3">
        ${resources.map((r) => `<div data-col="${r}" class="bg-gray-900/40 rounded-lg p-2 max-h-[60vh] overflow-y-auto"></div>`).join('')}
      </div>`;
    const onChange = () => {
      if (typeof renderStatsModalBody === 'function') renderStatsModalBody();
      if (typeof renderBuildList === 'function') renderBuildList();
    };
    resources.forEach((r) => {
      renderColumn(body.querySelector(`[data-col="${r}"]`), r, columns[r], rates, rowLabel, hunter, onChange);
    });
  }

  async function openHunterStatPathModal() {
    const resources = window.resourcesFor(currentHunter, false);
    const overlay = titledModal('chart-arrows-vertical', 'Effective Path', renderProgressPanel(resources), 'hunterStatPathModal');
    widenModal(overlay);
    bindProgressLabels(overlay, currentHunter, resources);

    let result, rates;
    const baseline = getBaselineBuild(currentHunter);
    try {
      const cfg = statPathCfgFor(currentHunter, baseline);
      [result, rates] = await Promise.all([
        greedyPurchasePath(currentHunter, cfg, TARGET_STEPS, false, (resource, done, total) => updateProgress(overlay, resource, done, total)),
        baseline.real ? IncomeModel.currentRates(currentHunter, store, baseline, 1000) : null,
      ]);
    } catch (err) {
      overlay.querySelector('.p-5').innerHTML = `<div class="text-red-400 py-8 text-center">Failed to compute Effective Path: ${escapeHtml(err.message || String(err))}</div>`;
      return;
    }
    const timingNote = baseline.real ? '' : ' Create a build to unlock timing estimates.';
    renderColumnsModal(overlay, result.columns, rates, (r) => STAT_LABELS[r.key] || r.key, currentHunter,
      `Next ${TARGET_STEPS} recommended purchases per material, ranked by effect on your simulated loot/min.${timingNote}`);
  }

  async function openBuildEffectivePathModal(build) {
    const resources = window.resourcesFor(currentHunter, true);
    const overlay = titledModal('chart-arrows-vertical', `Effective Path: ${escapeHtml(build.name || 'Unnamed')}`, renderProgressPanel(resources), 'buildEffectivePathModal');
    widenModal(overlay);
    bindProgressLabels(overlay, currentHunter, resources);

    let result, rates;
    const talents = build.talents || {};
    const attributes = build.attributes || {};
    const baseline = { level: build.level || 1, talents, attributes, real: hasMeaningfulAllocation(talents, attributes) };
    try {
      const cfg = statPathCfgFor(currentHunter, baseline);
      [result, rates] = await Promise.all([
        greedyPurchasePath(currentHunter, cfg, TARGET_STEPS, true, (resource, done, total) => updateProgress(overlay, resource, done, total)),
        baseline.real ? IncomeModel.currentRates(currentHunter, store, baseline, 1000) : null,
      ]);
    } catch (err) {
      overlay.querySelector('.p-5').innerHTML = `<div class="text-red-400 py-8 text-center">Failed to compute Effective Path: ${escapeHtml(err.message || String(err))}</div>`;
      return;
    }
    const timingNote = baseline.real ? '' : ' Allocate talent/attribute points on this build to unlock timing estimates.';
    renderColumnsModal(overlay, result.columns, rates,
      (r) => (r.kind === 'inscryption' ? (r.label || r.key) : (STAT_LABELS[r.key] || r.key)), currentHunter,
      `Next ${TARGET_STEPS} recommended purchases per material, ranked by effect on this build's simulated loot/min.${timingNote}`);
  }

  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'openStatPathBtn') openHunterStatPathModal();
  });

  window.openBuildEffectivePathModal = openBuildEffectivePathModal;
})();
