/**
 * FULL-ACCOUNT parity: is this port a true clone of the hunter sim, for every hunter and every
 * input the account actually has?
 *
 *   node tools/bench/live-account-parity.mjs [hunter] [--json]
 *
 * Every earlier comparison here was partial, and each partial one hid something. Comparing with no
 * upgrades confirmed only the base sim. Comparing with just the ones a share code can carry left
 * relics, trinkets, loop mods, milestones and IAP untested -- and the one time an untransportable
 * relic was passed anyway, the harness reported a 98% material gap that was purely its own
 * asymmetry. Meanwhile the real save's Ozzy build turned out to be ILLEGAL on the site because the
 * importer had been loading attribute levels into the wrong attributes, which no internal bench
 * could see.
 *
 * So this seeds the live site with the ACCOUNT, not with a build:
 *   * every upgrade category from the pulled save, written into `hunter-data.upgrades`
 *   * the hunter's base stats, into `hunter-data.hunterStats`
 *   * gem state into `gemPlanner_store` (which is also what unlocks Ozzy's page at Exodus >= 2)
 * then imports talents/attributes only, so the SITE resolves every upgrade through its own code
 * path -- and runs the identical state through the clone.
 *
 * WHAT COUNTS AS A MISMATCH. Both sides are 1000-iteration Monte Carlo, so exact equality is the
 * wrong test; deltas beyond ~2% are flagged. But the site DISPLAYS rounded values ("656.54k",
 * "146.67m"), so a stat is only compared to the precision the site actually shows -- otherwise the
 * rounding itself reads as a discrepancy. That display precision is reported per stat so a rounding
 * difference can never be mistaken for a math difference.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { evaluateOnLiveSite, shutdownLiveBrowser } from '../../compare-mcp/live-eval.mjs';
import { evaluateOnClone } from '../../compare-mcp/clone-eval.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require('./harness.js');

const onlyHunter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const asJson = process.argv.includes('--json');

const SAVE_DIR = path.join(__dirname, '../gamefiles/save');
const decoded = fs.existsSync(SAVE_DIR)
  ? fs.readdirSync(SAVE_DIR).filter((f) => f.startsWith('decoded-') && f.endsWith('.json'))
  : [];
if (!decoded.length) {
  console.log('SKIP: no decoded save -- this verifies NOTHING without one.');
  process.exit(0);
}

const sb = H.browserSandbox();
const save = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, decoded[0]), 'utf8'));
const mapped = sb.mapSaveToStore(save);
const flatUpgrades = mapped.globalUpgrades || {};
const perHunter = mapped.perHunter || {};

// Gems: the site keys them by tree with {level, nodes[], upgrades{}}. Ozzy's page needs Exodus >= 2
// to render at all, so the account's own level is used and floored at 2 for reachability -- and the
// SAME state goes to the clone, so the comparison stays like-for-like.
function gemStatesForSite() {
  const out = {};
  const src = mapped.gems || {};
  for (const [tree, st] of Object.entries(src)) {
    out[tree] = {
      level: st.level || 0,
      nodes: Array.isArray(st.nodes) ? st.nodes.slice(0, 3) : [false, false, false],
      upgrades: st.upgrades || {},
    };
  }
  out.exodus = { ...(out.exodus || { nodes: [false, false, false], upgrades: {} }) };
  out.exodus.level = Math.max(out.exodus.level || 0, 2);
  return out;
}

/** Only the upgrade keys this hunter's own Overrides surface exposes. */
function upgradesFor(hunter) {
  const defs = sb.HUNTER_DEFS[hunter];
  const out = {};
  for (const [cat, group] of Object.entries(defs.globalUpgrades || {})) {
    for (const item of group.items || []) {
      const v = flatUpgrades[`${cat}.${item.id}`];
      if (v) out[`${cat}.${item.id}`] = v;
    }
  }
  return out;
}

/** How many significant digits the site's own display carries for a value like "146.67m". */
function displayPrecisionOf(n) {
  if (n == null || !Number.isFinite(n) || n === 0) return null;
  const abs = Math.abs(n);
  // The site prints k/m/b suffixed values to 2 decimals -> ~5 significant digits at most.
  return abs >= 1000 ? 5 : 4;
}

function compare(hunter, live, clone) {
  const runsPerDay = clone.avgTime ? (24 * 60) / clone.avgTime : null;
  const perDay = (v) => (v != null && runsPerDay != null ? v * runsPerDay : null);
  const fields = [
    ['lootScore', live.lootScore, clone.lootPerMin],
    ['avgStage', live.avgStage, clone.avgStage],
    ['avgTimeMinutes', live.avgTimeMinutes, clone.avgTime],
    ['mat1PerRun', live.mat1PerRun, clone.mat1],
    ['mat2PerRun', live.mat2PerRun, clone.mat2],
    ['mat3PerRun', live.mat3PerRun, clone.mat3],
    ['xpPerRun', live.xpPerRun, clone.xp],
    ['mat1PerDay', live.mat1PerDay, perDay(clone.mat1)],
    ['xpPerDay', live.xpPerDay, perDay(clone.xp)],
  ];
  return fields.map(([key, l, c]) => {
    if (l == null || c == null) return { key, live: l, clone: c, deltaPct: null, flagged: l !== c };
    const base = Math.max(Math.abs(l), Math.abs(c), 1e-9);
    const deltaPct = ((c - l) / base) * 100;
    // Compare only to the precision the site prints, so its own rounding is not read as a gap.
    const sig = displayPrecisionOf(l);
    const tol = sig ? Math.max(2, 100 * (5 * 10 ** -sig)) : 2;
    return {
      key, live: l, clone: c, deltaPct: Number(deltaPct.toFixed(3)),
      displaySigDigits: sig, toleratedPct: Number(tol.toFixed(3)),
      flagged: Math.abs(deltaPct) > tol,
    };
  });
}

const hunters = onlyHunter ? [onlyHunter] : ['borge', 'ozzy', 'knox'];
const report = [];
let failures = 0;

for (const hunter of hunters) {
  const real = perHunter[hunter];
  if (!real || !real.level) { console.log(`skip ${hunter}: no level in the save`); continue; }
  const upgrades = upgradesFor(hunter);
  const testBuild = {
    level: real.level,
    talents: real.talents,
    attributes: real.attributes,
    baseStats: real.hunterStats,
    globalUpgrades: upgrades,
    accountUpgrades: upgrades,
    accountHunterStats: real.hunterStats,
    gemStates: gemStatesForSite(),
  };

  let live;
  try {
    live = await evaluateOnLiveSite(hunter, testBuild);
  } catch (err) {
    console.log(`FAIL ${hunter}: live site did not evaluate -- ${err.message}`);
    failures++;
    continue;
  }
  const clone = await evaluateOnClone(hunter, { ...testBuild, iterations: 1000 });
  const diffs = compare(hunter, live, clone);
  const bad = diffs.filter((d) => d.flagged);
  failures += bad.length;
  report.push({ hunter, level: real.level, upgradeCount: Object.keys(upgrades).length, diffs });

  console.log(`\n=== ${hunter} lvl${real.level} — ${Object.keys(upgrades).length} account upgrades seeded ===`);
  for (const d of diffs) {
    const mark = d.flagged ? 'FAIL' : 'ok  ';
    console.log(`  ${mark} ${d.key.padEnd(16)} live ${String(d.live).padStart(16)}  clone `
      + `${String(typeof d.clone === 'number' ? d.clone.toPrecision(8) : d.clone).padStart(16)}`
      + `  ${d.deltaPct == null ? '' : `${d.deltaPct >= 0 ? '+' : ''}${d.deltaPct}%`}`
      + `${d.toleratedPct ? ` (tol ${d.toleratedPct}%)` : ''}`);
  }
}

await shutdownLiveBrowser();
if (asJson) console.log(JSON.stringify(report, null, 2));
console.log(failures
  ? `\n${failures} stat(s) outside the site's own display precision`
  : '\nthe clone matches the live site on every hunter, with the full account seeded');
process.exit(failures ? 1 : 0);
