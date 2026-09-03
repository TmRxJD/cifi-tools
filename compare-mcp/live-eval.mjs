// Evaluates a build against the REAL cifi-tools.com by generating a real build-share code
// (build-code.mjs, byte-compatible with the live site's own format -- validated 2026-07 by
// round-tripping a generated code through the live site's own Import flow), pasting it into
// a fresh guest session via "Import with Upgrades", saving the build, and reading the
// resulting "Main Statistics" panel. A fresh incognito-style browser context is used per
// call so nothing needs signing in or cleaning up afterward -- it's a throwaway guest build
// in a throwaway session.
import { chromium } from 'playwright';
import { generateBuildCode } from './build-code.mjs';

const LIVE_URL = 'https://cifi-tools.com';
const HUNTER_NAV_HREF = { borge: '/borge', ozzy: '/ozzy', knox: '/knox' };

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

// "Main Statistics\nLoot Score\n38.64k\nØ Time\n3h 21m\nØ Stage\n150.9\n139-159\nRuns per Day\n7.16"
// -- confirmed against two live imports (2026-07): a low-stage build showed "43.2"/"10.5m"/
// "137" (no suffix/hours needed), a high-stage one showed the k-suffixed/hour-containing
// forms above, so all three must be parsed generically rather than assuming the small-number
// shapes seen first.
function parseSuffixedNumber(str) {
  if (str == null) return null;
  const m = String(str).trim().match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1;
  return n * mult;
}

// "3h 21m", "10.5m", or "45s" -> minutes.
function parseDurationToMinutes(str) {
  if (!str) return null;
  let minutes = 0;
  const h = str.match(/([\d.]+)\s*h/);
  const m = str.match(/([\d.]+)\s*m(?!s)/);
  const s = str.match(/([\d.]+)\s*s/);
  if (h) minutes += Number.parseFloat(h[1]) * 60;
  if (m) minutes += Number.parseFloat(m[1]);
  if (s) minutes += Number.parseFloat(s[1]) / 60;
  return h || m || s ? minutes : null;
}

// The "Loot" section right after the 4 headline stats is 4 material cards in a fixed order
// (mat1, mat2, mat3, xp -- confirmed against app.js's own `[r.mat1, r.mat2, r.mat3, r.xp]`
// ordering), each rendering as "<perRun>\nper run\n<perDay>\nper day".
function parseLootMaterials(block) {
  // NOT a plain split on "Loot" -- "Loot Score" earlier in the same block also contains the
  // word "Loot" and would be matched first, silently grabbing the wrong (middle) segment.
  const idx = block.search(/\nLoot\n/);
  const lootBlock = idx === -1 ? null : block.slice(idx);
  if (!lootBlock) return null;
  const re = /([\d.]+\s*[kmb]?)\s*\n?\s*per run\s*\n?\s*([\d.]+\s*[kmb]?)\s*\n?\s*per day/gi;
  const materials = [];
  let m;
  while ((m = re.exec(lootBlock)) && materials.length < 4) {
    materials.push({ perRun: parseSuffixedNumber(m[1]), perDay: parseSuffixedNumber(m[2]) });
  }
  return materials.length === 4 ? materials : null;
}

function parseMainStatistics(text) {
  const block = text.split('Main Statistics')[1];
  if (!block) return null;
  const grab = (re) => {
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };
  const rangeMatch = block.match(/Ø Stage\s*\n?\s*([\d.]+)\s*\n?\s*(\d+)-(\d+)/);
  const materials = parseLootMaterials(block);
  return {
    lootScore: parseSuffixedNumber(grab(/Loot Score\s*\n?\s*([\d.]+\s*[kmb]?)\b/i)),
    avgTimeMinutes: parseDurationToMinutes(grab(/Ø Time\s*\n?\s*((?:[\d.]+\s*[hms]\s*)+)/i)),
    avgStage: rangeMatch ? Number.parseFloat(rangeMatch[1]) : Number.parseFloat(grab(/Ø Stage\s*\n?\s*([\d.]+)/)),
    minStage: rangeMatch ? Number.parseInt(rangeMatch[2], 10) : null,
    maxStage: rangeMatch ? Number.parseInt(rangeMatch[3], 10) : null,
    runsPerDay: Number.parseFloat(grab(/Runs per Day\s*\n?\s*([\d.]+)/)),
    // [mat1, mat2, mat3, xp] per-run/per-day, matching HunterSim.evaluate()'s own field order.
    mat1PerRun: materials?.[0]?.perRun ?? null, mat1PerDay: materials?.[0]?.perDay ?? null,
    mat2PerRun: materials?.[1]?.perRun ?? null, mat2PerDay: materials?.[1]?.perDay ?? null,
    mat3PerRun: materials?.[2]?.perRun ?? null, mat3PerDay: materials?.[2]?.perDay ?? null,
    xpPerRun: materials?.[3]?.perRun ?? null, xpPerDay: materials?.[3]?.perDay ?? null,
  };
}

/**
 * @param {'borge'|'ozzy'|'knox'} hunter
 * @param {{level:number, talents:object, attributes:object, baseStats:object, globalUpgrades:object}} testBuild
 *   Same shape as clone-eval.evaluateOnClone's testBuild. baseStats gets encoded as explicit
 *   build overrides (so the result never depends on the guest session's ambient/default base
 *   stats) and globalUpgrades gets encoded as the build's upgradeOverrides -- both win over
 *   any ambient site state per the live evaluator's own override-first resolution order.
 */
export async function evaluateOnLiveSite(hunter, testBuild) {
  const code = await generateBuildCode(
    hunter,
    { level: testBuild.level, talents: testBuild.talents, attributes: testBuild.attributes, overrides: testBuild.baseStats || {} },
    {},
    testBuild.globalUpgrades || {},
    {},
  );
  const stats = await importCodeAndReadStats(hunter, code, {
    accountUpgrades: testBuild.accountUpgrades,
    hunterStats: testBuild.accountHunterStats,
  });
  return { ...stats, buildCode: code };
}

// Imports a build code AS-IS (no regeneration) -- used to test real, pre-existing
// build-share codes (e.g. from a user's own account history) rather than ones this server
// generated itself, so decode/encode round-trip bugs can't hide behind always regenerating.
/**
 * Seed the live site's ACCOUNT-WIDE upgrade state before a build is imported.
 *
 * WHY THIS EXISTS. A build share code carries only that hunter's CODE_PARAMS. Everything else --
 * most relics, every trinket, most inscryptions -- lives in the site's own account state, under
 * the `hunter-data` localStorage key. Without a way to set it, those upgrades simply cannot be
 * compared: passing them to compare_builds applied them to the CLONE while the site evaluated
 * zero, which reported a real level-49 Borge as 98% off and looked like a clone bug.
 *
 * Writing account state directly is how the site itself stores it, so this exercises the real
 * resolution path rather than a test hook. Only the keys given are touched; the rest of
 * `hunter-data` is left exactly as found.
 */
async function seedAccountUpgrades(page, accountUpgrades, hunterStats, hunter) {
  if (!accountUpgrades && !hunterStats) return;
  await page.evaluate(({ ups, stats, h }) => {
    const raw = localStorage.getItem('hunter-data');
    const d = raw ? JSON.parse(raw) : {};
    d.upgrades = d.upgrades || {};
    for (const [flatKey, value] of Object.entries(ups || {})) {
      const dot = flatKey.indexOf('.');
      const cat = dot === -1 ? flatKey : flatKey.slice(0, dot);
      const id = dot === -1 ? null : flatKey.slice(dot + 1);
      if (!id) continue;
      d.upgrades[cat] = d.upgrades[cat] || {};
      d.upgrades[cat][id] = value;
    }
    if (stats && Object.keys(stats).length) {
      d.hunterStats = d.hunterStats || {};
      d.hunterStats[h] = { ...(d.hunterStats[h] || {}), ...stats };
    }
    localStorage.setItem('hunter-data', JSON.stringify(d));
  }, { ups: accountUpgrades || {}, stats: hunterStats || {}, h: hunter });
}

export async function importCodeAndReadStats(hunter, code, opts = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    // Ozzy/Knox's sidebar nav link is hidden on a fresh guest account (gated behind
    // Exodus-gem-level/account-level unlock conditions client-side -- see webapp/public/
    // index.html's hunterOzzyBtn data-unlock-gem/data-unlock-lvl attrs, which mirror the
    // live site's own gating), so a guest session can never click it into view. The route
    // itself isn't actually gated server-side though -- navigating directly to it works.
    await page.goto(`${LIVE_URL}${HUNTER_NAV_HREF[hunter]}`, { waitUntil: 'domcontentloaded' });
    // Account state must exist BEFORE the app reads it, so seed then reload.
    if (opts.accountUpgrades || opts.hunterStats) {
      await seedAccountUpgrades(page, opts.accountUpgrades, opts.hunterStats, hunter);
      await page.goto(`${LIVE_URL}${HUNTER_NAV_HREF[hunter]}`, { waitUntil: 'domcontentloaded' });
    }
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.locator('textarea').first().fill(code);
    // "Import with Upgrades" writes the CODE's upgrades over the account's, which would undo the
    // seeding. With seeded state, import talents/attributes only and let the account supply the
    // rest -- which is also how a real player uses the site.
    await page.getByRole('button', {
      name: (opts.accountUpgrades || opts.hunterStats) ? /^Import Build Only/ : /^Import with Upgrades/,
    }).click();
    await page.getByRole('button', { name: 'Create Build', exact: true }).click();
    await page.getByText('Main Statistics').waitFor({ timeout: 15000 });
    const text = await page.locator('main').innerText();
    const stats = parseMainStatistics(text);
    if (!stats || stats.lootScore == null) {
      throw new Error(`Could not parse Main Statistics from live site output:\n${text.slice(0, 500)}`);
    }
    return stats;
  } finally {
    await context.close();
  }
}

export async function shutdownLiveBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}
