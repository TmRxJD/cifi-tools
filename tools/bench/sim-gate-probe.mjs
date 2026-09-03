/**
 * WHICH gated upgrades does the live site gate in the SIM, not just in its UI?
 *
 *   node tools/bench/sim-gate-probe.mjs [category ...]
 *
 * Hiding a locked upgrade from the interface and refusing to APPLY it are different behaviours, and
 * cifi-tools does not do both for everything. Tier-2 relics are ignored by its simulator entirely
 * while Power gem < 3 -- feeding t2r7 at 0, 5 or 40 returns byte-identical output -- but a
 * nominally Exodus-4-gated gadget applies with no gem state at all. So the gate table cannot be
 * applied wholesale to the sim, and guessing either way is wrong in one direction or the other:
 * over-gating discards upgrades the account owns, under-gating inflates every number that includes
 * one.
 *
 * This measures it per category, three evaluations each:
 *   BASE     the upgrade at 0, no gems
 *   LOCKED   the upgrade set high, gems still empty
 *   UNLOCKED the upgrade set high, that category's gate satisfied
 *
 * and reads the verdict off the site's own numbers:
 *   LOCKED == BASE and UNLOCKED != BASE  -> the site GATES it in the sim
 *   LOCKED != BASE                       -> the site does NOT gate it
 *   all three equal                      -> the upgrade is inert here (says nothing about gating)
 *
 * Then it asks the same of this clone and reports where the two disagree. A disagreement is a real
 * parity bug: it is exactly the shape of the tier-2 relic gap, which overstated a level-70 Borge's
 * loot by 70%.
 *
 * The upgrades are written into the site's ACCOUNT state rather than a build code, because only
 * three gated keys per hunter are code-carriable.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { evaluateOnLiveSite, shutdownLiveBrowser } from '../../compare-mcp/live-eval.mjs';
import { evaluateOnClone } from '../../compare-mcp/clone-eval.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require('./harness.js');
const sb = H.browserSandbox();

const HUNTER = 'borge';
// A build well clear of a stage boundary: near one, loot swings on the run distribution rather
// than on the upgrade, which is what made an early Knox probe read -0.85% at t2r7=20 and +0.64% at
// 40 -- a sign flip that no multiplier can produce.
const BUILD = {
  level: 70,
  talents: { revival: 2, loth: 5, ua: 5, impeccable: 10, omen: 5, ll: 10, pog: 15, tfow: 15 },
  attributes: {
    ares: 60, ylith: 10, spartan: 6, timeless: 5, baal: 6, sensors: 6,
    htb: 10, lfin: 10, exp: 6, weak: 6, atlas: 6, battle: 3,
  },
  baseStats: {
    hp: 320, atk: 300, regen: 220, dr: 40, evade: 45, effect: 50,
    critchance: 75, critpower: 70, atkspeed: 40,
  },
};

// One representative key per gated category, with a value big enough to move the sim clearly.
const PROBES = [
  ['gadgets', 'upgrades.gadgets.wrench', 60],
  ['relics(t2)', 'upgrades.relics.t2r7', 40],
  ['shardmilestones', 'upgrades.shardmilestones.m0', 90],
  ['researches', 'upgrades.researches.res81', 6],
  ['cms', 'upgrades.cms.cm46', 1],
  ['loopmods', 'upgrades.loopmods.roe', 10],
  ['trinkets', 'upgrades.trinkets.last_handbook', 230],
];

const only = process.argv.slice(2);
const gates = sb.UPGRADE_GATES || {};

function gemsFor(key) {
  const g = gates[key];
  if (!g) return {};
  const nodes = [false, false, false, false, false, false];
  if (g.node) nodes[g.node - 1] = true;
  return { [g.gem]: { level: g.level, nodes, upgrades: {} } };
}

const flat = (k, v) => ({ [k.replace(/^upgrades\./, '')]: v });
const sig = (s) => (s == null ? 'null' : [s.lootScore, s.avgStage, s.mat1PerRun].join('|'));
const cloneSig = (s) => (s == null ? 'null' : [s.lootPerMin, s.avgStage, s.mat1].join('|'));

async function live(upgrades, gemStates) {
  return evaluateOnLiveSite(HUNTER, {
    ...BUILD, globalUpgrades: upgrades, accountUpgrades: upgrades, accountHunterStats: BUILD.baseStats, gemStates,
  });
}
async function clone(upgrades, gemStates) {
  return evaluateOnClone(HUNTER, {
    ...BUILD, globalUpgrades: upgrades, gemPlannerStore: { gemStates }, iterations: 1000,
  });
}

let failures = 0;
const rows = [];

const baseLive = await live({}, {});
const baseClone = await clone({}, {});
console.log(`baseline: site loot ${baseLive.lootScore}, clone ${baseClone.lootPerMin.toPrecision(8)}\n`);

for (const [cat, key, value] of PROBES) {
  if (only.length && !only.includes(cat)) continue;
  const ups = flat(key, value);
  const gems = gemsFor(key);

  const lockedLive = await live(ups, {});
  const unlockedLive = await live(ups, gems);
  const lockedClone = await clone(ups, {});
  const unlockedClone = await clone(ups, gems);

  const siteLockedSame = sig(lockedLive) === sig(baseLive);
  const siteUnlockedMoves = sig(unlockedLive) !== sig(baseLive);
  const cloneLockedSame = cloneSig(lockedClone) === cloneSig(baseClone);
  const cloneUnlockedMoves = cloneSig(unlockedClone) !== cloneSig(baseClone);

  let siteVerdict;
  if (!siteUnlockedMoves && siteLockedSame) siteVerdict = 'INERT';
  else if (siteLockedSame) siteVerdict = 'GATED';
  else siteVerdict = 'NOT GATED';

  let cloneVerdict;
  if (!cloneUnlockedMoves && cloneLockedSame) cloneVerdict = 'INERT';
  else if (cloneLockedSame) cloneVerdict = 'GATED';
  else cloneVerdict = 'NOT GATED';

  const agree = siteVerdict === cloneVerdict;
  if (!agree) failures++;
  rows.push({ cat, key, siteVerdict, cloneVerdict, agree });
  console.log(`${agree ? 'ok  ' : 'FAIL'} ${cat.padEnd(16)} site ${siteVerdict.padEnd(9)} `
    + `clone ${cloneVerdict.padEnd(9)} ${agree ? '' : '<-- MISMATCH'}`);
  if (siteVerdict === 'INERT') {
    console.log(`     note: ${key} moves nothing on the site even unlocked, so this says nothing `
      + 'about gating -- pick a key with a real effect to test this category');
  }
}

await shutdownLiveBrowser();
console.log(failures
  ? `\n${failures} category(ies) where this tool gates differently from the site`
  : '\nthis tool gates every probed category the same way the site does');
process.exit(failures ? 1 : 0);
