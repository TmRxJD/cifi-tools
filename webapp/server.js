'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 5173;
// Live reload is dev-only scaffolding, never wanted for a real deployment (e.g. the
// the-tower-run-tracker copy this gets synced into) -- opt in explicitly.
const LIVE_RELOAD = process.env.LIVE_RELOAD !== '0';

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.css': 'text/css',
};

// Every change under public/ triggers a full page reload in every connected tab via a plain
// Server-Sent-Events stream -- there's no bundler here to do real HMR (module-level hot
// swapping) for this vanilla-script app, so a full reload is the pragmatic equivalent: it's
// still automatic and immediate, which is the actual point (never having to remember to hard
// refresh or wonder if you're looking at stale code while iterating).
const sseClients = new Set();
function broadcastReload() {
  for (const res of sseClients) {
    try { res.write('data: reload\n\n'); } catch { sseClients.delete(res); }
  }
}
if (LIVE_RELOAD) {
  let debounceTimer = null;
  fs.watch(PUBLIC_DIR, { recursive: true }, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(broadcastReload, 100);
  });
}

const LIVE_RELOAD_SCRIPT = `
<script>
(function () {
  function connect() {
    const es = new EventSource('/__livereload');
    es.onmessage = () => location.reload();
    es.onerror = () => { es.close(); setTimeout(connect, 1000); };
  }
  connect();
})();
</script>`;

http.createServer((req, res) => {
  if (LIVE_RELOAD && req.url === '/__livereload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(req.url.split('?')[0]));
  if (req.url === '/' || req.url === '') filePath = path.join(PUBLIC_DIR, 'index.html');
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    // index.html is the entry point that references every other file by (versioned) URL --
    // if a browser caches THIS, it keeps loading old asset URLs forever regardless of any
    // ?v= cache-bust, which is exactly what required a hard refresh to pick up updates
    // (including the bridge connection code). Every other file is safe to cache normally
    // since its URL changes whenever its content does.
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache';
    let body = data;
    if (LIVE_RELOAD && ext === '.html') {
      body = Buffer.from(data.toString('utf8').replace('</body>', `${LIVE_RELOAD_SCRIPT}\n</body>`));
    }
    res.writeHead(200, headers);
    res.end(body);
  });
}).listen(PORT, () => console.log(`HunterSim webapp running at http://localhost:${PORT}${LIVE_RELOAD ? ' (live reload on)' : ''}`));
