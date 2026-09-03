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

# The SPEND THRESHOLD gates. A tier is opened by total points spent on that hunter's attributes,
# and the game writes the bound two ways: as a literal (`>= 75`) for the first tier, and as an
# authored field (`>= POM12UnlockReq`) for the later ones. Both forms are captured; the field form
# is resolved against the authored values read by typetree.py, because a field NAME is not a value
# and recording the name as if it were one is how an unverified number acquires a verified look.
SPEND_LITERAL = re.compile(r"<(borge|ozzy|knox)PointsSpend>k__BackingField >= (\d+)\)")
SPEND_FIELD = re.compile(r"<(borge|ozzy|knox)PointsSpend>k__BackingField >= (POM|POI|POK)(\d+)UnlockReq\)")


def recovered_source():
    """The decompiled HuntersAttributes, with Cpp2IL's IL_ notes stripped."""
    cmd = [sys.executable, os.path.join(ROOT, "tools", "il2cpp-cli", "csharp.py"), "HuntersAttributes"]
    env = dict(os.environ, CIFI_APK=APK)
    res = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if res.returncode != 0 or not res.stdout:
        sys.exit(f"csharp.py failed: {res.stderr[-800:]}")
    return [ln for ln in res.stdout.split("\n") if not ln.lstrip().startswith("//IL_")]


def parse_edges(lines):
    """(child -> parents, child -> spend threshold), per hunter."""
    edges = {h: {} for h in PREFIX_HUNTER.values()}
    thresholds = {h: {} for h in PREFIX_HUNTER.values()}
    local_of = {}
    depth = 0
    # stack of (brace_depth_at_which_the_guard_body_opened, prefix, index)
    stack = []
    spend_stack = []
    pending = None  # a guard seen, whose `{` has not arrived yet
    pending_spend = None

    for ln in lines:
        m = LOCAL_ASSIGN.search(ln)
        if m:
            local_of[m.group(1)] = (m.group(2), int(m.group(3)))

        # A spend gate opens a block whose unlocks belong to that threshold, not to a parent
        # attribute. Tracked separately so a tier bound is never mistaken for a dependency edge.
        # NOT cleared when a line does not match: Cpp2IL puts the opening `{` on the line AFTER
        # the `if`, so clearing here would discard every gate before its block ever opened -- which
        # yields an empty threshold map that reads as "the game has no tier gates".
        sf = SPEND_FIELD.search(ln)
        sl = None if sf else SPEND_LITERAL.search(ln)
        if sf or sl:
            pending_spend = ("field", sf.group(2) + sf.group(3) + "UnlockReq") if sf else ("literal", int(sl.group(2)))

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
                if pending_spend is not None:
                    spend_stack.append((depth, pending_spend))
                    pending_spend = None
            elif ch == "}":
                while stack and stack[-1][0] >= depth:
                    stack.pop()
                while spend_stack and spend_stack[-1][0] >= depth:
                    spend_stack.pop()
                depth -= 1

        u = UNLOCK.search(ln)
        if u:
            hunter = PREFIX_HUNTER[u.group(1)]
            child = int(u.group(2))
            if spend_stack:
                thresholds[hunter][child] = spend_stack[-1][1]
            if stack:
                _, pfx, idx = stack[-1]
                if pfx is not None and u.group(1) == pfx and child != idx:
                    edges[hunter].setdefault(child, set()).add(idx)
    return edges, thresholds


def authored_unlock_reqs():
    """`POM12UnlockReq` -> its authored number, straight from the MonoBehaviour."""
    cmd = [sys.executable, os.path.join(ROOT, "tools", "il2cpp-cli", "typetree.py"),
           "--dump", "HuntersAttributes", "--grep", "UnlockReq"]
    env = dict(os.environ, CIFI_APK=APK)
    res = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        sys.exit(f"typetree.py failed: {res.stderr[-800:]}")
    body = res.stdout[res.stdout.index("{"):]
    return {k: v for k, v in json.loads(body).items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    lines = recovered_source()
    edges, thresholds = parse_edges(lines)
    authored = authored_unlock_reqs()
    for hunter, e in edges.items():
        print(f"{hunter}: {len(e)} gated attribute(s)", file=sys.stderr)
        for child in sorted(e):
            print(f"    {child} <- {sorted(e[child])}", file=sys.stderr)

    if not any(edges.values()):
        sys.exit("no dependency edges recovered -- the method shape changed; do NOT treat this as "
                 "'the game has no attribute tree'")

    # Resolve `POM12UnlockReq` style bounds to their authored numbers. An unresolvable field is
    # fatal rather than recorded by name: a threshold nobody can compare is worse than none.
    resolved = {}
    for hunter, per_node in thresholds.items():
        resolved[hunter] = {}
        for node, (kind, val) in sorted(per_node.items()):
            if kind == "literal":
                resolved[hunter][str(node)] = val
            elif val in authored:
                resolved[hunter][str(node)] = authored[val]
            else:
                sys.exit(f"{hunter} node {node} gates on {val}, which typetree.py did not report -- "
                         f"cannot record a threshold without its value")
        print(f"{hunter} thresholds: {resolved[hunter]}", file=sys.stderr)

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
        "_thresholdSource": (
            "the same method's `<hunter>PointsSpend >= N` gates, where N is a literal for the "
            "first tier and an authored POM/POI/POK<n>UnlockReq field for the later ones; field "
            "values read with tools/il2cpp-cli/typetree.py."
        ),
        "spendThresholds": resolved,
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
