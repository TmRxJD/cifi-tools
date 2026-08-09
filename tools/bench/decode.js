'use strict';
// Print everything a build code actually carries. Use when a fixture's recorded score doesn't
// reproduce, to see whether the relevant field is in the code or absent from it.
//   node tools/bench/decode.js <code>
const H = require('./harness.js');

(async () => {
  const code = process.argv[2];
  if (!code) throw new Error('usage: node tools/bench/decode.js <build-code>');
  const build = await H.parseBuildCode(code);
  if (!build) throw new Error('did not decode');
  console.log(`hunter ${build.hunter}  level ${build.level}`);
  console.log('talents        :', JSON.stringify(build.talents));
  console.log('attributes     :', JSON.stringify(build.attributes));
  console.log('base stats     :', JSON.stringify(build.overrides));
  console.log('upgradeOverride:', JSON.stringify(build.upgradeOverrides, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
