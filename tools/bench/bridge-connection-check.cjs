const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('webapp/public/saveImport.js', 'utf8');
const start = source.indexOf('const BRIDGE_PORT =');
const end = source.indexOf('window.tryConnectCifiBridge = tryConnectBridge;') + 'window.tryConnectCifiBridge = tryConnectBridge;'.length;
assert(start >= 0 && end > start, 'bridge client must be measured');
function fixture(permission = 'granted', legacy = false, probe = null) {
  const sockets = [], timers = new Map();
  class Socket {
    static OPEN = 1;
    constructor(url, options) {
      if (legacy && options) throw new TypeError('legacy constructor');
      this.readyState = 0;
      this.listeners = {};
      sockets.push(this);
    }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    hello() { this.readyState = 1; this.onmessage({ data: JSON.stringify({ type: 'HELLO' }) }); }
  }
  const context = { window: {}, AbortController, fetch: async () => {
    if (probe) return { ok: true, json: async () => probe };
    throw new TypeError('network blocked');
  }, navigator: { permissions: { query: async ({ name }) => {
    assert.equal(name, 'loopback-network');
    if (permission === 'unsupported') throw new TypeError('unsupported permission');
    return { state: permission };
  } } }, WebSocket: Socket, setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  const measured = source.slice(start, end);
  vm.runInNewContext(process.argv.includes('--negative-control')
    ? measured.replace('Math.max(timeoutMs, 8000)', 'timeoutMs') : measured, context);
  return { ...context.window, sockets, timers };
}
async function main() {
  const f = fixture();
  const first = f.tryConnectCifiBridge(1000);
  const second = f.tryConnectCifiBridge();
  await new Promise(setImmediate);
  assert.equal(f.sockets.length, 1, 'concurrent probes share one socket');
  assert([...f.timers.values()][0].ms >= 8000, 'delayed handshake must survive the old one-second timeout');
  f.sockets[0].hello();
  assert.equal(await first, await second);
  assert.equal(await f.tryConnectCifiBridge(), f.sockets[0], 'reuse established socket');
  f.sockets[0].listeners.close();
  const again = f.tryConnectCifiBridge();
  await new Promise(setImmediate);
  assert.equal(f.sockets.length, 2, 'closed socket is replaced');
  f.sockets[1].hello();
  await again;
  const denied = fixture('denied');
  assert.equal(await denied.tryConnectCifiBridge(), null);
  assert.equal(denied.sockets.length, 0);
  assert.match(denied.cifiBridgeConnectionMessage(), /blocked/);
  const prompt = fixture('prompt');
  assert.equal(await prompt.tryConnectCifiBridge(), null, 'background must not trigger permission prompt');
  const clicked = prompt.tryConnectCifiBridge(1000, { interactive: true });
  await new Promise(setImmediate);
  assert.equal([...prompt.timers.values()][0].ms, 60000, 'user can answer permission prompt');
  prompt.sockets[0].hello();
  await clicked;
  const old = fixture('unsupported', true);
  const compatible = old.tryConnectCifiBridge();
  await new Promise(setImmediate);
  old.sockets[0].hello();
  await compatible;
  const failed = fixture();
  const attempt = failed.tryConnectCifiBridge();
  await new Promise(setImmediate);
  failed.sockets[0].onerror();
  assert.equal(await attempt, null);
  assert.equal(failed.timers.size, 0, 'failure clears timer');
  assert.match(failed.cifiBridgeConnectionMessage(), /permissions/);
  const reachable = fixture('granted', false, { product: 'adb-bridge', game: 'cifi', version: '0.6.1' });
  const blockedSocket = reachable.tryConnectCifiBridge();
  await new Promise(setImmediate);
  reachable.sockets[0].onerror();
  await blockedSocket;
  assert.match(reachable.cifiBridgeConnectionMessage(), /reachable.*WebSocket/);
  const wrong = fixture('granted', false, { product: 'other-service' });
  const wrongAttempt = wrong.tryConnectCifiBridge();
  await new Promise(setImmediate);
  wrong.sockets[0].onerror();
  await wrongAttempt;
  assert.match(wrong.cifiBridgeConnectionMessage(), /different or outdated/);
  console.log('PASS: delayed handshake, shared/reused socket, reconnect, denied/prompt permission, legacy browser, failure cleanup');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
