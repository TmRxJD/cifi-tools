"""Every factor in every install node's bonus getter -- the complete multiply chain, per node.

This is the general form of the check that caught Badge12. A per-SHIP uniform multiplier cannot
reorder an allocation, so no allocator bench can see it, and one worth x222 sat unmodelled for
months. The only way to be sure there is not another is to enumerate EVERY term each
`RU<Category><n>Bonus` getter multiplies in and require each one to be accounted for by name.

Both kinds of read are captured, because either alone hides terms:
  * named accesses (`Badges.FinalBadge2Bonus`, `mM.RU4GenLevel`), and
  * the operands inside Cpp2IL's decompiler notes, resolved through resolve-loads.py -- this is
    where the gem perks and the installs researches live, invisible to any name search.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-node-factors.py
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "reference", "node-factors.json")
CSHARP = os.path.join(HERE, "..", "il2cpp-cli", "csharp.py")
RESOLVE = os.path.join(HERE, "..", "il2cpp-cli", "resolve-loads.py")
APK_DIR = os.environ.get("CIFI_APK", "apk-0.7.3.54")

MEMBER = re.compile(r"^\t(public|private|internal|protected)\s")
PROP = re.compile(r"^\tpublic \w[\w<>]* (RU([A-Za-z]+)(\d+)Bonus)\s*$")

# Reads that are not multiplicands: ownership flags gate a branch, and Pow/helpers are runtime.
NOT_A_FACTOR = re.compile(r"(Acquired|Unlocked)$|^(Pow|NoteDecompilerIssue|Log10|Max|Min|Floor)$")


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
    if not bodies:
        raise SystemExit("no RU<Category><n>Bonus getters found")

    cache = {}
    def resolve(type_name, offset):
        key = (type_name, offset)
        if key not in cache:
            env = dict(os.environ, CIFI_APK=APK_DIR)
            r = subprocess.run([sys.executable, RESOLVE, "--offset", type_name, "0x" + offset],
                               capture_output=True, text=True, env=env)
            m = re.search(r"-> ([<\w>]+)", r.stdout)
            cache[key] = m.group(1).replace("<", "").replace(">k__BackingField", "") if m else None
        return cache[key]

    out = {}
    for (category, idx), body in sorted(bodies.items()):
        names = set(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)", body))
        names |= set(re.findall(r"<([A-Za-z0-9_]+)>k__BackingField", body))
        names |= set(re.findall(r"=\s*(RU\d+[A-Za-z]+BaseBonus)\b", body))
        for t, o in re.findall(r"\(([A-Za-z0-9_]+)\)\+([0-9A-F]+)", body):
            n = resolve(t, o)
            if n: names.add(n)
        # int operands inside unimplemented instructions are MasterManager counters; float ones are
        # the node's own authored base bonus (see extract-node-counters.py for why the opcode is
        # the discriminator rather than the register).
        for o in re.findall(r"cvtsi2ss [^\"]*?dword ptr \[\w+\+([0-9A-F]+)h\]", body):
            n = resolve("MasterManager", o)
            if n: names.add(n)
        factors = sorted(n for n in names if not NOT_A_FACTOR.search(n))
        out.setdefault(category, {})[str(idx)] = factors

    payload = {
        "_source": "RU<Category><n>Bonus getter bodies (tools/il2cpp-cli/csharp.py), with note "
                   "operands resolved via resolve-loads.py",
        "_meaning": "Every term a node's bonus multiplies in. Ownership flags (…Acquired/…Unlocked) "
                    "and runtime helpers (Pow) are excluded -- they gate a branch, they are not "
                    "factors.",
        "_game": APK_DIR,
        "factors": {c: dict(sorted(v.items(), key=lambda kv: int(kv[0]))) for c, v in sorted(out.items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2) + chr(10))
    total = sum(len(v) for v in out.values())
    distinct = sorted({f for v in out.values() for fs in v.values() for f in fs})
    print(f"wrote factors for {total} node(s); {len(distinct)} distinct terms -> {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
