'use strict';
// THE OPTIMIZER MUST NEVER CLEAR FEWER BOSSES THAN THE BUILD IT IS HANDED.
//
// WHY THIS IS THE INVARIANT AND NOT A THRESHOLD ON LOOT.
//
// Loot is continuous and its gate ("match or beat the import") is already covered by run.js. What
// that gate cannot say is WHICH KIND of shortfall it found, and across every measured build the
// answer has been the same one thing: a boss.
//
// Measured over the 12-build shipped sample, sorted by loot delta:
//
//     borge@73   -39.44%   ref avg stage 300.5 (3 bosses)   ours 299.9 (2 bosses)
//     ozzy@54    -17.86%   ref avg stage 195.7 (1 boss)     ours 195.6 (1 boss)
//     ...every remaining build 0.00% or better, every one boss-matched...
//
// EVERY build that clears the same number of bosses as its reference matches or beats it. The ONLY
// build that falls short by more than the 0.2% comparison noise floor is the ONLY build that clears
// one fewer. A 0.197% difference in average stage cost 39.44% of the loot, because the reward table
// changes on the first kill of a boss stage -- so this is a cliff, not a slope, and a percentage
// threshold on loot describes it far more loosely than counting the cliffs directly.
//
// So: boss count is the DISCRIMINATING variable, it is already recorded in every gate output, and
// it is integer-valued -- which means this check has no tolerance to tune and cannot be softened
// into passing. That is the point.
//
// SEMANTICS, STATED SO NOTHING HERE NEEDS INTERPRETING.
//   bossesCleared(avgStage) = floor(avgStage / BOSS_INTERVAL)
// It is "how many bosses the AVERAGE run gets past", not "can this build ever kill that boss". A
// build averaging 299.9 does sometimes clear 300; what it does not do is clear it often enough for
// the average run to be past it, and average-run reward is what lootPerMin integrates.
//
//   node tools/bench/boss-parity-check.js results-shipped.json [more.json ...]
//
// Reads gate output; runs no optimizer, so it is seconds rather than hours.

const path = require('path');
const fs = require('fs');
const H = require(path.join(__dirname, 'harness.js'));

async function main() {
  let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) {
    // AUTO-DISCOVER, so this runs inside all.js instead of being a gate nobody invokes. It reports
    // SKIP rather than inventing data when the gate has not been run; all.js counts a SKIP
    // separately and --strict turns it into a failure, which is the correct handling for "this
    // check verified nothing".
    const root = path.join(__dirname, '../..');
    files = fs.readdirSync(root)
      .filter((f) => /^results.*\.json$/.test(f))
      .map((f) => path.join(root, f));
    if (!files.length) {
      console.log('SKIP  boss-parity-check: no results*.json in the repo root. Produce one with');
      console.log('      node tools/bench/run.js --sample=12 --out=results-sample.json');
      return;
    }
    console.log(`(no file given -- discovered ${files.length}: ${files.map((f) => path.basename(f)).join(', ')})`);
  }

  const Objective = H.Objective;
  if (!Objective || !Number.isFinite(Objective.BOSS_INTERVAL)) {
    throw new Error('boss-parity-check: OptimizerObjective.BOSS_INTERVAL is unavailable; '
      + 'the boss spacing must come from the objective, not from a copy in this file');
  }
  const INTERVAL = Objective.BOSS_INTERVAL;
  const bosses = (stage) => Math.floor(stage / INTERVAL);

  let rows = [];
  for (const f of files) {
    const p = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
    if (!fs.existsSync(p)) throw new Error(`boss-parity-check: no such results file: ${p}`);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`boss-parity-check: ${f} is not a gate results array`);
    rows = rows.concat(parsed.map((r) => Object.assign({ _file: path.basename(p) }, r)));
  }

  // AN EMPTY COMPARISON SET IS A FAILURE, NOT A PASS. This repo has shipped two benches that
  // silently compared nothing and reported success for it.
  const usable = rows.filter((r) => Number.isFinite(r.importStage) && Number.isFinite(r.optimizedStage));
  if (!usable.length) {
    console.log(`FAIL  boss-parity-check: ${rows.length} row(s) read, 0 carried both `
      + 'importStage and optimizedStage -- nothing was compared');
    process.exit(1);
  }

  const failures = [];
  const matched = [];
  for (const r of usable) {
    const want = bosses(r.importStage);
    const got = bosses(r.optimizedStage);
    const line = `${String(r.hunter || '?').padEnd(5)}@${String(r.level ?? '?').padEnd(3)}`
      + ` ref ${r.importStage.toFixed(2).padStart(7)} (${want} boss${want === 1 ? '' : 'es'})`
      + `  ours ${r.optimizedStage.toFixed(2).padStart(7)} (${got})`
      + (Number.isFinite(r.lootDeltaPct) ? `  loot ${r.lootDeltaPct.toFixed(2).padStart(7)}%` : '');
    if (got < want) failures.push({ r, want, got, line }); else matched.push(line);
  }

  console.log(`boss spacing ${INTERVAL} (from OptimizerObjective.BOSS_INTERVAL)`);
  console.log(`compared ${usable.length} build(s) from ${files.length} file(s)`);
  console.log('');
  for (const f of failures) console.log(`FAIL  ${f.line}   -- clears ${f.want - f.got} fewer boss(es)`);
  if (!failures.length) for (const l of matched) console.log(`ok    ${l}`);

  // Report the correlation the invariant rests on, so a future run can see it stop holding rather
  // than inheriting this file's comment as an assumption.
  const withLoot = usable.filter((x) => Number.isFinite(x.lootDeltaPct));
  const short = withLoot.filter((x) => x.lootDeltaPct < -1);
  const shortAndBossDown = short.filter((x) => bosses(x.optimizedStage) < bosses(x.importStage));
  console.log('');
  console.log(`builds short by more than 1% on loot: ${short.length}`);
  console.log(`  of those, clearing fewer bosses:    ${shortAndBossDown.length}`);
  if (short.length && shortAndBossDown.length !== short.length) {
    console.log('  NOTE: a build is short on loot WITHOUT losing a boss -- that is a different');
    console.log('        cause from the one this check was built for, and needs its own diagnosis.');
  }

  if (failures.length) {
    console.log('');
    console.log(`FAIL  ${failures.length} of ${usable.length} build(s) clear fewer bosses than the reference`);
    process.exit(1);
  }
  console.log('');
  console.log(`PASS  all ${usable.length} build(s) clear at least as many bosses as the reference`);
}

main().catch((e) => { console.error('FAIL ' + (e && e.stack || e)); process.exit(1); });
