"""Extract designer-authored values from the build into tools/reference/authored-values.json.

This is the DATA half of the sourcing rule in CLAUDE.md: type trees answer "what number did a
designer type", disassembly answers "how do the numbers combine". Everything written here is the
former, read straight out of serialized MonoBehaviours -- no wiki, no community table, no
inference. `tools/bench/authored-value-check.js` then holds the tool's own tables against it.

    python tools/bench/extract-authored-values.py

Add a family by adding an entry to FAMILIES: the class to read, and the field-name patterns worth
keeping (these classes run to thousands of fields, most of them UI object references).

BigDouble is serialized as {mantissa, exponent} meaning mantissa * 10**exponent, so `9.0e-1` is
0.9. Flattened here rather than in the consumer, so the JSON holds plain numbers.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "il2cpp-cli"))
from typetree import Extractor                                        # noqa: E402

OUT = os.path.join(HERE, "..", "reference", "authored-values.json")

FAMILIES = [
    # (class, backend, relaxed, [field-name regexes to keep])
    ("OuroRelics", "AssetsTools", False,
     [r"^Relic\d+(StartCost|AdditiveCostIncrease|CostExponent|BonusPerLevel|UnlockReq)$"]),
    ("FleetManager", "AssetsTools", False,
     [r"^RU\d+[A-Za-z]+BaseBonus$", r"^EvoBonus[A-Za-z]+\d*$"]),
    # Gear's tree does not fully match the build's layout: AssetsTools dies mid-read, AssetStudio
    # reads every field and only trips the trailing total. The bases are early in the class and
    # cross-check against the wiki's x1.01/x1.02, but do not add LATE Gear fields here without a
    # second source. See typetree.py's read_instances docstring.
    ("Gear", "AssetStudio", True,
     [r"^GearBaseBonus\d$", r"^GearUnlock(BaseCost|CostExponent)$"]),
]


def flatten(value):
    """BigDouble {mantissa, exponent} -> float where that is lossless, else keep the pair.

    The game uses BigDouble precisely because these values leave float range -- some cost
    exponents here run past 1e308. Collapsing those to `inf` would be a silently wrong number, so
    anything that cannot be represented stays as its {mantissa, exponent} pair and the consumer
    deals with it. Never let a value that does not fit become a value that merely looks wrong.
    """
    if isinstance(value, dict) and set(value) == {"mantissa", "exponent"}:
        try:
            return value["mantissa"] * (10.0 ** value["exponent"])
        except OverflowError:
            return {"mantissa": value["mantissa"], "exponent": value["exponent"]}
    return value


def main():
    out = {
        "_source": "serialized MonoBehaviours in assets/level0, read via reconstructed Unity type "
                   "trees (IL2CPP strips them; see tools/il2cpp-cli/typetree.py)",
        "_game": "CIFI 0.7.3.54, Unity 6000.3.8f1, il2cpp metadata v39",
        "_note": "BigDouble {mantissa, exponent} has been flattened to mantissa * 10**exponent.",
        "classes": {},
    }
    for cls, backend, relaxed, patterns in FAMILIES:
        ex = Extractor(backend=backend)
        instances = ex.read_instances(cls, relaxed=relaxed)
        if not instances:
            print(f"  {cls}: NO INSTANCE READ -- skipped", file=sys.stderr)
            continue
        regexes = [re.compile(p) for p in patterns]
        fields = {k: flatten(v) for k, v in instances[0].items()
                  if any(r.match(k) for r in regexes)}
        out["classes"][cls] = fields
        print(f"  {cls}: {len(fields)} field(s) kept "
              f"(backend={backend}{', relaxed' if relaxed else ''})", file=sys.stderr)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(out, indent=2, sort_keys=True) + "\n")
    total = sum(len(v) for v in out["classes"].values())
    print(f"wrote {total} authored value(s) across {len(out['classes'])} class(es) to {OUT}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
