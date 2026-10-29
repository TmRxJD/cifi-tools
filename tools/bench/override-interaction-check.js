'use strict';
// Execute the shipped controls. The broken fast-decrement control must fail this same check.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
process.on('uncaughtException', error => { console.error(error); process.exit(1); });
const source = fs.readFileSync(path.join(__dirname, '../../webapp/public/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `missing section: ${start}`);
  return source.slice(from, to);
}
class Element {
  constructor() { this.children = []; this.selectors = new Map(); this.events = {}; this.attributes = {}; }
  set innerHTML(value) { this.html = value; this.children = []; this.selectors.clear(); }
  get innerHTML() { return this.html; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(selector) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, callback) { this.events[event] = callback; }
  removeEventListener() {}
  remove() { this.removed = true; }
}
const host = new Element(), body = new Element();
const document = { body, createElement: () => new Element(), getElementById: id => id === 'cifi-companion-modals' ? host : null };
let refreshes = 0, saves = 0;
const ctx = vm.createContext({
  document, console, setTimeout, clearTimeout, EMBEDDED: true, currentHunter: 'borge',
  window: { refreshStoreFromNative() { refreshes++; }, ALL_UPGRADE_CATEGORIES: {} },
  store: { borge: { hunterStats: { hp: 5 }, builds: [] }, settings: { ui: { overridesHideMaxed: true } } },
  defs: () => ({ statCaps: { hp: 10 } }), escapeHtml: value => String(value), iconSvg: () => '',
  overrideFieldResource: () => null, overrideCostEligible: () => false,
  accountLevel: () => ctx.store.borge.hunterStats.hp,
  getOverrideGroups: () => [{ title: 'Stats', fields: [{ key: 'hp', label: 'HP', global: () => ctx.store.borge.hunterStats.hp }] }],
  saveStore() { saves++; }, renderBuildList() {},
});
vm.runInContext(section('function overrideNumericRow(', 'function genericModal('), ctx);
function fastDecrement(makeRow) {
  let value;
  const row = makeRow({ key: 'hp', label: 'HP' }, '', 5, next => { value = next; });
  row.querySelector('[data-min]').onclick();
  assert.equal(value, 0, 'fast decrement clamps at zero rather than clearing the override');
}
fastDecrement(ctx.overrideNumericRow);
const old = vm.createContext({ ...ctx });
vm.runInContext('function brokenRow(f, current, globalVal, onChange) { const row = document.createElement("div"); row.querySelector("[data-min]").onclick = () => onChange(""); return row; }', old);
assert.throws(() => fastDecrement(old.brokenRow), /fast decrement clamps/, 'known-bad control must fail');
let value;
const row = ctx.overrideNumericRow({ key: 'hp', label: 'HP' }, 9, 5, next => { value = next; });
row.querySelector('[data-max]').onclick();
assert.equal(value, 10, 'fast increment clamps at the stat cap');
const zero = ctx.overrideNumericRow({ key: 'hp', label: 'HP' }, 0, 5, () => {});
assert.equal(zero.querySelector('[data-dec]').disabled, true);

const build = { id: 'imported', name: 'Imported', isImported: true, overrides: { hp: 10 } };
ctx.store.borge.builds.push(build);
ctx.openOverridesModal(build);
const modal = host.children.at(-1);
assert.equal(refreshes, 1, 'comparison reads the current native account');
assert.equal(body.children.length, 0, 'companion modal stays under its styled host');
const rows = () => modal.querySelector('#overridesBody').children;
assert.equal(rows().length, 1, 'imported cap difference is visible');
modal.querySelector('[data-hide-maxed]').onclick();
assert.equal(rows().length, 1, 'hide maxed preserves cap override above current account');
const accountBefore = JSON.stringify(ctx.store.borge.hunterStats);
modal.events.click({ target: modal });
assert.equal(modal.removed, true, 'backdrop saves and closes');
assert.equal(build.overrides.hp, 10);
assert.equal(JSON.stringify(ctx.store.borge.hunterStats), accountBefore, 'dialog never changes account stats');
assert.equal(refreshes, 3, 'toggle and close refresh before saving');
assert.equal(saves, 2);

ctx.effectBox = () => '';
ctx.store.globalUpgrades = { 'ultima.ulti': 1.1989 };
ctx.renderUpgradesPage = () => {};
vm.runInContext(section('function renderUpgradeInput(', 'function renderUpgradesPage('), ctx);
const card = ctx.renderUpgradeInput('ultima', { id: 'ulti', label: 'Ultima', maxLevel: 10 });
assert(card.innerHTML.includes('value="1.1989"'));
assert(!card.innerHTML.includes('type="range"'), 'Diamond Ultima is typed input only');
const input = card.querySelector('[data-ulti-input]');
input.value = '2.3456'; input.valueAsNumber = 2.3456;
input.onchange();
assert.equal(ctx.store.globalUpgrades['ultima.ulti'], 2.3456, 'manual entry preserves four decimals');
input.value = ''; input.valueAsNumber = NaN;
input.onchange();
assert.equal(ctx.store.globalUpgrades['ultima.ulti'], 2.3456, 'empty entry does not reset account multiplier');
console.log('PASS override controls: caps, fast decrement, known-bad control, imported comparisons, scoped modal, backdrop, native refresh and typed Ultima');
