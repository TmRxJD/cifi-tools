"""Extract the GAME'S OWN gear piece icons from the APK.

    CIFI_APK=apk-0.7.3.61 python tools/assets/extract-gear-icons.py [--write]

WHY. The Gear Sets page lists 27 pieces by name only. The game draws each with a distinctive icon,
which is how players actually recognise them.

HOW, AND WHY THE TWO OBVIOUS ROUTES DO NOT WORK:

  1. `Gear.GearIconImagePaths` is the field that names them, and the `Gear` MonoBehaviour CANNOT BE
     READ: its type tree fails with "read_int_array out of bounds" even with --relaxed. That is a
     known, separate defect already recorded in this repo (the class comes up short against its
     serialized layout), not something this script can fix.
  2. MATCHING SPRITE NAMES TO PIECE NAMES finds nothing -- zero of 37 match, under any
     normalisation. The icons are not named after the pieces.

  So the icons are located through the SCENE, at the same menu path the piece NAMES came from
  (see tools/bench/extract-gear-names.py). The exact node is:

      .../CraftingNewGearPiecePanel/ItemSelectionLayout/<index>/ReqBox/Icon

  and its sprite is named `t_31`, `t_32`, ... -- which is why no name search could ever have found
  them. UI components cannot be type-tree read here either, so the sprite reference is taken from
  the raw component bytes AT OFFSET 92, the Image component's m_Sprite slot (established on the
  ship evolution art and confirmed here).

  OFFSET 92 SPECIFICALLY, not "any 8 bytes that match a sprite id". Scanning the whole component
  produces false positives -- small path ids collide with real sprites, and every row appeared to
  reference `Icon_Vedio` and `RU-Zeus1-128`. A first version of this script took the LARGEST sprite
  found anywhere in the row and returned the same panel background (`Popup002_White_01`) for all 37
  pieces: 37 confident, identical, wrong answers.

  There is more than one `ItemSelectionLayout` in the scene. The first version matched an Academy
  MILESTONE list instead of the gear panel, so the full ancestor path is required, not the row
  name plus its parent.

THE ROW INDEX IS THE MAPPING, and it is already proven. gear-names.json records the crafting
menu's 37 rows in order, and that order is the one this project already verified: 22 ungated pieces
in colour blocks of 3/4/5/5/5 matching our own sizes and order, then 15 gem-gated rows (White,
Yellow, Black). So a row's index identifies its piece without needing the icon to be named.

Yellow and Black rows are extracted too but written under their own names -- the tool does not model
those sets (they have no install targets in this build), so nothing renders them yet. Getting the
art now costs nothing and means the sets are ready if a future build wires them.
"""
import argparse
import json
import os
import re
import struct
import sys

try:
    import UnityPy
except ImportError:
    sys.exit('UnityPy is required: python -m pip install UnityPy')

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APK = os.environ.get('CIFI_APK', 'apk-0.7.3.61')
ASSET_DIR = os.path.join(REPO, 'tools', 'gamefiles', APK, 'assets')
OUT_DIR = os.path.join(REPO, 'webapp', 'public', 'assets', 'gear')
NAMES = os.path.join(REPO, 'tools', 'reference', 'gear-names.json')
REF = os.path.join(REPO, 'tools', 'reference', 'gear-icons.json')

ROW = re.compile(r'^ItemSelectionLayout/(\d+)(?:-[A-Za-z]+-Q\d+)?$')


def slug(name):
    """A stable file name for a piece. Lower-case, non-alphanumerics collapsed to a dash.

    The UI keys gear pieces BY NAME, so the slug has to be derivable from the displayed name
    without a second lookup table -- the same rule shipsPage.js uses for portraits.
    """
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', name.lower())).strip('-')


def component_ids(go):
    """path ids of this GameObject's components."""
    out = []
    for entry in getattr(go, 'm_Component', []) or getattr(go, 'm_Components', []) or []:
        comp = entry.component if hasattr(entry, 'component') else (entry[1] if isinstance(entry, (list, tuple)) else entry)
        pid = getattr(comp, 'm_PathID', None)
        if pid:
            out.append(pid)
    return out


def transform_of(go, index):
    for pid in component_ids(go):
        obj = index.get(pid)
        if obj is None:
            continue
        try:
            c = obj.read()
        except Exception:
            continue
        if hasattr(c, 'm_Father') or hasattr(c, 'm_Children'):
            return c
    return None


def path_for(go, index, depth=8):
    parts, cur, n = [], go, 0
    while cur is not None and n < depth:
        parts.append(getattr(cur, 'm_Name', '?'))
        tr = transform_of(cur, index)
        father = getattr(tr, 'm_Father', None) if tr is not None else None
        try:
            ftr = father.read() if father is not None else None
            cur = ftr.m_GameObject.read() if ftr is not None else None
        except Exception:
            break
        n += 1
    return '/'.join(reversed(parts))


def descendants(go, index, depth=4):
    """This GameObject and everything under it, to `depth`."""
    out = [go]
    frontier = [(go, 0)]
    while frontier:
        cur, d = frontier.pop()
        if d >= depth:
            continue
        tr = transform_of(cur, index)
        for ch in getattr(tr, 'm_Children', []) or []:
            try:
                cgo = ch.read().m_GameObject.read()
            except Exception:
                continue
            out.append(cgo)
            frontier.append((cgo, d + 1))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(NAMES):
        sys.exit(f'missing {NAMES} -- run tools/bench/extract-gear-names.py first')
    rows = json.load(open(NAMES, encoding='utf-8'))['rows']
    by_index = {r['index']: r for r in rows}
    print(f'{len(rows)} gear rows named ({APK})')

    print('loading scene + shared assets...')
    env = UnityPy.load(ASSET_DIR)
    index, sprite_ids = {}, {}
    for o in env.objects:
        index[o.path_id] = o
        if o.type.name == 'Sprite':
            sprite_ids[o.path_id] = o
    print(f'indexed {len(index)} objects, {len(sprite_ids)} sprites')

    ICON_OFFSET = 92   # Image.m_Sprite in the raw component bytes

    def icon_sprite(row_go):
        """The sprite on this row's ReqBox/Icon, or None."""
        t = transform_of(row_go, index)
        for ch in getattr(t, 'm_Children', []) or []:
            try:
                box = ch.read().m_GameObject.read()
            except Exception:
                continue
            if getattr(box, 'm_Name', '') != 'ReqBox':
                continue
            bt = transform_of(box, index)
            for c2 in getattr(bt, 'm_Children', []) or []:
                try:
                    icon = c2.read().m_GameObject.read()
                except Exception:
                    continue
                if getattr(icon, 'm_Name', '') != 'Icon':
                    continue
                for pid in component_ids(icon):
                    obj = index.get(pid)
                    if obj is None or obj.type.name != 'MonoBehaviour':
                        continue
                    try:
                        raw = obj.get_raw_data()
                    except Exception:
                        continue
                    if len(raw) <= ICON_OFFSET + 8:
                        continue
                    s_obj = sprite_ids.get(struct.unpack_from('<q', raw, ICON_OFFSET)[0])
                    if s_obj is None:
                        continue
                    try:
                        return s_obj.read()
                    except Exception:
                        return None
        return None

    found = {}
    scanned = 0
    for o in list(index.values()):
        if o.type.name != 'GameObject':
            continue
        try:
            go = o.read()
        except Exception:
            continue
        if not re.match(r'^\d+(-[A-Za-z]+-Q\d+)?$', getattr(go, 'm_Name', '') or ''):
            continue
        # THE FULL ANCESTOR PATH IS REQUIRED: the scene has more than one ItemSelectionLayout, and
        # matching on the row name plus its immediate parent lands on an Academy milestone list.
        p = path_for(go, index)
        if 'CraftingNewGearPiecePanel/ItemSelectionLayout/' not in p:
            continue
        m = re.search(r'ItemSelectionLayout/(\d+)', p)
        if not m:
            continue
        scanned += 1
        idx = int(m.group(1))
        if idx not in by_index:
            continue
        sd = icon_sprite(go)
        if sd is not None:
            found[idx] = sd

    print(f'matched {scanned} row object(s); resolved {len(found)} icon(s)')

    # DISTINCTNESS IS THE PROOF THAT THE RIGHT NODE WAS READ. The first version of this script
    # resolved all 37 rows to the SAME sprite -- a panel background -- and every count and every
    # "resolved" line looked correct. Identical icons across rows is the signature of reading a
    # shared decoration instead of the piece art, so it fails here rather than being written out.
    src_names = [sd.m_Name for sd in found.values()]
    if len(set(src_names)) != len(src_names):
        from collections import Counter
        dupes = [n for n, c in Counter(src_names).items() if c > 1]
        sys.exit(f'refusing to write -- {len(dupes)} sprite(s) are shared across rows '
                 f'({", ".join(dupes[:3])}). That means a shared decoration was read, not the '
                 'piece icon.')

    written, missing = [], []
    if args.write:
        os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {}
    for idx, row in sorted(by_index.items()):
        sd = found.get(idx)
        name = row['name']
        if sd is None:
            missing.append(f'{idx} {name}')
            continue
        fn = f'{slug(name)}.png'
        if args.write:
            sd.image.save(os.path.join(OUT_DIR, fn))
        manifest[name] = fn
        written.append((idx, name, sd.m_Name, sd.image.width, sd.image.height))

    print(f'\n{"WROTE" if args.write else "WOULD WRITE"} {len(written)} icon(s)')
    for idx, name, src, w, h in written[:10]:
        print(f'  {idx:2d} {name:<28} <- {src} ({w}x{h})')
    if len(written) > 10:
        print(f'  ... and {len(written) - 10} more')
    if missing:
        # NAMED, NEVER SILENT. A piece with no icon must fall back to its name in the UI rather
        # than borrow a neighbour's picture.
        print(f'\nNO ICON RESOLVED for {len(missing)}:')
        for m in missing:
            print(f'  {m}')

    if args.write:
        with open(REF, 'w', encoding='utf-8') as fh:
            json.dump({
                '_source': 'scene ItemSelectionLayout rows; sprite refs found by raw path-id scan',
                '_game': APK,
                '_meaning': 'displayed gear piece name -> icon file in webapp/public/assets/gear/',
                'icons': manifest,
            }, fh, indent=2)
        print(f'\nwrote {REF}')
    else:
        print('\n(report only -- pass --write)')


if __name__ == '__main__':
    sys.exit(main())
