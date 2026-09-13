---
name: fleet-ship-mechanics
description: Load before touching ship/fleet logic -- crew, rank, evolution, install-node math (coefficients, counters, gear multipliers, badges, Meltdown), gear pieces/sets, the fleet allocator, or anything shipSchema.js/shipsPage.js computes for Cradle/Demeter/Auxesia/Hephaestus/Koios/Zagreus/Zeus. Does NOT cover per-hunter (Borge/Ozzy/Knox) sim logic, relics, or save-field mappings for hunter stats -- see hunter-sim-mechanics for those. Answers "is this fleet mechanic already verified" before re-deriving it from the APK. Covers ship install node dispatch (which RU<Category><n>Bonus getter reads what), gear piece->install mappings and their exponential (base^level) scaling, gear set bonuses, badge multipliers, cap-raise formulas, Meltdown's exponent placement, the growth-counter zero-at-reset bug, the AOTC operations-grant scoring fix, and the allocator gate (allocator-check.js, node-factor-check.js, node-effect-probe.js). If you are about to say a ship mechanic "isn't modelled" or start extracting a new fleet value from the APK, check here first.
---

Read [reference.md](reference.md) before asserting a fleet/ship-mechanics fact is new, unverified,
or contradicts what's already established there. For per-hunter sim/relic/save-import questions,
use `hunter-sim-mechanics` instead.
