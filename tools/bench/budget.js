'use strict';
// A WALL-CLOCK BUDGET FOR MEASUREMENT BENCHES, SO THEY REPORT INSTEAD OF RUNNING FOREVER.
//
//   const budget = makeBudget(args, { minutes: 15 });
//   for (const fx of picks) {
//     if (budget.stop(done, picks.length)) break;
//     ...
//   }
//   budget.report(done, picks.length);
//
// WHY. These benches loop over builds running the real optimizer, and per-build cost varies more
// than 10x with level -- so "five builds" can mean four minutes or forty, and there is no way to
// tell which until it is already happening. Every one of them has been launched and then waited on
// blindly, repeatedly, in this project. A measurement you cannot predict the end of is one you
// stop running.
//
// PARTIAL RESULTS ARE REPORTED AS PARTIAL. The budget stops between BUILDS, never mid-build, so
// every row printed is a complete measurement -- and the summary says how many of the requested
// builds were actually measured.
//
// IT THEREFORE OVERSHOOTS, BY UP TO ONE BUILD. A 2-minute budget was measured finishing at 222s
// because the build in flight took 221s. That is the deliberate trade: a half-measured row is
// worse than a late one, since it would be a number nobody could interpret. The report prints
// actual elapsed time, so the overshoot is visible rather than implied.
//
// A truncated sweep that printed a median without saying it covered three of nine would be exactly
// the kind of number this repo has been burned by: technically produced, quietly answering a
// different question than the one asked.
//
// It deliberately does NOT cap the optimizer itself (`maxSeconds`). That would change what each
// arm computes and make the comparison measure the cap rather than the thing under test -- see
// effort-value-check, which disables the optimizer's cap for that reason. This bounds how many
// builds are attempted, not how each one runs.

/**
 * @param {string[]} args      process.argv.slice(2), for --max-minutes=
 * @param {{minutes?: number}} [opts]  default budget when the flag is absent
 */
function makeBudget(args, opts = {}) {
  const flag = args.find((a) => a.startsWith('--max-minutes='));
  const minutes = flag ? Number(flag.slice('--max-minutes='.length)) : (opts.minutes || 15);
  // 0 or negative disables the budget, for a deliberate overnight run. Stated rather than
  // silently clamped, because "I asked for no limit and got 15 minutes" is a worse surprise than
  // a run that goes long on purpose.
  const unlimited = !Number.isFinite(minutes) || minutes <= 0;
  const startedAt = Date.now();
  const deadlineAt = unlimited ? Infinity : startedAt + minutes * 60_000;
  let stopped = false;

  return {
    minutes,
    unlimited,
    elapsedSeconds: () => Math.round((Date.now() - startedAt) / 1000),

    /** True when the budget is spent. Call BETWEEN builds so no row is half-measured. */
    stop(done, total) {
      if (Date.now() <= deadlineAt) return false;
      if (!stopped) {
        stopped = true;
        console.log(`\n*** STOPPED at the ${minutes}-minute budget after ${done} of ${total} `
          + 'build(s). Raise it with --max-minutes=N, or --max-minutes=0 for no limit. ***');
      }
      return true;
    },

    /** Print what was actually covered. Always call it: silence reads as "all of them". */
    report(done, total) {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (done < total) {
        console.log(`\nPARTIAL: ${done} of ${total} build(s) measured in ${secs}s. Any summary `
          + 'above describes ONLY those, and is not a result for the full set.');
      } else {
        console.log(`\ncomplete: ${done} build(s) in ${secs}s`
          + (this.unlimited ? '' : ` (budget ${minutes}m)`));
      }
    },
  };
}

module.exports = { makeBudget };
