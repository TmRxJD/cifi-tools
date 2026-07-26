// Batch regression runner: decodes each real build code in known-builds.mjs, imports the
// SAME code as-is into the live site (no regeneration -- this also exercises the decode
// path itself, not just encode), evaluates the same decoded parameters on the local clone,
// and reports clone-vs-live deltas plus how both compare to the user's originally-observed
// Loot Score (which may be stale if the live site's formulas changed since it was recorded).
//
// Usage: node batch-test.mjs [count] [startIndex] [hunter=borge|ozzy]
import { parseBuildCode } from './build-code.mjs';
import { importCodeAndReadStats } from './live-eval.mjs';
import { evaluateOnClone, shutdownClone } from './clone-eval.mjs';
import { shutdownLiveBrowser } from './live-eval.mjs';
import { KNOWN_BORGE_BUILDS, KNOWN_BORGE_PUSH_BUILDS, KNOWN_BORGE_LATE_BUILDS } from './known-builds.mjs';
import { KNOWN_OZZY_BUILDS, KNOWN_OZZY_PUSH_BUILDS } from './known-builds-ozzy.mjs';
import { KNOWN_KNOX_BUILDS } from './known-builds-knox.mjs';

const HUNTER = (process.argv[4] || 'borge').toLowerCase();
const BUILD_SETS = {
  borge: [
    ...KNOWN_BORGE_BUILDS.map((b) => ({ ...b, set: 'main' })),
    ...KNOWN_BORGE_PUSH_BUILDS.map((b) => ({ ...b, set: 'push' })),
    ...KNOWN_BORGE_LATE_BUILDS.map((b) => ({ ...b, set: 'late' })),
  ],
  ozzy: [
    ...KNOWN_OZZY_BUILDS.map((b) => ({ ...b, set: 'main' })),
    ...KNOWN_OZZY_PUSH_BUILDS.map((b) => ({ ...b, set: 'push' })),
  ],
  knox: [
    ...KNOWN_KNOX_BUILDS.map((b) => ({ ...b, set: 'main' })),
  ],
};
const ALL = BUILD_SETS[HUNTER];
if (!ALL) throw new Error(`Unknown hunter "${HUNTER}" -- expected borge or ozzy`);

function stripUpgradesPrefix(upgradeOverrides) {
  const flat = {};
  for (const [k, v] of Object.entries(upgradeOverrides || {})) {
    if (k.startsWith('upgrades.')) flat[k.slice('upgrades.'.length)] = v;
  }
  return flat;
}

function pct(a, b) {
  if (a == null || b == null) return null;
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return ((b - a) / base) * 100;
}

async function runOne(entry) {
  const decoded = await parseBuildCode(entry.code);
  if (!decoded) return { ...entry, error: 'Failed to decode build code' };

  const testBuild = {
    level: decoded.level,
    talents: decoded.talents,
    attributes: decoded.attributes,
    baseStats: decoded.overrides,
    globalUpgrades: stripUpgradesPrefix(decoded.upgradeOverrides),
  };

  const [live, clone] = await Promise.all([
    importCodeAndReadStats(HUNTER, entry.code),
    evaluateOnClone(HUNTER, testBuild),
  ]);

  const cloneLive = pct(live.lootScore, clone.lootPerMin);
  const liveExpected = pct(entry.expectedLootScore, live.lootScore);
  return {
    ...entry, decodedLevel: decoded.level,
    liveLootScore: live.lootScore, cloneLootScore: clone.lootPerMin,
    cloneVsLivePct: cloneLive == null ? null : Number(cloneLive.toFixed(2)),
    liveVsExpectedPct: liveExpected == null ? null : Number(liveExpected.toFixed(2)),
  };
}

const startIndex = Number(process.argv[3] || 0);
const count = Number(process.argv[2] || ALL.length);
const slice = ALL.slice(startIndex, startIndex + count);

console.log(`Running ${slice.length} ${HUNTER} build(s), starting at index ${startIndex} of ${ALL.length}...\n`);

const results = [];
for (const entry of slice) {
  process.stdout.write(`[${entry.set} lvl${entry.level}] ${entry.code.slice(0, 16)}... `);
  try {
    const r = await runOne(entry);
    results.push(r);
    if (r.error) {
      console.log(`ERROR: ${r.error}`);
    } else {
      const flag = Math.abs(r.cloneVsLivePct) > 2 ? '  <-- FLAGGED (>2%)' : '';
      console.log(`live=${r.liveLootScore}  clone=${r.cloneLootScore.toFixed(1)}  clone-vs-live=${r.cloneVsLivePct}%  live-vs-userExpected=${r.liveVsExpectedPct}%${flag}`);
    }
  } catch (e) {
    console.log(`EXCEPTION: ${e.message}`);
    results.push({ ...entry, error: e.message });
  }
}

const flagged = results.filter((r) => !r.error && Math.abs(r.cloneVsLivePct) > 2);
console.log(`\n${results.length} run, ${flagged.length} flagged (>2% clone-vs-live), ${results.filter((r) => r.error).length} errored.`);
if (flagged.length) {
  console.log('\nFlagged builds:');
  flagged.forEach((r) => console.log(`  lvl${r.level} (${r.set}) ${r.code}: live=${r.liveLootScore} clone=${r.cloneLootScore.toFixed(1)} (${r.cloneVsLivePct}%)`));
}

await shutdownLiveBrowser();
await shutdownClone();
