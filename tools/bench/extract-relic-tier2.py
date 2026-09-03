"""Extract the AUTHORED tier-2 relic data (caps, costs, per-level bonus) from the game.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-relic-tier2.py --write

WHY THIS EXISTS. Tier-2 relic caps were an open question in this repo for a long time --
`relicMaxLevel` throws for them rather than guess, and `relic-caps.json` covers tier 1 only, whose
three bands (`Tier1Low/Medium/High RelicsMaxLevel` = 200 / 100 / 8) ARE plain authored fields on
`OuroRelics`. Tier 2 has no such band field, so the cap looked like it lived in code.

It does not. `OuroRelics.CheckRelicMaxLevel(levels, relicMaxLevels, ...)` compares the player's
level against `Relic+0x50`, and dump.cs names `Relic.baseMaxLevel` as the BigDouble at 0x48 -- so
+0x50 is its exponent half, the documented BigDouble +8 case. The cap is therefore authored
per relic, on the `Relic` ScriptableObjects in `OuroRelics.T2RelicValues`.

WHY typetree.py CANNOT READ THESE. Those PPtrs carry `m_FileID: 2`, which level0's own externals
list resolves to `sharedassets0.assets` -- and `Relic` is a ScriptableObject, so it never appears
in typetree.py's list of MonoBehaviours with reconstructed trees. The objects are read here
directly instead. The layout is not guessed: dump.cs gives the field order and offsets (four
BigDoubles, then two more, then two strings), and a MonoBehaviour asset stream is
m_GameObject(12) + m_Enabled(1, padded to 4) + m_Script(12) + m_Name(length-prefixed, 4-aligned)
before the class's own fields.

THE PARSE IS CROSS-VALIDATED, which is what licenses trusting it. Each object's own name is
`T2_01`..`T2_10`, and the `bonusPerLevel1` this reads matches the live cifi-tools bundle's `value:`
for the same relic exactly -- 1.02 for T2_07 ("Arthur's Sword") and 1.08 for T2_05 ("The Gorgon
Eye"). Two independent sources agreeing on a field adjacent to the one being extracted is what
tells you the offsets are right.
"""

import argparse
import json
import os
import struct
import sys

import UnityPy

APK = os.environ.get("CIFI_APK", "apk-0.7.3.61")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, "tools", "gamefiles", APK, "assets")
OUT = os.path.join(ROOT, "tools", "reference", "relic-tier2.json")

# Field order and offsets from dump.cs's `public class Relic : ScriptableObject`.
FIELDS = (
    "startCost",
    "additiveCostIncrease",
    "costExponent",
    "baseMaxLevel",
    "bonusPerLevel1",
    "bonusPerLevel2",
)


def big_double(raw, off):
    """A BigDouble is 16 bytes: double mantissa, then int64 exponent."""
    (mantissa,) = struct.unpack_from("<d", raw, off)
    (exponent,) = struct.unpack_from("<q", raw, off + 8)
    return mantissa, exponent


def read_relics():
    path = os.path.join(ASSETS, "sharedassets0.assets")
    if not os.path.exists(path):
        sys.exit(f"{path} not found -- stage the build first (see tools/gamefiles/README.md)")
    env = UnityPy.load(path)
    out = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        # 28 = m_GameObject(12) + m_Enabled(1 -> 4) + m_Script(12); then the name.
        if len(raw) < 32:
            continue
        (name_len,) = struct.unpack_from("<i", raw, 28)
        if not 0 < name_len < 64 or len(raw) < 32 + name_len:
            continue
        name = raw[32:32 + name_len].decode("utf-8", "replace")
        if not name.startswith("T2_"):
            continue
        off = (32 + name_len + 3) & ~3
        if len(raw) < off + 16 * len(FIELDS):
            continue
        rec = {}
        for i, field in enumerate(FIELDS):
            mantissa, exponent = big_double(raw, off + i * 16)
            rec[field] = {"mantissa": mantissa, "exponent": exponent}
        cap = rec["baseMaxLevel"]
        rec["maxLevel"] = round(cap["mantissa"] * (10 ** cap["exponent"]))
        out[f"t2r{int(name.split('_')[1])}"] = rec
    return dict(sorted(out.items(), key=lambda kv: int(kv[0][3:])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help=f"write {os.path.relpath(OUT, ROOT)}")
    args = ap.parse_args()

    relics = read_relics()
    if not relics:
        sys.exit("no T2_* Relic ScriptableObjects found -- did the asset layout change?")

    payload = {
        "_source": (
            "OuroRelics.T2RelicValues -> Relic ScriptableObjects in sharedassets0.assets; field "
            "order and offsets from dump.cs's `public class Relic : ScriptableObject`. The cap is "
            "the field CheckRelicMaxLevel() compares against (Relic+0x50 = baseMaxLevel's exponent "
            "half, the BigDouble +8 case)."
        ),
        "_game": APK,
        "_crossCheck": (
            "bonusPerLevel1 matches the live cifi-tools bundle's `value:` for the same relic "
            "(t2r5 1.08, t2r7 1.02), which is what confirms the field offsets."
        ),
        "relics": relics,
    }
    text = json.dumps(payload, indent=2) + "\n"
    if args.write:
        with open(OUT, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {os.path.relpath(OUT, ROOT)} ({len(relics)} tier-2 relics)")
    else:
        print(text)


if __name__ == "__main__":
    main()
