'use strict';
// Test the production disclosure of unsupported install multipliers. The old check
// kept an uncalled implementation alive; it proved no user-visible behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../../webapp/public');
const source = fs.readFileSync(path.join(root, 'shipsPage.js'), 'utf8');
const start = source.indexOf('function unmodelledInstallBonusTerms()');
const end = source.indexOf('/** Evolution factors', start);
assert(start >= 0 && end > start, 'production disclosure function must exist');
const helper = source.slice(start, end);
function verify(code) {
  let checked = 0;
  for (const [quality, ru83, ru96, expected] of [[0,0,0,0], [2,0,0,1], [0,1,0,1], [0,0,1,1], [2,1,1,2]]) {
    const context = { window: { store: { gems: { power: { qualityLevel: quality } }, fleetResearch: { levels: { ru83, ru96 } } } } };
    const warnings = vm.runInNewContext(`${code}\nunmodelledInstallBonusTerms()`, context);
    assert.equal(warnings.length, expected, `quality=${quality}, RU83=${ru83}, RU96=${ru96}`);
    if (quality >= 2) assert(warnings.some(w => w.includes('Power quality')));
    if (ru83 || ru96) assert(warnings.some(w => w.includes('RU83/RU96')));
    checked++;
  }
  return checked;
}
try {
  const checked = verify(helper);
  assert.throws(() => verify(helper.replace('return out;', 'return [];')), /quality=2/, 'a silent warning implementation must fail');
  const schema = fs.readFileSync(path.join(root, 'storeSchema.js'), 'utf8');
  assert(!/\bpowerGU\d*Level\b|\bguLevels\b|\bperGuLevel\b/i.test(schema), 'new per-GU inputs require a real install multiplier model');
  assert(!source.includes('function installBonusGlobalMultiplier('), 'unwired multiplier implementation must stay deleted');
  console.log(`PASS install multiplier disclosure: ${checked} account states; silent-warning negative control rejected`);
} catch (error) { console.error(error); process.exitCode = 1; }
