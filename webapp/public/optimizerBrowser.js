// Shared allocation/gating helpers -- used both by the UI (to disable +/- buttons exactly
// like the real site does) and by the beam-search worker. Mirrors cifi-tools.com's own
// gating function z(e): a node's next point requires being under max, having every
// dependency parent already >0, and (if it has a minValue) enough points already spent in
// strictly-lower-tier nodes.
(function (global) {
  function costOf(defs, alloc) {
    return defs.reduce((sum, d) => sum + (alloc[d.id] || 0) * (d.cost || 1), 0);
  }

  function cloneAlloc(a) { return { ...a }; }

  function isEligible(def, defs, deps, minVal, alloc) {
    const level = alloc[def.id] || 0;
    if (level >= def.maxLevel) return false;
    const parents = deps[def.id];
    if (parents && parents.length && !parents.every((p) => (alloc[p] || 0) > 0)) return false;
    const threshold = minVal[def.id] || 0;
    if (threshold > 0) {
      let sum = 0;
      for (const r of defs) {
        const rThreshold = minVal[r.id] || 0;
        if (rThreshold < threshold) sum += (alloc[r.id] || 0) * (r.cost || 1);
      }
      if (sum < threshold) return false;
    }
    return true;
  }

  // Can this node currently be decremented without leaving the allocation invalid to save?
  // (The real site just checks level>0; it cascades a clear of stranded descendants
  // afterward, which clearInvalidDescendants below replicates.)
  function canDecrement(def, alloc) {
    return (alloc[def.id] || 0) > 0;
  }

  function clearInvalidDescendants(defs, deps, minVal, alloc) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of defs) {
        if ((alloc[d.id] || 0) > 0) {
          const parents = deps[d.id];
          const parentsOk = !parents || parents.every((p) => (alloc[p] || 0) > 0);
          const threshold = minVal[d.id] || 0;
          let thresholdOk = true;
          if (threshold > 0) {
            let sum = 0;
            for (const r of defs) {
              const rThreshold = minVal[r.id] || 0;
              if (rThreshold < threshold) sum += (alloc[r.id] || 0) * (r.cost || 1);
            }
            thresholdOk = sum >= threshold;
          }
          if (!parentsOk || !thresholdOk) { alloc[d.id] = 0; changed = true; }
        }
      }
    }
  }

  function randomAllocation(defs, budget) {
    const alloc = {};
    defs.forEach((d) => { alloc[d.id] = 0; });
    let spent = 0;
    for (let guard = 0; guard < 5000 && spent < budget; guard++) {
      const d = defs[Math.floor(Math.random() * defs.length)];
      const cost = d.cost || 1;
      if (alloc[d.id] < d.maxLevel && spent + cost <= budget) { alloc[d.id]++; spent += cost; }
    }
    return alloc;
  }

  function neighbor(defs, budget, alloc) {
    const next = cloneAlloc(alloc);
    const spent = costOf(defs, next);
    const leftover = budget - spent;
    const roll = Math.random();
    if (roll < 0.34) {
      const candidates = defs.filter((d) => next[d.id] < d.maxLevel && (d.cost || 1) <= leftover);
      if (candidates.length) { next[candidates[Math.floor(Math.random() * candidates.length)].id]++; return next; }
    }
    if (roll < 0.67) {
      const from = defs.filter((d) => next[d.id] > 0);
      const to = defs.filter((d) => next[d.id] < d.maxLevel);
      if (from.length && to.length) {
        const df = from[Math.floor(Math.random() * from.length)];
        const dt = to[Math.floor(Math.random() * to.length)];
        next[df.id]--;
        const freed = leftover + (df.cost || 1);
        if ((dt.cost || 1) <= freed) next[dt.id]++;
        return next;
      }
    }
    const from = defs.filter((d) => next[d.id] > 0);
    if (from.length) next[from[Math.floor(Math.random() * from.length)].id]--;
    return next;
  }

  function randomConstrainedAllocation(defs, budget, deps, minVal) {
    const alloc = {};
    defs.forEach((d) => { alloc[d.id] = 0; });
    let spent = 0;
    for (let guard = 0; guard < 5000 && spent < budget; guard++) {
      const eligible = defs.filter((d) => (d.cost || 1) + spent <= budget && isEligible(d, defs, deps, minVal, alloc));
      if (!eligible.length) break;
      const d = eligible[Math.floor(Math.random() * eligible.length)];
      alloc[d.id]++;
      spent += d.cost || 1;
    }
    return alloc;
  }

  function constrainedNeighbor(defs, budget, alloc, deps, minVal) {
    const next = cloneAlloc(alloc);
    const spent = costOf(defs, next);
    const leftover = budget - spent;
    const roll = Math.random();
    const spendOnce = () => {
      const eligible = defs.filter((d) => (d.cost || 1) <= leftover && isEligible(d, defs, deps, minVal, next));
      if (!eligible.length) return false;
      next[eligible[Math.floor(Math.random() * eligible.length)].id]++;
      return true;
    };
    if (roll < 0.34 && spendOnce()) return next;
    if (roll < 0.67) {
      const from = defs.filter((d) => next[d.id] > 0);
      if (from.length) {
        const df = from[Math.floor(Math.random() * from.length)];
        next[df.id]--;
        clearInvalidDescendants(defs, deps, minVal, next);
        const freedBudget = budget - costOf(defs, next);
        const eligible = defs.filter((d) => (d.cost || 1) <= freedBudget && isEligible(d, defs, deps, minVal, next));
        if (eligible.length) next[eligible[Math.floor(Math.random() * eligible.length)].id]++;
        return next;
      }
    }
    const from = defs.filter((d) => next[d.id] > 0);
    if (from.length) {
      next[from[Math.floor(Math.random() * from.length)].id]--;
      clearInvalidDescendants(defs, deps, minVal, next);
    }
    return next;
  }

  const Optimizer = {
    costOf, cloneAlloc, isEligible, canDecrement, clearInvalidDescendants,
    randomAllocation, neighbor, randomConstrainedAllocation, constrainedNeighbor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Optimizer;
  else global.Optimizer = Optimizer;
})(typeof window !== 'undefined' ? window : globalThis);
