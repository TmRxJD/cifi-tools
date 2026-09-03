"""Decompile named IL2CPP methods to readable C, headlessly, via Ghidra + PyGhidra.

WHY. Before this, answering "how does the game combine these bonuses?" meant reading raw capstone
x86_64 output by hand and tracking registers across basic blocks the compiler had reordered. That
works, but it is slow, it is not reproducible by anyone else, and a single mis-tracked register
silently produces a confident wrong answer -- which has happened in this project. This turns the
same question into: name the methods, read the C.

    python tools/il2cpp-cli/decompile.py GeneratorManager'$$'get_MK1Production
    python tools/il2cpp-cli/decompile.py --targets tools/il2cpp-cli/targets.json
    python tools/il2cpp-cli/decompile.py --list 'GeneratorManager..get_MK'

Output and the Ghidra project go to B:\huntersim-re (override with HUNTERSIM_SCRATCH) -- a
project is ~215MB per run and must not sit on the system drive. Re-running reuses the project.

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

DEFAULT_GHIDRA = os.environ.get("GHIDRA_INSTALL_DIR", r"E:\tools\ghidra_12.1.3_PUBLIC")
GAMEFILES = os.path.join(HERE, "..", "gamefiles", "apk-0.7.3.54")
DEFAULT_SO = os.path.join(GAMEFILES, "extracted", "libil2cpp.so")

# A Ghidra project for a 58MB libil2cpp.so is ~215MB, and every run of this tool makes one. That
# does not belong on the system drive: C: on this machine hit 0.2GB free after three runs. B: is
# the big scratch volume -- override with HUNTERSIM_SCRATCH if yours differs. Only the decompiled
# .c files (a few hundred KB) come back into the repo, and even those are gitignored under
# tools/gamefiles/.
SCRATCH = os.environ.get("HUNTERSIM_SCRATCH") or (
    r"B:\huntersim-re" if os.path.isdir("B:\\") else os.path.join(GAMEFILES, "scratch"))
DEFAULT_OUT = os.path.join(SCRATCH, "decompiled")
PROJECT_DIR = os.path.join(SCRATCH, "ghidra-project")
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

    # Deterministic span for a callee that has no dump.cs entry (IL2CPP runtime helpers): scan
    # forward with capstone to its first RET. Ghidra's own flow-following alternative is unbounded
    # and does not terminate usefully on this binary.
    _elf_holder = {}

    def classify_callee(addr, limit=0x600):
        """(span, returns) for a callee, read from its actual bytes.

        `returns` is the important half, and getting it wrong is what caused the runaway output.
        IL2CPP getters END with a call to a throw/abort helper (0x1AFA69F here) that never returns:
        it has no RET at all, just a chain of PLT jumps. An earlier version of this code forced
        setNoReturn(False) on every callee, so the decompiler believed that helper returned, let
        flow FALL THROUGH past the end of the function into the next one, and cascaded from there
        through the binary.

        Classification, entirely from the disassembly:
          * first instruction is an unconditional JMP  -> PLT thunk; it returns via its target.
          * a RET is reachable within `limit`          -> returns.
          * otherwise                                  -> does not return (throw/abort helper).
        """
        try:
            if "elf" not in _elf_holder:
                from analyze import Elf
                _elf_holder["elf"] = Elf(args.so)
            insns = _elf_holder["elf"].disasm_function(addr, addr + limit)
            if insns and insns[0].mnemonic == "jmp":
                return insns[0].size, True          # thunk
            for insn in insns:
                if insn.mnemonic == "ret":
                    return (insn.address - addr) + insn.size, True
        except Exception:                                              # noqa: BLE001
            return 0x80, True       # unknown: assume it returns, the safer error here
        return 0x80, False          # no RET, not a thunk -> non-returning

    if args.list_pattern:
        for rva, _o, name, sig in idx.find(args.list_pattern)[:100]:
            print(f"0x{rva:X}  {name}\n           {sig}")
        return 0

    if not args.method and not args.targets:
        ap.error("give at least one method name, or --targets, or --list")

    targets = resolve_targets(args, idx)
    os.makedirs(args.out, exist_ok=True)
    # Deliberately do NOT pre-create PROJECT_DIR's project: pyghidra calls
    # GhidraProject.createProject(...) and throws "Unable to delete test project" if it finds a
    # directory it did not make. Create only the parent.
    os.makedirs(os.path.dirname(PROJECT_DIR) or ".", exist_ok=True)

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
    from ghidra.program.model.listing import FlowOverride
    from ghidra.program.model.symbol import SourceType
    from ghidra.util.task import ConsoleTaskMonitor

    def mark_tail_calls(listing, entry, end):
        """Tell the decompiler that a JMP out of the body is a tail CALL, not a branch.

        THIS is the fix for the runaway-output bug, and it took reading Ghidra's own decompiler
        source to find. `Funcdata::startProcessing` (funcdata.cc) does:

            Address baddr(baseaddr.getSpace(), 0);
            Address eaddr(baseaddr.getSpace(), ~((uintb)0));
            followFlow(baddr, eaddr);

        -- the decompiler follows flow across the ENTIRE address space and never consults the
        function's body. So `setBody` cannot bound it, which matches the measurement that the body
        stayed pinned at its exact span while the output ballooned to ~960k chars.

        CALLs are fine: they become call-specs and are not followed. But an unconditional JMP is
        followed, and IL2CPP getters end in a tail-call JMP (e.g. `jmp BigDouble::op_Addition`).
        Flow therefore walks into the callee, and then everything IT reaches. `checkContainedCall`
        (flow.cc) subsequently rewrites every CALL whose target now lies inside the visited range
        into a BRANCH -- "Possible PIC construction ... Changing call to branch" -- inlining those
        too. That is the cascade.

        FlowOverride.CALL_RETURN maps BRANCH -> CALL/RETURN, which is exactly a tail call, so flow
        stops at the jump.
        """
        marked = 0
        insn = listing.getInstructionAt(entry)
        while insn is not None and insn.getAddress().compareTo(end) <= 0:
            ft = insn.getFlowType()
            if ft is not None and ft.isJump() and ft.isUnConditional() and not ft.isComputed():
                for f in insn.getFlows() or []:
                    if not (entry.getOffset() <= f.getOffset() <= end.getOffset()):
                        insn.setFlowOverride(FlowOverride.CALL_RETURN)
                        marked += 1
                        break
            insn = listing.getInstructionAfter(insn.getAddress())
        return marked

    def ret_type(kind):
        return {"double": DoubleDataType(), "float": FloatDataType(), "void": VoidDataType(),
                "bool": BooleanDataType(), "int": IntegerDataType(),
                "long": LongDataType()}.get(kind, PointerDataType())

    def apply_signature(program, fn, monitor, kind="pointer", param_count=2):
        """Declare a function's arity and return type.

        Needed on the TARGET because a stripped binary otherwise decompiles to `void f(void)` plus
        a tail call instead of a body. Needed just as much on every CALLEE STUB, for a different
        and much less obvious reason -- see declare_callees.
        """
        try:
            d = FunctionDefinitionDataType(fn.getName())
            d.setReturnType(ret_type(kind))
            n = max(param_count, 0)
            params = []
            for i in range(n):
                pointerish = (i == 0 or i == n - 1)   # `this` and the trailing MethodInfo*
                params.append(ParameterDefinitionImpl(
                    f"a{i+1}", PointerDataType() if pointerish else LongDataType(), None))
            d.setArguments(params)
            ApplyFunctionSignatureCmd(
                fn.getEntryPoint(), d, SourceType.USER_DEFINED).applyTo(program, monitor)
            return True
        except Exception as exc:                                       # noqa: BLE001
            print(f"  (signature not applied for {fn.getName()}: {exc})")
            return False

    def declare_callees(program, fm, flat, idx, entry, span, monitor):
        """Give every address this function CALLs a named, RETURNING function stub.

        THE BOUNDING BUG THIS FIXES. A stub whose body is a single instruction contains no RET, so
        Ghidra concludes the callee does not return. Its decompiler then rewrites `call X` as a
        branch -- reported as "Possible PIC construction ... Changing call to branch" -- and inlines
        X into the caller. X's own calls are then unknown too, so it recurses, and a 324-byte
        function decompiles to ~960k chars of C spanning half the binary. Pinning the caller's body
        with setBody does NOT stop this: the flow rewrite happens below that level.

        The cure is to make each stub look like a normal returning function, which
        setNoReturn(False) plus an explicit signature does. The stub body stays one instruction --
        we still never disassemble the callee, which is the whole point of the approach.
        """
        listing = program.getListing()
        end = entry.add(max(span, 1) - 1)
        seen = set()
        made = 0
        failures = []
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
                    existing = fm.getFunctionAt(addr)
                    if existing is not None:
                        continue
                    hit = idx.name_at(target)
                    # Only name it when the address is EXACTLY a method start; landing mid-body
                    # means our span or the index is off, and a confident wrong label is worse
                    # than none.
                    label = hit[2].replace("$$", "__").replace(".", "_") \
                        if (hit and hit[0] == target) else f"sub_{target:X}"
                    # Give the callee its REAL span from the dump index, not a one-instruction
                    # stub. This is what actually bounds the caller: a stub body holds no RET, so
                    # Ghidra decides the callee never returns, rewrites `call` as a branch, and
                    # inlines it -- and since the inlined code's own calls are unknown too, it
                    # cascades until a 454-byte function decompiles to ~150k chars of C. Measured:
                    # the caller's body was pinned correctly at 454 bytes the whole time, so
                    # setBody was never the problem. Disassembling a handful of small callees is
                    # far cheaper than the full auto-analysis this design exists to avoid.
                    # The callee's body MUST contain its RET. Without one Ghidra infers "does not
                    # return", rewrites `call` as a branch, and INLINES the callee -- which then
                    # cascades through the callee's own unknown calls. Measured: the caller's own
                    # body stayed correctly pinned at its exact span the whole time, so setBody was
                    # never the lever; this is.
                    #
                    # Not every callee is in dump.cs: IL2CPP RUNTIME helpers (the class-init guard
                    # called at the top of essentially every managed method, e.g. 0x1AFA484) sit
                    # below the lowest managed-method RVA and have no index entry, so there is no
                    # span to look up. Letting Ghidra follow flow to find the end instead is worse
                    # than the disease -- unbounded, it disassembles huge swathes of the binary and
                    # was killed after 15 minutes on two functions.
                    #
                    # So bound it deterministically: scan forward with capstone to the callee's
                    # first RET. Cheap, terminates, and needs no Ghidra round-trips.
                    if hit and hit[0] == target:
                        c_start, c_end = idx.bounds(hit[2])
                        window = min((c_end - c_start) if c_end else 0x400, 0x4000)
                        _, callee_returns = classify_callee(target, window)
                    else:
                        window, callee_returns = classify_callee(target)
                    callee_body = AddressSet(addr, addr.add(max(window, 1) - 1))
                    DisassembleCommand(callee_body, callee_body, True).applyTo(program, monitor)
                    if listing.getInstructionAt(addr) is None:
                        failures.append((target, "no instruction at target"))
                        continue
                    fn = None
                    try:
                        fn = fm.createFunction(label, addr, callee_body, SourceType.USER_DEFINED)
                    except Exception as exc:                           # noqa: BLE001
                        # Overlaps an existing ELF symbol or another function. What matters is that
                        # SOMETHING owns the address, not that we named it -- so fall back rather
                        # than swallowing, which is how these silently failed to exist for a while.
                        try:
                            fn = fm.createFunction(None, addr, callee_body, SourceType.DEFAULT)
                        except Exception:                              # noqa: BLE001
                            fn = fm.getFunctionAt(addr) or fm.getFunctionContaining(addr)
                            if fn is None:
                                failures.append((target, type(exc).__name__))
                    if fn is not None:
                        # Never blanket-assume "returns" -- see classify_callee.
                        fn.setNoReturn(not callee_returns)
                        try:
                            fn.setInline(False)   # never fold a callee into the caller's body
                        except Exception:                              # noqa: BLE001
                            pass
                        apply_signature(program, fn, monitor)
                        made += 1
            insn = listing.getInstructionAfter(insn.getAddress())
        return made, failures

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
                # Gotcha 2: disassemble ONLY this function's own bytes. Restricting to `body`
                # keeps flow from running off into callees, whose bytes we deliberately never
                # disassemble.
                body = AddressSet(entry, entry.add(max(t["span"], 1) - 1))
                DisassembleCommand(body, body, True).applyTo(program, monitor)

                # Declare every call target as a named, RETURNING function. This is what actually
                # bounds the body -- see declare_callees for why a non-returning stub causes the
                # decompiler to inline the callee and blow the output up.
                stubs, stub_failures = declare_callees(
                    program, fm, flat, idx, entry, t["span"], monitor)
                if stub_failures:
                    # Loud, not silent: an undeclared callee is the difference between a clean
                    # 2k-char function and an inlined 900k-char one, so it must be visible.
                    print(f"    WARNING {len(stub_failures)} callee stub(s) not declared: "
                          + ", ".join(f"0x{a:X} ({why})" for a, why in stub_failures[:4]))

                # mark_tail_calls (FlowOverride.CALL_RETURN on a JMP leaving the body) is
                # DELIBERATELY NOT CALLED. It is the textbook tail-call mechanism and it does work,
                # but measured here it changed nothing (1 jump marked, call->branch count identical)
                # while making a single small function take >10 minutes instead of seconds --
                # setFlowOverride triggers re-disassembly and non-returning propagation inside the
                # open transaction. The real cause was the callee returns-classification; see
                # classify_callee. Kept for reference, not on the hot path.
                tails = 0

                fn = fm.getFunctionAt(entry)
                if fn is None:
                    fn = fm.createFunction(t["label"], entry, body, SourceType.USER_DEFINED)
                if fn is not None:
                    fn.setBody(body)      # pin it; otherwise flow analysis can widen it again
                if fn is None:
                    status = "no-function"
                else:
                    # Gotcha 3: without a signature this decompiles to a stub.
                    apply_signature(program, fn, monitor, t["returnType"], t["paramCount"])
                    res = decomp.decompileFunction(fn, args.timeout, monitor)
                    if res and res.decompileCompleted() and res.getDecompiledFunction():
                        code = res.getDecompiledFunction().getC()
                        status = "ok"
                    else:
                        status = res.getErrorMessage() if res else "null-result"
            except Exception as exc:                              # noqa: BLE001
                status = f"exception: {exc}"

            # Ghidra prefixes the body with one comment line per decompiler note. On these
            # functions that was 1167 of 2151 lines -- more than half the file, and none of it an
            # answer to anything. Keep the tally, because it is a useful health signal (a spike in
            # call->branch conversions means callees are being inlined into the body again), and
            # drop the lines themselves.
            kept, dropped, pic = [], 0, 0
            for line in code.split("\n"):
                if line.lstrip().startswith("/* WARNING:"):
                    dropped += 1
                    if "Changing call to branch" in line:
                        pic += 1
                else:
                    kept.append(line)
            code = "\n".join(kept).lstrip("\n")
            path = os.path.join(args.out, t["label"] + ".c")
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"/* {t['name']} */\n/* address: 0x{t['address']:X}"
                        f"  span: 0x{t['span']:X} */\n/* status: {status} */\n"
                        f"/* decompiler notes suppressed: {dropped}"
                        f" ({pic} call->branch) */\n\n{code}")
            results.append((t["label"], status, len(code), path))
            print(f"  {t['label']:48} {status:12} {len(code):>7} chars"
                  f"  ({dropped} notes hidden, {pic} call->branch, {tails} tail-call)")

        program.endTransaction(outer_tx, True)
        decomp.dispose()

    ok = sum(1 for r in results if r[1] == "ok")
    print(f"\ndecompiled ok={ok} failed={len(results) - ok} -> {args.out}")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
