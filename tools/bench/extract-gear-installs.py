"""Extract the game's own gear-piece -> install-node dispatch into tools/reference/.

Each `RU<Category><n>Bonus` property in FleetManager multiplies in the specific
`Gear.<Color>Item<N>Bonus<M>` that targets that node, so the property bodies ARE the mapping. This
is the one gear fact the optimizer is most sensitive to -- gear is the only per-NODE multiplier we
model, and it is exponential in the piece's level, so pointing a piece at the wrong node sends
points to the wrong place with confidence.

Bonus1 is the piece's install1 target, Bonus2 its install2.

    python tools/bench/extract-gear-installs.py     # -> tools/reference/gear-install-map.json
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "gear-install-map.json")
CSHARP = os.path.join(HERE, "..", "il2cpp-cli", "csharp.py")

PROP = re.compile(r"^\tpublic \w[\w<>]* (RU([A-Za-z]+)(\d+)Bonus)\s*$")
MEMBER = re.compile(r"^\t(public|private|internal|protected)\s")
GEAR = re.compile(r"Gear\.([A-Za-z]+)Item(\d+)Bonus(\d+)")


def main():
    proc = subprocess.run([sys.executable, CSHARP, "FleetManager"], capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(f"could not recover FleetManager C#: {proc.stderr[-600:]}")

    current = None
    mappings = []
    for line in proc.stdout.splitlines():
        m = PROP.match(line)
        if m:
            current = (m.group(2), int(m.group(3)))
            continue
        if current and MEMBER.match(line):
            current = None
            continue
        if not current:
            continue
        g = GEAR.search(line)
        if g:
            mappings.append({
                "category": current[0],
                "node": current[1],
                "color": g.group(1),
                "item": int(g.group(2)),
                "bonus": int(g.group(3)),
            })

    # A given (color, item, bonus) must target exactly one node -- if the same piece-slot appeared
    # against two nodes our extraction would be wrong, and silently mapping one of them would be
    # worse than stopping.
    seen = {}
    for e in mappings:
        key = (e["color"], e["item"], e["bonus"])
        if key in seen and seen[key] != (e["category"], e["node"]):
            raise SystemExit(f"{key} targets both {seen[key]} and {(e['category'], e['node'])}")
        seen[key] = (e["category"], e["node"])

    payload = {
        "_source": "RU<Category><n>Bonus property bodies in the recovered FleetManager C# "
                   "(tools/il2cpp-cli/csharp.py)",
        "_meaning": "Gear.<Color>Item<N>Bonus<M> is multiplied into that node's bonus. M=1 is the "
                    "piece's install1 target, M=2 its install2.",
        "_game": "CIFI 0.7.3.54",
        "mappings": sorted(mappings, key=lambda e: (e["category"], e["node"], e["color"], e["item"])),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {len(mappings)} gear->install mapping(s) "
          f"({len(seen)} distinct piece slots) to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
