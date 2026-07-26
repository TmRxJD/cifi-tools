'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 5173;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.css': 'text/css',
};

http.createServer((req, res) => {
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
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(PORT, () => console.log(`HunterSim webapp running at http://localhost:${PORT}`));
