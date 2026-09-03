// Node-native port of webapp/public/buildCode.js's encode side, so this server can generate
// real cifi-tools.com-compatible build-share codes without needing a browser/DOM. Loads the
// actual browser files via vm so the CODE_PARAMS tables and HUNTER_DEFS never drift out of
// sync with the webapp's own copies -- there is exactly one source of truth for both.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_PUBLIC = path.join(__dirname, '../webapp/public');

let sandboxPromise = null;
async function getSandbox() {
  if (!sandboxPromise) {
    sandboxPromise = (async () => {
      const hunterDefsSrc = await readFile(path.join(WEBAPP_PUBLIC, 'hunterDefs.js'), 'utf8');
      const buildCodeSrc = await readFile(path.join(WEBAPP_PUBLIC, 'buildCode.js'), 'utf8');
      const sandbox = { window: {}, console };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(hunterDefsSrc, sandbox, { filename: 'hunterDefs.js' });
      vm.runInContext(buildCodeSrc, sandbox, { filename: 'buildCode.js' });
      return sandbox;
    })();
  }
  return sandboxPromise;
}

/**
 * @param {'borge'|'ozzy'|'knox'} hunter
 * @param {{level?:number, talents?:object, attributes?:object, overrides?:object}} buildData
 * @param {object} [hunterStats] base stat overrides used by CODE_PARAMS' baseStatKeys entries
 * @param {object} [globalUpgrades] flat "category.field" upgrade map
 * @param {object} [gems] gem tree state, same shape as saveImport.js's `gems` output
 */
export async function generateBuildCode(hunter, buildData, hunterStats = {}, globalUpgrades = {}, gems = {}) {
  const sandbox = await getSandbox();
  return sandbox.generateBuildCode(hunter, buildData, hunterStats, globalUpgrades, gems);
}

/**
 * The parameter names a build SHARE CODE can carry for this hunter.
 *
 * This exists so callers can tell whether an override they passed actually reached the live site.
 * A code is the only transport to cifi-tools, and it carries only these names -- anything else is
 * applied to the clone and silently dropped on the way out, which turns a comparison into a
 * different-inputs test that reads as a clone bug.
 *
 * Read from the shipped buildCode.js through the same sandbox as everything else here, never
 * copied, so it cannot drift from the table the encoder actually uses.
 */
export async function getCodeParams(hunter) {
  const sandbox = await getSandbox();
  const table = sandbox.CODE_PARAMS || (sandbox.BuildCode && sandbox.BuildCode.CODE_PARAMS);
  if (!table || !table[hunter]) {
    throw new Error(`CODE_PARAMS unavailable for ${hunter} -- buildCode.js must export it for the `
      + 'comparison tools to know which overrides transport to the live site');
  }
  return table[hunter];
}

export async function getHunterDefs() {
  const sandbox = await getSandbox();
  return sandbox.HUNTER_DEFS;
}

/** @param {string} code a real cifi-tools.com build-share code */
export async function parseBuildCode(code) {
  const sandbox = await getSandbox();
  return sandbox.parseBuildCode(code);
}
