"""Name the field reads that Cpp2IL could not resolve, so they stop being invisible.

THE FAILURE MODE THIS EXISTS TO KILL. When Cpp2IL cannot resolve a field load it emits

    Cpp2ILHelpers.NoteDecompilerIssue("Unmanaged memory load: [v67 @ rcx_v11 (FleetManager)+1C30]");
    BigDouble bigDouble16 = bigDouble15 * (BigDouble)0;

The operand is replaced by a ZERO and the field's NAME never appears. Two consequences, both of
which have already produced wrong conclusions in this repo:

  * grepping the recovered C# for a field name finds nothing, and "no references" reads as "not
    used" -- that is how ship EVOLUTION was twice declared absent from the production chain when
    it is in fact a factor worth x162,000 on the reference account;
  * `* (BigDouble)0` looks like a multiply by zero. It is a MISSING OPERAND, not a zero.

dump.cs carries every field's offset, so the name is recoverable: parse `(Type)+OFFSET` out of the
note and look it up. This turns an invisible read into `FleetManager.<CradleEvolutionBonus>`.

    python tools/il2cpp-cli/resolve-loads.py GeneratorManager
    python tools/il2cpp-cli/resolve-loads.py FleetManager --member RUGen2Bonus
    python tools/il2cpp-cli/resolve-loads.py --offset FleetManager 0x1C30

Offsets in the notes may point INTO a field rather than at its start -- BigDouble is 16 bytes
(mantissa at +0, exponent at +8), so a note at +1C30 is the exponent half of the field declared at
+1C28. Matches report the containing field and the delta.
"""

import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Same CIFI_APK switch as the rest of the il2cpp tooling. This one matters more than most:
# offsets come from a decompiled body of ONE build, and resolving them against another build's
# dump.cs yields confident nonsense rather than an error -- "+96 into" a 16-byte BigDouble field,
# or a text field where a bonus should be. Caught exactly that way while diffing 0.7.3.54 vs .61.
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")
DUMP = os.path.join(HERE, "..", "gamefiles", APK_DIR, "il2cpp-dump", "dump.cs")

NOTE_RE = re.compile(r'NoteDecompilerIssue\("Unmanaged memory load: \[([^\]]*)\]"\)')
# "v67 @ rcx_v11 (FleetManager)+1C30"  or  "this @ rdi (GemPerks)+1200"
TARGET_RE = re.compile(r"\(([A-Za-z0-9_.<>`]+)\)\+([0-9A-Fa-f]+)")
FIELD_RE = re.compile(r"^\s+(?:[\w\s<>,\[\]?.`]+?)\s+([\w<>`.]+);\s*//\s*0x([0-9A-Fa-f]+)\s*$")


def load_type_fields(dump_path=DUMP):
    """{type_name: [(offset, declaration)]} for every class/struct in the dump, offsets sorted."""
    types = {}
    current = None
    decl = re.compile(r"^(?:public |private |internal |protected |sealed |abstract |static )*"
                      r"(?:class|struct)\s+([A-Za-z0-9_.<>`]+)")
    with open(dump_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line and line[0] not in " \t":
                # Only a type DECLARATION changes scope. Do not clear on other column-0 lines:
                # dump.cs puts the opening `{`, the closing `}` and `// Namespace:` comments at
                # column 0 too, and clearing on those threw away every field (parsed 11,383 types
                # with 0 fields each, silently -- the lookup just answered "no field contains that
                # offset" for everything).
                m = decl.match(line)
                if m:
                    current = m.group(1)
                    types.setdefault(current, [])
                continue
            if current is None:
                continue
            m = FIELD_RE.match(line.rstrip("\n"))
            if m:
                types[current].append((int(m.group(2), 16), m.group(1), line.strip()))
    for t in types:
        types[t].sort(key=lambda e: e[0])
    return types


def resolve(types, type_name, offset):
    """-> (field_name, declared_offset, delta) for the field containing `offset`, or None."""
    fields = types.get(type_name)
    if not fields:
        return None
    best = None
    for off, name, decl in fields:
        if off <= offset:
            best = (off, name, decl)
        else:
            break
    if best is None:
        return None
    return (best[1], best[0], offset - best[0], best[2])


def recovered_csharp(type_name):
    proc = subprocess.run([sys.executable, os.path.join(HERE, "csharp.py"), type_name],
                          capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(f"could not recover C# for {type_name}: {proc.stderr[-500:]}")
    return proc.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("type", nargs="?", help="Type whose recovered C# to scan")
    ap.add_argument("--member", help="Only report loads inside members whose name matches")
    ap.add_argument("--offset", nargs=2, metavar=("TYPE", "OFFSET"),
                    help="Resolve one offset directly, e.g. --offset FleetManager 0x1C30")
    args = ap.parse_args()

    types = load_type_fields()

    if args.offset:
        t, off = args.offset[0], int(args.offset[1], 0)
        hit = resolve(types, t, off)
        if not hit:
            print(f"no field of {t} contains +0x{off:X}")
            return 1
        name, decl_off, delta, decl = hit
        print(f"{t}+0x{off:X} -> {name}  (declared at +0x{decl_off:X}, +{delta} into it)")
        print(f"    {decl}")
        return 0

    if not args.type:
        ap.error("give a type, or --offset TYPE OFFSET")

    src = recovered_csharp(args.type)
    lines = src.splitlines()
    member = None
    member_re = re.compile(r"^\t(?:public|private|internal|protected)\s+.*?([A-Za-z0-9_]+)\s*(?:\(|$|\{)")
    seen = 0
    for i, line in enumerate(lines):
        m = member_re.match(line)
        if m:
            member = m.group(1)
        note = NOTE_RE.search(line)
        if not note:
            continue
        if args.member and (member is None or args.member.lower() not in member.lower()):
            continue
        tm = TARGET_RE.search(note.group(1))
        if not tm:
            continue          # e.g. "[v41 @ rdi_v2+E4]" -- no type named, nothing to resolve
        owner, off = tm.group(1), int(tm.group(2), 16)
        hit = resolve(types, owner, off)
        seen += 1
        where = f"{args.type}.{member}" if member else args.type
        if hit:
            name, decl_off, delta, _ = hit
            extra = "" if delta == 0 else f" (+{delta} into it)"
            print(f"  line {i+1:>6}  {where:<44} -> {owner}.{name}{extra}")
        else:
            print(f"  line {i+1:>6}  {where:<44} -> UNRESOLVED {owner}+0x{off:X}")
    print(f"\n{seen} unresolved load(s) named"
          + (f" in members matching {args.member!r}" if args.member else ""), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
