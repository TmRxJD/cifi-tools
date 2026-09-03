"""Export every method in dump.cs as a function definition list for Ghidra.

WHY THIS EXISTS. Ghidra's auto-analysis spends hours on a 78MB libil2cpp.so guessing where
functions start and whether they return -- and it guesses, because the binary is stripped. We do
not have to guess: dump.cs states every method's RVA outright, and sorting them gives each one's
end for free. This turns "hours of inference" into "read a table".

Getting that table INTO Ghidra up front is also the root fix for the decompiler's runaway output.
Ghidra's `Funcdata::startProcessing` follows flow across the entire address space, and
`FlowInfo::checkContainedCall` rewrites a CALL into a BRANCH -- inlining the callee -- when the
callee is not a known function and its entry has already been visited. Declaring every function
before decompiling anything removes both halves of that condition globally, instead of patching it
per target as an earlier version of decompile.py tried to do.

The `returns` column matters as much as the addresses. IL2CPP getters END with a call to a
throw/abort helper that never returns (0x1AFA69F here: no RET at all, just PLT jumps). If Ghidra
believes that returns, flow falls through past the end of every function into the next one and
cascades. Classified from the bytes: an unconditional JMP at the entry is a PLT thunk (returns via
its target); otherwise a reachable RET means it returns; no RET means it does not.

    python tools/il2cpp-cli/export-functions.py            # -> <scratch>/functions.tsv

Output is TSV so the Ghidra-side Java script can parse it without a JSON dependency:

    <rva-hex>\t<end-hex>\t<returns 1|0>\t<name>
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dumpindex import DumpIndex                                       # noqa: E402
from analyze import Elf                                               # noqa: E402

GAMEFILES = os.path.join(HERE, "..", "gamefiles", "apk-0.7.3.54")
DEFAULT_SO = os.path.join(GAMEFILES, "extracted", "libil2cpp.so")
SCRATCH = os.environ.get("HUNTERSIM_SCRATCH") or (
    r"B:\huntersim-re" if os.path.isdir("B:\\") else os.path.join(GAMEFILES, "scratch"))
DEFAULT_OUT = os.path.join(SCRATCH, "functions.tsv")

# Cap on how far to scan for a RET. Real IL2CPP methods are far smaller; a runaway scan here would
# cost more than the whole export.
RET_SCAN_LIMIT = 0x800


def classify(elf, rva, limit, end):
    """Does this function return?

    BIASED TOWARD "YES", deliberately, because the two errors are not symmetric. A function wrongly
    marked non-returning makes the decompiler discard everything after each call to it -- silently
    wrong output, the worst outcome. A function wrongly marked returning can at worst let flow fall
    through into the next function, which shows up as visible noise.

    A first cut here used "no RET anywhere" and classified 38% of the binary as non-returning. That
    was wrong: IL2CPP methods routinely END IN A TAIL-CALL JMP, which returns perfectly well via
    its target. Only a function with neither a RET nor an outbound jump genuinely cannot return --
    the throw/abort helpers (0x1AFA69F here is the canonical one: no RET, just PLT jumps into the
    exception machinery, and it is the last call in essentially every getter).
    """
    try:
        insns = elf.disasm_function(rva, rva + min(limit, RET_SCAN_LIMIT))
    except Exception:                                                  # noqa: BLE001
        return True          # unreadable: assume it returns, the safer error
    if not insns:
        return True
    if insns[0].mnemonic == "jmp":
        return True          # PLT thunk: returns via its target
    for i in insns:
        if i.mnemonic == "ret":
            return True
        # A tail call: unconditional jump leaving this function's own range.
        if i.mnemonic == "jmp" and i.op_str.startswith("0x"):
            target = int(i.op_str, 16)
            if not (rva <= target < end):
                return True
    return False


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    idx = DumpIndex()
    elf = Elf(DEFAULT_SO)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    entries = idx.entries
    written = nonreturning = 0
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        for i, (rva, _off, name, _sig) in enumerate(entries):
            end = entries[i + 1][0] if i + 1 < len(entries) else rva + 0x40
            span = max(end - rva, 1)
            if elf.va_to_off(rva) is None:
                continue      # not in a mapped segment; nothing to define
            returns = classify(elf, rva, span, end)
            if not returns:
                nonreturning += 1
            safe = name.replace("$$", "__").replace("\t", " ").replace(" ", "_")
            f.write(f"{rva:x}\t{end:x}\t{1 if returns else 0}\t{safe}\n")
            written += 1
    print(f"wrote {written} function(s) to {out_path} "
          f"({nonreturning} classified non-returning)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
