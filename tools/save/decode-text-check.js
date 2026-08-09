'use strict';
// Prove the PASTE path: raw save TEXT (as a clipboard would carry it) -> decodeCifiSaveText.
// The paste button calls processImportedSaveText(raw), whose first step is exactly this.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '../../webapp/public');
const sb = { console, TextEncoder, TextDecoder, crypto: require('node:crypto').webcrypto, atob, btoa };
sb.window = sb; sb.self = sb; sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'saveImport.js'), 'utf8'), sb, { filename: 'saveImport.js' });

(async () => {
  const file = process.argv[2] || path.join(__dirname, '../../bridge/test-fixtures/sample-save-DATA.text');
  const raw = fs.readFileSync(file, 'utf8');
  console.log(`raw text: ${raw.length.toLocaleString()} chars`);

  const save = await sb.decodeCifiSaveText(raw);
  const keys = Object.keys(save);
  console.log(`decoded : ${keys.length.toLocaleString()} fields`);
  console.log(`  level  : ${save.BorgeLevel ?? save.PlayerLevel ?? '(n/a)'}`);
  console.log(`  sample : ${keys.slice(0, 6).join(', ')}`);

  // A clipboard round-trip can add/lose surrounding whitespace and normalise newlines; the
  // paste handler trims, so verify those variants decode identically.
  const variants = {
    'trimmed': raw.trim(),
    'leading/trailing whitespace': `\n\n  ${raw.trim()}  \n\n`.trim(),
    'CRLF newlines': raw.trim().replace(/\n/g, '\r\n'),
  };
  for (const [label, text] of Object.entries(variants)) {
    try {
      const d = await sb.decodeCifiSaveText(text);
      console.log(`  ${label.padEnd(28)} -> ${Object.keys(d).length === keys.length ? 'identical' : 'DIFFERENT'}`);
    } catch (e) {
      console.log(`  ${label.padEnd(28)} -> FAILED: ${e.message}`);
    }
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
