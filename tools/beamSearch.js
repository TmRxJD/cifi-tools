'use strict';
const os = require('os');
const { WorkerPool } = require('./workerPool');
const history = require('./history');
const {
  randomAllocation, randomConstrainedAllocation, neighbor, constrainedNeighbor,
} = require('./optimizer');

function sigOf(entry) {
  return JSON.stringify([entry.talentAlloc, entry.attrAlloc]);
}

function dedupTopK(list, k) {
  const bySig = new Map();
  for (const e of list) {
    const sig = sigOf(e);
    const existing = bySig.get(sig);
    if (!existing || existing.score < e.score) bySig.set(sig, e);
  }
  return [...bySig.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

// Beam search: keeps `beamWidth` candidate allocations alive at once. Every generation,
// each beam member spawns `neighborsPerMember` mutated neighbors; ALL of them (beam width
// * neighbors, typically several dozen) are scored in ONE parallel batch across the
// persistent worker pool -- so every generation productively uses every CPU core, unlike
// independent SA chains where a fast restart finishes early and idles.
//
// Also warm-starts from cifi_history/<hunter>_<mode>.json: allocations a past run already
// found valuable get folded into the initial beam alongside your live in-game build,
// carrying information across sessions instead of starting from scratch every time.
async function beamSearch(configPath, cfg, {
  mode = 'loot', timeBudgetMs = 40000, beamWidth = 8, neighborsPerMember = 3,
  searchIterations = 100, poolSize = os.cpus().length, log = () => {},
} = {}) {
  const deps = cfg.ATTRIBUTE_DEPENDENCIES || {};
  const minVal = cfg.ATTRIBUTE_MIN_VALUE || {};
  const pool = new WorkerPool(configPath, poolSize);

  try {
    const historyCandidates = history.load(cfg.hunter, mode);
    log(`Loaded ${historyCandidates.length} candidates from previous runs' history.`);

    const seeds = [];
    if (cfg.currentTalents && cfg.currentAttrs) seeds.push({ talentAlloc: cfg.currentTalents, attrAlloc: cfg.currentAttrs });
    for (const h of historyCandidates) seeds.push({ talentAlloc: h.talentAlloc, attrAlloc: h.attrAlloc });
    while (seeds.length < beamWidth) {
      seeds.push({
        talentAlloc: randomAllocation(cfg.TALENTS, cfg.TALENT_BUDGET),
        attrAlloc: randomConstrainedAllocation(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, deps, minVal),
      });
    }

    const seedScores = await pool.scoreBatch(seeds, mode, searchIterations);
    let beam = dedupTopK(seeds.map((s, i) => ({ ...s, score: seedScores[i] })), beamWidth);

    const allSeen = new Map();
    beam.forEach((b) => allSeen.set(sigOf(b), b));

    const start = Date.now();
    let gen = 0;
    while (Date.now() - start < timeBudgetMs) {
      const candidates = [];
      for (const member of beam) {
        for (let k = 0; k < neighborsPerMember; k++) {
          const mutateTalents = Math.random() < 0.5;
          const nt = mutateTalents ? neighbor(cfg.TALENTS, cfg.TALENT_BUDGET, member.talentAlloc) : member.talentAlloc;
          const na = mutateTalents ? member.attrAlloc : constrainedNeighbor(cfg.ATTRIBUTES, cfg.ATTRIBUTE_BUDGET, member.attrAlloc, deps, minVal);
          candidates.push({ talentAlloc: nt, attrAlloc: na });
        }
      }
      const scores = await pool.scoreBatch(candidates, mode, searchIterations);
      const scoredCandidates = candidates.map((c, i) => ({ ...c, score: scores[i] }));
      scoredCandidates.forEach((c) => {
        const sig = sigOf(c);
        if (!allSeen.has(sig) || allSeen.get(sig).score < c.score) allSeen.set(sig, c);
      });

      beam = dedupTopK([...beam, ...scoredCandidates], beamWidth);
      gen++;
      log(`gen ${gen} (${candidates.length} evals): beam best = ${beam[0].score.toFixed(2)}, elapsed ${((Date.now() - start) / 1000).toFixed(1)}s`);
    }

    return { beam, allSeen: [...allSeen.values()], generations: gen };
  } finally {
    await pool.terminate();
  }
}

module.exports = { beamSearch };
