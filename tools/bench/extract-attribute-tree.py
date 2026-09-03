"""Recover each hunter's ATTRIBUTE DEPENDENCY TREE from the game's own code.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-attribute-tree.py --write

WHY THIS EXISTS. The attribute tree is the optimizer's legality model: which attributes can be
funded at all depends on which parents are non-zero, and `AllocSpace` enumerates dependency-closed
support sets from it. A wrong edge does not produce a slightly worse build -- it changes which
allocations are considered to exist. Despite that, the tree had NO verification against either
source: the live cifi-tools bundle does not declare it (its `minValue` hits are a UI input prop,
and it has no parent/requires field at all), and the scene's authored `POM`/`POI`/`POK` families
carry Cost, MaxLevel and Bonus but no requirement. It was transcribed and never checked.

The game does state it, in code rather than data. `HuntersAttributes.CheckPOMUnlcoks()` (the typo
is the game's) drives the attribute screen: inside `if (POM0Level != 0)` it calls
`POM1LockedObject.SetActive(false)`, `POM4...`, `POM6...` -- i.e. buying POM0 unlocks POM1, POM4
and POM6. That is the dependency edge, expressed as UI state.

PARSE BY BRACE DEPTH, NOT INDENTATION. Cpp2IL puts the opening `{` on its own line at the SAME
indent as the `if`, so an indentation-based scope stack pops every guard immediately and finds zero
edges -- which reads as "the method does not do this" rather than "the parser cannot see it".

The recovered C# also assigns levels to locals first (`int num33 = mMO32.POM1Level;`) and then
guards on the local (`if (num33 > 0)`), so locals are tracked back to the field they came from.
"""

import argparse
import json
import os
import re
import subprocess
import sys

APK = os.environ.get("CIFI_APK", "apk-0.7.3.61")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "tools", "reference", "attribute-tree.json")

PREFIX_HUNTER = {"POM": "borge", "POI": "ozzy", "POK": "knox"}

GUARD_FIELD = re.compile(r"if \(\(?int\)?\s*\w+\.(POM|POI|POK)(\d+)Level\)?\s*(?:!= 0|> 0)")
GUARD_LOCAL = re.compile(r"if \((num\d+)\s*(?:!= 0|> 0)\)")
LOCAL_ASSIGN = re.compile(r"(num\d+) = \w+\.(POM|POI|POK)(\d+)Level;")
UNLOCK = re.compile(r"(POM|POI|POK)(\d+)LockedObject\.SetActive\(value: false\)")


def recovered_source():
    """The decompiled HuntersAttributes, with Cpp2IL's IL_ notes stripped."""
    cmd = [sys.executable, os.path.join(ROOT, "tools", "il2cpp-cli", "csharp.py"), "HuntersAttributes"]
    env = dict(os.environ, CIFI_APK=APK)
    res = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if res.returncode != 0 or not res.stdout:
        sys.exit(f"csharp.py failed: {res.stderr[-800:]}")
    return [ln for ln in res.stdout.split("\n") if not ln.lstrip().startswith("//IL_")]


def parse_edges(lines):
    """child index -> set of parent indices, per hunter."""
    edges = {h: {} for h in PREFIX_HUNTER.values()}
    local_of = {}
    depth = 0
    # stack of (brace_depth_at_which_the_guard_body_opened, prefix, index)
    stack = []
    pending = None  # a guard seen, whose `{` has not arrived yet

    for ln in lines:
        m = LOCAL_ASSIGN.search(ln)
        if m:
            local_of[m.group(1)] = (m.group(2), int(m.group(3)))

        g = GUARD_FIELD.search(ln)
        if g:
            pending = (g.group(1), int(g.group(2)))
        else:
            g2 = GUARD_LOCAL.search(ln)
            if g2 and g2.group(1) in local_of:
                pending = local_of[g2.group(1)]
            elif g2:
                # A guard on a local we cannot resolve would silently orphan the edges inside it.
                # Push a marker so those edges are dropped rather than mis-attributed to the
                # enclosing guard, which would invent a parent.
                pending = (None, None)

        for ch in ln:
            if ch == "{":
                depth += 1
                if pending is not None:
                    stack.append((depth, pending[0], pending[1]))
                    pending = None
            elif ch == "}":
                while stack and stack[-1][0] >= depth:
                    stack.pop()
                depth -= 1

        u = UNLOCK.search(ln)
        if u and stack:
            _, pfx, idx = stack[-1]
            if pfx is not None and u.group(1) == pfx and int(u.group(2)) != idx:
                edges[PREFIX_HUNTER[pfx]].setdefault(int(u.group(2)), set()).add(idx)
    return edges


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    lines = recovered_source()
    edges = parse_edges(lines)
    for hunter, e in edges.items():
        print(f"{hunter}: {len(e)} gated attribute(s)", file=sys.stderr)
        for child in sorted(e):
            print(f"    {child} <- {sorted(e[child])}", file=sys.stderr)

    if not any(edges.values()):
        sys.exit("no dependency edges recovered -- the method shape changed; do NOT treat this as "
                 "'the game has no attribute tree'")

    payload = {
        "_source": ("HuntersAttributes.CheckPOMUnlcoks() in the recovered C# (tools/il2cpp-cli/"
                    "csharp.py). An edge is `if (<PFX><parent>Level != 0) { "
                    "<PFX><child>LockedObject.SetActive(false); }` -- the dependency expressed as "
                    "UI state, which is where the game states it."),
        "_game": APK,
        "_meaning": ("indices are the game's own POM/POI/POK numbering, NOT our attribute ids; "
                     "attribute-tree-check.js joins the two by tree shape plus authored cost/cap."),
        "edges": {
            hunter: {str(child): sorted(parents) for child, parents in sorted(e.items())}
            for hunter, e in edges.items()
        },
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
