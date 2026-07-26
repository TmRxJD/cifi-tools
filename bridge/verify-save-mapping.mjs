// Regression check for webapp/public/saveImport.js's field mapping: decodes the sample save
// in test-fixtures/ (or a path passed as argv[2]), runs it through the real mapCifiSaveToStore,
// then validates every talent/attribute against hunterDefs.js's maxLevel caps and
// attributeDependencies chains. A cap violation or a broken dependency chain means the
// positional Skill{n}Level / attribute-index mapping for that hunter is wrong -- this is how
// the Ozzy echo-talent and snek/vect/cycle/deal swap bugs were originally caught (2026-07).
//
// Usage: node verify-save-mapping.mjs [path/to/DATA.text]
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';

const rawPath = process.argv[2] ?? path.join(import.meta.dirname, 'test-fixtures/sample-save-DATA.text');

class DotNetRandom {
  constructor(seed) {
    const MSEED = 161803398;
    const MBIG = 2147483647;
    this.MBIG = MBIG;
    this.SeedArray = new Array(56).fill(0);
    const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed);
    let mj = MSEED - subtraction;
    this.SeedArray[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.SeedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.SeedArray[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        this.SeedArray[i] -= this.SeedArray[1 + (i + 30) % 55];
        if (this.SeedArray[i] < 0) this.SeedArray[i] += MBIG;
      }
    }
    this.inext = 0;
    this.inextp = 21;
  }
  InternalSample() {
    let locINext = this.inext;
    let locINextp = this.inextp;
    if (++locINext >= 56) locINext = 1;
    if (++locINextp >= 56) locINextp = 1;
    let retVal = this.SeedArray[locINext] - this.SeedArray[locINextp];
    if (retVal === this.MBIG) retVal--;
    if (retVal < 0) retVal += this.MBIG;
    this.SeedArray[locINext] = retVal;
    this.inext = locINext;
    this.inextp = locINextp;
    return retVal;
  }
  NextBytes(n) {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = this.InternalSample() % 256;
    return buf;
  }
}

function computeAesKeyBytes() {
  const EDITOR_NAME = '1for2for3for4two';
  let seed = 0;
  for (const c of EDITOR_NAME) seed += c.charCodeAt(0);
  return new DotNetRandom(seed).NextBytes(16);
}

async function decodeSaveFile(filePath) {
  const rawText = await readFile(filePath, 'utf8');
  const mainB64 = rawText.split('\n')[0].trim();
  const blob = Buffer.from(mainB64, 'base64');
  const iv = blob.subarray(0, 16);
  const ciphertext = blob.subarray(16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', computeAesKeyBytes(), iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

const save = await decodeSaveFile(rawPath);
const saveImportSrc = await readFile(path.join(import.meta.dirname, '../webapp/public/saveImport.js'), 'utf8');
const hunterDefsSrc = await readFile(path.join(import.meta.dirname, '../webapp/public/hunterDefs.js'), 'utf8');

const sandbox = {
  window: {},
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  crypto: { subtle: {} },
  WebSocket: class {},
  TextDecoder: (await import('node:util')).TextDecoder,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(hunterDefsSrc, sandbox);
vm.runInContext(saveImportSrc, sandbox);

const result = sandbox.mapCifiSaveToStore(save);
const DEFS = sandbox.HUNTER_DEFS;

let problems = 0;
for (const [hunterKey, hd] of Object.entries(DEFS)) {
  const ph = result.perHunter[hunterKey];
  if (!ph) continue;

  for (const t of hd.talents) {
    const v = ph.talents[t.id];
    if (v === undefined) { console.log(`[${hunterKey}] MISSING talent ${t.id}`); problems++; continue; }
    if (v > t.maxLevel) { console.log(`[${hunterKey}] CAP VIOLATION talent ${t.id} = ${v} > maxLevel ${t.maxLevel}`); problems++; }
  }
  for (const a of hd.attributes) {
    const v = ph.attributes[a.id];
    if (v === undefined) { console.log(`[${hunterKey}] MISSING attribute ${a.id}`); problems++; continue; }
    if (v > a.maxLevel) { console.log(`[${hunterKey}] CAP VIOLATION attribute ${a.id} = ${v} > maxLevel ${a.maxLevel}`); problems++; }
  }
  for (const [attrId, prereqs] of Object.entries(hd.attributeDependencies || {})) {
    const v = ph.attributes[attrId] || 0;
    if (v <= 0) continue;
    for (const prereq of prereqs) {
      if ((ph.attributes[prereq] || 0) <= 0) {
        console.log(`[${hunterKey}] DEPENDENCY VIOLATION ${attrId}=${v} but prerequisite ${prereq}=0`);
        problems++;
      }
    }
  }
}

console.log(problems === 0 ? '\nALL CHECKS PASSED' : `\n${problems} PROBLEM(S) FOUND`);
process.exitCode = problems === 0 ? 0 : 1;
