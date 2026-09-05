# Integrity audit

**Status: scoping complete, remediation not started.** No feature work until this closes.

This exists because the test harness has been unreliable for two days. Every defect below was
silent: the run completed, the numbers looked plausible, and they were wrong. The point of this
document is that the fixes are enumerated so none is forgotten, and each has an acceptance
criterion that is *checked*, not asserted.

---

## What went wrong (measured, not recalled)

| # | Defect | Consequence | Status |
|---|---|---|---|
| 1 | `evalStateFor` reads a `currentHunter` global | A Knox build scored with Ozzy's stats read **-0.48%** when it is **+18.48%**; a whole investigation chased it | fixed + guarded |
| 2 | Fixtures scored under the developer's account | `borge@13` read **+237%** against a true **+35%** | fixed (`cfgForImport`), documented |
| 3 | Shipped effort declared twice with different values | 9 of 13 `optimize()` call sites inherit it; the entire bench suite validated a config the app never runs | fixed + guarded |
| 4 | `JSON.stringify(Infinity) === null` | Serialized fixture config made **0 of 289** supports realizable; the obvious equivalence check passed anyway because scoring never reads `maxLevel` | fixed + guarded |
| 5 | `AccountState` guard was dead on the bench path | Claimed "structurally impossible"; `cfgForImport` never calls `AccountState` | guard now proven live; **duplication still present** |
| 6 | `ctx.score` dropped `.boss` | Archive collapsed to one cell; QD search silently degraded to a hill climb and still returned a plausible build | fixed + guarded |
| 7 | `optimize()` silently ignored unknown options | 9 benches passed a dead `scorerFor` for months | fixed + guarded |
| 8 | My own tooling produced three confident wrong numbers from bad greps | "37 benches cannot fail" (false), plus two path/label bugs in `basin-probe` | detectors now self-test |

**The pattern in all of them:** a check, a config, or a measurement that could not fail, and nothing
asserted that it could.

---

## Current measured state

```
104 bench files   77 gate-like   27 tools/helpers
  5 gate-like cannot fail (report PASS whatever they find)
 28 gate-like not wired into all.js
 75 gate-like have never been shown capable of failing
 12 guards, all proven live (guard-liveness-check)
```

`all.js` decides status by **exit code only** (`code !== 0 ? FAIL : skipped ? SKIP : PASS`), so a
bench that cannot exit non-zero is decorative regardless of what it prints.

---

## Checklist

### A. Prove every gate can fail (the core gap: 75 of 77)

- [ ] **A1** Build `mutation-check.js`: for each gate, apply a known corruption to the data or code
      path it validates and assert the gate exits non-zero. A gate that still passes is DEAD.
      *Acceptance: every gate in `all.js` has at least one corruption that makes it fail, and the
      list of gates with none is empty.*
- [ ] **A2** Classify the 5 gates that cannot fail (`clamp-intervention`, `ship-audit`,
      `sirred-algorithm-check`, `starvation-check`, `uncapped-bias-check`) as either REPORT (fine,
      but must be declared as such) or GATE (must be given a failure mechanism).
      *Acceptance: no bench is ambiguous; `all.js` labels reports explicitly.*
- [ ] **A3** Every gate must assert it compared a NON-EMPTY set. An empty comparison must fail, not
      pass. (`inscryption-slot-test` once ran over an empty list and passed.)
      *Acceptance: each gate prints a count, and a zero count fails.*

### B. One canonical source per concern

- [ ] **B1** `cfgForImport` is a full parallel implementation of `AccountState.optimizerCfg`.
      Route it through `AccountState.build` so validation cannot be bypassed, keeping the
      spend-based budget as an explicit option.
      *Acceptance: `cfgForImport` contains no independent cfg assembly; the gate's results are
      unchanged (compare `results-shipped.json` before/after, build for build).*
- [ ] **B2** Audit for other parallel implementations: config builders, scorers, cost tables,
      fill/legality logic, anything computing the same fact twice.
      *Acceptance: a written list, each either unified or justified in a comment.*
- [ ] **B3** Enforce it: a check that fails if two files declare the same named constant or the
      same shipped default.
      *Acceptance: negative control — introducing a duplicate declaration fails the check.*

### C. Zod schema enforcement (extend to what is currently unschemaed)

- [ ] **C1** Schema for the optimizer **config** (`cfg`): node lists, deps, minValue, budgets,
      hunterStats keyed to the hunter, `maxLevel` finite-or-Infinity. Replaces the hand-rolled
      checks in `config-sanity-check`.
      *Acceptance: the 6 existing negative controls still fail, now via zod.*
- [ ] **C2** Schema for the optimizer **result** (`best`, `ranked`, `diag`, `ledger`), so a missing
      or renamed diagnostic field fails instead of reading `undefined`.
      *Acceptance: negative control — deleting a `diag` field fails.*
- [ ] **C3** Schema for **gate results** (`results-*.json`), so a consumer cannot read a field that
      silently is not there (`a.bestScore || 0` scored arms as zero).
      *Acceptance: negative control — renaming a field fails.*
- [ ] **C4** Schema for the **serialized fixture config**, including the `Infinity` marker.
      *Acceptance: negative control — a bare `null` `maxLevel` fails.*

### D. Wire everything up

- [ ] **D1** Triage the 28 gates not in `all.js`: gate, report, or diagnostic tool. Wire the gates.
      *Acceptance: `all.js` membership is complete and each omission is justified in one line.*
- [ ] **D2** Add `config-sanity-check` and `guard-liveness-check` to `all.js` (they are gates and
      are currently not run).
- [ ] **D3** `all.js --strict` must be the CI default so a SKIP cannot hide a check that verified
      nothing.

### E. Invariants that report usable status

- [ ] **E1** Every gate prints what it compared and how many, not just PASS.
      *Acceptance: `all.js` shows a count column; a gate reporting zero comparisons fails.*
- [ ] **E2** Any number crossing a boundary carries its units/fidelity in the field name
      (`scoreAtFinalIterations`, not `score`) — the 100-vs-1000-iteration confusion cost a day.
      *Acceptance: a check that fails on a bare `score` field in `diag`.*

---

## Rules adopted from these failures

1. **A check that cannot fail is worse than no check** — it converts an open risk into false safety.
   Every check ships with a negative control.
2. **Verify the detector before trusting the finding.** Three wrong numbers today came from greps
   that were never tested against a known-positive case.
3. **An equivalence test must exercise the code path under test.** The `Infinity` corruption passed
   a scoring-based equivalence check because scoring never reads `maxLevel`.
4. **A setup failure is not a pass.** `guard-liveness-check` counted a missing export as the guard
   firing.
5. **Two copies of one fact will disagree.** Derive, or assert equality.
