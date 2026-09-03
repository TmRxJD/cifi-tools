"""Extract every ship install node's UNLOCK REQUIREMENT and BASE MAX LEVEL from the game.

Both are authored fields on the FleetManager MonoBehaviour -- `RU<n><Category>Requirement` and
`RU<n><Category>MaxLevel` -- so neither has to be transcribed from the wiki, which is where our
catalog got them.

The semantics are stated by the game's own buy method, not inferred. `BuyRU4Gen()` reads:

    int totalInstallsCradle = TotalInstallsCradle;
    if (totalInstallsCradle >= RU4GenRequirement) {
        obj2 = RL.FinalShipRanksMaxLevelBonus * RU4GenMaxLevel;
        if (MM.RU4GenLevel < obj2 && MM.Ship1RankPoints > 0) { ...buy... }
    }

So the gate is "total installs spent on THAT SHIP >= requirement" (our `gateAtTotalInstalls`), and
the effective cap is the authored base times a research multiplier (our `nodeMaxLevel`). A
requirement of 0 means the node is open from the start.

    python tools/bench/extract-ship-node-gates.py   # -> tools/reference/ship-node-gates.json
    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-ship-node-gates.py
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "ship-node-gates.json")
TYPETREE = os.path.join(HERE, "..", "il2cpp-cli", "typetree.py")
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")

FIELD = re.compile(r"^RU(\d+)([A-Za-z]+)(Requirement|MaxLevel)$")


def main():
    proc = subprocess.run([sys.executable, TYPETREE, "--dump", "FleetManager"],
                          capture_output=True, text=True)
    if proc.returncode != 0 or "{" not in proc.stdout:
        raise SystemExit(f"could not read authored FleetManager data: {proc.stderr[-600:]}")
    data = json.loads(proc.stdout[proc.stdout.index("{"):])

    nodes = {}
    for key, val in data.items():
        m = FIELD.match(key)
        if not m:
            continue
        idx, category, what = int(m.group(1)), m.group(2), m.group(3)
        entry = nodes.setdefault(category, {}).setdefault(str(idx), {})
        entry["requirement" if what == "Requirement" else "maxLevel"] = val

    if not nodes:
        raise SystemExit("no RU<n><Category>Requirement/MaxLevel fields found")
    # Both halves must be present for a node, or a consumer would silently treat a missing cap as
    # unlimited / a missing gate as open.
    incomplete = [f"RU{i}{c}" for c, xs in nodes.items() for i, e in xs.items()
                  if "requirement" not in e or "maxLevel" not in e]
    if incomplete:
        raise SystemExit(f"{len(incomplete)} node(s) missing a half: {incomplete[:8]}")

    payload = {
        "_source": "FleetManager MonoBehaviour (tools/il2cpp-cli/typetree.py), fields "
                   "RU<n><Category>Requirement and RU<n><Category>MaxLevel",
        "_meaning": "requirement: the node unlocks once TotalInstalls<Ship> >= this value (0 = open "
                    "from the start). maxLevel: the BASE cap, which the game multiplies by "
                    "ResearchLaboratory.FinalShipRanksMaxLevelBonus to get the effective cap.",
        "_semanticsFrom": "FleetManager.BuyRU<n><Category>() in the recovered C#",
        "_game": APK_DIR,
        "categories": {c: dict(sorted(xs.items(), key=lambda kv: int(kv[0])))
                       for c, xs in sorted(nodes.items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + "\n")
    total = sum(len(x) for x in nodes.values())
    print(f"wrote {total} node gate(s) across {len(nodes)} categories to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
