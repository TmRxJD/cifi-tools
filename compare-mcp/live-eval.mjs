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

function parseMainStatistics(text) {
  const block = text.split('Main Statistics')[1];
  if (!block) return null;
  const grab = (re) => {
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };
  const rangeMatch = block.match(/Ø Stage\s*\n?\s*([\d.]+)\s*\n?\s*(\d+)-(\d+)/);
  return {
    lootScore: parseSuffixedNumber(grab(/Loot Score\s*\n?\s*([\d.]+\s*[kmb]?)\b/i)),
    avgTimeMinutes: parseDurationToMinutes(grab(/Ø Time\s*\n?\s*((?:[\d.]+\s*[hms]\s*)+)/i)),
    avgStage: rangeMatch ? Number.parseFloat(rangeMatch[1]) : Number.parseFloat(grab(/Ø Stage\s*\n?\s*([\d.]+)/)),
    minStage: rangeMatch ? Number.parseInt(rangeMatch[2], 10) : null,
    maxStage: rangeMatch ? Number.parseInt(rangeMatch[3], 10) : null,
    runsPerDay: Number.parseFloat(grab(/Runs per Day\s*\n?\s*([\d.]+)/)),
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
  const stats = await importCodeAndReadStats(hunter, code);
  return { ...stats, buildCode: code };
}

// Imports a build code AS-IS (no regeneration) -- used to test real, pre-existing
// build-share codes (e.g. from a user's own account history) rather than ones this server
// generated itself, so decode/encode round-trip bugs can't hide behind always regenerating.
export async function importCodeAndReadStats(hunter, code) {
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
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.locator('textarea').first().fill(code);
    await page.getByRole('button', { name: /^Import with Upgrades/ }).click();
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
