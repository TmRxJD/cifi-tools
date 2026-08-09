'use strict';
// What simulation params does a hunter actually read, and which of them can a share code carry?
// Answers "is this field even in the sim?" without guessing.
//   node tools/bench/params-report.js [borge|ozzy|knox]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '../../webapp/public');
const params = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'params.json'), 'utf8'));
const src = fs.readFileSync(path.join(PUBLIC, 'buildCode.js'), 'utf8');
const start = src.indexOf('const CODE_PARAMS');
const end = src.indexOf('};', start) + 2;
const sb = { window: {}, globalThis: {} };
sb.window = sb;
vm.createContext(sb);
vm.runInContext(`${src.slice(start, end)}; this.OUT = CODE_PARAMS;`, sb);
const CODE_PARAMS = sb.OUT;

const hunter = process.argv[2] || 'knox';
const evalParams = params[hunter];
const codeParams = CODE_PARAMS[hunter];
const codeSet = new Set(codeParams);

console.log(`${hunter}: ${evalParams.length} simulation params, ${codeParams.length} share-code fields`);
const notEncodable = evalParams.filter((n) => !codeSet.has(n));
console.log(`\nsimulation params a share code CANNOT carry (${notEncodable.length}):`);
notEncodable.forEach((n) => console.log(`  ${n}`));
const notSimulated = codeParams.filter((n) => !evalParams.includes(n));
console.log(`\nshare-code fields the simulation never reads (${notSimulated.length}):`);
notSimulated.forEach((n) => console.log(`  ${n}`));
