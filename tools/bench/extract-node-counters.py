"""Extract the "per X" COUNTER each ship install node multiplies by, from the game.

A node's bonus is `1 + coeff * counter * crew * level * <uniform mults>`. The COUNTER is the part
our catalog calls `gearKey`, and it is the one field of a node that scales its value directly --
point a node at the wrong counter and its worth is off by whatever the two counters differ by
(loopModsOwned reads 35 on the bench fixture where a flat node reads 1).

METHOD: elimination, not keyword matching. Take every member the getter reads -- named accesses,
`<X>k__BackingField`, and the operands hidden inside Cpp2IL's decompiler notes -- then remove the
terms that are structural rather than a counter (own level, authored base bonus, crew, gear pieces,
badges, research/gem multipliers). Whatever remains is the counter, or nothing for a flat node.

WHY ELIMINATION. A keyword scan silently MISSES counters, and a miss looks exactly like "this node
is flat", which is a plausible-looking wrong answer. Two real false negatives while building this:
`LMAssist.LoopModLevelsCount` was missed because the keyword list had "Mods" and not "Mod", making
five Zagreus nodes look like catalog errors; and Koios 3's counter is inside a "Not implemented
instruction" note (`cvtsi2ss xmm0, dword ptr [rax+1B68h]`) rather than an "Unmanaged memory load",
so parsing only the latter hid it. BOTH note kinds carry operands -- see CLAUDE.md's rule that a
multiply by `(BigDouble)0` or `0f` is a MISSING OPERAND, not a zero.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-counters.py
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "ship-node-counters.json")
CSHARP = os.path.join(HERE, "..", "il2cpp-cli", "csharp.py")
RESOLVE = os.path.join(HERE, "..", "il2cpp-cli", "resolve-loads.py")
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")

MEMBER = re.compile(r"^\t(public|private|internal|protected)\s")
PROP = re.compile(r"^\tpublic \w[\w<>]* (RU([A-Za-z]+)(\d+)Bonus)\s*$")

# Terms every node carries regardless of its counter.
STRUCTURAL = re.compile(
    r"^(RU\d+[A-Za-z]+(Level|BaseBonus|MaxLevel|Requirement)"
    r"|Final[A-Za-z]*Crew|Final[A-Za-z]*Rank"
    r"|Final[A-Za-z]*Badge\d*Bonus\d*|FinalDarkBadge\d+Bonus"
    r"|[A-Za-z]+Item\d+Bonus\d+"
    r"|Final(Ship\d+|AllShips)InstallsBonus"
    r"|FinalPowerGU\d+Bonus"
    r"|FinalShipRanksMaxLevelBonus"
    r"|NoteDecompilerIssue)$")


def main():
    proc = subprocess.run([sys.executable, CSHARP, "FleetManager"], capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(f"could not recover FleetManager C#: {proc.stderr[-500:]}")
    lines = proc.stdout.splitlines()

    bodies = {}
    cur, buf = None, []
    for line in lines:
        m = PROP.match(line)
        if m:
            if cur: bodies[cur] = "\n".join(buf)
            cur, buf = (m.group(2), int(m.group(3))), []
            continue
        if cur:
            if MEMBER.match(line):
                bodies[cur] = "\n".join(buf)
                cur, buf = None, []
            else:
                buf.append(line)
    if cur: bodies[cur] = "\n".join(buf)
    if not bodies:
        raise SystemExit("no RU<Category><n>Bonus getters found")

    cache = {}
    def resolve(type_name, offset):
        key = (type_name, offset)
        if key not in cache:
            env = dict(os.environ, CIFI_APK=APK_DIR)
            r = subprocess.run([sys.executable, RESOLVE, "--offset", type_name, "0x" + offset],
                               capture_output=True, text=True, env=env)
            m = re.search(r"-> ([<\w>]+)", r.stdout)
            cache[key] = m.group(1).replace("<", "").replace(">k__BackingField", "") if m else None
        return cache[key]

    out = {}
    for (category, idx), body in sorted(bodies.items()):
        names = set(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)", body))
        names |= set(re.findall(r"<([A-Za-z0-9_]+)>k__BackingField", body))
        # Operands inside BOTH note kinds. `(Type)+OFFSET` names the type; a bare `[reg+OFFSET]`
        # inside an unimplemented instruction is a MasterManager read in every observed case.
        for t, o in re.findall(r"\(([A-Za-z0-9_]+)\)\+([0-9A-F]+)", body):
            n = resolve(t, o)
            if n: names.add(n)
        # A bare `dword ptr [reg+OFFSET]` inside an unimplemented instruction carries an operand
        # too, but the register alone does not say which object it is -- and resolving against the
        # wrong type returns a real-looking field name rather than an error. The conversion opcode
        # disambiguates it: a COUNTER is an int field (`cvtsi2ss`, int -> float), while the node's
        # authored base bonus is already a float (`cvtss2sd`). Taking every dword read produced ten
        # bogus counters on the first run (CellGeneratorsMK8, MK5FirstUnlockStat, ...); taking only
        # the float ones would have mislabelled RU4GenBaseBonus as Gen 4's counter. Only integer
        # loads are considered, and only against MasterManager, which is where the counters live.
        for o in re.findall(r"cvtsi2ss [^\"]*?dword ptr \[\w+\+([0-9A-F]+)h\]", body):
            n = resolve("MasterManager", o)
            if n: names.add(n)
        counters = sorted(n for n in names if not STRUCTURAL.match(n))
        out.setdefault(category, {})[str(idx)] = counters

    payload = {
        "_source": "RU<Category><n>Bonus getter bodies in the recovered FleetManager C# "
                   "(tools/il2cpp-cli/csharp.py), with note operands resolved via resolve-loads.py",
        "_meaning": "The 'per X' quantities a node's bonus multiplies by. An empty list means the "
                    "node is flat (no counter). Our catalog calls this `gearKey`.",
        "_game": APK_DIR,
        "counters": {c: dict(sorted(v.items(), key=lambda kv: int(kv[0]))) for c, v in sorted(out.items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + "\n")
    total = sum(len(v) for v in out.values())
    print(f"wrote counters for {total} node(s) across {len(out)} categories to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
