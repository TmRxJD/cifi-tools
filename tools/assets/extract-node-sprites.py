"""Extract the GAME'S OWN ship-install-node icons from the APK.

    CIFI_APK=apk-0.7.3.61 python tools/assets/extract-node-sprites.py [--write]

WHY. webapp/public/assets/nodes/*.png were cropped by hand from cifi.fandom.com pages and from
in-game screenshots -- 77 files at mixed sizes (Koios still 55x65 against the wiki set's ~128px),
with visible compression artifacts and background bleed. The game ships the real sprites at 256px,
so cropping was never necessary; nobody had looked.

THE KEY IS THE ruId, NOT THE INSTALL CODE, AND CONFUSING THEM IS A KNOWN TRAP IN THIS REPO.
The game names its sprites `RU-<Category><n>-256`, where n is the RU registry id -- the same
numbering as `RU<n><Category>Requirement`, the tooltip index and the authored coefficients. Our
catalog is keyed by the COMMUNITY install code, and the two differ on 15 nodes (Cradle's codes
9/11 carry ruIds 11/9, and Zeus 10/11 are likewise swapped). Indexing by code produced 15 false
mismatches when the node NAMES were checked the same way, so this reads `ruId` from the shipped
catalog and never assumes identity.

Two sizes exist for most nodes (-128 and -256) and a few also have -64. We take the LARGEST
available per node: the UI renders these small, but a browser downscaling a 256px source looks
better than one upscaling a 64px crop, which is the actual complaint.

OUTPUT IS A REPORT BY DEFAULT. `--write` is required to touch webapp/public/assets/nodes/, and it
reports every node it could NOT find rather than silently leaving a stale hand-cropped file in
place -- a mix of real and cropped assets with no record of which is which is worse than either.
"""
import argparse
import io
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
OUT_DIR = os.path.join(REPO, 'webapp', 'public', 'assets', 'nodes')
SHIPS_JS = os.path.join(REPO, 'webapp', 'public', 'shipsPage.js')

# Mirrors SHIP_CATEGORY / SHIP_CODE_PREFIX in shipsPage.js. Ouroboros (8) is deliberately absent:
# it has no catalog entry and no icon prefix, so it has nothing to extract.
SHIP_CATEGORY = {1: 'Gen', 2: 'Tech', 3: 'Loop', 4: 'Auto', 5: 'Shard', 6: 'Research', 7: 'Academy'}
SHIP_PREFIX = {1: 'CRA', 2: 'AUX', 3: 'ZAG', 4: 'HEP', 5: 'DEM', 6: 'KOI', 7: 'ZEUS'}

# THE ART'S CATEGORY NAMES ARE NOT THE CODE'S CATEGORY NAMES, and assuming they were is what made
# the first run report Koios and Zeus -- 22 nodes -- as having no game sprite at all. The RU sprite
# families actually present are Gen, Tech, Loop, Auto, Shard, Res, Zeus and Ouro: `Research` is
# abbreviated to `Res`, and `Academy` is named for its SHIP (Zeus) rather than its category, which
# is the game's own inconsistency and not ours to correct.
#
# Worth stating because the failure was silent in the dangerous direction: a missing sprite leaves
# the hand-cropped file in place and looks like "the game doesn't ship these", which is exactly the
# conclusion the old comment drew when it cut Koios and Zeus from screenshots instead.
SPRITE_CATEGORY = {'Research': 'Res', 'Academy': 'Zeus'}


def parse_catalog():
    """Read (ship, code) -> ruId out of the SHIPPED catalog.

    Parsed from shipsPage.js rather than duplicated here: a second copy of the code->ruId mapping
    would drift, and it is precisely the mapping that must not be guessed. If the parse finds
    nothing the script FAILS rather than falling back to `ruId == code`, because that fallback is
    exactly the wrong answer for the 15 nodes where they differ.
    """
    src = io.open(SHIPS_JS, encoding='utf-8').read()
    start = src.index('const SHIP_NODE_CATALOG')
    end = src.index('\n};', start)
    body = src[start:end]

    out = {}
    ship = None
    for line in body.splitlines():
        m_ship = re.match(r'\s{2}(\d+):\s*\{', line)
        if m_ship:
            ship = int(m_ship.group(1))
            continue
        m_node = re.match(r'\s{4}(\d+):\s*\{(.*)$', line)
        if m_node and ship is not None:
            code = int(m_node.group(1))
            m_ru = re.search(r'ruId:\s*(\d+)', m_node.group(2))
            if m_ru:
                out[(ship, code)] = int(m_ru.group(1))
    if not out:
        sys.exit('parsed ZERO catalog entries -- the catalog format changed; fix this parser '
                 'rather than assuming ruId == code (it differs on 15 nodes)')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true', help='write PNGs into webapp/public/assets/nodes/')
    args = ap.parse_args()

    if not os.path.exists(ASSETS):
        sys.exit(f'missing {ASSETS} -- pull the APK first (see tools/gamefiles/README.md)')

    catalog = parse_catalog()
    print(f'catalog: {len(catalog)} nodes across {len(set(s for s, _ in catalog))} ships ({APK})')

    # Index every RU sprite by (category, ruId) -> {size: object}, keeping all sizes so the largest
    # can be chosen per node rather than assuming 256 exists for all of them.
    env = UnityPy.load(ASSETS)
    sprites = {}
    pat = re.compile(r'^RU-([A-Za-z]+)(\d+)-(\d+)$')
    for obj in env.objects:
        if obj.type.name != 'Sprite':
            continue
        try:
            data = obj.read()
        except Exception:
            continue
        m = pat.match(data.m_Name or '')
        if not m:
            continue
        cat, ru, size = m.group(1), int(m.group(2)), int(m.group(3))
        sprites.setdefault((cat, ru), {})[size] = data
    print(f'sprites: {len(sprites)} distinct RU icons found')

    if args.write:
        os.makedirs(OUT_DIR, exist_ok=True)

    written, missing = [], []
    for (ship, code), ru in sorted(catalog.items()):
        cat = SHIP_CATEGORY.get(ship)
        prefix = SHIP_PREFIX.get(ship)
        if not cat or not prefix:
            continue
        art = SPRITE_CATEGORY.get(cat, cat)
        found = sprites.get((art, ru))
        name = f'{prefix}{code}'
        if not found:
            missing.append(f'{name} (RU-{art}{ru})')
            continue
        best = max(found)
        if args.write:
            path = os.path.join(OUT_DIR, f'{name}.png')
            found[best].image.save(path)
        written.append((name, f'RU-{art}{ru}-{best}', best))

    by_size = {}
    for _, _, size in written:
        by_size[size] = by_size.get(size, 0) + 1
    print(f'\n{"WROTE" if args.write else "WOULD WRITE"} {len(written)} icon(s): '
          + ', '.join(f'{n}x{s}px' for s, n in sorted(by_size.items(), reverse=True)))
    for name, src, _ in written[:5]:
        print(f'  {name:<7} <- {src}')
    if len(written) > 5:
        print(f'  ... and {len(written) - 5} more')

    if missing:
        # REPORTED, NEVER SILENT. A node left without a game sprite keeps whatever hand-cropped file
        # is already there, and a set that is half real and half cropped with no record of which is
        # which is worse than either -- so the gap is named.
        print(f'\nNO GAME SPRITE for {len(missing)} node(s) -- these keep their existing asset:')
        for m in missing:
            print(f'  {m}')
    if not args.write:
        print('\n(report only -- pass --write to replace the hand-cropped assets)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
