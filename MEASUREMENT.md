# The measurement contract

Every wrong conclusion in this project's recent history came from a **broken measurement**, not a
broken algorithm. Not one. That is the single most important fact about working here, and this file
exists so it stops being rediscovered.

A result is only as good as the test that produced it. **An unverified measurement is worse than no
measurement**, because it is acted on.

Each rule below is followed by the real failure that produced it. None is hypothetical.

---

## 1. Name the exact fixture, never `hunter@level`

Two fixtures can share a level. `knox@35` scores **+0.04%** and is healthy; `knox@35b` scores
**−0.69%** and is the failing one. A shortfall report printed `knox@35` for the failing build, that
ambiguous label was fed into a spot check, and the check measured the **healthy** build and reported
it fine.

> A report that cannot name what it is reporting on sends the next investigation to the wrong place.

**Rule:** reports print `fixture.name` (or `uid`), resolved from the fixture list. Never build an
identifier by concatenating hunter and level.

## 2. Judge every build on ITS OWN objective

14 of 195 fixtures are `push` builds, judged on average stage. Judging one on loot fails it for
succeeding at what it was built for.

- `sweep-progress` ranked push builds on loot and reported borge@12 as a shortfall when it had
  **beaten** its import on stage by 2.79%.
- `boss-damage-ab` built its scorer from `fx.mode` but hardcoded `mode: 'loot'` into `optimize()` —
  incoherent, and one push fixture away from lying.

**Rule:** a bench that judges a build against its import reads `fixture.mode`. A bench that assumes
loot **refuses** a push fixture rather than scoring it wrongly. Enforced by
`bench-integrity-check.js`.

## 3. Test a mechanism on the build it is FOR

`bossDamageBands` splits kill-0 cells by boss damage. It was measured **once**, on borge@73, whose
archive fills **477 cells** — a descriptor already discriminating fine. It did nothing there, and
was deleted as measured-dead.

knox@30 fills **SIX cells**: every build is `kill 0` at stage ≈100, so only concentration varies.
That is the degenerate archive the axis exists for, and it was never tested there.

> A null result on a build the mechanism was not designed for is not evidence about the mechanism.

**Rule:** before running an A/B, write down which build's *failure shape* the mechanism addresses,
and test that shape. borge@73 (rich archive, converges regardless) and knox@30 (degenerate archive)
are **opposite** problems.

## 4. Assert the flag from the RESULT, never from the argument

`bossDamageBands` was added to `cellOf`, to `illuminate`'s signature and to its diag record — and
was **never passed at the call site**, because the surrounding lines used `!== false` where the
patch matched `=== true`. It read as correctly wired at three of four sites.

Unnoticed, the ON arm returns the control's number and it is written down as *"measured, no
effect"* — a false negative indistinguishable from a real one.

**Rule:** an A/B asserts the flag from `res.diag`, and **refuses to produce a number** if the run
did not record the setting it was given. This has already fired twice for real.

## 5. Know the noise floor before calling anything a result

Measured: `FINAL_ITERATIONS` carries ~0.12% mean error, so a comparison of two scores carries
~0.2–0.3%. Separately, **the search varies ~7 percentage points across seeds** — one seed is one
sample.

- knox@31's FI "regression" (−0.87%, then −2.72%) sits **inside** the seed variance. It is not
  evidence of harm, and equally not evidence of safety.
- An earlier "identical configuration" returned +15.34% and +8.24% purely because one added `rng()`
  call shifted the random stream.

**Rule:** state the floor with the number. A single-seed difference narrower than ~7 points is not a
result; a difference under ~0.3% is not even a difference.

## 6. Judge both arms on the SAME ruler

When comparing a cheaper configuration, score both arms at the **same** fidelity as the expensive
one. Scoring the cheap arm on its own noisier ruler flatters it — the same error as judging a push
build on loot, wearing different clothes.

## 7. A bench that compares nothing must FAIL, not pass

- A results file held 182 rows from a **crashed** run — every one a `ReferenceError`. Counting "rows
  with a finite delta" returned **zero shortfalls**, which reads exactly like a clean sweep and is a
  sweep that measured nothing.
- Historically: a fleet-slot check ran over an empty list and passed regardless.

**Rule:** print the comparison count. Zero comparisons is a failure. `sweep-progress` says
`NOTHING MEASURED` rather than reporting a pass.

## 8. A gate that cannot fail is not a gate

`sirred-algorithm-check` printed *"our allocator scored worse at N combinations"* and exited **0**.
A real regression was invisible to any runner.

A **report** is legitimate — some questions are honestly answered by "theory not supported" — but it
must *say so*, because from outside a report and a broken gate are identical.

**Rule:** every gate-shaped bench exits non-zero on failure or declares itself a REPORT. Enforced.

## 9. Do not let controls pollute the tally

`config-sanity-check` counted its own negative controls as failures, so a clean run printed
`3303/3311 checks passed` — eight apparent failures that were the controls working. A summary that
looks like a partial failure on a healthy run is one people learn to ignore.

**Rule:** restore counters after a deliberate corruption; report controls separately.

## 10. Score a fixture under ITS OWN account state

`cfgFor` reads the current store; `cfgForImport` reads only the build's own overrides. Using the
first on a community fixture reported borge@13 at **+237%** when the truth was +35% — it was
allocating 13 points against a maxed level-62 account's upgrades.

## 11. One writer per results file

Three sweeps ran concurrently, all rewriting the same file. Each rewrites the whole thing from its
own memory, so a run without `--resume` overwrote a resumed run's larger list. Progress went
**21 rows → 15 rows**, work going backwards, no error anywhere.

The kill that was supposed to prevent it matched nothing and reported success.

**Rule:** the guard lives in the program (a pid lock), not in the invocation.

## 12. No constructed regexes with escapes in benches

Five separate patches had a backslash level eaten by the shell heredoc that wrote them, turning an
escaped word-boundary into a literal **backspace** that matches nothing. Two historical benches were
disabled this way and passed on empty matches. Two versions of an audit whose job was *finding dead
code* accused five live functions of being dead.

**Rule:** character scanning, not regex, in bench tooling. It cannot acquire the bug.

## 13. Distinguish a timeout from a failure

`effort-option-check` was reported as FAILING when exit code 124 was a 115-second timeout. The gate
passed fine when given time.

**Rule:** check the exit code before calling something broken.

## 14. Silence is not progress, and neither is CPU

A sweep with longest-first scheduling printed nothing for minutes and was reasonably read as a hang.
Separately, a browser run *looked* alive while using **1.62 seconds of CPU per 20 seconds** — asleep,
not slow.

**Rule:** long jobs report on start, not only on completion. Confirm work is happening by measuring
CPU, not by the absence of an error.

---

## The meta-rule

**My own audit tools have carried the defects they hunt — three times.** A dead-code auditor with a
regex that matched nothing. A no-op auditor whose comment stripper swallowed live code. A
gate-integrity checker that missed `process.exit(bad ? 1 : 0)` and accused `all.js`.

So: **a new measurement tool is not trusted until it has been shown to fail on a known-bad input.**
Negative controls are not optional decoration; they are the only evidence a check can detect
anything at all.
