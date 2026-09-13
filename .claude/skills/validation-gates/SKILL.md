---
name: validation-gates
description: Load before or after making a change that needs validating -- which bench/gate command to run, what it checks, what the last full sweep result was, and where the TypeScript checker (npm run check) stands. Covers tools/bench/run.js (the optimizer acceptance gate, --sample/--seed/--list), tools/bench/all.js (the wired gate suite, and which ~12 real gates are NOT wired into it), every named check script and what game/site fact it verifies, the two-sided parity diagnostic, and the current TypeScript readiness numbers (9,375 lines, 38 npm run check errors, why a full .ts conversion isn't worth it yet). Use this when deciding which command proves a change is safe, when a bench result needs interpreting, or when asked "is TypeScript ready" / "how do I check this."
---

Read [reference.md](reference.md) for the full command list and the TypeScript readiness numbers.
