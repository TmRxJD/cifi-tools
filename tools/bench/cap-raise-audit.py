"""Enumerate every cap the GAME can RAISE, and how.

    CIFI_APK=apk-0.7.3.61 python tools/bench/cap-raise-audit.py --write

WHY. This game raises caps as an account progresses, so a number authored as `MaxLevel` is often
only the BASE. Wherever that happens, a tool holding the base either withholds levels the account
can really buy or -- if it holds a raised value unconditionally -- offers levels it cannot. Both are
silent: the optimizer simply allocates against the wrong ceiling and reports a confident result.

The game marks these itself. A raisable cap has a computed `Final<X>MaxLevel` property alongside
the authored `<X>MaxLevel` field, and the property body IS the raise formula. A cap with no such
property is static, and that absence is evidence -- it is how this audit concludes that attribute
caps, tier-2 relic caps and every talent except one cannot be raised at all.

What this emits is the RAISE FORMULA per cap family, as the operand names appearing in the
property body. `cap-raise-check.js` then asserts each one is either modelled by us or on the
explicit base-only list, and -- the point of the whole exercise -- that NO NEW cap family has
appeared since. A future build adding a raise shows up as an unaccounted family rather than as a
quietly wrong ceiling.
"""

import argparse
import json
import os
import re
import subprocess
import sys

APK = os.environ.get("CIFI_APK", "apk-0.7.3.61")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "tools", "reference", "cap-raises.json")
DUMP = os.path.join(ROOT, "tools", "gamefiles", APK, "il2cpp-dump", "dump.cs")

# Classes worth decompiling: the ones owning caps this tool models or deliberately does not.
CLASSES = ["FleetManager", "BorgeUpgrades", "OuroRelics"]

PROP = re.compile(r"^\tpublic (?:int|double|BigDouble) (Final[A-Za-z0-9]*MaxLevel[A-Za-z0-9]*)$")
# Operands inside a property body: field reads, backing fields and plain identifiers that look
# like game values. Locals (`num3`, `rL`) and language noise are dropped.
OPERAND = re.compile(r"<([A-Za-z0-9_]+)>k__BackingField|\b([A-Z][A-Za-z0-9_]{3,})\b")
NOISE = {
    "NullReferenceException", "ResearchLaboratory", "MasterManagerOuro", "GemNodes",
    "MasterManager", "BigDouble", "Cpp2ILHelpers", "NoteDecompilerIssue", "Mathf",
    "MultiverseMarket", "Badges", "Inventory", "GemPerks",
}


def decompile(cls):
    cmd = [sys.executable, os.path.join(ROOT, "tools", "il2cpp-cli", "csharp.py"), cls]
    res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, CIFI_APK=APK))
    if res.returncode != 0 or not res.stdout:
        sys.exit(f"csharp.py {cls} failed: {res.stderr[-600:]}")
    return [ln for ln in res.stdout.split("\n") if not ln.lstrip().startswith("//IL_")]


def property_bodies(lines):
    """Final*MaxLevel property name -> the operand names its body reads."""
    out = {}
    i = 0
    while i < len(lines):
        m = PROP.match(lines[i])
        if not m:
            i += 1
            continue
        name = m.group(1)
        depth = 0
        body = []
        j = i + 1
        started = False
        while j < len(lines):
            depth += lines[j].count("{") - lines[j].count("}")
            body.append(lines[j])
            if lines[j].count("{"):
                started = True
            if started and depth <= 0:
                break
            j += 1
        ops = set()
        for ln in body:
            for a, b in OPERAND.findall(ln):
                tok = a or b
                if tok and tok not in NOISE:
                    ops.add(tok)
        out[name] = sorted(ops)
        i = j + 1
    return out


def authored(cls):
    """Every authored field of a MonoBehaviour, as a name -> value dict."""
    cmd = [sys.executable, os.path.join(ROOT, "tools", "il2cpp-cli", "typetree.py"), "--dump", cls]
    res = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, CIFI_APK=APK))
    if res.returncode != 0:
        sys.exit(f"typetree.py {cls} failed: {res.stderr[-600:]}")
    return json.loads(res.stdout[res.stdout.index("{"):])


CATEGORIES = ["Gen", "Tech", "Loop", "Auto", "Shard", "Research", "Academy"]


def unreleased_slots():
    """Slots the game has WIRED but not yet AUTHORED -- cap 0 and bonus 0.

    These are the tripwire for content arriving in a later build. The install screen already
    carries nodes 12 and 13 in every category, with a Requirement and UI objects, but MaxLevel 0
    and BaseBonus 0 -- so they cannot be bought and contribute nothing, and not modelling them is
    correct today. The moment a build authors one, `cap-raise-check.js` fails, which is exactly
    when the fleet model gains a real gap.
    """
    fm = authored("FleetManager")
    out = {}
    for n in (12, 13):
        for cat in CATEGORIES:
            cap = fm.get(f"RU{n}{cat}MaxLevel")
            bonus = fm.get(f"RU{n}{cat}BaseBonus")
            if cap is None and bonus is None:
                continue
            out[f"RU{n}{cat}"] = {"maxLevel": cap, "baseBonus": bonus}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    unreleased = unreleased_slots()
    found = {}
    for cls in CLASSES:
        for name, ops in property_bodies(decompile(cls)).items():
            found[name] = {"class": cls, "operands": ops}

    if not found:
        sys.exit("no Final*MaxLevel properties recovered -- do NOT read this as 'no caps are raised'")

    # The full population, from dump.cs rather than only the classes decompiled above, so a raise
    # living somewhere unexpected still shows up as a name even when its body was not read.
    with open(DUMP, encoding="utf-8", errors="replace") as fh:
        all_names = sorted(set(re.findall(r"Final[A-Za-z0-9]*MaxLevel[A-Za-z0-9]*", fh.read())))

    payload = {
        "_source": (f"Final*MaxLevel property bodies recovered from {', '.join(CLASSES)} via "
                    "tools/il2cpp-cli/csharp.py; the full name list is grepped from dump.cs."),
        "_game": APK,
        "_meaning": ("a cap with a Final<X>MaxLevel property is RAISABLE and the operands are its "
                     "raise formula; a cap with no such property is static, and that absence is "
                     "the evidence that it cannot be raised."),
        "raisable": {k: found[k] for k in sorted(found)},
        "allFinalMaxLevelNames": all_names,
        "_unreleasedMeaning": (
            "install slots the game has wired (Requirement + UI) but not authored (MaxLevel 0, "
            "BaseBonus 0). Correctly unmodelled today; a build that authors one is a real gap."
        ),
        "unreleasedSlots": unreleased,
    }
    text = json.dumps(payload, indent=2) + "\n"
    print(f"{len(found)} property bodies read; {len(all_names)} Final*MaxLevel names in dump.cs",
          file=sys.stderr)
    if args.write:
        with open(OUT, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {os.path.relpath(OUT, ROOT)}")
    else:
        print(text)


if __name__ == "__main__":
    main()
