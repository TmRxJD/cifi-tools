"""Which production chain actually READS each install node's bonus.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-resources.py --write

WHY. A node's RESOURCE -- which pool its percentage actually boosts -- is the one field of the
install catalog that was never checked against the game. Name, coefficient, counter, cap and gate
all are; the resource was parsed out of the node's ENGLISH EFFECT TEXT by keyword, and a keyword
parser is only as good as the prose it reads.

That is not hypothetical. Zagreus slot 7 ("Reflection Theory") shipped with the effect string
`+0.01% MK3 output, per Loop Mod owned, per crew member (wiki text as-is -- possibly meant "all
Generators")`. The parenthetical is an EDITORIAL NOTE that ended up inside a machine-parsed field,
so the keyword scan saw "all Generators", credited the node to all ten generator tiers, and then
matched "MK3" as well -- applying the node's factor to MK3 TWICE. The game reads `RULoop7Bonus` in
`MK5Production` and nowhere else.

The game states this unambiguously: each `RU<Cat><n>Bonus` getter is read by exactly the production
properties it feeds, so the consumer list IS the node's resource set. This walks
`GeneratorManager` (and the other production owners) and records, per node, which `<X>Production`
properties read it.

WHAT THIS DOES NOT COVER. Nodes whose bonus is consumed outside a `*Production` property -- the
direct Cells/Shards/RP/AP/MP boosters and the amplifiers like Ahead Of The Curve -- have no
production consumer, and are emitted with an empty list rather than being dropped, so the bench can
tell "no consumer found" apart from "not extracted".
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

CLASSES = ["GeneratorManager", "FleetManager"]
CATEGORIES = ["Gen", "Tech", "Loop", "Auto", "Shard", "Research", "Academy"]

BONUS = re.compile(r"\bRU(" + "|".join(CATEGORIES) + r")(\d+)Bonus\b")
# A property whose value is a production/output pool.
OWNER = re.compile(r"^\tpublic (?:BigDouble|double) (?:get_)?([A-Za-z0-9_]+)$")


def decompile(cls):
    cmd = [sys.executable, os.path.join(ROOT, "tools", "il2cpp-cli", "csharp.py"), cls]
    res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, CIFI_APK=APK))
    if res.returncode != 0 or not res.stdout:
        sys.exit(f"csharp.py {cls} failed: {res.stderr[-600:]}")
    return [ln for ln in res.stdout.split("\n") if not ln.lstrip().startswith("//IL_")]


def consumers(lines):
    """(category, index) -> set of property names that read that node's bonus."""
    out = {}
    current = None
    for ln in lines:
        m = OWNER.match(ln)
        if m:
            current = m.group(1)
            continue
        for cat, idx in BONUS.findall(ln):
            # `public BigDouble RULoop7Bonus` is the DEFINITION, not a read of it.
            if current == f"RU{cat}{idx}Bonus":
                continue
            if current:
                out.setdefault((cat, int(idx)), set()).add(current)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    merged = {}
    for cls in CLASSES:
        for key, props in consumers(decompile(cls)).items():
            merged.setdefault(key, set()).update(props)

    if not merged:
        sys.exit("no node bonus consumers found -- do NOT read this as 'nodes feed nothing'")

    # Keep only the production-shaped consumers; everything else is UI text, a running total, or
    # the node's own getter chain, none of which say which resource the node boosts.
    prod = {}
    for (cat, idx), props in sorted(merged.items()):
        hits = sorted(p for p in props if p.endswith("Production"))
        prod.setdefault(cat, {})[str(idx)] = hits

    total = sum(len(v) for v in prod.values())
    with_consumer = sum(1 for cat in prod.values() for v in cat.values() if v)
    print(f"{total} node bonuses seen; {with_consumer} have a *Production consumer", file=sys.stderr)

    payload = {
        "_source": (f"`RU<Cat><n>Bonus` reads inside *Production properties of {', '.join(CLASSES)}, "
                    "recovered via tools/il2cpp-cli/csharp.py"),
        "_game": APK,
        "_meaning": ("the production pools that actually read each node's bonus -- the node's true "
                     "resource set. An EMPTY list means no *Production property reads it, which is "
                     "the normal case for direct resource boosters and amplifiers, not a gap."),
        "productionConsumers": prod,
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
