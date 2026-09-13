---
name: hunter-game-mechanics
description: Load before touching hunter-side sim/optimizer logic, save import, relics, inscriptions, gadgets, fragments, gear, gem gates, ship crew/rank/evolution/install math, or anything the evaluator/wasm computes for Borge/Ozzy/Knox. Answers "is this game mechanic already verified" and "what did we already learn about X" before re-deriving it from the APK. Covers determinism, memoization, relic/inscription/gadget costs and gating, share-code level inference, gem-tree gates, save-field mappings (attributes, base stats, inscryption slots, loop mods, trinkets, diamond specials, cms), ship crew/rank/evolution, install-node math (coefficients, counters, gear multipliers, badges, Meltdown), tier-2 relic caps, cap-raise formulas, and the IL2CPP/typetree/Cpp2IL methodology used to prove each one. If you are about to say a mechanic "isn't modelled" or "does nothing" or start extracting a new value from the APK, check here first -- this file exists specifically because that mistake has happened repeatedly and each entry records the actual measurement and the wrong reasoning that preceded it.
---

Read [reference.md](reference.md) before asserting a game-mechanics/save-mapping fact is new,
unverified, or contradicts what's already established there.
