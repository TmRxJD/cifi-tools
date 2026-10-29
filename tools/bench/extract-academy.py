"""Extract the Academy's authored data into tools/reference/academy-data.json.

    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-academy.py            # dry run: summary + drift check
    CIFI_APK=apk-0.7.3.61 python tools/bench/extract-academy.py --write    # (re)write the reference

WHY THIS IS GENERATED, NOT TRANSCRIBED. The mission table alone is ~560 authored numbers, and the
academy's bonus ROUTING (which milestone bonus feeds materials, which project bonus feeds farm
fragments) lives in code, not data. Hand-copying either invites exactly the drift CLAUDE.md warns
about -- the wiki's milestone table stops at 33 of 60 and gives the corvette the wrong evolution
exponent. So every value here comes from one of two primary sources, and each is read by machine:

  * AUTHORED VALUES -- typetree.py over the build's own scene (Missions, Personnel,
    ConstructionProjects, ConstructionMilestones, OuroRelics, Badges, ResearchLaboratory,
    FleetManager).
  * ROUTING -- the recovered C# (csharp.py): `ConstructionProjects.BeginProject<n>` names the
    material each cost slot debits; `ConstructionProjects.SetBonuses` and
    `ConstructionMilestones.SetAllBonuses` name the Final<Resource>Bonus each bonus multiplies into.

Missions and ConstructionProjects only read with `--backend AssetStudio --relaxed` (typetree.py's
docstring explains why). Relaxed reads are only trustworthy for fields before the tree diverges, so
this file cross-checks a sample of late fields against an independent source before writing
(see SPOT_CHECKS): the mission values agree with the farm table cifi-tools publishes.

Formulas are NOT extracted here -- they are documented in tools/reference/academy-mechanics.md and
implemented in webapp/public/academyModel.js. This file is data only.
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "il2cpp-cli"))
import csharp    # noqa: E402
import typetree  # noqa: E402

OUT = os.path.join(HERE, "..", "reference", "academy-data.json")

# The save spells Torkinstone that way (`TorkinstoneNew`); the Missions scene spells it TorkinStone.
# Normalise to the save's spelling so the model can index the save directly.
MATERIALS = ["Difar", "Kento", "Chromium", "Exon", "Organium", "Adamorphium", "Moskom", "Darkseid",
             "Torkinstone", "Pytoxene", "Gigantium", "Tokenium"]
MATERIAL_ALIASES = {"TorkinStone": "Torkinstone"}

PLANETS = {"W": "Wasta", "C": "Cryton", "E": "Egetuar", "S": "Sekhur"}

# Reward/bonus suffix spellings vary between missions in the authored data ("InnovationCoreBaseReward"
# vs "InnovationCoresBaseReward", "CellsBaseBonus" vs "CellBaseBonus"). One canonical key each.
REWARD_ALIASES = {
    "Ap": "ap", "Xp": "xp",
    "InnovationCore": "innovationCores", "InnovationCores": "innovationCores",
    "DarkInnovationCores": "darkInnovationCores",
    "Diamond": "diamonds", "Diamonds": "diamonds",
}
BONUS_ALIASES = {"Cells": "cells", "Cell": "cells", "AP": "ap", "Shard": "shards", "Shards": "shards",
                 "RP": "rp", "MP": "mp"}

# Research units the academy formulas read (see academy-mechanics.md). Their tier values are taken
# from the ResearchLaboratory typetree, which reads BigDouble tiers that research.json's scene-text
# extractor skipped (RU70Bonus1 = 1e200, RU80Bonus1 = 9.9e420, ...).
ACADEMY_RESEARCH = [43, 55, 58, 60, 62, 67, 70, 72, 77, 80, 82, 87, 89, 93, 94, 97, 99, 104, 106, 113]

# Badge fields the academy formulas read: Badge6 (mission speed), Badge20 (corvette power),
# DarkBadge5 (farm fragment multiplier).
ACADEMY_BADGE_FIELDS = ["Badge6Bonus1", "Badge20Bonus1", "DarkBadge5Bonus"]

# Relaxed-read spot checks against an INDEPENDENT source: cifi-tools' published farm table
# (tools/bench/live-bundle.js), which lists each farm's maxCrew and a base time equal to
# MPRequirement * 60 / 2 minutes. Agreement on the LAST farms of the class is what makes the
# relaxed read trustworthy for everything before them.
SPOT_CHECKS = [
    # (mission key, field, expected)
    ("S-F-4", "maxPersonnel", 40000),
    ("S-F-4", "fragmentsExponent", 200),
    ("E-F-4", "maxPersonnel", 8000),
    ("C-F-4", "mpRequirement", 4400),   # cifi-tools F2-4: 132000 min = 4400 * 60 / 2
    ("W-F-3", "mpRequirement", 80),     # cifi-tools F1-3:   2400 min =   80 * 60 / 2
]


def bigdouble(v):
    """Authored BigDoubles come back as {mantissa, exponent}; keep that exact shape."""
    if isinstance(v, dict) and set(v) == {"mantissa", "exponent"}:
        return {"mantissa": float(v["mantissa"]), "exponent": int(v["exponent"])}
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    raise ValueError(f"expected a number or BigDouble, got {v!r}")


class Reader:
    """One typetree Extractor per backend, built on first use (each load costs ~30s)."""

    def __init__(self):
        self._ex = {}

    def read(self, cls, backend="AssetsTools", relaxed=False):
        if backend not in self._ex:
            self._ex[backend] = typetree.Extractor(backend=backend)
        inst = self._ex[backend].read_instances(cls, relaxed=relaxed)
        if len(inst) != 1:
            raise SystemExit(f"{cls}: expected exactly one instance, found {len(inst)}")
        return inst[0]


def csharp_source(cls):
    with open(csharp.decompile_type(cls), encoding="utf-8") as f:
        return f.read()


# --- missions ---------------------------------------------------------------------------------

MISSION_FIELD = re.compile(r"^([WCES])([CF])MMission(\d+)(\w+)$")
ADVANCED_FIELD = re.compile(r"^([WCE])FMAdvancedMission(\d)(\w+)BaseReward$")


def classify(suffix):
    """-> (bucket, key) for one mission field suffix, or raise on anything unrecognised."""
    if suffix == "MPRequirement":
        return ("mpRequirement", None)
    if suffix == "MaxPersonnel":
        return ("maxPersonnel", None)
    if suffix == "FragmentsExponent":
        return ("fragmentsExponent", None)
    m = re.fullmatch(r"(\w+?)BaseReward", suffix)
    if m:
        name = MATERIAL_ALIASES.get(m.group(1), m.group(1))
        if name in MATERIALS:
            return ("materials", name)
        if name in REWARD_ALIASES:
            return ("other", REWARD_ALIASES[name])
    m = re.fullmatch(r"(\w+?)BaseBonus", suffix)
    if m and m.group(1) in BONUS_ALIASES:
        return ("permanentBonus", BONUS_ALIASES[m.group(1)])
    if suffix.endswith("SubCalc"):
        return (None, None)   # a getter's backing helper, not authored mission data
    raise SystemExit(f"unrecognised mission field suffix {suffix!r} -- extend classify()")


def is_value(v):
    """True for authored numbers and BigDoubles. The raw record also carries scene wiring (Unity
    object references such as `WCMMission1Button`, lists of them) and UI strings, which share the
    mission naming pattern but are not data."""
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    return isinstance(v, dict) and set(v) == {"mantissa", "exponent"}


def extract_missions(m):
    missions = {}
    for field, value in m.items():
        hit = MISSION_FIELD.match(field)
        if not hit or not is_value(value):
            continue
        planet, kind, idx, suffix = hit.groups()
        bucket, key = classify(suffix)
        if bucket is None:
            continue
        mk = f"{planet}-{kind}-{int(idx)}"
        entry = missions.setdefault(mk, {
            "planet": PLANETS[planet], "kind": "campaign" if kind == "C" else "farm",
            "index": int(idx), "materials": {}, "other": {}, "permanentBonus": {},
            "fragmentsExponent": None,
        })
        if bucket in ("materials", "other", "permanentBonus"):
            entry[bucket][key] = bigdouble(value)
        else:
            entry[bucket] = bigdouble(value)

    # Advanced farms carry their MaxPersonnel / MPRequirement as three-element ARRAYS on the class,
    # and their rewards as scalars. Sekhur has none.
    for p in ("W", "C", "E"):
        caps = m[f"{p}FMAdvancedMaxPersonnel"]
        reqs = m[f"{p}FMAdvancedMPRequirement"]
        if len(caps) != 3 or len(reqs) != 3:
            raise SystemExit(f"{p}FMAdvanced arrays should have 3 entries: {caps} / {reqs}")
        for i in range(3):
            missions[f"{p}-A-{i + 1}"] = {
                "planet": PLANETS[p], "kind": "advancedFarm", "index": i + 1,
                "mpRequirement": reqs[i], "maxPersonnel": caps[i],
                "materials": {}, "other": {}, "permanentBonus": {}, "fragmentsExponent": None,
            }
    for field, value in m.items():
        hit = ADVANCED_FIELD.match(field)
        if not hit:
            continue
        p, idx, name = hit.groups()
        name = MATERIAL_ALIASES.get(name, name)
        entry = missions[f"{p}-A-{int(idx)}"]
        if name in MATERIALS:
            entry["materials"][name] = bigdouble(value)
        elif name in REWARD_ALIASES:
            entry["other"][REWARD_ALIASES[name]] = bigdouble(value)
        else:
            raise SystemExit(f"unrecognised advanced reward {field!r}")

    for mk, e in missions.items():
        for req in ("mpRequirement", "maxPersonnel"):
            if req not in e:
                raise SystemExit(f"mission {mk} has no {req}")
    return dict(sorted(missions.items(), key=lambda kv: (
        "WCES".index(kv[0][0]), "CFA".index(kv[0][2]), kv[1]["index"])))


# --- projects ---------------------------------------------------------------------------------

def extract_projects(p, src):
    begin = re.compile(r"public void BeginProject(\d+)\(\)")
    debit = re.compile(r"mM\d+\.(\w+)New = ")
    materials = {}
    current = None
    for line in src.splitlines():
        hit = begin.search(line)
        if hit:
            current = int(hit.group(1))
            materials[current] = []
            continue
        if current is not None and re.search(r"^\t(public|private) ", line):
            current = None
        if current is not None:
            d = debit.search(line)
            if d:
                materials[current].append(MATERIAL_ALIASES.get(d.group(1), d.group(1)))

    routing = parse_routing(src, "SetBonuses", r"(Project\d+Bonus\d*)")
    projects = {}
    for n in range(1, 12):
        pre = f"Project{n}"
        costs = []
        k = 1
        while f"{pre}BaseCost{k}" in p:
            costs.append(bigdouble(p[f"{pre}BaseCost{k}"]))
            k += 1
        if len(costs) != len(materials.get(n, [])):
            raise SystemExit(f"{pre}: {len(costs)} authored cost slots but BeginProject{n} debits "
                             f"{materials.get(n)}")
        bonuses = {}
        for field, value in p.items():
            b = re.fullmatch(rf"{pre}BaseBonus(\d*)", field)
            if b:
                getter = f"{pre}Bonus{b.group(1)}"
                if getter not in routing:
                    raise SystemExit(f"{getter} is authored but SetBonuses never routes it")
                bonuses[getter] = {"base": bigdouble(value), "feeds": routing[getter]}
        projects[str(n)] = {
            "baseSeconds": p[f"{pre}BaseSecondsRequirement"],
            "secondsPerLevel": p[f"{pre}SecondsIncreasePerLevel"],
            "costExponent": p[f"{pre}CostExponent"],
            "costExponent2": p.get(f"{pre}CostExponent2"),
            "costs": [{"material": mat, "base": c} for mat, c in zip(materials[n], costs)],
            "bonuses": bonuses,
        }
    return projects, {"innovationCoreRequirement": p["InnovationCoreRequirement"],
                      "expansionMaxLevel": p["ExpansionMaxLevel"],
                      "expansionProjectBaseRequirement": p["ExpansionProjectBaseRequirement"]}


def parse_routing(src, method, getter_re):
    """Map each bonus getter read inside `method` to the Final<Resource>Bonus it is multiplied into.

    The recovered C# reads a run of getters (`BigDouble x = Project9Bonus2;`) and then assigns the
    product (`FinalMatsBonus = ...;`). A getter read after the last assignment, or assigned to two
    finals, is an error -- both would mean this parse misunderstood the method.
    """
    body = method_body(src, method)
    read = re.compile(rf"= {getter_re};")
    assign = re.compile(r"^\s*(Final\w+Bonus) = ")
    routing, pending = {}, []
    for line in body:
        r = read.search(line)
        if r:
            pending.append(r.group(1))
            continue
        a = assign.search(line)
        if a:
            for g in pending:
                if g in routing:
                    raise SystemExit(f"{method}: {g} routed twice ({routing[g]}, {a.group(1)})")
                routing[g] = a.group(1)
            pending = []
    if pending:
        raise SystemExit(f"{method}: getters read but never assigned: {pending}")
    return routing


def method_body(src, method):
    lines = src.splitlines()
    for i, line in enumerate(lines):
        if re.search(rf"\b(public|private) void {method}\(\)", line):
            depth, out = 0, []
            for j in range(i, len(lines)):
                out.append(lines[j])
                depth += lines[j].count("{") - lines[j].count("}")
                if j > i and depth == 0:
                    return out
    raise SystemExit(f"method {method} not found in recovered C#")


# --- milestones -------------------------------------------------------------------------------

def extract_milestones(ms, src):
    routing = parse_routing(src, "SetAllBonuses", r"(FinalMilestone(?:\d+|U\d)Bonus\d+)")
    out = {}
    n = 1
    while f"Milestone{n}Requirement" in ms:
        bonuses, ships = {}, {}
        for field, value in ms.items():
            b = re.fullmatch(rf"Milestone{n}Bonus(\d+)", field)
            if b:
                getter = f"FinalMilestone{n}Bonus{b.group(1)}"
                if getter not in routing:
                    raise SystemExit(f"{getter} is authored but SetAllBonuses never routes it")
                bonuses[f"Bonus{b.group(1)}"] = {"value": bigdouble(value), "feeds": routing[getter]}
            s = re.fullmatch(rf"Milestone{n}Ship(\d)Points", field)
            if s:
                ships[f"ship{s.group(1)}"] = value
        out[str(n)] = {"requirement": ms[f"Milestone{n}Requirement"], "bonuses": bonuses,
                       "shipRankPoints": ships}
        n += 1
    return out


# --- everything else --------------------------------------------------------------------------

def extract_personnel(p):
    out = {}
    for tier, name in enumerate(["MiningPod", "FireteamCarrier", "TitanHauler", "CombatCorvette"], 1):
        out[f"T{tier}"] = {
            "name": name,
            "baseOutput": p[f"{name}BaseOutput"],
            "evoExponent": p[f"{name}EvoExponent"],
            "maxEvo": p[f"{name}MaxEvo"],
            "evoRequirement": p[f"{name}EvoRequirement"],
            "startCost": bigdouble(p[f"{name}StartCost"]),
            "costExponent": bigdouble(p[f"{name}CostExponent"]),
        }
    return out


def extract_research(rl):
    out = {}
    for n in ACADEMY_RESEARCH:
        tiers = {}
        for k in range(1, 7):
            key = f"RU{n}Bonus{k}"
            if key in rl:
                tiers[f"Bonus{k}"] = bigdouble(rl[key])
        if not tiers:
            raise SystemExit(f"RU{n} has no Bonus fields in ResearchLaboratory")
        out[str(n)] = tiers
    return out


def spot_check(missions):
    for mk, field, expected in SPOT_CHECKS:
        got = missions[mk][field]
        if got != expected:
            raise SystemExit(f"relaxed-read spot check FAILED: {mk}.{field} = {got!r}, expected "
                             f"{expected!r} -- the relaxed Missions read has diverged; do not trust it")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()
    if typetree.APK_DIR != csharp.APK_DIR:
        raise SystemExit("typetree and csharp resolved different builds; set CIFI_APK")

    rd = Reader()
    missions_raw = rd.read("Missions", backend="AssetStudio", relaxed=True)
    projects_raw = rd.read("ConstructionProjects", backend="AssetStudio", relaxed=True)
    milestones_raw = rd.read("ConstructionMilestones")
    relics = rd.read("OuroRelics")
    badges = rd.read("Badges")
    fleet = rd.read("FleetManager")

    missions = extract_missions(missions_raw)
    spot_check(missions)
    projects, outpost = extract_projects(projects_raw, csharp_source("ConstructionProjects"))

    data = {
        "generatedFrom": f"{typetree.APK_DIR} via tools/bench/extract-academy.py (typetree + csharp)",
        "note": "Authored academy data and code-derived bonus routing. Formulas: academy-mechanics.md.",
        "secondsPerMP": missions_raw["SecondsPerMP"],
        "materials": MATERIALS,
        "personnel": extract_personnel(rd.read("Personnel")),
        "missions": missions,
        "projects": projects,
        "outpost": outpost,
        "milestones": extract_milestones(milestones_raw, csharp_source("ConstructionMilestones")),
        "relics": {
            "baseFarmFragments": relics["BaseFragmentsGainedFromFarmMissions"],
            "baseCampaignFragments": relics["BaseFragmentsGainedFromCampaignMissions"],
            "bonusPerLevel": {f"r{n}": bigdouble(relics[f"Relic{n}BonusPerLevel"])
                              for n in range(1, 21) if f"Relic{n}BonusPerLevel" in relics},
        },
        "badges": {f: bigdouble(badges[f]) for f in ACADEMY_BADGE_FIELDS},
        "research": extract_research(rd.read("ResearchLaboratory")),
        "zeus": {"startRankRequirement": fleet["Ship7StartRankRequirement"],
                 "rankExponent": fleet["Ship7RankExponent"]},
    }

    text = json.dumps(data, indent=1) + "\n"
    print(f"missions {len(missions)}, projects {len(projects)}, milestones {len(data['milestones'])}, "
          f"research {len(data['research'])}", file=sys.stderr)
    if args.write:
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {OUT}", file=sys.stderr)
        return 0
    if not os.path.exists(OUT):
        print("no reference yet -- rerun with --write", file=sys.stderr)
        return 1
    with open(OUT, encoding="utf-8") as f:
        same = f.read() == text
    print("reference is up to date" if same else "reference DIFFERS -- rerun with --write", file=sys.stderr)
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
