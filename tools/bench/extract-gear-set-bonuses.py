"""Extract which RESOURCE each gear set bonus multiplies, from the game's own aggregator.

`Gear.SetGearSetBonuses()` is the whole mapping in one method: it walks the five resource totals
(`TotalSetCellBonus`, `TotalSetMPBonus`, `TotalSetShardBonus`, `TotalSetRPBonus`,
`TotalSetAPBonus`), and for each one multiplies in exactly the `<Color>SetBonus<N>` values that
feed it. So the resource a bonus applies to is not something to infer from magnitude or from the
wiki's bonus text -- it is stated.

This matters because the bonus VALUES are authored data we can already read (typetree.py), but a
value with no resource is unusable: `WhiteSetBonus2` is 1e65, and guessing which of Cells / Shards
/ Academy Points a x1e65 lands on is exactly the kind of plausible-looking mistake this repo has
made before. It also gives an independent check on the 22 wiki-sourced pieces, whose bonus text we
had never verified against anything.

The colour bonus INDEX is the piece index within that colour (GreenSetBonus1 is the first Green
piece), which the extraction cross-validates: our transcribed Green bonuses are Cells, Mod Points,
Research, Academy, Cells and the game's aggregator puts Green 1/5 on Cells, 2 on MP, 3 on RP and 4
on AP. That agreement across all five colours is what licenses reading White's mapping off the
same method.

    python tools/bench/extract-gear-set-bonuses.py   # -> tools/reference/gear-set-bonus-map.json
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "gear-set-bonus-map.json")
CSHARP = os.path.join(HERE, "..", "il2cpp-cli", "csharp.py")
# csharp.py reads the same variable, so one env var switches the whole extraction.
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")

# `<TotalSetCellBonus>k__BackingField = ...` -- the auto-property backing field, which is what
# closes each resource's block. ilspycmd emits the angle brackets literally when decompiling a
# single type and escaped (`_003C`/`_003E`) when decompiling the whole assembly, so accept both
# rather than silently matching nothing and mis-attributing every bonus.
TOTAL = re.compile(r"(?:<|_003C)TotalSet(\w+?)Bonus(?:>|_003E)k__BackingField")
# Both the plain `num5 = GreenSetBonus1;` reads and the gated `FinalWhiteSetBonus1` property reads.
BONUS = re.compile(r"\b(?:Final)?([A-Z][a-z]+)SetBonus(\d)\b")

# The aggregator's own names for the five resource totals -> the wording our gear table uses, so a
# comparison against REAL_GEAR_PIECES' `setBonus` text is direct.
RESOURCE_LABEL = {
    "Cell": "Cells",
    "MP": "Mod Points",
    "Shard": "Shards",
    "RP": "Research Points",
    "AP": "Academy Points",
}


def typetree_build():
    """Which build typetree.py actually reads, taken from its own source rather than assumed.

    It needs an Il2CppDumper run (dump.cs + DummyDll), so it cannot simply follow CIFI_APK. Reading
    the constant means this label self-corrects the day typetree.py becomes build-switchable,
    instead of quietly going stale.
    """
    tt = os.path.join(HERE, "..", "il2cpp-cli", "typetree.py")
    with open(tt, encoding="utf-8") as f:
        src = f.read()
    # Honours CIFI_APK -> it read whatever we asked for. Pinned to a literal -> report that literal.
    if re.search(r'APK_DIR\s*=\s*os\.environ\.get\("CIFI_APK"', src) and "gamefiles\", APK_DIR" in src:
        return APK_DIR
    m = re.search(r'GAMEFILES\s*=\s*os\.path\.join\([^)]*?"(apk-[\d.]+)"', src)
    return m.group(1) if m else "unknown"


def read_bonus_values():
    """-> {"GreenSetBonus1": 500.0, ...} from the authored Gear MonoBehaviour.

    Gear's type tree does not fully match its serialized layout, so this needs the AssetStudio
    backend and a relaxed read -- see typetree.py's own module docstring. BigDouble fields come
    back as {mantissa, exponent} and are flattened here.
    """
    tt = os.path.join(HERE, "..", "il2cpp-cli", "typetree.py")
    proc = subprocess.run([sys.executable, tt, "--dump", "Gear",
                           "--backend", "AssetStudio", "--relaxed"],
                          capture_output=True, text=True)
    if proc.returncode != 0 or "{" not in proc.stdout:
        raise SystemExit(f"could not read authored Gear data: {proc.stderr[-600:]}")
    data = json.loads(proc.stdout[proc.stdout.index("{"):])
    out = {}
    for key, val in data.items():
        if not re.fullmatch(r"[A-Z][a-z]+SetBonus\d", key):
            continue
        if isinstance(val, dict) and "mantissa" in val:
            val = float(val["mantissa"]) * (10.0 ** int(val["exponent"]))
        out[key] = float(val)
    return out


def main():
    proc = subprocess.run([sys.executable, CSHARP, "Gear"], capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(f"could not recover Gear C#: {proc.stderr[-600:]}")

    lines = proc.stdout.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if "void SetGearSetBonuses()" in l)
    except StopIteration:
        raise SystemExit("SetGearSetBonuses() not found in the recovered Gear C#")

    # Walk the method, accumulating the bonus reads seen since the last total was written. When a
    # total IS written, everything accumulated belongs to that resource.
    pending = []
    mappings = []
    seen_totals = []
    for line in lines[start + 1:]:
        if re.match(r"^\t(public|private|internal|protected)\s", line):
            break  # next member; method is over
        total = TOTAL.search(line)
        if total:
            resource = total.group(1)
            seen_totals.append(resource)
            for color, idx in pending:
                mappings.append({"color": color, "index": int(idx), "resource": resource,
                                 "resourceLabel": RESOURCE_LABEL.get(resource, resource)})
            pending = []
            continue
        for color, idx in BONUS.findall(line):
            if (color, idx) not in pending:
                pending.append((color, idx))

    if pending:
        raise SystemExit(f"{len(pending)} bonus read(s) after the last resource total -- the "
                         "method shape changed and the block attribution is no longer safe")
    missing = set(RESOURCE_LABEL) - set(seen_totals)
    if missing:
        raise SystemExit(f"resource total(s) never written: {sorted(missing)} -- extraction is "
                         "incomplete, refusing to write a partial map")

    # A given (colour, index) is one piece and must land on exactly one resource.
    seen = {}
    for m in mappings:
        key = (m["color"], m["index"])
        if key in seen and seen[key] != m["resource"]:
            raise SystemExit(f"{key} maps to both {seen[key]} and {m['resource']}")
        seen[key] = m["resource"]

    # Fold in the authored VALUE for each bonus. The resource comes from code and the magnitude
    # from serialized data -- the two halves of the sourcing rule -- and carrying both lets the
    # bench check that a piece's displayed "x500 Cells Gained" is right in both respects.
    values = read_bonus_values()
    for m in mappings:
        v = values.get(f"{m['color']}SetBonus{m['index']}")
        if v is None:
            raise SystemExit(f"no authored value for {m['color']}SetBonus{m['index']}")
        m["value"] = v

    # A bonus the aggregator never reads is not necessarily dead -- it may simply not be a
    # multiplier on one of the five resource totals. OrangeSetBonus2 is 3000 and the piece grants
    # "3000 Diamonds", a one-off award with no total to feed. Record these WITH their values so a
    # bench can still check the magnitude rather than treating them as unknowable.
    used = {f"{m['color']}SetBonus{m['index']}" for m in mappings}
    unused = [{"name": k, "value": values[k]} for k in sorted(values) if k not in used]

    payload = {
        "_source": "Gear.SetGearSetBonuses() in the recovered C# (tools/il2cpp-cli/csharp.py); "
                   "values from the authored Gear MonoBehaviour (tools/il2cpp-cli/typetree.py)",
        "unusedBonuses": unused,
        "_meaning": "<color>SetBonus<index> is multiplied into that resource's TotalSet<...>Bonus. "
                    "The index is the piece's position within its colour.",
        # The two halves can come from DIFFERENT builds and saying so is the point: csharp.py honours
        # CIFI_APK, but typetree.py needs an Il2CppDumper run (dump.cs + DummyDll) that currently
        # exists only for 0.7.3.54. Labelling the whole file with one version would claim a
        # provenance half the data does not have.
        "_mappingFrom": APK_DIR,
        "_valuesFrom": typetree_build(),
        "mappings": sorted(mappings, key=lambda m: (m["color"], m["index"])),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {len(mappings)} set-bonus -> resource mapping(s) across "
          f"{len(seen_totals)} resource totals to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
