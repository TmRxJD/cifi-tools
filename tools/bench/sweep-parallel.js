'use strict';
// RUN THE CORPUS-METHOD SWEEP FOR ALL THREE HUNTERS AT ONCE.
//
//   node tools/bench/sweep-parallel.js
//
// WHY THIS EXISTS. The sequential loop ran one hunter at a time. Each run's scorer pool is capped
// at 3 workers (harness sets hardwareConcurrency 4, runner takes min(6, 4-1)), so a single hunter
// occupies ~4 of this machine's 8 cores and the other half sits idle. Three concurrent hunters
// oversubscribe slightly (~12 threads on 8 cores) but still finish far sooner, because the binding
// constraint is total CPU-seconds and half of them were being thrown away.
//
// RESUMABLE BY CONSTRUCTION: each hunter writes new-<hunter>.json after EVERY build and skips what
// is already recorded, so stopping and restarting this loses at most one in-flight build. Killing
// the old sequential sweep and starting this does NOT discard the knox builds already done.
//
// Each hunter is retried until its run prints the completion summary, because a sweep in this
// project has never once survived to the end on the first attempt.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '../..');
const HUNTERS = ['borge', 'ozzy', 'knox']; // longest first, so the tail is short
const MAX_ATTEMPTS = 8;

function runOnce(hunter) {
  return new Promise((resolve) => {
    const log = fs.openSync(path.join(ROOT, `new-${hunter}.log`), 'a');
    const child = spawn(process.execPath, [
      path.join(__dirname, 'corpus-donor-refine.js'),
      '--all', `--hunter=${hunter}`, `--out=new-${hunter}.json`,
    ], { cwd: ROOT, stdio: ['ignore', log, log] });
    child.on('exit', (code) => { fs.closeSync(log); resolve(code); });
    child.on('error', () => { try { fs.closeSync(log); } catch (e) { /* already closed */ } resolve(-1); });
  });
}

function completed(hunter) {
  const f = path.join(ROOT, `new-${hunter}.log`);
  if (!fs.existsSync(f)) return false;
  return fs.readFileSync(f, 'utf8').includes('met or beat');
}

async function driveHunter(hunter) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const code = await runOnce(hunter);
    if (completed(hunter)) {
      console.log(`${hunter}: COMPLETE (attempt ${attempt})`);
      return;
    }
    console.log(`${hunter}: attempt ${attempt} exited ${code} without finishing -- resuming`);
  }
  console.log(`${hunter}: gave up after ${MAX_ATTEMPTS} attempts -- run sweep-status.js to see how far it got`);
}

(async () => {
  console.log(`sweeping ${HUNTERS.join(', ')} in parallel; check progress with:`);
  console.log('  node tools/bench/sweep-status.js');
  console.log('');
  await Promise.all(HUNTERS.map(driveHunter));
  fs.writeFileSync(path.join(ROOT, 'new-done.log'), `complete ${new Date().toISOString()}\n`);
  console.log('');
  console.log('ALL HUNTERS COMPLETE');
})();
