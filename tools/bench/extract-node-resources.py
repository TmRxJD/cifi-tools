"""Which resource pool actually READS each install node's bonus.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-resources.py --write

WHY. A node's RESOURCE -- which pool its percentage boosts -- was the one field of the install
catalog never checked against the game. Name, coefficient, counter, cap and gate all were; the
resource was parsed out of the node's ENGLISH EFFECT TEXT by keyword, and a keyword parser is only
as good as the prose it reads. It is not cosmetic: `nodeMarginalLogGain` weights a node by its
tagged resources, so a mis-tagged node is mis-ranked.

The game states it unambiguously. Each `RU<Cat><n>Bonus` getter is read by exactly the pools it
feeds -- `MK<n>Production`, `CellProductionTotalMult`, `ShardsTotalMult`, `RPTotalMult`,
`MPTotalMult`, `Missions.APTotalMult`, `Missions.TotalMaterialBonus`,
`TechUpgrades.TotalSoftwareMult`/`TotalHardwareMult` -- so the consumer list IS the resource set.

SCAN THE WHOLE ASSEMBLY, NOT A LIST OF CLASSES. An earlier version scanned a hand-picked set of
managers and left 5 of 77 nodes with no consumer at all, because their pools live in `Missions` and
`TechUpgrades` -- classes nobody thought to name. A curated class list cannot distinguish "this node
feeds nothing" from "I did not look in the right file", and that is exactly the failure this whole
exercise exists to eliminate. One decompile of Assembly-CSharp.dll answers it for every node at
once.

EVERY NODE MUST RESOLVE. A node ends up either with a resource set or flagged `amplifier` (Demeter's
Ahead Of The Curve grants operations rather than boosting a pool -- it is consumed in
`LoopModifiers.PerformLoop`). There is deliberately no third "could not determine" state: this exits
non-zero instead, because an unresolved node in the reference becomes a check that silently compares
nothing.
"""

import argparse
import json
import os
import re
import subprocess
import sys

APK = os.environ.get("CIFI_APK", "apk-0.7.3.61")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "tools", "reference", "node-resources.json")

SCRATCH = os.environ.get("HUNTERSIM_SCRATCH") or (
    r"B:\huntersim-re" if os.path.isdir("B:\\")
    else os.path.join(ROOT, "tools", "gamefiles", "scratch"))
DLL = os.path.join(SCRATCH, f"cpp2il_out-{APK}", "Assembly-CSharp.dll")
FULL_CS = os.path.join(SCRATCH, f"full-{APK.replace('apk-', '')}.cs")

CATEGORIES = ["Gen", "Tech", "Loop", "Auto", "Shard", "Research", "Academy"]
GEN_TIERS = list(range(1, 13))  # the game's chain runs MK1Production..MK12Production

# Consumer member -> the tool's resource tags. Explicit, never a pattern: a regex that "looks
# resource-ish" swallows plumbing and, worse, silently misses a pool whose name does not fit --
# which is how a first pass left every direct-Cells node unverified (its filter was
# `endswith("Production")`, and Cells is accumulated in `CellProductionTotalMult`).
RESOURCE_OWNERS = {
    "CellProductionTotalMult": ["cells"],
    "ShardsTotalMult": ["shards"],
    "RPTotalMult": ["researchPoints"],
    "MPTotalMult": ["modPoints"],
    "APTotalMult": ["academyPoints"],
    "TotalMaterialBonus": ["missionMaterials"],
    # Intermediate pools: boosting a Tech Upgrade's OUTPUT makes the upgrade COUNT compound, which
    # other nodes convert into Cells/Shards/RP. The game keeps real totals for them, so they are
    # ordinary resources here rather than a tool-only abstraction.
    "TotalSoftwareMult": ["techSoftware"],
    "TotalHardwareMult": ["techHardware"],
    # An "All Gens" bonus reaches every generator tier.
    "FinalAllGensBonus": [f"mk{n}" for n in GEN_TIERS],
}
for _n in GEN_TIERS:
    RESOURCE_OWNERS[f"MK{_n}Production"] = [f"mk{_n}"]

# AMPLIFIERS grant a COUNTER rather than boosting a pool.
AMPLIFIER_OWNERS = {"PerformLoop"}

CLS = re.compile(r"^(?:public |internal |sealed |abstract |static )*class ([A-Za-z0-9_]+)")
OWNER = re.compile(r"^\t(?:public|private|internal|protected)[^(){}]*?\b([A-Za-z0-9_]+)\s*(?:\(|$)")
BONUS = re.compile(r"\bRU(" + "|".join(CATEGORIES) + r")(\d+)Bonus\b")


def full_source():
    """The whole assembly as C#, decompiled once and cached."""
    if os.path.isfile(FULL_CS):
        return FULL_CS
    if not os.path.isfile(DLL):
        sys.exit(f"{DLL} not found -- run tools/il2cpp-cli/csharp.py --rebuild first")
    print(f"decompiling the whole assembly to {FULL_CS} (one-off)...", file=sys.stderr)
    with open(FULL_CS, "w", encoding="utf-8") as fh:
        res = subprocess.run(["ilspycmd", DLL], stdout=fh, stderr=subprocess.PIPE, text=True)
    # A truncated decompile would silently shrink the consumer set, so size is checked too.
    if res.returncode != 0 or os.path.getsize(FULL_CS) < 1_000_000:
        if os.path.isfile(FULL_CS):
            os.remove(FULL_CS)
        sys.exit(f"ilspycmd failed: {res.stderr[-600:]}")
    return FULL_CS


def consumers(path):
    """(category, index) -> {"Class.Member", ...} for every read of that node's bonus."""
    out = {}
    cls = None
    owner = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            m = CLS.match(ln)
            if m:
                cls, owner = m.group(1), None
                continue
            m = OWNER.match(ln)
            if m:
                owner = m.group(1)
            for cat, idx in BONUS.findall(ln):
                node = f"RU{cat}{idx}"
                if owner and owner != f"{node}Bonus":
                    out.setdefault((cat, int(idx)), set()).add(f"{cls}.{owner}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    merged = consumers(full_source())
    if not merged:
        sys.exit("no node bonus consumers found -- do NOT read this as 'nodes feed nothing'")

    resolved = {}
    unresolved = []
    for (cat, idx), props in sorted(merged.items()):
        tags = set()
        amplifier = False
        classified = []
        for prop in props:
            member = prop.split(".")[-1]
            if member in RESOURCE_OWNERS:
                tags.update(RESOURCE_OWNERS[member])
                classified.append(prop)
            elif member in AMPLIFIER_OWNERS:
                amplifier = True
                classified.append(prop)
        if not classified:
            unresolved.append(f"RU{cat}{idx} <- {', '.join(sorted(props))}")
        resolved.setdefault(cat, {})[str(idx)] = {
            "resources": sorted(tags),
            "amplifier": amplifier,
            "consumers": sorted(classified),
        }

    total = sum(len(v) for v in resolved.values())
    print(f"{total} node bonuses resolved", file=sys.stderr)
    if unresolved:
        for u in unresolved:
            print(f"  UNRESOLVED {u}", file=sys.stderr)
        sys.exit(f"{len(unresolved)} node bonus(es) are read only by members this mapping does not "
                 "know -- add them to RESOURCE_OWNERS rather than letting a node go unverified")

    payload = {
        "_source": ("every read of `RU<Cat><n>Bonus` across the whole decompiled Assembly-CSharp, "
                    "classified by the member that reads it (see RESOURCE_OWNERS)"),
        "_game": APK,
        "_meaning": ("per node: the resource tags the game's own consumers prove it feeds, whether "
                     "it is an AMPLIFIER granting a counter rather than a pool, and the consumer "
                     "members it was derived from. Every node resolves to one or the other -- the "
                     "extractor exits non-zero rather than emitting an unclassified node."),
        "productionConsumers": resolved,
    }
    text = json.dumps(payload, indent=2) + "\n"
    if args.write:
        with open(OUT, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {os.path.relpath(OUT, ROOT)}")
    else:
        print(text)


if __name__ == "__main__":
    main()
