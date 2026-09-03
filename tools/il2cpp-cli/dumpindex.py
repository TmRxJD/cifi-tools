"""Name -> RVA index built straight from `dump.cs`, replacing script.json entirely.

WHY THIS EXISTS. analyze.py's ScriptIndex streams `script.json`, which Il2CppDumper only writes
if you patch its CLI (see README), and which is over 1 GB for CIFI. That is a lot of machinery for
something `dump.cs` already contains: Il2CppDumper writes an `// RVA: 0x... Offset: 0x... VA: 0x...`
comment directly above every method it emits. Parsing those is ~100 lines, needs no patched
dumper, no gigabyte file, and gives the same answer. Prefer this over ScriptIndex.

For CIFI the RVA and the VA in those comments are equal, i.e. the image base is 0 -- which is also
what Ghidra must be told to use, or every address here lands in the wrong place (see decompile.py).

Sorting by address additionally gives function BOUNDS for free: a method body runs until the next
method's RVA. Il2CppDumper emits methods grouped by class, NOT in address order, so you cannot get
this by reading the file top to bottom -- `get_CellProductionTotalMult` sits between
`get_MK1Production` and `get_MK2Production` in the binary while appearing after both in the dump.
Guessing a byte length instead is how you end up disassembling into the next function.

Usage:
    from dumpindex import DumpIndex
    idx = DumpIndex()                                  # default CIFI dump, cached
    rva, end = idx.bounds("GeneratorManager$$get_MK1Production")
    idx.find("GeneratorManager..get_MK")               # regex over qualified names
    idx.name_at(0x1D72BD9)                             # which method contains this address

CLI:
    python dumpindex.py                                # index + report size
    python dumpindex.py 'FleetManager..get_RUGen'      # search
"""

import bisect
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DUMP = os.path.join(
    HERE, "..", "gamefiles", "apk-0.7.3.54", "il2cpp-dump", "dump.cs")

_RVA_RE = re.compile(r'^\s*// RVA: 0x([0-9A-Fa-f]+) Offset: 0x([0-9A-Fa-f]+)')
# Type declarations sit at column 0; members are indented. That indentation is the only reliable
# way to tell "new class" from "a method of the current class" without parsing C# for real.
_TYPE_RE = re.compile(
    r'^(?:public |private |internal |protected |sealed |abstract |static |readonly )*'
    r'(?:class|struct|interface|enum)\s+([A-Za-z0-9_.<>`]+)')
_MEMBER_RE = re.compile(r'([A-Za-z0-9_.<>`]+)\s*\(')


class DumpIndex:
    def __init__(self, dump_path=None, cache_path=None):
        self.dump_path = os.path.abspath(dump_path or DEFAULT_DUMP)
        self.cache_path = cache_path or (self.dump_path + ".rvaindex.json")
        self.entries = self._load()
        self._rvas = [e[0] for e in self.entries]
        self._by_name = {}
        for e in self.entries:
            self._by_name.setdefault(e[2], e)   # first wins; overloads share a name

    # -- building -------------------------------------------------------------------------
    def _build(self):
        entries = []
        current_type = "?"
        pending = None
        with open(self.dump_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line and line[0] not in " \t":
                    m = _TYPE_RE.match(line)
                    if m:
                        current_type = m.group(1)
                        pending = None
                        continue
                m = _RVA_RE.match(line)
                if m:
                    pending = (int(m.group(1), 16), int(m.group(2), 16))
                    continue
                if pending is not None:
                    sig = line.strip()
                    if sig:
                        mm = _MEMBER_RE.search(sig)
                        name = mm.group(1) if mm else sig
                        entries.append([pending[0], pending[1],
                                        f"{current_type}$${name}", sig])
                        pending = None
        entries.sort(key=lambda e: e[0])
        return entries

    def _load(self):
        if os.path.exists(self.cache_path) and \
                os.path.getmtime(self.cache_path) >= os.path.getmtime(self.dump_path):
            with open(self.cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        entries = self._build()
        try:
            with open(self.cache_path, "w", encoding="utf-8") as f:
                json.dump(entries, f)
        except OSError:
            pass   # a read-only checkout is fine, just slower
        return entries

    # -- querying -------------------------------------------------------------------------
    def bounds(self, name):
        """(rva, end_rva) for `name`. end_rva is the NEXT method's start -- the real body end."""
        e = self._by_name.get(name)
        if e is None:
            raise KeyError(f"{name!r} not in {os.path.basename(self.dump_path)}. "
                           f"Try index.find(...) with a regex.")
        i = bisect.bisect_right(self._rvas, e[0])
        return e[0], (self._rvas[i] if i < len(self._rvas) else None)

    def rva_of(self, name):
        return self.bounds(name)[0]

    def signature(self, name):
        return self._by_name[name][3]

    def find(self, pattern):
        r = re.compile(pattern, re.I)
        return [e for e in self.entries if r.search(e[2])]

    def name_at(self, addr):
        """The method whose body contains `addr` -- for turning a call target back into a name."""
        i = bisect.bisect_right(self._rvas, addr) - 1
        return self.entries[i] if i >= 0 else None

    def __len__(self):
        return len(self.entries)


if __name__ == "__main__":
    idx = DumpIndex()
    print(f"{len(idx)} methods indexed from {idx.dump_path}")
    if len(sys.argv) > 1:
        hits = idx.find(sys.argv[1])
        for rva, _off, name, sig in hits[:80]:
            print(f"0x{rva:X}  {name}\n           {sig}")
        if len(hits) > 80:
            print(f"... and {len(hits) - 80} more")
