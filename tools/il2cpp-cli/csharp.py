"""Read the game's method BODIES as C#. This is the primary tool for game LOGIC.

    python tools/il2cpp-cli/csharp.py GeneratorManager
    python tools/il2cpp-cli/csharp.py FleetManager --grep RUGen2Bonus
    python tools/il2cpp-cli/csharp.py --rebuild          # re-run Cpp2IL from the binary

WHERE THIS SITS. Three tools, three questions, and using the wrong one wastes days:

  * a number a designer typed  -> typetree.py   (authored serialized data)
  * what a method DOES         -> THIS          (C# with real names and control flow)
  * raw machine code, when C# recovery fails or you need exact field offsets
                               -> decompile.py / analyze.py

THE STALE CLAIM THAT COST THIS PROJECT TIME. Until now the working assumption -- written into
research notes and acted on -- was that method bodies are unrecoverable for il2cpp metadata v39,
so game logic had to be read as x86_64 assembly. That was wrong, and the reason it looked right is
worth recording: Cpp2IL issue #223 is still open and still says IL recovery is legacy-only, and
#528 was closed as a duplicate of it. Both predate the work. The code disagrees with the issue
tracker: `LibCpp2IL` accepts metadata 23-108, `AsmResolverDllOutputFormatIlRecovery` really calls
`methodContext.Analyze()` then `IlGenerator.GenerateIl(...)`, and an SSA pipeline (SsaSimplifier,
ConstantFolder, DeadCodeEliminator, throw-helper/delegate/array recovery) landed between June and
August 2026. A commit on 2026-08-08 reads "Remove assumptions of x86, bring arm64 up to parity" --
x86_64 is the REFERENCE target, which is what this build is.

Measured here, not assumed: **52,545 of 52,553 methods recovered (100%), in 41 seconds.** The 8
failures are third-party (Newtonsoft.Json, DOTween, Sirenix) plus one 118KB game method,
ResearchLaboratory::TheRPDrainer, which is skipped as too big to analyse.

WHAT IT IS AND IS NOT. The output is CIL reconstructed from optimised machine code, so expect
readable logic, not original source: no local names, no comments, and occasional
`Cpp2ILHelpers.NoteDecompilerIssue("...")` where a load did not resolve. Those markers are honest
-- they say precisely where a value is missing rather than inventing one. When a field load fails
to resolve, get the offset from `decompile.py`/`analyze.py` and the value from `typetree.py`.

SETUP. Needs the Cpp2IL CI binary and `ilspycmd` (a dotnet tool). Cpp2IL has had no tagged release
since Feb 2024, so the CI build is the supported artifact:
    https://nightly.link/SamboyCoding/Cpp2IL/workflows/dotnet-core/development/Cpp2IL-net9-win-x64.zip
    dotnet tool install -g ilspycmd
Everything lands under B:\huntersim-re (HUNTERSIM_SCRATCH) -- the recovered assemblies are ~40MB
and the C# far more, so none of it belongs on the system drive or in the repo.
"""

import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Which pulled build to decompile. Switchable because "the game does not do X" and "this build
# does not do X yet" are different claims, and telling them apart means running the same extraction
# against two versions -- see the Yellow/Black gear question.
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")
GAMEFILES = os.path.join(HERE, "..", "gamefiles", APK_DIR)
SCRATCH = os.environ.get("HUNTERSIM_SCRATCH") or (
    r"B:\huntersim-re" if os.path.isdir("B:\\") else os.path.join(GAMEFILES, "scratch"))

CPP2IL_EXE = os.path.join(SCRATCH, "cpp2il", "Cpp2IL.exe")
CPP2IL_OUT = os.path.join(SCRATCH, "cpp2il_out" if APK_DIR == "apk-0.7.3.54" else f"cpp2il_out-{APK_DIR}")
CS_CACHE = os.path.join(SCRATCH, "csharp" if APK_DIR == "apk-0.7.3.54" else f"csharp-{APK_DIR}")
UNITY_VERSION = "6000.3.8f1"
DEFAULT_ASSEMBLY = "Assembly-CSharp.dll"


def run_cpp2il():
    """Lift libil2cpp.so back to .NET assemblies with real method bodies."""
    if not os.path.isfile(CPP2IL_EXE):
        raise SystemExit(f"Cpp2IL not found at {CPP2IL_EXE}\nSee this file's SETUP section.")
    so = os.path.join(GAMEFILES, "extracted", "libil2cpp.so")
    meta = os.path.join(GAMEFILES, "extracted", "global-metadata.dat")
    for path in (so, meta):
        if not os.path.isfile(path):
            raise SystemExit(f"missing input: {path}")
    # These three force options are all-or-nothing (Cpp2IL's AreForceOptionsValid). They are what
    # sidesteps split-APK autodetection: the metadata ships in base.apk and the .so in
    # split_config.x86_64.apk, and we already have both extracted.
    cmd = [CPP2IL_EXE,
           f"--force-binary-path={so}",
           f"--force-metadata-path={meta}",
           f"--force-unity-version={UNITY_VERSION}",
           "--output-as", "dll_il_recovery",
           "--output-to", CPP2IL_OUT]
    print(f"running Cpp2IL -> {CPP2IL_OUT}", file=sys.stderr)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    tail = (proc.stdout or "") + (proc.stderr or "")
    for line in tail.splitlines():
        if "successfully decompiled" in line or "Total execution time" in line:
            print("  " + re.sub(r"\x1b\[[0-9;]*m", "", line).strip(), file=sys.stderr)
    if proc.returncode != 0:
        raise SystemExit(f"Cpp2IL failed (exit {proc.returncode}):\n{tail[-2000:]}")


def decompile_type(type_name, assembly=DEFAULT_ASSEMBLY, refresh=False):
    """-> path to a .cs file for `type_name`, decompiled with ilspycmd (cached)."""
    dll = os.path.join(CPP2IL_OUT, assembly)
    if not os.path.isfile(dll):
        run_cpp2il()
    if not os.path.isfile(dll):
        raise SystemExit(f"{dll} still missing after running Cpp2IL")
    os.makedirs(CS_CACHE, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", type_name)
    out = os.path.join(CS_CACHE, f"{safe}.cs")
    if refresh or not os.path.isfile(out) or os.path.getsize(out) == 0:
        # ILSpy, not dnSpy: Cpp2IL's README is explicit that ILSpy copes far better with the
        # imperfect CIL that IL recovery produces.
        proc = subprocess.run(["ilspycmd", "-t", type_name, dll], capture_output=True, text=True)
        if proc.returncode != 0 or not proc.stdout.strip():
            raise SystemExit(f"ilspycmd failed for {type_name!r} "
                             f"(exit {proc.returncode}): {proc.stderr[-800:]}")
        with open(out, "w", encoding="utf-8") as f:
            f.write(proc.stdout)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("type", nargs="?", help="Type name, e.g. GeneratorManager")
    ap.add_argument("--assembly", default=DEFAULT_ASSEMBLY)
    ap.add_argument("--grep", help="Print only the member whose name matches, plus its body")
    ap.add_argument("--rebuild", action="store_true", help="Re-run Cpp2IL, then exit if no type")
    ap.add_argument("--refresh", action="store_true", help="Ignore the cached .cs for this type")
    args = ap.parse_args()

    if args.rebuild:
        run_cpp2il()
        if not args.type:
            return 0
    if not args.type:
        ap.error("give a type name, or --rebuild")

    path = decompile_type(args.type, args.assembly, refresh=args.refresh)
    text = open(path, encoding="utf-8").read()
    if not args.grep:
        print(text)
        return 0

    # Print each matching member from its declaration to the end of its body, by brace depth --
    # enough to read a property or method without dumping a 500KB class.
    lines = text.splitlines()
    needle = args.grep.lower()
    shown = 0
    for i, line in enumerate(lines):
        if needle not in line.lower() or "{" in line and line.strip().startswith("//"):
            continue
        if not re.search(r"\b(public|private|protected|internal|static)\b", line):
            continue
        depth, started = 0, False
        for j in range(i, min(i + 400, len(lines))):
            print(lines[j])
            depth += lines[j].count("{") - lines[j].count("}")
            started = started or "{" in lines[j]
            if started and depth <= 0:
                break
        print()
        shown += 1
    if not shown:
        print(f"(no member matching {args.grep!r} in {args.type}; "
              f"full source at {path})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
