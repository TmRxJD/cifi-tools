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
    python tools/il2cpp-cli/typetree.py --dump Gear --out tools/reference/gear-fields.json

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
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GAMEFILES = os.path.join(HERE, "..", "gamefiles", "apk-0.7.3.54")
DUMMY_DIR = os.path.join(GAMEFILES, "il2cpp-dump", "DummyDll")
ASSET_DIR = os.path.join(GAMEFILES, "assets")
UNITY_VERSION = "6000.3.8f1"
# level0 is the scene and holds the manager MonoBehaviours; the others are checked as a fallback.
ASSET_FILES = ("level0", "sharedassets0.assets", "globalgamemanagers.assets")


class Extractor:
    def __init__(self, unity_version=UNITY_VERSION, backend="AssetsTools", dummy_dir=DUMMY_DIR):
        from TypeTreeGeneratorAPI import TypeTreeGenerator
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
            self._nodes[short_name] = json.loads(self.gen.get_nodes_as_json(asm, full))
        return self._nodes[short_name]

    def read_instances(self, short_name, asset_files=ASSET_FILES):
        """Every serialized instance of `short_name`, as {field: value} dicts."""
        import UnityPy
        nodes = self.nodes_for(short_name)
        out = []
        for asset in asset_files:
            path = os.path.join(ASSET_DIR, asset)
            if not os.path.exists(path):
                continue
            env = UnityPy.load(path)
            for obj in env.objects:
                if obj.type.name != "MonoBehaviour":
                    continue
                try:
                    base = obj.read(check_read=False)
                    script = base.m_Script.read() if getattr(base, "m_Script", None) else None
                    if getattr(script, "m_ClassName", None) != short_name:
                        continue
                except Exception:                                      # noqa: BLE001
                    continue
                try:
                    out.append(obj.read_typetree(nodes))
                except Exception as exc:                               # noqa: BLE001
                    # Loud: a partial read here silently produces wrong NUMBERS, which is the
                    # exact failure mode this whole module exists to eliminate.
                    print(f"  WARNING {short_name} in {asset}: read_typetree failed "
                          f"({type(exc).__name__}: {exc})", file=sys.stderr)
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

    instances = ex.read_instances(args.dump)
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
