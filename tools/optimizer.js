'use strict';
const { compileEvaluator } = require('./hunterSim');

function costOf(defs, alloc) {
  return defs.reduce((sum, d) => sum + (alloc[d.id] || 0) * (d.cost || 1), 0);
}

function cloneAlloc(a) { return { ...a }; }

// --- Unconstrained allocation helpers (used for Talents, which have no unlock rules) ---

function randomAllocation(defs, budget) {
  const alloc = {};
  defs.forEach((d) => { alloc[d.id] = 0; });
  let spent = 0;
  for (let guard = 0; guard < 5000 && spent < budget; guard++) {
    const d = defs[Math.floor(Math.random() * defs.length)];
    const cost = d.cost || 1;
    if (alloc[d.id] < d.maxLevel && spent + cost <= budget) {
      alloc[d.id]++;
      spent += cost;
    }
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
    if (candidates.length) {
      const d = candidates[Math.floor(Math.random() * candidates.length)];
      next[d.id]++;
      return next;
    }
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
  if (from.length) {
    const df = from[Math.floor(Math.random() * from.length)];
    next[df.id]--;
  }
  return next;
}

// --- Constrained allocation helpers (used for Attributes, which have unlock rules) ---
// Mirrors cifi-tools.com's own gating function exactly: a node can take its next point
// only if (a) it's below its max, (b) every dependency parent already has >=1 point, and
// (c) if it has a minValue threshold, enough points are already spent in strictly-lower-
// tier nodes (nodes whose own threshold is smaller).

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

function descendantsOf(id, deps) {
  const result = [];
  for (const [k, parents] of Object.entries(deps)) {
    if (parents.includes(id)) {
      result.push(k);
      result.push(...descendantsOf(k, deps));
    }
  }
  return [...new Set(result)];
}

// Zeroing a node can strand its descendants below their unlock requirement; cascade-clear
// them too, exactly like the site's UI does when you pull a prerequisite back to 0.
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
        if (!parentsOk || !thresholdOk) {
          alloc[d.id] = 0;
          changed = true;
        }
      }
    }
  }
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
    const d = eligible[Math.floor(Math.random() * eligible.length)];
    next[d.id]++;
    return true;
  };

  if (roll < 0.34) {
    if (spendOnce()) return next;
  }
  if (roll < 0.67) {
    const from = defs.filter((d) => next[d.id] > 0);
    if (from.length) {
      const df = from[Math.floor(Math.random() * from.length)];
      next[df.id]--;
      clearInvalidDescendants(defs, deps, minVal, next);
      const freedBudget = budget - costOf(defs, next);
      const eligible = defs.filter((d) => (d.cost || 1) <= freedBudget && isEligible(d, defs, deps, minVal, next));
      if (eligible.length) {
        const dt = eligible[Math.floor(Math.random() * eligible.length)];
        next[dt.id]++;
      }
      return next;
    }
  }
  const from = defs.filter((d) => next[d.id] > 0);
  if (from.length) {
    const df = from[Math.floor(Math.random() * from.length)];
    next[df.id]--;
    clearInvalidDescendants(defs, deps, minVal, next);
  }
  return next;
}

// One compiled evaluator per config, cached on the config object itself so repeated
// optimize() calls (and scoreAllocation() calls outside a search) reuse it too.
function getEvalFast(cfg) {
  if (!cfg.__evalFast) cfg.__evalFast = compileEvaluator(cfg.hunter, cfg);
  return cfg.__evalFast;
}

async function scoreAllocation(cfg, talentAlloc, attrAlloc, mode, iterations) {
  const evalFast = getEvalFast(cfg);
  const r = await evalFast(talentAlloc, attrAlloc, iterations);
  const score = mode === 'push' ? r.avgStage : r.lootPerMin;
  return { score, result: r };
}

function signatureOf(talentAlloc, attrAlloc) {
  return JSON.stringify([talentAlloc, attrAlloc]);
}

// Keeps the topK distinct allocations seen by score. Search-time scores use a low
// iteration count (cheap but noisy Monte Carlo) -- a single "new best" reading can be a
// noise spike rather than a real improvement, so we carry a shortlist forward and only
// trust a high-iteration re-evaluation of that shortlist at the very end.
function pushTop(list, entry, topK) {
  const sig = signatureOf(entry.talentAlloc, entry.attrAlloc);
  if (list.some((e) => e.sig === sig)) return;
  list.push({ ...entry, sig });
  list.sort((a, b) => b.score - a.score);
  if (list.length > topK) list.length = topK;
}

// Simulated annealing over the joint (talent, attribute) allocation space for ONE restart
// chain. Talents are unconstrained; attributes must respect ATTRIBUTE_DEPENDENCIES /
// ATTRIBUTE_MIN_VALUE. Returns the topK distinct allocations seen (by noisy search score),
// for the caller to re-verify at higher precision.
async function runSingleRestart(cfg, { mode = 'loot', steps = 1500, searchIterations = 300, seeded = false, topK = 5, log = () => {}, restartLabel = 0 } = {}) {
  const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
  const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};

  let talentAlloc = seeded && cfg.currentTalents ? cloneAlloc(cfg.currentTalents) : randomAllocation(cfg.TALENTS, cfg.TALENT_BUDGET);
  let attrAlloc = seeded && cfg.currentAttrs ? cloneAlloc(cfg.currentAttrs) : randomConstrainedAllocation(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, deps, minVal);
  let current = await scoreAllocation(cfg, talentAlloc, attrAlloc, mode, searchIterations);
  const top = [];
  pushTop(top, { talentAlloc: cloneAlloc(talentAlloc), attrAlloc: cloneAlloc(attrAlloc), score: current.score }, topK);

  for (let i = 0; i < steps; i++) {
    const temp = Math.max(0.02, 1 - i / steps);
    const mutateTalents = Math.random() < 0.5;
    const nextTalentAlloc = mutateTalents ? neighbor(cfg.TALENTS, cfg.TALENT_BUDGET, talentAlloc) : talentAlloc;
    const nextAttrAlloc = mutateTalents ? attrAlloc : constrainedNeighbor(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, attrAlloc, deps, minVal);

    const candidate = await scoreAllocation(cfg, nextTalentAlloc, nextAttrAlloc, mode, searchIterations);
    const delta = candidate.score - current.score;
    const accept = delta >= 0 || Math.random() < Math.exp(delta / (Math.abs(current.score) * temp * 0.01 + 1e-9));

    if (accept) {
      talentAlloc = nextTalentAlloc;
      attrAlloc = nextAttrAlloc;
      current = candidate;
      if (candidate.score > top[top.length - 1]?.score || top.length < topK) {
        pushTop(top, { talentAlloc: cloneAlloc(talentAlloc), attrAlloc: cloneAlloc(attrAlloc), score: candidate.score }, topK);
        if (candidate.score === top[0].score) log(`restart ${restartLabel}, step ${i}: new best ${mode} score = ${candidate.score.toFixed(2)}`);
      }
    }
  }

  return top;
}

// Sequential (single-process) version: runs `restarts` SA chains one after another, then
// re-verifies the combined shortlist at finalIterations to filter out noise-driven false
// positives before picking the true winner. Prefer parallelOptimize() for real speed --
// this is kept as a simple, dependency-free fallback.
async function optimize(cfg, { mode = 'loot', steps = 1500, searchIterations = 300, finalIterations = 1000, restarts = 4, topK = 5, log = () => {} } = {}) {
  let shortlist = [];
  for (let restart = 0; restart < restarts; restart++) {
    const top = await runSingleRestart(cfg, { mode, steps, searchIterations, seeded: restart === 0, topK, log, restartLabel: restart });
    shortlist = shortlist.concat(top);
  }
  // Guarantee your real current build survives to final re-verification even if noise
  // evicted it from every restart's mid-search shortlist.
  if (cfg.currentTalents && cfg.currentAttrs) {
    shortlist.push({ talentAlloc: cfg.currentTalents, attrAlloc: cfg.currentAttrs });
  }

  let best = null;
  for (const c of shortlist) {
    const { score, result } = await scoreAllocation(cfg, c.talentAlloc, c.attrAlloc, mode, finalIterations);
    if (!best || score > best.score) best = { talentAlloc: c.talentAlloc, attrAlloc: c.attrAlloc, score, finalResult: result };
  }
  return best;
}

module.exports = {
  optimize, runSingleRestart, scoreAllocation, getEvalFast,
  randomAllocation, randomConstrainedAllocation, neighbor, constrainedNeighbor, isEligible,
};
