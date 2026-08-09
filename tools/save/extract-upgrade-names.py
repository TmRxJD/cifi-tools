"""Recover the save's positional-index -> upgrade-name mapping straight from the game's assets.

WHY
---
The save stores upgrades positionally: LM0Level..LM294Level (loop mods), RU0..110 (research),
Gadget0..29, CM1..26 and so on -- roughly 600 slots. Determining which index is which upgrade by
changing one thing in-game and diffing saves does not scale, and every mapping obtained that way
is a guess until a second save confirms it.

It does not have to be guesswork. The game ships the answer in its Unity scene: every tooltip
panel is a GameObject named `LM{n}-Tooltip` / `RU{n}-Tooltip` etc., and its child Text components
hold the display name and description. Resolving that hierarchy gives an exact, complete mapping
in one pass.

(The IL2CPP dump gives SaveData's field names and class structure but NOT display names --
verified: "Trample" and "Scavengers Advantage" do not appear in stringliteral.json. They are
asset data, not code literals.)

TYPE TREES
----------
This is an IL2CPP build, so serialized files carry no type trees for MonoBehaviour (measured:
399 of 400 reads fail without help), and every UI text component -- legacy `Text` and
`TextMeshProUGUI` alike -- is a MonoBehaviour. UnityPy's TypeTreeGenerator reconstructs the
missing trees from the DummyDll folder that Il2CppDumper already produced, which is why
`--dummy-dll` is required rather than optional.

USAGE
-----
    python tools/save/extract-upgrade-names.py <assets-dir> \
        --dummy-dll <il2cpp-dump-out/DummyDll> [-o out.json]

`assets-dir` is an extracted `assets/bin/Data` from the APK. Unity splits large serialized files
into `name.split0..N`; those are concatenated back together automatically.

Output JSON: { "LM": { "0": {"title": ..., "desc": ...}, ... }, "RU": {...}, ... }

STATUS -- READ THIS BEFORE TRUSTING OUTPUT
------------------------------------------
WORKING:
  * Split-file rejoining, scene loading (90,298 GameObjects in level0).
  * Locating the indexed tooltip objects: 327 found, e.g. LM0-Tooltip .. LM294-Tooltip,
    covering the whole LM range the save uses. The index really is in the GameObject name, so
    the mapping is recoverable without a single save diff.
  * GameObject and RectTransform typetrees (built in, no generator needed), so the parent/child
    hierarchy resolves fine.

NOT WORKING YET -- the last mile:
  Reading the Text components. They are MonoBehaviours, IL2CPP builds ship no MonoBehaviour type
  trees, and reconstructing them from Il2CppDumper's DummyDll produces trees whose field layout
  disagrees with the serialized bytes:
      ValueError: Expected to read 136 bytes, but only read 32 bytes   (x53654)
      ValueError: Expected to read 60 bytes, but only read 32 bytes    (x51206)
  The generator loads all 113 DLLs and resolves class names, so this is a layout-fidelity
  problem, not a wiring problem. Most likely causes, in the order worth trying:
    1. The DummyDll set is from a different build than these assets -- re-dump both from ONE apk.
    2. Il2CppDumper's stub DLLs lack field information the generator needs; regenerate the
       assemblies with Cpp2IL, which reconstructs fields more faithfully, and point --dummy-dll
       at those instead.
    3. Sidestep type trees entirely: AssetRipper (.NET, and dotnet 10 is already installed here)
       exports the scene to a Unity project with readable .prefab/.unity YAML, at which point
       the tooltip title/description are plain text next to their GameObject name.
  Option 3 is the most certain and needs no type-tree fidelity at all.

Until that is resolved this script reports what it found and what failed -- it does NOT emit a
partial or guessed mapping.
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from collections import defaultdict

try:
    import UnityPy
except ImportError:
    sys.exit("UnityPy is required:  python -m pip install UnityPy")

# GameObjects whose name encodes a save index, e.g. "LM90-Tooltip" -> family LM, index 90.
# Names like "LM12-3-Tooltip" carry a sub-index (a tier/variant); those are kept separately
# rather than silently collapsed onto LM12, because guessing which one owns the save slot is
# exactly the kind of assumption this tool exists to avoid.
INDEXED_NAME = re.compile(r'^(?P<family>[A-Za-z]+?)(?P<index>\d+)(?P<sub>-\d+)?-Tooltip$')

TEXT_CLASSES = {'Text', 'TextMeshPro', 'TextMeshProUGUI'}

# Set once the type-tree generator is ready; read_tree() consults it for MonoBehaviours.
GENERATOR = None
UNITY_VERSION = None


def build_generator(dummy_dll_dir, unity_version):
    """Reconstruct MonoBehaviour type trees from Il2CppDumper's DummyDll output."""
    from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
    gen = TypeTreeGenerator(unity_version)
    # load_local_dll_folder, NOT load_local_game: the latter expects a desktop game root
    # containing a `*_Data` directory, which an APK extraction does not have.
    gen.load_local_dll_folder(dummy_dll_dir)
    return gen


def join_split_files(src_dir, work_dir):
    """Unity writes big serialized files as name.split0..N. Rejoin them, copy the rest."""
    splits = defaultdict(list)
    plain = []
    for entry in os.listdir(src_dir):
        m = re.match(r'^(.*)\.split(\d+)$', entry)
        if m:
            splits[m.group(1)].append((int(m.group(2)), entry))
        else:
            plain.append(entry)

    out = []
    for base, parts in splits.items():
        parts.sort()
        dest = os.path.join(work_dir, base)
        with open(dest, 'wb') as fh:
            for _, name in parts:
                with open(os.path.join(src_dir, name), 'rb') as chunk:
                    shutil.copyfileobj(chunk, fh)
        out.append(dest)
    for name in plain:
        src = os.path.join(src_dir, name)
        if os.path.isfile(src):
            dest = os.path.join(work_dir, name)
            shutil.copyfile(src, dest)
            out.append(dest)
    return out


READ_ERRORS = defaultdict(int)


def read_tree(obj):
    """Read an object's typetree, falling back to a generated one for MonoBehaviours.

    Failures are COUNTED, not swallowed. Silently returning None here is how an earlier version
    reported "0 texts" while the real problem was an unrelated missing-file error on every single
    object -- a diagnostic dead end. READ_ERRORS is printed at the end of a run.
    """
    try:
        return obj.read_typetree()
    except Exception:
        pass
    if GENERATOR is None or obj.type.name != 'MonoBehaviour':
        return None
    try:
        # The MonoScript reference names the concrete class; the generator supplies its tree.
        script = obj.read(check_read=False).m_Script.read()
        # get_nodes takes (assembly, fullname) -- namespace and class joined, not passed apart.
        fullname = f'{script.m_Namespace}.{script.m_ClassName}' if script.m_Namespace else script.m_ClassName
        # get_nodes_up returns a UnityPy TypeTreeNode; get_nodes returns raw API nodes that
        # read_typetree cannot consume ("'TypeTreeNode' object has no attribute 'm_Children'").
        nodes = GENERATOR.get_nodes_up(script.m_AssemblyName, fullname)
        return obj.read_typetree(nodes)
    except Exception as err:
        READ_ERRORS[f'{type(err).__name__}: {str(err)[:90]}'] += 1
        return None


def collect(env):
    """Index every GameObject, Transform and text-bearing component by path_id, per file."""
    game_objects, transforms, texts = {}, {}, {}
    for obj in env.objects:
        key = (obj.assets_file.name, obj.path_id)
        name = obj.type.name
        if name == 'GameObject':
            tree = read_tree(obj)
            if tree:
                game_objects[key] = tree
        elif name in ('Transform', 'RectTransform'):
            tree = read_tree(obj)
            if tree:
                transforms[key] = tree
        elif name == 'MonoBehaviour' or name in TEXT_CLASSES:
            # Identify text components by SHAPE, not by class name: anything carrying an m_Text
            # string qualifies. Legacy UI.Text, TextMeshProUGUI and any wrapper the game uses all
            # serialize a MonoBehaviour, so matching on class name alone silently found nothing.
            tree = read_tree(obj)
            if tree and isinstance(tree, dict) and isinstance(tree.get('m_Text'), str):
                texts[key] = tree
    return game_objects, transforms, texts


def transform_of(go_tree, file_name, transforms):
    for comp in go_tree.get('m_Component', []):
        ref = comp.get('component') if isinstance(comp, dict) else None
        if ref is None and isinstance(comp, dict):
            ref = comp
        pid = (ref or {}).get('m_PathID')
        if pid is None:
            continue
        key = (file_name, pid)
        if key in transforms:
            return transforms[key], key
    return None, None


def texts_under(go_key, game_objects, transforms, texts, depth=0):
    """Every Text value in this GameObject's subtree, in hierarchy order."""
    if depth > 6:
        return []
    file_name, _ = go_key
    go = game_objects.get(go_key)
    if not go:
        return []

    found = []
    for comp in go.get('m_Component', []):
        ref = comp.get('component') if isinstance(comp, dict) else None
        if ref is None and isinstance(comp, dict):
            ref = comp
        pid = (ref or {}).get('m_PathID')
        tkey = (file_name, pid)
        if tkey in texts:
            value = texts[tkey].get('m_Text')
            if value:
                found.append(value)

    tr, _ = transform_of(go, file_name, transforms)
    if tr:
        for child in tr.get('m_Children', []):
            ckey = (file_name, child.get('m_PathID'))
            ctr = transforms.get(ckey)
            if not ctr:
                continue
            cgo = ctr.get('m_GameObject', {}).get('m_PathID')
            found.extend(texts_under((file_name, cgo), game_objects, transforms, texts, depth + 1))
    return found


def main():
    global GENERATOR, UNITY_VERSION
    ap = argparse.ArgumentParser()
    ap.add_argument('assets_dir')
    ap.add_argument('--dummy-dll', required=True, help="Il2CppDumper's DummyDll directory")
    ap.add_argument('--unity-version', default='6000.3.8f1')
    ap.add_argument('--only', default=None, help='only load files whose name starts with this')
    ap.add_argument('-o', '--out', default='tools/save/upgrade-names.json')
    args = ap.parse_args()

    UNITY_VERSION = args.unity_version
    print(f'building type trees from {args.dummy_dll} (Unity {UNITY_VERSION}) ...', flush=True)
    GENERATOR = build_generator(args.dummy_dll, UNITY_VERSION)

    work = tempfile.mkdtemp(prefix='cifi-assets-')
    try:
        print(f'joining split files into {work} ...', flush=True)
        files = join_split_files(args.assets_dir, work)
        if args.only:
            files = [f for f in files if os.path.basename(f).startswith(args.only)]
        print(f'{len(files)} asset file(s); loading with UnityPy ...', flush=True)

        env = UnityPy.load(*files)
        game_objects, transforms, texts = collect(env)
        print(f'{len(game_objects)} GameObjects, {len(transforms)} transforms, {len(texts)} texts', flush=True)

        result = defaultdict(dict)
        unresolved = []
        for key, go in game_objects.items():
            name = go.get('m_Name') or ''
            m = INDEXED_NAME.match(name)
            if not m:
                continue
            values = [v.strip() for v in texts_under(key, game_objects, transforms, texts) if v and v.strip()]
            slot = m.group('index') + (m.group('sub') or '')
            if not values:
                unresolved.append(name)
                continue
            # The tooltip's first text is its title; the longest is the description. Both are
            # recorded verbatim -- no cleanup, so a human can see exactly what the game says.
            result[m.group('family')][slot] = {
                'title': values[0],
                'desc': max(values, key=len),
                'all': values,
            }

        os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as fh:
            json.dump(result, fh, indent=2, ensure_ascii=False, sort_keys=True)

        print(f'\nwrote {args.out}')
        for family in sorted(result):
            print(f'  {family:<10} {len(result[family])} indices resolved')
        if unresolved:
            print(f'  ({len(unresolved)} tooltip objects had no text under them, e.g. {unresolved[:5]})')
        if READ_ERRORS:
            total = sum(READ_ERRORS.values())
            print(f'\n{total} typetree read failure(s):')
            for msg, n in sorted(READ_ERRORS.items(), key=lambda kv: -kv[1])[:5]:
                print(f'  {n:>7}  {msg}')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
