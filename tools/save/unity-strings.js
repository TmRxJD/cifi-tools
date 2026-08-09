'use strict';
// Extract the ordered string stream from Unity serialized asset files.
//
// WHY THIS EXISTS
// ---------------
// The save stores upgrades positionally (LM0Level..LM294Level, RU0..110, Gadget0..29, CM1..26).
// Working out which index is which upgrade by changing one thing in-game and diffing saves does
// not scale to ~600 slots. It does not have to: the game ships the answer.
//
// The IL2CPP dump (Il2CppDumper output) gives the SaveData field names and the class structure,
// but NOT the display names -- those aren't code string literals (verified: "Trample" and
// "Scavengers Advantage" are absent from stringliteral.json). They live in the Unity scene and
// asset files, where UI Text component values and GameObject names are stored as plain UTF-8.
// Verified directly: "Trample" is in globalgamemanagers.assets, "The Wrench of Gore" and
// "Timeless Mastery" are in level0.
//
// Unity serializes a string as int32 little-endian byte-length followed by UTF-8 bytes, padded
// to a 4-byte boundary. Scanning for that exact shape (rather than any run of printable bytes)
// both avoids garbage and preserves the ORDER objects appear in the file -- and order is what
// lets a GameObject name like "LM7" be associated with the Text values that follow it.
//
//   node tools/save/unity-strings.js <file|dir> [--min 3] [--max 200] [--grep pattern]
//
// Output is one `offset<TAB>string` per line, in file order.

const fs = require('fs');
const path = require('path');

const MIN_DEFAULT = 3;
const MAX_DEFAULT = 200;

/**
 * Pull every plausible Unity-serialized string out of a buffer, in file order.
 * @returns {{offset:number,value:string}[]}
 */
function extractStrings(buf, { min = MIN_DEFAULT, max = MAX_DEFAULT } = {}) {
  const out = [];
  const limit = buf.length - 4;
  for (let i = 0; i <= limit; i += 1) {
    const len = buf.readInt32LE(i);
    if (len < min || len > max) continue;
    const start = i + 4;
    const end = start + len;
    if (end > buf.length) continue;

    // Accept printable ASCII plus common typographic bytes; reject control characters, which is
    // what separates a real string from four bytes that happen to look like a length.
    let ok = true;
    for (let j = start; j < end; j++) {
      const b = buf[j];
      if (b === 9 || b === 10 || b === 13) continue;
      if (b < 32 || b > 126) { ok = false; break; }
    }
    if (!ok) continue;

    const value = buf.toString('utf8', start, end);
    // A real Unity string is followed by alignment padding to a 4-byte boundary; requiring the
    // padding bytes to be zero removes most remaining false positives.
    const padded = (4 - (len % 4)) % 4;
    let padOk = true;
    for (let j = end; j < end + padded && j < buf.length; j++) if (buf[j] !== 0) { padOk = false; break; }
    if (!padOk) continue;

    out.push({ offset: i, value });
    i = end + padded - 1;
  }
  return out;
}

function filesUnder(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target)
    .map((f) => path.join(target, f))
    .filter((f) => fs.statSync(f).isFile());
}

function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  if (!target) throw new Error('usage: node tools/save/unity-strings.js <file|dir> [--min N] [--max N] [--grep pattern]');
  const flag = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? def : args[i + 1];
  };
  const min = Number(flag('min', MIN_DEFAULT));
  const max = Number(flag('max', MAX_DEFAULT));
  const grep = flag('grep', null);
  const re = grep ? new RegExp(grep, 'i') : null;

  for (const file of filesUnder(target)) {
    const strings = extractStrings(fs.readFileSync(file), { min, max });
    const hits = re ? strings.filter((s) => re.test(s.value)) : strings;
    if (!hits.length) continue;
    console.log(`\n## ${path.basename(file)}  (${strings.length} strings, ${hits.length} shown)`);
    for (const s of hits) console.log(`${String(s.offset).padStart(10)}\t${s.value}`);
  }
}

module.exports = { extractStrings };
if (require.main === module) main();
