"""Extract the game's own relic level caps -- band per relic, base values, and the raises.

Resolves a question CLAUDE.md carried as open for a long time. Two community sources disagreed:
Ryther's data said r5/r6 cap at 8 "rising to 11 with Power Gem Node 1", while the live fragment
planner implied r6 at 11 "rising to 16 with Exodus node 2" (and r9 100 -> 105). There was no way to
choose, so the repo held the base cap and deliberately modelled no raise at all.

The game settles it, and neither source was wrong -- they were describing DIFFERENT raises that
both exist:

    FinalTier1<Band>RelicsMaxLevel = Tier1<Band>RelicsMaxLevel + FinalExodus3Bonus
    FinalR5MaxLevel / FinalR6MaxLevel / FinalR14MaxLevel
                                   = ...as above, PLUS GemNodes.FinalPower1Bonus4

Two inputs, both primary:
  * the BAND each relic uses -- parsed from `CheckRelic<N>MaxLevelStatus()` in the recovered C#
    (tools/il2cpp-cli/csharp.py), which is the game's own dispatch;
  * the BASE value of each band -- read as authored serialized data (typetree.py).

    python tools/bench/extract-relic-caps.py     # -> tools/reference/relic-caps.json
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "il2cpp-cli"))
from typetree import Extractor                                        # noqa: E402

OUT = os.path.join(HERE, "..", "reference", "relic-caps.json")
BAND_FIELD = {
    "FinalTier1LowRelicsMaxLevel": "Low",
    "FinalTier1MediumRelicsMaxLevel": "Medium",
    "FinalTier1HighRelicsMaxLevel": "High",
    # r5/r6/r14 get their own property; each reads the High cap and adds the Power gem raise.
    "FinalR5MaxLevel": "High",
    "FinalR6MaxLevel": "High",
    "FinalR14MaxLevel": "High",
}
POWER_RAISED = {"FinalR5MaxLevel", "FinalR6MaxLevel", "FinalR14MaxLevel"}


def recovered_csharp(type_name):
    """The type's C#, via the csharp.py pipeline (cached under the scratch dir)."""
    script = os.path.join(HERE, "..", "il2cpp-cli", "csharp.py")
    proc = subprocess.run([sys.executable, script, type_name],
                          capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(f"could not recover C# for {type_name}: {proc.stderr[-600:]}")
    return proc.stdout


def bands_from_csharp(src):
    """{relic_number: (band, power_raised)} from each CheckRelic<N>MaxLevelStatus body."""
    lines = src.splitlines()
    out = {}
    for i, line in enumerate(lines):
        m = re.search(r"\bvoid CheckRelic(\d+)MaxLevelStatus\(\)", line)
        if not m:
            continue
        depth, started, body = 0, False, []
        for j in range(i, min(i + 200, len(lines))):
            body.append(lines[j])
            depth += lines[j].count("{") - lines[j].count("}")
            started = started or "{" in lines[j]
            if started and depth <= 0:
                break
        text = "\n".join(body)
        refs = {f for f in BAND_FIELD if f in text}
        if len(refs) != 1:
            # Ambiguity here would silently mis-cap a relic; refuse rather than pick.
            raise SystemExit(f"relic {m.group(1)}: expected exactly one cap source, got {sorted(refs)}")
        field = refs.pop()
        out[int(m.group(1))] = (BAND_FIELD[field], field in POWER_RAISED)
    return out


def main():
    src = recovered_csharp("OuroRelics")
    bands = bands_from_csharp(src)
    if len(bands) != 20:
        raise SystemExit(f"expected 20 tier-1 relics, parsed {len(bands)}")

    fields = Extractor().read_instances("OuroRelics")[0]
    base = {b: fields[f"Tier1{b}RelicsMaxLevel"] for b in ("Low", "Medium", "High")}

    payload = {
        "_source": "band per relic parsed from CheckRelic<N>MaxLevelStatus() in the recovered C# "
                   "(tools/il2cpp-cli/csharp.py); band base values read as authored serialized "
                   "data (tools/il2cpp-cli/typetree.py)",
        "_raises": "FinalTier1<Band>RelicsMaxLevel = base + GemNodes.FinalExodus3Bonus. r5, r6 and "
                   "r14 additionally add GemNodes.FinalPower1Bonus4. This is why the two community "
                   "sources disagreed -- both raises are real and they are different.",
        "_game": "CIFI 0.7.3.54",
        "bandBaseMaxLevel": base,
        "relicBand": {f"r{n}": {"band": b, "powerRaised": p} for n, (b, p) in sorted(bands.items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"bands: {base}", file=sys.stderr)
    print(f"wrote {len(bands)} relic cap assignments to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
