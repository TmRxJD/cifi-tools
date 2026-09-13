'use strict';
// Exercise the isolated-world client with actual event delivery, not source-string assertions.
// The native Vue integration is separately tested by companion-browser-check.js.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
try {
const source = fs.readFileSync(path.join(__dirname,'../../extension/companion.js'),'utf8');
const listeners = new Map();
let panel = null, renders = 0;
const request = {textContent:'',dataset:{}};
const document = {
  querySelector(){return panel;},
  getElementById(){return request;},
  addEventListener(type,fn){listeners.set(type,fn);},
  dispatchEvent(event){listeners.get(event.type)?.(event);},
};
const window = {render(){renders++;},renderFleetPage(){renders++;},startCompanionBridgeStatus(){},openCompanionSaveImport(){}};
const context = vm.createContext({window,document,Event:class {constructor(type){this.type=type;}},console});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../../extension/routes.js'),'utf8'),context);
request.dataset.routes = JSON.stringify(window.CifiCompanionRoutes);
vm.runInContext(source,context);
const emit = type => document.dispatchEvent({type:`cifi-companion:${type}`});
emit('page-mounted');
window.refreshEmbeddedCompanionPage();
assert.equal(renders,0,'native pages must not call a companion renderer');
panel = {dataset:{cifiCompanionPage:'fleet'},isConnected:true,replaceChildren(){}};
emit('page-mounted');
assert.equal(renders,1);
window.refreshEmbeddedCompanionPage();
assert.equal(renders,2,'import refreshes only the mounted added page');
emit('page-unmounted');
panel = null;
window.refreshEmbeddedCompanionPage();
assert.equal(renders,2,'late import completion must not render over a native page');
for (const [input,output] of [['gems','/upgrades/gems'],['settings','/settings'],['sim','/companion/hunters'],['fleet','/companion/fleet'],['upgrades/relics','/upgrades/relics']]) {
  window.navigateEmbeddedCompanion(input);
  assert.equal(request.textContent,output);
}
assert.throws(()=>window.navigateEmbeddedCompanion('missing'),'unknown destinations must fail');
// Negative control: the guard must reject a declared page with no loaded renderer.
panel = {dataset:{cifiCompanionPage:'missing'},isConnected:true};
assert.throws(()=>emit('page-mounted'),/renderer unavailable/);
console.log('PASS client lifecycle, native destinations, import boundaries; unknown-page negative control rejected');
} catch(error) { console.error(error); process.exitCode=1; }
