'use strict';
// The evaluator's real argument arity must equal params.json's list length, per hunter.
//
// This is the fact that settles what can and cannot be wired. Eight override controls reach no
// parameter, and the tempting next step is to go looking for the missing slot -- emulate the
// module, hunt for an argument the resolver forgot. There is no such slot: the wasm's own type
// section says EVALBORGE_WASM takes exactly 101 arguments, EVALOZZY_WASM 89 and EVALKNOX_WASM 91,
// which is exactly what params.json lists. Every argument is named and accounted for, so those
// controls cannot be made to affect a result without inventing an input the evaluator does not
// read. They are labelled "not simulated" in the UI instead.
//
// Asserting it here means that if a future release.wasm gains an argument -- which is precisely how
// those controls would become live -- the mismatch is reported rather than silently ignored by a
// params.json that is one entry short.
//
//   node tools/bench/wasm-arity-check.js

const fs = require('fs');
const path = require('path');

const buf = fs.readFileSync(path.join(__dirname, '../../webapp/public/release.wasm'));
const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../../webapp/public/params.json'), 'utf8'));

let p = 8; // magic + version
const u32 = () => { let r = 0, s = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };

const types = [];
const funcTypes = [];
let importedFuncs = 0;
const funcExports = [];

while (p < buf.length) {
  const id = buf[p++];
  const size = u32();
  const end = p + size;
  if (id === 1) {                       // type section
    const n = u32();
    for (let i = 0; i < n; i++) {
      p++;                              // 0x60 func
      const np = u32(); p += np;
      const nr = u32(); p += nr;
      types.push(np);
    }
  } else if (id === 2) {                // import section -- function imports shift the index space
    const n = u32();
    for (let i = 0; i < n; i++) {
      const m = u32(); p += m; const nm = u32(); p += nm;
      const kind = buf[p++];
      if (kind === 0) { u32(); importedFuncs++; }
      else if (kind === 1) { p++; const f = buf[p++]; u32(); if (f) u32(); }
      else if (kind === 2) { const f = buf[p++]; u32(); if (f) u32(); }
      else if (kind === 3) { p += 2; }
    }
  } else if (id === 3) {                // function section
    const n = u32();
    for (let i = 0; i < n; i++) funcTypes.push(u32());
  } else if (id === 7) {                // export section
    const n = u32();
    for (let i = 0; i < n; i++) {
      const nl = u32(); const name = buf.slice(p, p + nl).toString('utf8'); p += nl;
      const kind = buf[p++]; const idx = u32();
      if (kind === 0) funcExports.push({ name, idx });
    }
  }
  p = end;
}

const EVAL = { EVALBORGE_WASM: 'borge', EVALOZZY_WASM: 'ozzy', EVALKNOX_WASM: 'knox' };
let failures = 0;
let checked = 0;

for (const [exportName, hunter] of Object.entries(EVAL)) {
  const e = funcExports.find((x) => x.name === exportName);
  if (!e) { failures++; console.log(`FAIL ${exportName}: not exported by release.wasm`); continue; }
  const arity = types[funcTypes[e.idx - importedFuncs]];
  const listed = params[hunter].length;
  checked++;
  if (arity !== listed) {
    failures++;
    console.log(`FAIL ${exportName}: wasm takes ${arity} argument(s) but params.json lists ${listed} `
      + `for ${hunter}. If the wasm GAINED one, a parameter is unnamed and whatever should drive it `
      + 'is being dropped; if it lost one, every argument after the gap is shifted.');
  } else {
    console.log(`ok   ${exportName}: ${arity} arguments, all named in params.json`);
  }
}

console.log(`\nchecked ${checked} evaluator export(s) against params.json`);
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('every wasm argument is named -- there is no unaccounted parameter slot');
