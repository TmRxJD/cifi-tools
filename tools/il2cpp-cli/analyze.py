"""Reusable helpers for going from a method NAME to real disassembled x86_64 code, built from
the pieces this project's Meltdown investigation (2026-09) had to derive from scratch. Nothing
here is a general disassembler framework -- it is the minimum needed to answer "does function A
call/reference function B or field offset N" without re-deriving ELF parsing and script.json
streaming every time that question comes up again.

Prerequisites (see this directory's README.md for the one-time CLI patch that adds script.json --
`Il2CppDumpCli` alone, unpatched, only writes dump.cs + DummyDll, which have no addresses at all):
  1. Run tools/il2cpp-cli's Il2CppDumpCli against libil2cpp.so + global-metadata.dat with the
     StructGenerator.WriteScript(outputDir) call added to Program.cs (patch below).
  2. That produces script.json in the output dir: one entry per method, {"Address": <RVA>,
     "Name": "TypeName$$MethodName", ...}. It is large (over 1 GB for CIFI) -- this module streams
     it rather than loading it whole.

Architecture note: CIFI's libil2cpp.so under tools/gamefiles/apk-<ver>/extracted/ is x86_64, not
ARM64 -- it is built for the Android emulator's ABI (split_config.x86_64.apk), not a real device.
Disassemble with capstone.CS_ARCH_X86 / CS_MODE_64, not ARM64 -- using the wrong architecture
does not error, it silently produces garbage instructions (this cost real time once already).

Usage (see the bottom of this file for the exact commands used to resolve the Meltdown scope
question, as a worked example):

    from analyze import Elf, ScriptIndex

    elf = Elf(r"...\libil2cpp.so")
    idx = ScriptIndex(r"...\script.json")            # lazy; only scans what you ask it to resolve

    rva = idx.rva_of("GeneratorManager$$get_MK1Production")
    insns = elf.disasm_function(rva, next_rva=idx.rva_of("GeneratorManager$$get_MK2Production"))
    calls = [i for i in insns if i.mnemonic == 'call' and i.op_str.startswith('0x')]
    field_reads = [i for i in insns if references_offset(i, 0x378)]

Patch to tools/il2cpp-cli's own Program.cs (adds script.json; ~3 lines):
    Cli.csproj: add
        <Compile Include="../dumpersrc/Il2CppDumper/Outputs/StructGenerator.cs" />
        <Compile Include="../dumpersrc/Il2CppDumper/Outputs/StructInfo.cs" />
        <Compile Include="../dumpersrc/Il2CppDumper/Outputs/HeaderConstants.cs" />
    Program.cs: after the DummyDll export block, add
        new StructGenerator(executor).WriteScript(outputDir);
"""

import re
import struct

try:
    import capstone
except ImportError:
    capstone = None  # only needed for disasm_function; ScriptIndex/Elf.va_to_off work without it


class Elf:
    """Minimal ELF64 PT_LOAD segment mapper (VA -> file offset) plus an x86_64 disassemble helper.
    Only what's needed to read code out of an Android x86_64 libil2cpp.so -- not a general ELF
    parser (no section headers, no relocations, no dynamic symbol table)."""

    def __init__(self, path):
        self.data = open(path, 'rb').read()
        d = self.data
        e_phoff = struct.unpack_from('<Q', d, 0x20)[0]
        e_phentsize = struct.unpack_from('<H', d, 0x36)[0]
        e_phnum = struct.unpack_from('<H', d, 0x38)[0]
        self.e_machine = struct.unpack_from('<H', d, 0x12)[0]  # 0x3E = EM_X86_64, 0xB7 = EM_AARCH64
        self.segments = []  # (vaddr, file_offset, filesz)
        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            p_type, _flags, p_offset, p_vaddr, _paddr, p_filesz, _memsz, _align = \
                struct.unpack_from('<IIQQQQQQ', d, off)
            if p_type == 1:  # PT_LOAD
                self.segments.append((p_vaddr, p_offset, p_filesz))
        self._md = None

    def va_to_off(self, va):
        for vaddr, offset, filesz in self.segments:
            if vaddr <= va < vaddr + filesz:
                return offset + (va - vaddr)
        return None

    def _capstone(self):
        if self._md is None:
            if capstone is None:
                raise RuntimeError("capstone not installed (pip install capstone)")
            if self.e_machine != 0x3E:
                raise RuntimeError(
                    f"e_machine is 0x{self.e_machine:x}, not EM_X86_64 (0x3e) -- this helper "
                    "assumes an x86_64 build. Check the binary before disassembling.")
            self._md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
            self._md.detail = True
        return self._md

    def disasm_function(self, rva, next_rva=None, max_bytes=20000):
        """Disassemble from `rva` up to `next_rva` (exclusive) -- or `max_bytes` if the next
        function's start isn't known. Passing next_rva (the next method's own RVA, from
        ScriptIndex) is far more reliable than guessing a byte length or stopping at the first
        `ret`, since a real function can have multiple ret sites across branches."""
        off = self.va_to_off(rva)
        if off is None:
            raise ValueError(f"RVA 0x{rva:x} is not in any PT_LOAD segment")
        size = (next_rva - rva) if next_rva else max_bytes
        code = self.data[off:off + size]
        return list(self._capstone().disasm(code, rva))


def references_offset(insn, disp):
    """True if a capstone x86 instruction has a memory operand at exactly displacement `disp`
    (e.g. `qword ptr [rax + 0x378]`). Needs `md.detail = True` (Elf._capstone sets this)."""
    if not getattr(insn, 'operands', None):
        return False
    for op in insn.operands:
        if op.type == capstone.x86.X86_OP_MEM and op.mem.disp == disp:
            return True
    return False


class ScriptIndex:
    """Streams script.json (too large to load whole -- 1+ GB for CIFI) to resolve method
    Name <-> Address. Every lookup re-scans from the start; this is a debugging/investigation
    tool for a handful of lookups per session, not a hot path. For many lookups in one run, use
    resolve_many()/rvas_of_many() to do it in a single pass instead of one scan per name."""

    def __init__(self, path):
        self.path = path

    def rvas_of_many(self, names):
        """{name: rva} for every name found, in one streaming pass."""
        wanted = set(names)
        found = {}
        buf_addr = None
        with open(self.path, 'r', encoding='utf-8') as f:
            for line in f:
                m = re.search(r'"Address":\s*(\d+)', line)
                if m:
                    buf_addr = int(m.group(1))
                    continue
                m2 = re.search(r'"Name":\s*"([^"]+)"', line)
                if m2 and m2.group(1) in wanted and m2.group(1) not in found:
                    found[m2.group(1)] = buf_addr
                    buf_addr = None
                    if len(found) == len(wanted):
                        break
        return found

    def rva_of(self, name):
        return self.rvas_of_many([name]).get(name)

    def names_of_many(self, rvas):
        """{rva: name} for every address found, in one streaming pass -- the reverse lookup,
        for turning a disassembly's call targets back into readable method names."""
        wanted = set(rvas)
        found = {}
        buf_addr = None
        with open(self.path, 'r', encoding='utf-8') as f:
            for line in f:
                m = re.search(r'"Address":\s*(\d+)', line)
                if m:
                    buf_addr = int(m.group(1))
                    continue
                m2 = re.search(r'"Name":\s*"([^"]+)"', line)
                if m2 and buf_addr in wanted and buf_addr not in found:
                    found[buf_addr] = m2.group(1)
                    buf_addr = None
                    if len(found) == len(wanted):
                        break
        return found


def call_targets(insns):
    """Every `call 0x...` target in a disassembled instruction list, in order."""
    return [int(i.op_str, 16) for i in insns if i.mnemonic == 'call' and i.op_str.startswith('0x')]


# --- Worked example: how the Meltdown-scope question was actually resolved (2026-09-02) -------
#
#   elf = Elf(r"tools/gamefiles/apk-0.7.3.54/extracted/libil2cpp.so")
#   idx = ScriptIndex(r"<il2cppdumper output dir>/script.json")
#   names = [f"GeneratorManager$$get_MK{n}Production" for n in range(1, 13)]
#   rvas = idx.rvas_of_many(names)
#   ordered = sorted(rvas.items(), key=lambda kv: kv[1])
#   for i, (name, rva) in enumerate(ordered):
#       next_rva = ordered[i + 1][1] if i + 1 < len(ordered) else None
#       insns = elf.disasm_function(rva, next_rva)
#       hits = [i for i in insns if references_offset(i, 0x378)]  # OuroborosResetter.FinalMeltdownPower
#       print(name, len(hits))
#
# Result: every MK1..MK11 getter had exactly one hit, in the identical surrounding shape (load
# own production -> load the Meltdown field -> BigDouble.Pow) -- proving Meltdown applies to
# every generator tier, not just MK1. See shipsPage.js's own Meltdown comment for the fix this
# produced, and git log for the exact commit.
#
# --- Second worked example: relic bonus formula shapes (2026-09-02) ----------------------------
#
# OuroRelics.get_FinalRelic{4,16,17}Bonus are all the identical tiny shape: read the relic's own
# per-level coefficient from a field on `this` (a runtime config value, invisible from static
# disassembly -- this confirms the FORMULA, not the number), read the relic's LEVEL via a call,
# then `1.0 + level * coefficient`, done. This matches the simple linear-per-level bonus shape
# hunterDefs.js already assumes for these relics (never verified against game code before this).
#
# get_FinalRelic7Bonus and get_FinalRelic19Bonus are structurally different (multiple field
# chases, an extra multiplication) -- consistent with, and does not contradict, this project's
# separately-confirmed finding (tools/bench/relic-arg-probe.js / relic-sweep.js) that r7 and r19
# reach the hunter-sim wasm but change nothing there: this ship-side getter almost certainly
# computes a DIFFERENT effect (their real "Loot xN" bonus) via a different code path than
# whatever hunter-sim param was probed inert.
#
# Not pursued further: the actual per-level coefficients (the field values themselves) require
# reading a live save or a ScriptableObject config table, not code -- disassembly only confirms
# shape here, same limit as the r5/r6 cap-raise investigation above.
