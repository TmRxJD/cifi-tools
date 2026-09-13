---
name: optimizer-search-design
description: Load before touching, tuning, or proposing a change to webapp/public/optimizer/ (space.js, search.js, runner.js, worker.js, objective.js) -- the MAP-Elites archive, corpus-donor refit, VND polish, effort levels, boss-cliff handling, or any search-quality question. Answers "has this metaheuristic already been tried" before reaching for FI-MAP-Elites, bet-and-run, OCBA, GOMEA, SAIL, path relinking, R-SPLINE, or a richer move set -- most of these were implemented and measured, several are the standing open defect list. Covers why marginal-greedy allocation fails here, the talent/attribute coupling, why the archive stopped being the bottleneck once corpus donors landed, every budget dial's measured justification (top-K, maxevals, neighborhoods), the boss-wall/boss-cliff mechanism and its fix, and which builds still fail and why (borge@73, knox@30, the Ozzy bimodal outcome). If you are about to suggest "what about trying X" for the search algorithm, check here first -- a large fraction of the plausible ideas in this space have already been tried and measured, sometimes rejected for a specific reason worth reading before re-attempting.
---

Read [reference.md](reference.md) before implementing or proposing a change to the search
algorithm, its effort/budget tuning, or its behaviour on a specific hunter/level fixture.
