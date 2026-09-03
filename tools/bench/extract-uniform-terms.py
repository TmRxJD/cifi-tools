"""Which uniform per-node multipliers are provably INERT until their upgrade is bought.

Every install node's bonus carries terms that are identical across a ship's nodes -- the Power gem
upgrade, the ship-installs research, the all-ships research. They cannot reorder an allocation,
which is why the optimizer omits them, but "cannot reorder" is not "safe to ignore": if one were
non-1 by default, every absolute number the tool shows would be wrong.

This records the checkable half. A getter is inert-when-unowned if it BOTH gates on the upgrade's
level and falls through to 1:

    if (Level <= 0) return 1;                      // or
    result = 1; if (Level > 0) { ...real... }      // or
    int num = mM.Level; if (num > 0) { ... } return 1.0;

WHY THE THREE-STATE RESULT. An earlier version returned a bare true/false and reported four terms
as NOT inert that plainly are -- `FinalRU78Bonus1` ends `return 1.0;` while the check only looked
for `= 1;`. A missed shape read as "this term is live", which is the opposite of the truth and
exactly the sort of confident-wrong answer this repo keeps having to unlearn. So a getter with no
level gate at all is recorded as null (undeterminable), never as false.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-uniform-terms.py
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "uniform-node-terms.json")
CSHARP = os.path.join(HERE, "..", "il2cpp-cli", "csharp.py")
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")

# term -> (declaring type, the upgrade level it is gated on)
TERMS = {f"PowerGU{n}BonusCalc": ("GemPerks", f"PowerGU{n}Level") for n in range(1, 8)}
TERMS["FinalRU78Bonus1"] = ("ResearchLaboratory", "RU78Level")          # Fleet Analysis 2
TERMS["FinalRU101Bonus1"] = ("ResearchLaboratory", "RU101Level")        # second installs factor
TERMS["FinalRU83InstallsBonus"] = ("ResearchLaboratory", "RU83Level")   # all-ships installs
TERMS["FinalRU96InstallsBonus"] = ("ResearchLaboratory", "RU96Level")   # all-ships installs

MEMBER = re.compile(r"^\t(public|private|internal|protected)\s")


def body(src_lines, name):
    pat = re.compile(r"^\t(public|private|internal|protected)[^;]*\b" + re.escape(name) + r"\s*$")
    i = next((n for n, l in enumerate(src_lines) if pat.match(l)), None)
    if i is None:
        return None
    out = []
    for l in src_lines[i + 1:]:
        if MEMBER.match(l):
            break
        out.append(l)
    return "\n".join(out)


def inert_when_unowned(b, level_field):
    """True / False / None(undeterminable) -- see the module docstring."""
    if b is None:
        return None
    gated = bool(re.search(re.escape(level_field) + r"\s*(<=|>)\s*0", b))
    if not gated:
        # the level is often read into a local first: `int num = mM.RU101Level; if (num > 0)`
        m = re.search(r"(\w+)\s*=\s*[\w.]*" + re.escape(level_field) + r"\b", b)
        gated = bool(m and re.search(re.escape(m.group(1)) + r"\s*(<=|>)\s*0", b))
    if not gated:
        return None
    return bool(re.search(r"return\s+1(?:\.0+)?\s*;", b)) or bool(re.search(r"=\s*1(?:\.0+)?\s*;", b))


def main():
    by_type = {}
    for term, (type_name, _) in TERMS.items():
        by_type.setdefault(type_name, []).append(term)

    results = {}
    for type_name, terms in by_type.items():
        proc = subprocess.run([sys.executable, CSHARP, type_name], capture_output=True, text=True)
        if proc.returncode != 0 or not proc.stdout.strip():
            raise SystemExit(f"could not recover {type_name}: {proc.stderr[-400:]}")
        lines = proc.stdout.splitlines()
        for term in terms:
            level_field = TERMS[term][1]
            b = body(lines, term)
            verdict = inert_when_unowned(b, level_field)
            # Trace every term: a silent per-term result is what let an earlier version of this
            # file disagree with a hand-check for several rounds without anything looking wrong.
            print(f"   {term}: body={'None' if b is None else len(b)} inert={verdict}", file=sys.stderr)
            results[term] = {
                "type": type_name,
                "levelField": level_field,
                "found": b is not None,
                "inertWhenUnowned": verdict,
            }

    payload = {
        "_source": "getter bodies in the recovered C# (tools/il2cpp-cli/csharp.py)",
        "_meaning": "inertWhenUnowned: true = the getter provably yields 1 while its upgrade level "
                    "is 0, so omitting the term is EXACT for an account that has not bought it. "
                    "null = no level gate found, so it cannot be determined -- never read null as "
                    "false.",
        "_game": APK_DIR,
        "terms": dict(sorted(results.items())),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + chr(10))
    inert = sum(1 for v in results.values() if v["inertWhenUnowned"] is True)
    print(f"wrote {len(results)} uniform term(s), {inert} provably inert when unowned, to {OUT}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
