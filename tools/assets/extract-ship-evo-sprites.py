"""Extract each fleet ship's PER-EVOLUTION artwork from the APK.

    CIFI_APK=apk-0.7.3.61 python tools/assets/extract-ship-evo-sprites.py [--write]

WHY. Evolving a ship changes how it looks in game, and the tool showed one fixed portrait per ship
whatever evo level the user had entered.

ALL SEVEN SHIPS HAVE EVOLUTION ART. Getting to that took three wrong turns, recorded because each
produced a confident, plausible, WRONG answer:

  1. SEARCHING SPRITE NAMES for the ships finds only CradleEvo0..7, HephyEvo0..5 and ZeusEvo0..6.
     Grouping all 2093 sprite names by "prefix + trailing digits" and listing every zero-based run
     of 4-8 members returns exactly those three and nothing else -- which reads as proof that four
     ships have no per-evo art. It is not. FOUR OF THE SEVEN ARE NAMED AFTER THEIR CATEGORY, NOT
     THEIR SHIP: SpaceShip-TechUpgrades-LV* (Auxesia), SpaceShip-LoopMods-LV* (Zagreus),
     SpaceShip-ShardMining-LV* (Demeter), SpaceShip-Research-LV* (Koios). No search for a ship name
     or any abbreviation of it can find those. "I could not find it" is not "it is not there" --
     the same mistake this repo already made with gear names.
  2. FOLLOWING FleetManager's `Ship<n>Evolution<m>` PPtrs is field-MISALIGNED: Ship1Evolution0
     resolves to a GameObject named "CostBox", while the scalars beside it in the same dump are
     sane (Evolution0MaxCrew 30/100/180/...). A pointer read at the wrong offset returns a
     real-looking object rather than an error -- documented here for BigDouble, equally true for
     PPtrs.
  3. READING THE SCENE'S UI.Image COMPONENTS needs a type tree that cannot be built: Image is a
     Unity built-in, so it is absent from dump.cs and patch_missing_enums has nothing to work from.
     Every read fails "out of bounds".

  WHAT ACTUALLY FOUND THEM was scanning the raw bytes of the scene's `Spaceship-Evolution<n>`
  MonoBehaviours for any 8-byte value matching a known Sprite path id. The sprite reference sits at
  offset 92 and named `SpaceShip-TechUpgrades-LV5`, which is what revealed the category naming.
  That probe is not needed now the pattern is known, but it is the technique to reach for when a
  type tree is unavailable.

THE MAPPING IS CORROBORATED, NOT ASSUMED. FleetManager declares a stage count per ship and the
counts are NOT uniform -- Cradle 8, Zeus 7, Hephaestus 6, Auxesia/Zagreus/Koios 5, Demeter 4. Each
sprite set matches its ship's declared stages exactly, so the category-to-ship mapping rests on an
independent number rather than on a category name sounding right. The script REFUSES TO WRITE if
they ever disagree, because a wrong mapping would show a user another ship's artwork.

Numbering differs between the families and is normalised here: Evo* is 0-based; the category sets
start at LV1, and Auxesia's first is a bare `-LV` with no digit.
"""
import argparse
import json
import os
import re
import sys

try:
    import UnityPy
except ImportError:
    sys.exit('UnityPy is required: python -m pip install UnityPy')

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APK = os.environ.get('CIFI_APK', 'apk-0.7.3.61')
ASSETS = os.path.join(REPO, 'tools', 'gamefiles', APK, 'assets', 'sharedassets0.assets')
OUT_DIR = os.path.join(REPO, 'webapp', 'public', 'assets', 'ships')
REF = os.path.join(REPO, 'tools', 'reference', 'ship-evo-stages.json')
DUMP = os.path.join(REPO, 'tools', 'gamefiles', APK, 'il2cpp-dump', 'dump.cs')

SHIP_FILE = {1: 'cradle', 2: 'auxesia', 3: 'zagreus', 4: 'hephaestus',
             5: 'demeter', 6: 'koios', 7: 'zeus'}

# ship -> (sprite-name regex, offset that turns the captured number into a 0-based stage).
# CradleEvo7_1 and CradleEvoT are variants rather than stages; the anchored patterns already
# exclude them, and this note exists so nobody "fixes" the anchor.
SPRITE_SETS = {
    'cradle':     (re.compile(r'^CradleEvo(\d+)(@[0-9.]+x?)?$'), 0),
    'hephaestus': (re.compile(r'^HephyEvo(\d+)(@[0-9.]+x?)?$'), 0),
    'zeus':       (re.compile(r'^ZeusEvo(\d+)(@[0-9.]+x?)?$'), 0),
    'auxesia':    (re.compile(r'^SpaceShip-TechUpgrades-LV(\d*)$'), -1),
    'zagreus':    (re.compile(r'^SpaceShip-LoopMods-LV(\d*)$'), -1),
    'demeter':    (re.compile(r'^SpaceShip-ShardMining-LV(\d*)$'), -1),
    'koios':      (re.compile(r'^SpaceShip-Research-LV(\d*)$'), -1),
}


def declared_stages():
    """ship id -> [stage...] from FleetManager's Ship<n>Evolution<m> field DECLARATIONS.

    The field NAMES are reliable even though their PPtr VALUES misread (see the docstring), and
    they are what makes the category-to-ship mapping checkable rather than assumed.
    """
    if not os.path.exists(DUMP):
        sys.exit(f'missing {DUMP} -- run the il2cpp dump for {APK} first')
    src = open(DUMP, encoding='utf-8', errors='replace').read()
    out = {}
    for m in re.finditer(r'public GameObject Ship(\d)Evolution(\d+);', src):
        out.setdefault(int(m.group(1)), set()).add(int(m.group(2)))
    if not out:
        sys.exit('no Ship<n>Evolution<m> fields found -- fix this rather than assuming a uniform '
                 'stage count, which differs per ship (4 to 8)')
    return {k: sorted(v) for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()

    stages = declared_stages()
    print(f'FleetManager declares evolution stages ({APK}):')
    for s in sorted(stages):
        print(f'  Ship{s} {SHIP_FILE.get(s, "?"):<11} {stages[s]}')

    print('\nreading sprites...')
    env = UnityPy.load(ASSETS)
    found = {}
    for o in env.objects:
        if o.type.name != 'Sprite':
            continue
        try:
            d = o.read()
        except Exception:
            continue
        name = d.m_Name or ''
        for ship, (pat, off) in SPRITE_SETS.items():
            m = pat.match(name)
            if not m:
                continue
            stage = int(m.group(1) or '1') + off
            area = d.image.width * d.image.height
            prev = found.get((ship, stage))
            # Several sets ship at two resolutions (@0.5x / @1x); take the larger, same reasoning
            # as the node icons -- the UI draws these small, and downscaling beats upscaling.
            if prev is None or area > prev[1]:
                found[(ship, stage)] = (d, area)
            break

    have = {}
    for (ship, stage) in found:
        have.setdefault(ship, []).append(stage)
    for v in have.values():
        v.sort()

    print(f'resolved {len(found)} sprite(s) across {len(have)} ship(s)')
    for ship in sorted(have):
        sizes = sorted({f'{found[(ship, st)][0].image.width}x{found[(ship, st)][0].image.height}'
                        for st in have[ship]})
        print(f'  {ship:<11} evo {have[ship]}   {", ".join(sizes)}')

    # THE CHECK THAT MAKES THE CATEGORY MAPPING EVIDENCE RATHER THAN A GUESS: each ship's sprite
    # set must equal the stage list FleetManager declares for it. "TechUpgrades sounds like
    # Auxesia" is not a source. "TechUpgrades has exactly Auxesia's five declared stages" is.
    problems = []
    for sid, decl in stages.items():
        name = SHIP_FILE.get(sid)
        if not name:
            continue
        got = have.get(name, [])
        if got != decl:
            problems.append(f'{name}: declares {decl}, sprites give {got}')
    if problems:
        print('\nMISMATCH between declared stages and sprite sets:')
        for p in problems:
            print(f'  {p}')
        sys.exit('refusing to write -- a mismatch means the category-to-ship mapping is wrong, and '
                 "writing anyway would show users another ship's artwork")

    if args.write:
        os.makedirs(OUT_DIR, exist_ok=True)
        for (ship, stage), (d, _) in sorted(found.items()):
            d.image.save(os.path.join(OUT_DIR, f'{ship}-evo{stage}.png'))
        ref = {
            '_source': 'sharedassets0 sprites, checked against FleetManager Ship<n>Evolution<m>',
            '_game': APK,
            '_meaning': ('per-ship evolution stages and therefore which artwork exists; stage '
                         'counts are NOT uniform (Cradle 8 ... Demeter 4)'),
            'ships': {
                SHIP_FILE[s]: {'stages': stages[s], 'maxStage': max(stages[s])}
                for s in sorted(stages) if s in SHIP_FILE
            },
        }
        with open(REF, 'w', encoding='utf-8') as fh:
            json.dump(ref, fh, indent=2)
        print(f'\nwrote {len(found)} PNG(s) to {OUT_DIR}')
        print(f'wrote {REF}')
    else:
        print('\n(report only -- pass --write)')


if __name__ == '__main__':
    sys.exit(main())
