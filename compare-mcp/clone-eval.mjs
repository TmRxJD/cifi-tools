// Evaluates a build against the LOCAL clone (webapp/) by driving a headless Chromium page
// that loads it for real (so the actual release.wasm + params.json + HunterSim.evaluate()
// code path runs exactly as it does for a user) and calling window.HunterSim.evaluate()
// in-page. This is the same wasm binary the live site uses (see hunterSimBrowser.js's own
// header comment), so any mismatch against the live site's result is a sign the STATE we
// build (talents/attributes/hunterStats/upgrades) doesn't match what the live site would
// have built for the same inputs -- not a wasm/formula difference.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = path.join(__dirname, '../webapp');
const CLONE_PORT = process.env.CLONE_PORT || 5173;
const CLONE_URL = `http://localhost:${CLONE_PORT}`;

let serverProcess = null;
let browserPromise = null;

async function ensureCloneServerRunning() {
  try {
    const res = await fetch(CLONE_URL, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return;
  } catch {
    // not running yet -- start it below
  }
  if (serverProcess) return;
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: WEBAPP_DIR,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(CLONE_PORT) },
  });
  serverProcess.unref();
  // Poll until it responds instead of a fixed sleep -- the server binds synchronously on
  // listen() so this is usually instant, but give it a few tries under load.
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(CLONE_URL, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Local clone server did not come up on ${CLONE_URL}`);
}

async function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

/**
 * @param {'borge'|'ozzy'|'knox'} hunter
 * @param {{level:number, talents:object, attributes:object, baseStats:object, globalUpgrades:object}} testBuild
 *   globalUpgrades is a flat "category.field" -> value map (same shape as the webapp's
 *   store.globalUpgrades), e.g. { "relics.r4": 13, "inscryptions.i3": 8 }.
 * @param {number} [iterations]
 */
export async function evaluateOnClone(hunter, testBuild, iterations = 1000) {
  await ensureCloneServerRunning();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(CLONE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.HunterSim !== 'undefined', { timeout: 15000 });

    // IMPORTANT: resolveParam's gem-tree params (upgrades.gems_nodes.*, e.g. per-tree level/
    // node/named-upgrade values) are read EXCLUSIVELY from state.gemPlannerStore, never from
    // state.upgrades -- reconstructing a nested state.upgrades.gems_nodes object here (an
    // earlier version of this file did that) silently returns 0 for every one of those
    // params, understating any build with gem-tree investment (which starts mattering heavily
    // from roughly level 38+ as accounts unlock gem trees). The real app itself never
    // reconstructs gemPlannerStore from a build-code import either -- app.js's own
    // applyImportedBuild() just merges payload.upgradeOverrides straight into build.overrides
    // (full "upgrades.category.field" keys), which resolveParam's generic override check
    // (checked before the gems_nodes special-case) returns directly. Mirroring that exact
    // real code path here, rather than reconstructing gemPlannerStore ourselves, is both
    // simpler and provably correct for every upgrade param -- not just the gem ones.
    const overrides = { ...(testBuild.baseStats || {}) };
    for (const [flatKey, value] of Object.entries(testBuild.globalUpgrades || {})) {
      overrides[`upgrades.${flatKey}`] = value;
    }

    const state = {
      level: testBuild.level,
      hunterStats: testBuild.baseStats || {},
      talents: testBuild.talents || {},
      attributes: testBuild.attributes || {},
      overrides,
      gemPlannerStore: { gemStates: {} },
      iterations,
    };

    const result = await page.evaluate(
      ({ hunter, state }) => window.HunterSim.evaluate(hunter, state),
      { hunter, state },
    );
    return result;
  } finally {
    await page.close();
  }
}

export async function shutdownClone() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
