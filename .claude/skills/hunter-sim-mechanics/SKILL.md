---
name: hunter-sim-mechanics
description: Load before touching per-hunter (Borge/Ozzy/Knox) sim/optimizer logic, save import, relics, inscriptions, gadgets, fragments, gem gates, talent/attribute search, or anything the evaluator/wasm computes for a hunter build. Does NOT cover ships/fleet installs, gear, or crew/rank -- see fleet-ship-mechanics for those. Answers "is this game mechanic already verified" and "what did we already learn about X" before re-deriving it from the APK. Covers determinism, memoization, relic/inscription/gadget costs and gating, share-code level inference, gem-tree gates, save-field mappings (attributes, base stats, inscryption slots, loop mods, trinkets, diamond specials, cms), the talent/attribute optimizer's known bugs (flat-fill bias, threshold-fill degeneracy, boss-wall objective blindness), and the IL2CPP/typetree/Cpp2IL methodology used to prove each one. If you are about to say a mechanic "isn't modelled" or "does nothing" or start extracting a new value from the APK, check here first -- this file exists specifically because that mistake has happened repeatedly and each entry records the actual measurement and the wrong reasoning that preceded it.
---

Read [reference.md](reference.md) before asserting a hunter-side game-mechanics/save-mapping fact
is new, unverified, or contradicts what's already established there. For ships, fleet installs,
gear, or crew/rank, use `fleet-ship-mechanics` instead.
