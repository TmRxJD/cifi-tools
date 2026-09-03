"""Which badge multiplies each ship's install nodes, and by how much -- from the game.

Two independent halves, both authored/compiled rather than transcribed:
  * WHICH badge: each `RU<Category><n>Bonus` getter names the badge it multiplies in, so the
    ship->badge mapping is read out of FleetManager's own code.
  * HOW MUCH: `Badge<N>Bonus` / `DarkBadge<N>Bonus` on the authored Badges MonoBehaviour.

This exists because the tool modelled Badge2 (x7, ships 1-4) and DarkBadge1 (x3, all ships) but not
Badge12 (x222), which every Shard/Research/Academy node multiplies in -- so Demeter, Koios and Zeus
totals were understated by 222x for anyone who owned it. A per-ship uniform term cannot reorder an
allocation, which is exactly why nothing caught it.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-badge-map.py
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "badge-map.json")
CSHARP = os.path.join(HERE, "..", "il2cpp-cli", "csharp.py")
TYPETREE = os.path.join(HERE, "..", "il2cpp-cli", "typetree.py")
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")

MEMBER = re.compile(r"^\t(public|private|internal|protected)\s")
PROP = re.compile(r"^\tpublic \w[\w<>]* (RU([A-Za-z]+)(\d+)Bonus)\s*$")
BADGE = re.compile(r"\bFinal((?:Dark)?Badge\d+)Bonus\d*\b")


def main():
    proc = subprocess.run([sys.executable, CSHARP, "FleetManager"], capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(f"could not recover FleetManager: {proc.stderr[-400:]}")

    bodies, cur, buf = {}, None, []
    for line in proc.stdout.splitlines():
        m = PROP.match(line)
        if m:
            if cur: bodies[cur] = "\n".join(buf)
            cur, buf = (m.group(2), int(m.group(3))), []
            continue
        if cur:
            if MEMBER.match(line):
                bodies[cur] = "\n".join(buf); cur, buf = None, []
            else:
                buf.append(line)
    if cur: bodies[cur] = "\n".join(buf)

    # A badge counts for a category only if EVERY one of its nodes reads it -- a badge referenced by
    # a single node (Shard 1 reads Badge5) is a one-off in that node's own formula, not a per-ship
    # multiplier, and treating it as one would overstate the whole ship.
    per_cat, node_counts = {}, {}
    for (cat, _idx), body in bodies.items():
        node_counts[cat] = node_counts.get(cat, 0) + 1
        for badge in set(BADGE.findall(body)):
            per_cat.setdefault(cat, {})[badge] = per_cat.setdefault(cat, {}).get(badge, 0) + 1
    universal = {cat: sorted(b for b, n in badges.items() if n == node_counts[cat])
                 for cat, badges in per_cat.items()}

    tt = subprocess.run([sys.executable, TYPETREE, "--dump", "Badges",
                         "--backend", "AssetStudio", "--relaxed"], capture_output=True, text=True)
    if "{" not in tt.stdout:
        raise SystemExit(f"could not read authored Badges data: {tt.stderr[-400:]}")
    authored = json.loads(tt.stdout[tt.stdout.index("{"):])

    def value(badge):
        for key in (f"{badge}Bonus", f"{badge}Bonus1"):
            v = authored.get(key)
            if isinstance(v, dict) and "mantissa" in v:
                return float(v["mantissa"]) * (10.0 ** int(v["exponent"]))
            if isinstance(v, (int, float)):
                return float(v)
        return None

    badges = sorted({b for bs in universal.values() for b in bs})
    payload = {
        "_source": "which badge: RU<Category><n>Bonus getter bodies (tools/il2cpp-cli/csharp.py); "
                   "value: the authored Badges MonoBehaviour (tools/il2cpp-cli/typetree.py)",
        "_meaning": "perCategory lists badges read by EVERY node of that category, i.e. genuine "
                    "per-ship multipliers. A badge only some nodes read is excluded on purpose.",
        "_game": APK_DIR,
        "perCategory": {c: universal[c] for c in sorted(universal)},
        "values": {b: value(b) for b in badges},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + chr(10))
    print(f"wrote badge map for {len(universal)} categories to {OUT}", file=sys.stderr)
    for c in sorted(universal):
        print(f"   {c:10} {universal[c]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
