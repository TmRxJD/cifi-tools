'use strict';
// Persists top allocations found across runs so a future search can warm-start from
// everywhere a past search already explored, instead of only from your live in-game build.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '.history');

function fileFor(hunter, mode) {
  return path.join(DIR, `${hunter}_${mode}.json`);
}

function load(hunter, mode) {
  try {
    const raw = fs.readFileSync(fileFor(hunter, mode), 'utf8');
    return JSON.parse(raw); // [{ talentAlloc, attrAlloc, score }, ...] sorted best-first
  } catch {
    return [];
  }
}

function save(hunter, mode, candidates, keep = 20) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  const sorted = [...candidates].sort((a, b) => b.score - a.score).slice(0, keep);
  fs.writeFileSync(fileFor(hunter, mode), JSON.stringify(sorted, null, 2));
}

module.exports = { load, save };
