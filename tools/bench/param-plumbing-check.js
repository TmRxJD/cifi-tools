'use strict';
// Every sim parameter the evaluator reads must be SETTABLE, and must land in its own argument slot.
//
// This is the hunter-side counterpart of node-factor-check. The fleet side asks "is every factor in
// the game's multiply chain accounted for"; here the chain is the wasm's argument vector, and the
// question is whether our resolver can actually drive each of its ~90-100 slots.
//
// The failure it catches is a resolver that SILENTLY DROPS a value. `resolveParam` has a generic
// override path, so almost every param is settable by name -- which makes the exceptions
// interesting rather than routine. It found two:
//
//   * `exodus_gem3` (Ozzy) and `exodus_gem5` (Knox) ignored an explicit override entirely, while
//     their Count twins honoured one. An input that vanishes is the single failure mode this
//     project treats as unacceptable in a resolver.
//   * Worse, overriding the Count moved only its own slot, so the wasm received a pair of
//     arguments holding DIFFERENT values for one quantity -- a state the real game cannot produce.
//
// NO TWINS. An earlier version of this bench declared exodus_gem3/powerInnovationCount and
// exodus_gem5/attractionCreationCount as "twins" that had to move together, because our resolver
// derived both halves from the same sum. The live cifi-tools bundle -- authoritative here, since
// that tool was built with the game's devs -- says otherwise: `gemN` is a 0/1 owned flag and the
// Count params are never derived at all. The resolver now matches, so every param moves exactly
// one slot and there is nothing to declare. Keeping a twin table would have frozen our own bug in
// as an expectation.
//
//   node tools/bench/param-plumbing-check.js [--verbose]

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const sb = H.browserSandbox();
const verbose = process.argv.includes('--verbose');
const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../../webapp/public/params.json'), 'utf8'));

// Left deliberately empty -- see the note above. If a genuine two-name quantity ever appears,
// declare it here rather than inferring it from a diff.
const TWINS = [];
const twinOf = new Map();
TWINS.forEach(([a, b]) => { twinOf.set(a, b); twinOf.set(b, a); });

(async () => {
  let failures = 0;
  let checked = 0;

  for (const hunter of ['borge', 'ozzy', 'knox']) {
    const names = params[hunter];
    const base = { hunterStats: {}, talents: {}, attributes: {}, upgrades: {}, overrides: {}, level: 60 };
    const a0 = await sb.HunterSim.buildArgs(hunter, base);
    if (a0.length !== names.length) {
      failures++;
      console.log(`FAIL ${hunter}: argument vector is ${a0.length} long but params.json lists ${names.length}`);
      continue;
    }

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      checked++;
      const value = (Number(a0[i]) || 0) + 3;
      const args = await sb.HunterSim.buildArgs(hunter, { ...base, overrides: { [name]: value } });
      const moved = [];
      for (let j = 0; j < args.length; j++) if (args[j] !== a0[j]) moved.push(j);

      const twin = twinOf.get(name);
      const allowed = new Set([i]);
      if (twin) {
        const ti = names.indexOf(twin);
        if (ti >= 0) allowed.add(ti);
      }

      if (moved.length === 0) {
        failures++;
        console.log(`FAIL ${hunter} [${i}] ${name}: setting an override changed NOTHING -- the `
          + 'resolver silently drops it');
      } else if (!moved.every((j) => allowed.has(j)) || !moved.includes(i)) {
        failures++;
        console.log(`FAIL ${hunter} [${i}] ${name}: override moved ${JSON.stringify(moved.map((j) => `${j}:${names[j]}`))}`
          + `, expected only its own slot${twin ? ` and its twin ${twin}` : ''}`);
      } else if (twin && moved.length !== allowed.size) {
        failures++;
        console.log(`FAIL ${hunter} [${i}] ${name}: is twinned with ${twin} but only its own slot `
          + 'moved -- the wasm would receive two different values for one quantity');
      } else if (verbose) {
        console.log(`ok   ${hunter} [${i}] ${name}${twin ? ` (+twin)` : ''}`);
      }
    }
  }

  console.log(`\nchecked ${checked} sim parameter(s) across 3 hunters`);
  if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
  console.log('every sim parameter is settable and lands in its own slot');
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
