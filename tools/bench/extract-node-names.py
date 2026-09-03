"""Extract every ship install node's displayed NAME from the scene's fleet UI.

Each node has a tooltip at
`Canvas/FleetView.Canvas/UI/UpgradePanel-<Ship>/Tooltips/Tooltip<N>/Title`, and **N is the node's
ruId**, not the community install-code number our catalog is keyed by. That is not an assumption:
Cradle's ruIds 9/10/11 carry three distinct authored coefficients, so the numbers alone pin which
node is which, and the titles line up with that pinning. Indexing by our slot instead reports 15
false mismatches -- every ship whose code<->ruId mapping is not the identity.

Only `Title` exists under a tooltip; the effect text is populated at runtime, so the scene cannot
validate our effect wording -- only the name.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-names.py
"""

import json, os, re, sys
sys.path.insert(0, r"C:\Users\jdion\Projects\CIFI\HunterSim\tools\il2cpp-cli")
import UnityPy
HERE = os.path.dirname(os.path.abspath(__file__))
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")
LEVEL0 = os.path.join(HERE, "..", "gamefiles", APK_DIR, "assets", "level0")
OUT = os.path.join(HERE, "..", "reference", "ship-node-names.json")
ROW = re.compile(r"UpgradePanel-([A-Za-z0-9]+)/Tooltips/Tooltip(\d+)/([A-Za-z0-9_]+)$")
env = UnityPy.load(LEVEL0)
def comp(go, want):
    for e in getattr(go, "m_Component", []) or []:
        try: c = (e.component if hasattr(e, "component") else e[1]).read()
        except Exception: continue
        if type(c).__name__ in want: return c
    return None
def path(go, depth=9):
    parts, cur, n = [], go, 0
    while cur is not None and n < depth:
        parts.append(getattr(cur, "m_Name", "?"))
        tr = comp(cur, ("Transform","RectTransform"))
        f = getattr(tr, "m_Father", None) if tr is not None else None
        try:
            ftr = f.read() if f is not None else None
            cur = ftr.m_GameObject.read() if ftr is not None else None
        except Exception: break
        n += 1
    return "/".join(reversed(parts))
def text_of(obj):
    try: raw = obj.get_raw_data()
    except Exception: return None
    best = None
    for i in range(len(raw)-4):
        ln = int.from_bytes(raw[i:i+4], "little")
        if not (3 <= ln <= 300) or i+4+ln > len(raw): continue
        body = raw[i+4:i+4+ln]
        if not all(32 <= b <= 126 or b in (10,13) for b in body): continue
        v = " ".join(body.decode("ascii").split())
        if not any(c.isalpha() for c in v): continue
        if best is None or len(v) > len(best): best = v
    return best
sn = {}
out = {}
for o in env.objects:
    if o.type.name != "MonoBehaviour": continue
    try:
        mb = o.read(check_read=False); ptr = mb.m_Script
        k = (ptr.m_FileID, ptr.m_PathID)
        if k not in sn: sn[k] = ptr.read().m_ClassName
        if sn[k] != "Text": continue
        go = mb.m_GameObject.read()
    except Exception: continue
    m = ROW.search(path(go))
    if not m: continue
    ship, idx, kind = m.group(1), int(m.group(2)), m.group(3)
    v = text_of(o)
    if not v: continue
    out.setdefault(ship, {}).setdefault(idx, {})[kind] = v
payload = {
    "_source": "Canvas/FleetView.Canvas/UI/UpgradePanel-<Ship>/Tooltips/Tooltip<ruId>/Title in level0",
    "_meaning": "Displayed install-node names. The tooltip index is the node's ruId, NOT the "
                "community install-code number SHIP_NODE_CATALOG is keyed by.",
    "_game": APK_DIR,
    "panels": {k: {kk: vv for kk, vv in sorted(v.items(), key=lambda kv: int(kv[0]))} for k, v in sorted(out.items())},
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(json.dumps(payload, indent=2) + chr(10))
print(f"wrote names for {sum(len(v) for v in out.values())} node(s) across {len(out)} panels to {OUT}", file=sys.stderr)
