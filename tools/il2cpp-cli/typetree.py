"""Read AUTHORED MonoBehaviour data out of an IL2CPP build, by reconstructing Unity's type trees.

THE ROOT CAUSE THIS FIXES. IL2CPP strips Unity's type trees from the build. Serialized MonoBehaviour
data therefore looks like opaque bytes, and every tool that wants a designer-authored number is
pushed toward guessing: hand-rolled byte-offset scans, or disassembling/emulating code to recover a
value that was never computed in the first place. This project did exactly that for months --
`analyze.py` and `decompile.py` exist because of it, and the wiki was the only source for numbers
like "+0.5% MK1 per manual MK2 generator".

Reconstruct the type trees and the data reads back as plain named fields:

    FleetManager.RU2GenBaseBonus = 0.05000000074505806

Disassembly is still the right tool for FORMULA SHAPE ("where does the Meltdown Pow sit", "are
these bonuses summed or multiplied"). It is the wrong tool for VALUES. Use this for values.

    python tools/il2cpp-cli/typetree.py --list                     # classes with serialized data
    python tools/il2cpp-cli/typetree.py --dump FleetManager        # all its fields, as JSON
    python tools/il2cpp-cli/typetree.py --dump FleetManager --grep GenBaseBonus
    python tools/il2cpp-cli/typetree.py --dump Gear --backend AssetStudio --relaxed

BACKENDS DIFFER, and it matters. `Gear`'s reconstructed tree does not quite match the build's
layout. The default AssetsTools backend fails MID-read ("read_double out of bounds"), which nothing
can rescue; AssetStudio reads every field and only trips the trailing total (5984 of 6132 bytes),
so `--backend AssetStudio --relaxed` gets the values out. If a class refuses to read, try the other
backend before concluding the data is unreachable.

HOW IT WORKS, and the one thing that does not.

TypeTreeGeneratorAPI (already a dependency of UnityPy) exposes two inputs:
  * `load_il2cpp(so_bytes, metadata_bytes)` -- the direct route, no DummyDlls needed. **It does not
    work on this build.** CIFI's global-metadata.dat is version 39, and the LibCpp2IL bundled in
    TypeTreeGeneratorAPI 0.0.10 fails with "Fatal Exception initializing LibCpp2IL!" on it. Same
    version wall that forced this project off Perfare's Il2CppDumper and onto AndnixSH's fork.
    Re-test it after upgrading the package; if it starts working, prefer it -- it removes the
    dependency on having dumped DummyDlls.
  * `load_dll(dll_bytes)` -- what this module uses. The DummyDlls under il2cpp-dump/DummyDll/ carry
    exactly the field layout the generator needs, and they came from a dumper that DOES read v39.

The generated nodes go to UnityPy's `ObjectReader.read_typetree(nodes)`, which accepts a plain
list of dicts as long as each has m_Level/m_Type/m_Name -- which is what `get_nodes_as_json`
returns, so no conversion is needed.
"""

import argparse
import re
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Which pulled build to read. Everything here -- DummyDlls, dump.cs and the scene -- must come
# from the SAME build, so one variable switches all of them together; mixing a newer scene with an
# older DummyDll silently misreads fields.
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")
GAMEFILES = os.path.join(HERE, "..", "gamefiles", APK_DIR)
DUMMY_DIR = os.path.join(GAMEFILES, "il2cpp-dump", "DummyDll")
ASSET_DIR = os.path.join(GAMEFILES, "assets")
UNITY_VERSION = "6000.3.8f1"
# level0 is the scene and holds the manager MonoBehaviours; the others are checked as a fallback.
ASSET_FILES = ("level0", "sharedassets0.assets", "globalgamemanagers.assets")


_DUMP = os.path.join(GAMEFILES, "il2cpp-dump", "dump.cs")
_TYPE_DECL = re.compile(r"^(?:public |private |internal |protected |sealed |abstract |static )*"
                        r"(class|struct|enum)\s+([A-Za-z0-9_.<>`]+)")
_FIELD_DECL = re.compile(
    r"^\s+(?:public|private|protected|internal)\s+(?!static\b)(?:readonly\s+)?"
    r"(.+?)\s+([\w<>`]+);\s*//\s*0x[0-9A-Fa-f]+\s*$")
_dump_cache = {}


def _dump_types():
    """(enum_names, {type: [(field_name, field_type), ...] in declaration order}) from dump.cs."""
    if _dump_cache:
        return _dump_cache["enums"], _dump_cache["fields"]
    enums, fields, current = set(), {}, None
    with open(_DUMP, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line and line[0] not in " \t":
                m = _TYPE_DECL.match(line)
                if m:
                    current = m.group(2)
                    if m.group(1) == "enum":
                        enums.add(current)
                    else:
                        fields.setdefault(current, [])
                continue
            if current is None or current not in fields:
                continue
            m = _FIELD_DECL.match(line.rstrip("\n"))
            if m:
                fields[current].append((m.group(2), m.group(1).strip()))
    _dump_cache["enums"], _dump_cache["fields"] = enums, fields
    return enums, fields


def patch_missing_enums(nodes):
    """Re-insert the ENUM-typed fields the generator drops.

    THE BUG THIS WORKS AROUND. TypeTreeGeneratorAPI omits enum-typed fields from the tree, but
    Unity serialises an enum as a plain int. Every omitted enum leaves the reader 4 bytes short,
    and from that point the object is garbage -- an array length gets read out of the middle of a
    PPtr and the reader runs off the end thousands of bytes later, which is why the symptom
    (`read___int64 out of bounds`) looks nothing like the cause.

    That single defect is what made `GemPerks` unreadable: `GemRequirement` is an enum and the
    class has 38 of them, plus Odin's `SerializationData.SerializedFormat` (enum `DataFormat`).

    dump.cs has both halves of what is needed -- which types are enums, and each class's fields in
    declaration order -- so the omissions can be put back exactly where they belong. The
    generator's ordering for the fields it DID emit matches dump order (verified for GemPerks: all
    840 of them), so aligning on that order is sound.

    Only enums are re-inserted. The other omissions are correct and must stay out: Unity genuinely
    cannot serialise `List<List<T>>` or `List<Dictionary<..>>`, and Odin-serialised fields live in
    the SerializationData blob rather than in Unity's field stream.
    """
    enums, dump_fields = _dump_types()
    if not nodes:
        return nodes

    def build(index, level):
        """Flat list -> [(node, children)] for everything at `level` starting at `index`."""
        out = []
        i = index
        while i < len(nodes) and nodes[i]["m_Level"] >= level:
            if nodes[i]["m_Level"] > level:
                break
            node = nodes[i]
            kids, i = build(i + 1, level + 1)
            out.append((node, kids))
        return out, i

    def build_at(i, level):
        kids = []
        while i < len(nodes) and nodes[i]["m_Level"] == level:
            node = nodes[i]
            sub, i = build_at(i + 1, level + 1)
            kids.append((node, sub))
        return kids, i

    def patch(node, kids):
        declared = dump_fields.get(node["m_Type"])
        if declared and kids:
            child_level = kids[0][0]["m_Level"]
            present = {c[0]["m_Name"] for c in kids}
            missing = [(n, t) for n, t in declared if n not in present and t in enums]
            if missing:
                by_name = {c[0]["m_Name"]: c for c in kids}
                rebuilt, used = [], set()
                for name, ftype in declared:
                    if name in by_name:
                        rebuilt.append(by_name[name]); used.add(name)
                    elif ftype in enums:
                        rebuilt.append(({"m_Level": child_level, "m_Type": "int",
                                         "m_Name": name, "m_MetaFlag": 0}, []))
                # Anything the generator emitted that dump.cs did not list (Unity's own base
                # fields: m_GameObject, m_Enabled, m_Script, m_Name, ...) keeps its position at
                # the front, where Unity writes it.
                extra = [c for c in kids if c[0]["m_Name"] not in used]
                kids = extra + rebuilt
        return [(node, [x for k in kids for x in patch(*k)])]

    roots, _ = build_at(0, nodes[0]["m_Level"])
    flat = []

    def emit(node, kids):
        flat.append(node)
        for k in kids:
            emit(*k)

    for node, kids in roots:
        for n, k in patch(node, kids):
            emit(n, k)
    return flat


class Extractor:
    def __init__(self, unity_version=UNITY_VERSION, backend="AssetsTools", dummy_dir=DUMMY_DIR):
        # UnityPy's own subclass over TypeTreeGeneratorAPI's: adds a node cache and
        # load_local_dll_folder. (Its get_nodes_up() only normalises the assembly name to end in
        # ".dll" -- it is NOT an inheritance walk, despite the name.)
        from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
        if not os.path.isdir(dummy_dir):
            raise SystemExit(f"DummyDll directory not found: {dummy_dir}\n"
                             "Run tools/il2cpp-cli's dumper first (see its README).")
        self.gen = TypeTreeGenerator(unity_version, backend)
        self.loaded, self.failed = 0, []
        for path in sorted(glob.glob(os.path.join(dummy_dir, "*.dll"))):
            try:
                self.gen.load_dll(open(path, "rb").read())
                self.loaded += 1
            except Exception as exc:                                   # noqa: BLE001
                self.failed.append((os.path.basename(path), str(exc)[:80]))
        if not self.loaded:
            raise SystemExit("no DummyDlls loaded -- cannot build type trees")
        # short class name -> (assembly, fully-qualified name)
        self.defs = {}
        for asm, full in self.gen.get_monobehaviour_definitions():
            self.defs.setdefault(full.split(".")[-1], (asm, full))
        self._nodes = {}

    def nodes_for(self, short_name):
        if short_name not in self.defs:
            raise KeyError(f"{short_name!r} is not a MonoBehaviour with serialized data. "
                           "Use --list to see what is available.")
        if short_name not in self._nodes:
            asm, full = self.defs[short_name]
            raw = json.loads(self.gen.get_nodes_as_json(asm, full))
            self._nodes[short_name] = patch_missing_enums(raw)
        return self._nodes[short_name]

    def read_instances(self, short_name, asset_files=ASSET_FILES, relaxed=False):
        """Every serialized instance of `short_name`, as {field: value} dicts.

        `relaxed` passes UnityPy's check_read=False, which skips the trailing "did the tree consume
        exactly the object's bytes" assertion. Needed for classes whose reconstructed tree does not
        quite match the build's layout -- `Gear` comes up 148 bytes short. Fields BEFORE the
        divergence still read correctly (verified: Gear's PPtrs and GearUnlockBaseCost/Exponent all
        come back sane, and GearBaseBonus1/2 read 1.01/1.02 exactly as the wiki claimed), but a
        field late in such a class is NOT trustworthy without a second source. Off by default.
        """
        import UnityPy
        nodes = self.nodes_for(short_name)
        out = []
        for asset in asset_files:
            path = os.path.join(ASSET_DIR, asset)
            if not os.path.exists(path):
                continue
            env = UnityPy.load(path)
            # level0 holds ~144k MonoBehaviours and most share a handful of MonoScripts, so
            # resolving the script per object dominated the runtime until this cache. Key on the
            # PPtr, not the object.
            script_names = {}
            for obj in env.objects:
                if obj.type.name != "MonoBehaviour":
                    continue
                try:
                    base = obj.read(check_read=False)
                    ptr = getattr(base, "m_Script", None)
                    if ptr is None:
                        continue
                    key = (ptr.m_FileID, ptr.m_PathID)
                    if key not in script_names:
                        script = ptr.read()
                        script_names[key] = getattr(script, "m_ClassName", None)
                    if script_names[key] != short_name:
                        continue
                except Exception:                                      # noqa: BLE001
                    continue
                try:
                    out.append(obj.read_typetree(nodes, check_read=not relaxed))
                except Exception as exc:                               # noqa: BLE001
                    # Loud: a partial read here silently produces wrong NUMBERS, which is the
                    # exact failure mode this whole module exists to eliminate.
                    print(f"  WARNING {short_name} in {asset}: read_typetree failed "
                          f"({type(exc).__name__}: {exc})"
                          + ("" if relaxed else "  -- retry with --relaxed if the fields you need "
                                                "are early in the class"), file=sys.stderr)
            if out:
                break
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="List classes that have serialized data")
    ap.add_argument("--dump", metavar="CLASS", help="Read every instance of CLASS")
    ap.add_argument("--grep", help="Only show fields whose name matches this substring")
    ap.add_argument("--out", help="Write the dump to this JSON file instead of stdout")
    ap.add_argument("--backend", default="AssetsTools", choices=("AssetsTools", "AssetStudio"))
    ap.add_argument("--unity", default=UNITY_VERSION)
    ap.add_argument("--relaxed", action="store_true",
                    help="Skip the trailing size assertion (see read_instances). Only fields "
                         "before the tree's divergence are trustworthy.")
    args = ap.parse_args()

    ex = Extractor(args.unity, args.backend)
    print(f"loaded {ex.loaded} DummyDll(s); {len(ex.defs)} classes with serialized data",
          file=sys.stderr)

    if args.list:
        for name in sorted(ex.defs):
            print(name)
        return 0

    if not args.dump:
        ap.error("give --list or --dump CLASS")

    instances = ex.read_instances(args.dump, relaxed=args.relaxed)
    if not instances:
        print(f"no readable instance of {args.dump} found", file=sys.stderr)
        return 1

    if args.grep:
        needle = args.grep.lower()
        instances = [{k: v for k, v in inst.items() if needle in k.lower()} for inst in instances]

    payload = instances[0] if len(instances) == 1 else instances
    text = json.dumps(payload, indent=2, default=str)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        n = len(payload) if isinstance(payload, dict) else sum(len(i) for i in payload)
        print(f"wrote {n} field(s) to {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
