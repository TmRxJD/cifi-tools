"""Extract the gear pieces' real in-game names from the scene's crafting menu.

Every gear piece has a row under
`AcademyCanvas/YourAcademyMenu/GearMenu/CraftingNewGearPiecePanel/ItemSelectionLayout/<index>`,
whose `ReqBox/DescText` is the piece's displayed NAME and whose `ReqBox/LevelText` is its unlock
level. The row's GameObject is named for its index, and the rows past the free ones carry their
gate in the name (`22-GemOfPower-Q2`), so the ordering and the gating both come from the scene
rather than from us.

WHY THIS TOOK SO LONG TO FIND, because the method is the lesson:

  * The names are stored UPPERCASE ("MINING DRONE"). Every earlier search was case-sensitive on
    the wiki's title case, so it returned a confident zero. One `grep -i` would have found them.
  * The one wiki name that genuinely is not in the game is "Cell Battery" -- so the first needle
    tried was the single worst choice, and its absence was generalised into "no gear names exist
    anywhere", which then got as far as a committed comment.
  * A raw `grep` over `level0` is not a search of the scene. Parts of it are compressed, so
    strings that are plainly there via UnityPy are invisible to grep. Treat a grep miss on a
    Unity asset as "not proven", never as "not present".

The 37 rows are exactly `Gear.GearIconImagePaths`' length: 22 ungated pieces (the five colours the
wiki documents, and which this repo already modelled) followed by 15 gem-gated ones -- White,
Yellow and Black, five each, behind Gem Of Power quality 2, 4 and 6.

    python tools/bench/extract-gear-names.py        # -> tools/reference/gear-names.json
"""

import json
import os
import re
import sys

import UnityPy

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "gear-names.json")
# Which pulled build to read. Every conclusion drawn from these files is about ONE build, so make
# the build switchable and print it -- comparing two versions is how you tell "the game does not do
# this" apart from "this build does not do this yet", which is exactly the distinction the
# Yellow/Black gear question turned on.
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")
LEVEL0 = os.path.join(HERE, "..", "gamefiles", APK_DIR, "assets", "level0")

ROW = re.compile(r"ItemSelectionLayout/(\d+)(?:-([A-Za-z]+)-Q(\d+))?/ReqBox/(DescText|LevelText)$")
PRINTABLE = re.compile(rb"[ -~]{3,}")


def component_of(go, wanted):
    for entry in getattr(go, "m_Component", []) or []:
        try:
            comp = (entry.component if hasattr(entry, "component") else entry[1]).read()
        except Exception:
            continue
        if type(comp).__name__ in wanted:
            return comp
    return None


def path_for(go, depth=8):
    parts, cur, n = [], go, 0
    while cur is not None and n < depth:
        parts.append(getattr(cur, "m_Name", "?"))
        tr = component_of(cur, ("Transform", "RectTransform"))
        father = getattr(tr, "m_Father", None) if tr is not None else None
        try:
            ftr = father.read() if father is not None else None
            cur = ftr.m_GameObject.read() if ftr is not None else None
        except Exception:
            break
        n += 1
    return "/".join(reversed(parts))


def text_of(obj):
    """The Text component's string.

    Read from the raw bytes rather than a type tree -- UI.Text's tree does not reliably
    reconstruct here -- but parse Unity's actual string encoding (int32 length, then that many
    bytes) rather than scanning for printable runs.

    The precision matters: these labels contain NEWLINES, because the crafting menu wraps them
    over two lines ("FIELD\\nHARD DRIVE"). A printable-run scan splits on the newline and then
    picking the longest run silently yields "HARD DRIVE", "BATTERY" for "CELL BATTERY", and
    "GRAVITY" for "GRAVITY BOMB" -- half-right names that look plausible enough to ship.
    """
    try:
        raw = obj.get_raw_data()
    except Exception:
        return None
    best = None
    for i in range(len(raw) - 4):
        length = int.from_bytes(raw[i:i + 4], "little")
        if not (3 <= length <= 64) or i + 4 + length > len(raw):
            continue
        body = raw[i + 4:i + 4 + length]
        if not all(32 <= b <= 126 or b in (10, 13) for b in body):
            continue
        value = " ".join(body.decode("ascii").split())
        if value.upper() != value or not any(c.isalpha() for c in value):
            continue
        if best is None or len(value) > len(best):
            best = value
    return best


def main():
    if not os.path.exists(LEVEL0):
        raise SystemExit(f"scene not found: {LEVEL0} (see tools/gamefiles/README)")
    env = UnityPy.load(LEVEL0)

    script_name = {}
    rows = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            mb = obj.read(check_read=False)
        except Exception:
            continue
        ptr = getattr(mb, "m_Script", None)
        if ptr is None:
            continue
        key = (ptr.m_FileID, ptr.m_PathID)
        if key not in script_name:
            try:
                script_name[key] = ptr.read().m_ClassName
            except Exception:
                script_name[key] = None
        if script_name[key] != "Text":
            continue
        try:
            go = mb.m_GameObject.read()
        except Exception:
            continue
        m = ROW.search(path_for(go))
        if not m:
            continue
        idx, gem, quality, which = int(m.group(1)), m.group(2), m.group(3), m.group(4)
        value = text_of(obj)
        if not value:
            continue
        row = rows.setdefault(idx, {"index": idx, "gemGate": None, "quality": None})
        if gem:
            row["gemGate"] = gem
            row["quality"] = int(quality)
        if which == "DescText":
            row["name"] = value
        else:
            row["unlockText"] = value

    if not rows:
        raise SystemExit("no ItemSelectionLayout rows found -- the menu path changed")
    missing = [i for i, r in rows.items() if "name" not in r]
    if missing:
        raise SystemExit(f"row(s) {sorted(missing)} have no DescText; refusing a partial map")

    ordered = [rows[i] for i in sorted(rows)]
    payload = {
        "_source": "AcademyCanvas/YourAcademyMenu/GearMenu/CraftingNewGearPiecePanel/"
                   "ItemSelectionLayout/<index>/ReqBox/{DescText,LevelText} in level0",
        "_meaning": "Displayed gear piece names, in the crafting menu's own order. Rows carrying a "
                    "gemGate are locked behind that gem at the given quality.",
        "_game": APK_DIR,
        "rows": ordered,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {len(ordered)} gear name(s) from {APK_DIR} to {OUT}", file=sys.stderr)
    for r in ordered:
        gate = f"  [{r['gemGate']} Q{r['quality']}]" if r["gemGate"] else ""
        print(f"  {r['index']:2}  {r['name']:<26}{gate}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
