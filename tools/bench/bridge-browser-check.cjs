const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const { chromium } = createRequire(path.resolve('compare-mcp/package.json'))('playwright');
const { WebSocketServer } = createRequire(path.resolve('../../adb-bridge/package.json'))('ws');
const source = fs.readFileSync('webapp/public/saveImport.js', 'utf8');
const start = source.indexOf('const BRIDGE_PORT =');
const end = source.indexOf('window.tryConnectCifiBridge = tryConnectBridge;') + 'window.tryConnectCifiBridge = tryConnectBridge;'.length;
assert(start >= 0 && end > start);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<script>${source.slice(start, end).replace('const BRIDGE_PORT = 43791;', `const BRIDGE_PORT = ${server.address().port};`)}</script>`);
});
const wss = new WebSocketServer({ server });
let connections = 0;
wss.on('connection', socket => {
  connections++;
  const timer = setTimeout(() => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'HELLO' }));
  }, 1800);
  socket.on('close', () => clearTimeout(timer));
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const [a, b] = await Promise.all([window.tryConnectCifiBridge(1000, { interactive: true }), window.tryConnectCifiBridge(1000, { interactive: true })]);
      return { open: a?.readyState === WebSocket.OPEN, same: a === b, reused: await window.tryConnectCifiBridge() === a };
    });
    assert.deepEqual(result, { open: true, same: true, reused: true });
    assert.equal(connections, 1);
    console.log('PASS: real Chrome accepts a 1.8-second HELLO, shares concurrent probes, and reuses one live socket');
  } finally {
    await browser?.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
