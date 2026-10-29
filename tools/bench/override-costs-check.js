'use strict';
// Exercise the shipped dialog, not a parallel implementation of its cost logic.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
process.on('uncaughtException', error => {
  console.error(error);
  process.exit(1);
});
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'webapp/public/app.js'), 'utf8');
const start = source.indexOf('function openOverrideCostsModal(');
const end = source.indexOf('\n// Evaluates the build', start);
assert(start >= 0 && end > start, 'shipped override cost dialog must exist');
const context = vm.createContext({ console, window: {}, EMBEDDED: false, currentHunter: 'borge' });
for (const file of ['hunterDefs.js', 'costFormulas.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'webapp/public', file), 'utf8'), context);
}
context.escapeHtml = value => String(value);
context.iconSvg = context.matIcon = () => '';
let captured;
context.titledModal = (icon, title, body, id) => {
  captured = { title, body, id };
  return { firstElementChild: { classList: { replace() {} } } };
};
let globals = {};
context.accountLevel = (hunter, key) => globals[key] ?? 0;
context.getOverrideGroups = hunter => [
  { title: 'Base Stats', fields: context.window.HUNTER_DEFS[hunter].baseStatKeys.map(key => ({ key, label: key === 'hp' ? 'Max HP' : key, global: () => globals[key] ?? 0 })) },
  ...[['Relics', 'relics', ['r4', 't2r7']], ['Gadgets', 'gadgets', ['wrench', 'zaptron', 'anchor']], ['Inscryptions', 'inscryptions', ['i11']]].map(([title, group, ids]) => ({ title, fields: ids.map(id => {
    const key = `upgrades.${group}.${id}`;
    return { key, label: id, global: () => globals[key] ?? 0 };
  }) })),
];
vm.runInContext(source.slice(start, end), context);
function render(overrides, hunter = 'borge', results = null) {
  context.openOverrideCostsModal({ name: 'Test import', overrides }, hunter, results);
  assert.equal(captured.id, 'overrideCostsModal');
  return captured.body;
}
const gem = { 'upgrades.gems_nodes.attraction_level': 5 };
assert.match(render(gem), /No Override Costs/);
assert.match(render({}), /No Override Costs/);
globals = { hp: 3 };
assert.match(render({ hp: 3 }), /No Override Costs/);
assert.match(render({ hp: 2 }), /No Override Costs/);
const before = JSON.stringify(globals);
const mixed = render({ hp: 4, ...gem }, 'borge', { avgTime: 10, mat1: 100 });
assert.match(mixed, /Max HP/);
assert.match(mixed, /Global/);
assert.match(mixed, /Override/);
assert.match(mixed, /Difference/);
assert.doesNotMatch(mixed, /attraction_level|Gem Nodes|No Override Costs/);
assert.equal(JSON.stringify(globals), before, 'overview must not mutate account levels');
assert.match(mixed, /md:hidden/);
assert.match(mixed, /hidden md:block/);
globals = {};
assert.doesNotMatch(render({ 'upgrades.gadgets.wrench': 1 }), /Gadgets/);
assert.match(render({ 'upgrades.gadgets.anchor': 1 }, 'knox'), /Tesseracts/);
const salvo = render({ proj: 2 }, 'knox');
for (const key of ['mat1', 'mat2', 'mat3']) {
  assert.match(salvo, new RegExp(context.window.CostFormulas.resourceAbbr('knox', key)));
}
assert.doesNotMatch(render({ multichance: 1, multipower: 1 }, 'ozzy'), /No Override Costs/);
assert.match(render({ 'upgrades.relics.r4': 1 }), /Relic #4/);
assert.match(render({ 'upgrades.relics.t2r7': 1 }), /No Override Costs/);
assert.match(render({ 'upgrades.inscryptions.i11': 1 }), /Inscryptions/);
// Test the actual button fragment with empty/nonempty overrides; this catches unconditional
// rendering independently of whether the dialog itself successfully handles an empty build.
const button = source.match(/\$\{Object\.keys\(build\.overrides \|\| \{\}\)\.length \? `(<button data-act="overrideCosts"[^\n]+)` : ''\}/);
assert(button, 'cost button must be conditional on actual overrides');
const buttonExpression = button[0];
function buttonFor(overrides) {
  return vm.runInNewContext('`' + buttonExpression + '`', { build: { overrides }, accent: 'red', iconSvg: () => '' });
}
assert.equal(buttonFor({}), '');
assert.equal(buttonFor(undefined), '');
assert.match(buttonFor(gem), /View override costs/);
assert.match(source, /getElementById\('cifi-companion-modals'\) \|\| document\.body/, 'extension modals must remain in the scoped stylesheet root');
globals = { hp: 3 };
context.EMBEDDED = true;
let refreshes = 0;
context.window.refreshStoreFromNative = () => { refreshes++; globals = { hp: 4 }; };
assert.match(render({ hp: 4 }), /No Override Costs/, 'overview compares with the latest native account');
assert.equal(refreshes, 1);
assert.equal(globals.hp, 4);
// Known-bad negative control: the formerly unconditional button must fail this measurement.
assert.throws(() => assert(source.replace(button[0], button[1]).match(/\$\{Object\.keys\(build\.overrides \|\| \{\}\)\.length \? `(<button data-act="overrideCosts"[^\n]+)` : ''\}/)));
console.log('ok  override costs: gem imports, positive deltas, hunter currencies, responsive rows, account preservation, conditional button and known-bad control');
