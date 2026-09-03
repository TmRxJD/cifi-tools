"""Decompile named IL2CPP methods to readable C, headlessly, via Ghidra + PyGhidra.

WHY. Before this, answering "how does the game combine these bonuses?" meant reading raw capstone
x86_64 output by hand and tracking registers across basic blocks the compiler had reordered. That
works, but it is slow, it is not reproducible by anyone else, and a single mis-tracked register
silently produces a confident wrong answer -- which has happened in this project. This turns the
same question into: name the methods, read the C.

    python tools/il2cpp-cli/decompile.py GeneratorManager'$$'get_MK1Production
    python tools/il2cpp-cli/decompile.py --targets tools/il2cpp-cli/targets.json
    python tools/il2cpp-cli/decompile.py --list 'GeneratorManager..get_MK'

Output goes to tools/gamefiles/apk-<ver>/decompiled/<label>.c (gitignored with the rest of
gamefiles). Re-running reuses the saved Ghidra project, so only the first run pays import cost.

SETUP (one time). Needs Ghidra 11.3+ (PyGhidra is in-tree from 11.3; 10.x will not work) and a
JDK 21. Point GHIDRA_INSTALL_DIR at the install -- this file falls back to the known local path.
`pip install pyghidra`, or install the copy that ships with Ghidra:
    pip install --no-index -f "$GHIDRA_INSTALL_DIR/Ghidra/Features/PyGhidra/pypkg/dist" pyghidra

THREE THINGS THAT SILENTLY RUIN A RUN, all learned the hard way / from prior art:

 1. IMAGE BASE MUST BE 0. dump.cs quotes RVA == VA for CIFI, i.e. base 0. Ghidra's ELF loader
    picks its own base otherwise and every address lands somewhere plausible but wrong -- the
    worst failure mode, because you still get C out, just for the wrong function. Asserted below.

 2. DO NOT RUN FULL AUTO-ANALYSIS. On a ~58MB libil2cpp.so it takes tens of minutes to hours and
    can OOM. Import with analysis off and disassemble only the target's own byte span; the RVA
    table already tells us where each function starts and ends, which is most of what analysis
    would have been guessing at.

 3. APPLY A SIGNATURE BEFORE DECOMPILING. The binary is stripped, so Ghidra assumes `void f(void)`,
    treats the real arguments as unaffected registers, and emits a prologue plus a tail call
    instead of a body. Only arity and return type matter; IL2CPP `this`/MethodInfo* pointers can
    stay generic. (This specific fix is taken from tower-extractor's ExportTargetsDecompile.java,
    which hit and documented the same wall.)

A target may name a method (resolved through dumpindex, which also supplies the real end address)
or give an explicit address+span. Return type and param count are optional hints for (3); the
defaults are a pointer return and 2 params (`this`, MethodInfo*), which is right for a getter.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dumpindex import DumpIndex                                    # noqa: E402

DEFAULT_GHIDRA = r"E:\tools\ghidra_12.1.3_PUBLIC"
GAMEFILES = os.path.join(HERE, "..", "gamefiles", "apk-0.7.3.54")
DEFAULT_SO = os.path.join(GAMEFILES, "extracted", "libil2cpp.so")
DEFAULT_OUT = os.path.join(GAMEFILES, "decompiled")
PROJECT_DIR = os.path.join(GAMEFILES, "ghidra-project")
PROJECT_NAME = "cifi_il2cpp"


def resolve_targets(args, idx):
    """-> [{label, name, address, span, returnType, paramCount}]"""
    raw = []
    if args.targets:
        with open(args.targets, "r", encoding="utf-8") as f:
            raw = json.load(f)["methods"]
    for name in args.method:
        raw.append({"name": name})

    out = []
    for t in raw:
        name = t.get("name")
        if "address" in t:
            addr, span = int(str(t["address"]), 0), int(str(t.get("span", "0x800")), 0)
        else:
            start, end = idx.bounds(name)
            addr = start
            # A span cap keeps one pathological function from stalling the decompiler; real
            # IL2CPP getters are far smaller than this.
            span = min((end - start) if end else 0x2000, int(str(t.get("span", "0x4000")), 0))
        out.append({
            "label": t.get("label") or (name or f"0x{addr:X}").replace("$$", ".").replace("/", "_"),
            "name": name or f"sub_{addr:X}",
            "address": addr,
            "span": span,
            "returnType": t.get("returnType", "pointer"),
            "paramCount": int(t.get("paramCount", 2)),
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("method", nargs="*", help="Qualified name, e.g. GeneratorManager$$get_MK1Production")
    ap.add_argument("--targets", help="JSON file with {\"methods\":[{name,label,span,...}]}")
    ap.add_argument("--list", dest="list_pattern", help="Regex-search the dump index and exit")
    ap.add_argument("--so", default=DEFAULT_SO)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--ghidra", default=os.environ.get("GHIDRA_INSTALL_DIR", DEFAULT_GHIDRA))
    ap.add_argument("--timeout", type=int, default=300, help="Per-function decompile seconds")
    args = ap.parse_args()

    idx = DumpIndex()

    if args.list_pattern:
        for rva, _o, name, sig in idx.find(args.list_pattern)[:100]:
            print(f"0x{rva:X}  {name}\n           {sig}")
        return 0

    if not args.method and not args.targets:
        ap.error("give at least one method name, or --targets, or --list")

    targets = resolve_targets(args, idx)
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(PROJECT_DIR, exist_ok=True)

    if not os.path.isdir(args.ghidra):
        print(f"ERROR: Ghidra not found at {args.ghidra}. Set GHIDRA_INSTALL_DIR.", file=sys.stderr)
        return 2
    os.environ["GHIDRA_INSTALL_DIR"] = args.ghidra

    import pyghidra
    pyghidra.start()

    from ghidra.app.decompiler import DecompInterface, DecompileOptions
    from ghidra.app.cmd.disassemble import DisassembleCommand
    from ghidra.app.cmd.function import ApplyFunctionSignatureCmd
    from ghidra.program.model.address import AddressSet
    from ghidra.program.model.data import (
        BooleanDataType, DoubleDataType, FloatDataType, FunctionDefinitionDataType,
        IntegerDataType, LongDataType, ParameterDefinitionImpl, PointerDataType, VoidDataType)
    from ghidra.program.model.symbol import SourceType
    from ghidra.util.task import ConsoleTaskMonitor

    def ret_type(kind):
        return {"double": DoubleDataType(), "float": FloatDataType(), "void": VoidDataType(),
                "bool": BooleanDataType(), "int": IntegerDataType(),
                "long": LongDataType()}.get(kind, PointerDataType())

    def declare_callees(program, fm, flat, idx, entry, span, monitor):
        """Give every address this function CALLs a named, minimal function stub.

        A one-byte body is deliberate: we only need Ghidra to agree that the target is a function
        so the call is emitted as a call, and to have a name to print. Letting it compute a real
        body would mean disassembling (and following the flow of) every callee, which is the cost
        this whole approach exists to avoid.
        """
        listing = program.getListing()
        end = entry.add(max(span, 1) - 1)
        seen = set()
        insn = listing.getInstructionAt(entry)
        while insn is not None and insn.getAddress().compareTo(end) <= 0:
            mnemonic = insn.getMnemonicString().lower()
            if mnemonic in ("call", "jmp"):     # jmp too: IL2CPP getters tail-call constantly
                for ref in insn.getFlows() or []:
                    target = ref.getOffset()
                    if target in seen or entry.getOffset() <= target <= end.getOffset():
                        continue
                    seen.add(target)
                    addr = flat.toAddr(target)
                    if fm.getFunctionAt(addr) is not None:
                        continue
                    hit = idx.name_at(target)
                    # Only name it when the address is EXACTLY a method start; landing mid-body
                    # means our span or the index is off, and a confident wrong label is worse
                    # than none.
                    label = hit[2].replace("$$", "__").replace(".", "_") \
                        if (hit and hit[0] == target) else f"sub_{target:X}"
                    # A function cannot be created over undefined bytes, and we deliberately did
                    # NOT disassemble the callee (that is the cost being avoided). Disassemble one
                    # small window -- just enough to hang a function off -- then pin the body to
                    # it. Skipping this step is why an earlier version silently created nothing,
                    # left every call looking like a branch, and produced a 440k-char "function".
                    try:
                        stub = AddressSet(addr, addr.add(0xF))
                        DisassembleCommand(stub, None, False).applyTo(program, monitor)
                        first = listing.getInstructionAt(addr)
                        if first is not None:
                            fm.createFunction(label, addr,
                                              AddressSet(addr, addr.add(first.getLength() - 1)),
                                              SourceType.USER_DEFINED)
                    except Exception:                                  # noqa: BLE001
                        pass
            insn = listing.getInstructionAfter(insn.getAddress())

    print(f"Opening {args.so} (analysis OFF, image base 0)...")
    with pyghidra.open_program(args.so, project_location=PROJECT_DIR,
                               project_name=PROJECT_NAME, analyze=False) as flat:
        program = flat.getCurrentProgram()
        monitor = ConsoleTaskMonitor()

        # Gotcha 1. dump.cs RVAs assume base 0; anything else silently decompiles the wrong bytes.
        # Ghidra's ELF loader picks its own base for a shared object (0x100000 in practice), and
        # setImageBase lives on Program, not the flat API, and needs its own transaction.
        base = program.getImageBase().getOffset()
        if base != 0:
            print(f"  image base was 0x{base:X}; rebasing to 0 so dump.cs RVAs line up")
            space = program.getAddressFactory().getDefaultAddressSpace()
            tx = program.startTransaction("rebase to 0")
            try:
                program.setImageBase(space.getAddress(0), True)
            finally:
                program.endTransaction(tx, True)
            base = program.getImageBase().getOffset()
        assert base == 0, f"image base is 0x{base:X}, expected 0 -- addresses would be wrong"

        decomp = DecompInterface()
        opts = DecompileOptions()
        opts.setMaxPayloadMBytes(256)      # default ceiling aborts on the big production getters
        decomp.setOptions(opts)
        decomp.toggleCCode(True)
        decomp.toggleSyntaxTree(True)
        decomp.setSimplificationStyle("decompile")   # "normalize" would skip C output entirely
        decomp.openProgram(program)

        fm = program.getFunctionManager()
        results = []
        # Creating functions and applying signatures both mutate the program, so everything below
        # runs inside one transaction. (A Ghidra *script* gets one for free; a pyghidra session
        # does not, and the mutation silently fails without it.)
        outer_tx = program.startTransaction("decompile targets")
        for t in targets:
            entry = flat.toAddr(t["address"])
            status, code = "?", ""
            try:
                # Gotcha 2: disassemble ONLY this function's own bytes. followFlow=False matters --
                # with it on, disassembly runs through every `call` into the callee and Ghidra,
                # having no analysis to tell it those targets are functions, reports "Possible PIC
                # construction ... Changing call to branch" and folds the entire reachable program
                # into one body (354k chars of C for a 324-byte function, observed).
                body = AddressSet(entry, entry.add(max(t["span"], 1) - 1))
                DisassembleCommand(body, None, False).applyTo(program, monitor)

                # Declare every call target as its own function, named from the dump index, with a
                # deliberately minimal body. Two payoffs: the calls stay calls (so this function's
                # body stops at its own span), and the decompiled C reads
                # `FleetManager__get_FinalCradleCrew(...)` instead of `FUN_02134e7f(...)`.
                declare_callees(program, fm, flat, idx, entry, t["span"], monitor)

                fn = fm.getFunctionAt(entry)
                if fn is None:
                    fn = fm.createFunction(t["label"], entry, body, SourceType.USER_DEFINED)
                if fn is not None:
                    fn.setBody(body)      # pin it; otherwise flow analysis can widen it again
                if fn is None:
                    status = "no-function"
                else:
                    # Gotcha 3: without a signature this decompiles to a stub.
                    try:
                        d = FunctionDefinitionDataType(fn.getName())
                        d.setReturnType(ret_type(t["returnType"]))
                        n = max(t["paramCount"], 0)
                        params = []
                        for i in range(n):
                            pointerish = (i == 0 or i == n - 1)
                            params.append(ParameterDefinitionImpl(
                                f"a{i+1}",
                                PointerDataType() if pointerish else LongDataType(), None))
                        d.setArguments(params)
                        ApplyFunctionSignatureCmd(
                            fn.getEntryPoint(), d, SourceType.USER_DEFINED).applyTo(program, monitor)
                    except Exception as exc:                      # noqa: BLE001
                        print(f"  (signature not applied for {t['label']}: {exc})")
                    res = decomp.decompileFunction(fn, args.timeout, monitor)
                    if res and res.decompileCompleted() and res.getDecompiledFunction():
                        code = res.getDecompiledFunction().getC()
                        status = "ok"
                    else:
                        status = res.getErrorMessage() if res else "null-result"
            except Exception as exc:                              # noqa: BLE001
                status = f"exception: {exc}"

            path = os.path.join(args.out, t["label"] + ".c")
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"/* {t['name']} */\n/* address: 0x{t['address']:X}"
                        f"  span: 0x{t['span']:X} */\n/* status: {status} */\n\n{code}")
            results.append((t["label"], status, len(code), path))
            print(f"  {t['label']:48} {status:12} {len(code):>7} chars")

        program.endTransaction(outer_tx, True)
        decomp.dispose()

    ok = sum(1 for r in results if r[1] == "ok")
    print(f"\ndecompiled ok={ok} failed={len(results) - ok} -> {args.out}")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
