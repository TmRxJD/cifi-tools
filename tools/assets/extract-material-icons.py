"""Extract every hunter's three material icons from the APK.

    CIFI_APK=apk-0.7.3.61 python tools/assets/extract-material-icons.py [--write]

WHY. The standalone site shipped only BORGE's three material icons (`assets/loot_mat1..3.png`) and
served them for every hunter, so Ozzy's and Knox's cards showed Obsidian/Behlium/Hellish-Biomatter.
The extension looked right only because cifi-tools supplies its own per-hunter icons.

WHERE THEY ARE. One sprite family, `Hunt.<Material>`, named after the material itself -- and the
names match CostFormulas' per-hunter labels, which is what pins each sprite to a (hunter, mat)
slot rather than guessing by position:

    borge  Obsidian        Behlium          Hellish-Biomatter
    ozzy   Farahite Ore    Galvarium        Vectid Crystals
    knox   Glacium         Aquarius Quartz  Tesseracts

Three names differ from the label and are mapped explicitly below: the game spells the ore
`Farahyte`, calls Vectid Crystals `VectidEmerald`, and the Tesseract sprite is `NautilusTesseract`.
The asset set ALSO contains `Hunt.NautilusTeseract` (one 's') -- a typo'd duplicate -- so every
sprite is named exactly; a substring match would pick either at random.

OUTPUT: every icon trimmed to its visible pixels and fitted, centred, into a transparent 128x128
square. Native sprite sizes range from 56x58 to 218x208, and the UI draws them into square boxes,
so unnormalised art rendered at visibly different scales from one hunter to the next.

CROSS-CHECK, and why the first version of it was wrong. The committed Borge icons are cifi-tools'
own 77x77 RE-RENDERS of these sprites (their bundle ships them as `loot_mat1-<hash>.png`), so an
exact pixel comparison can never succeed -- and it duly refused to write, on correct data. What
actually establishes identity is RANK, not equality: each Borge sprite, normalised alongside the
three committed icons, must be closer to its OWN slot than to either other one. A wrong or
shuffled mapping fails that by construction, with no tuned threshold to argue about. It SKIPs once
the legacy files are gone; the result from when they were present is recorded in the git log.
"""
import argparse
import io
import os
import sys

try:
    import UnityPy
    from PIL import Image
except ImportError:
    sys.exit('UnityPy and Pillow are required: python -m pip install UnityPy Pillow')

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APK = os.environ.get('CIFI_APK', 'apk-0.7.3.61')
ASSET_DIR = os.path.join(REPO, 'tools', 'gamefiles', APK, 'assets')
PUBLIC = os.path.join(REPO, 'webapp', 'public', 'assets')
OUT_DIR = os.path.join(PUBLIC, 'materials')
OUT_SIZE = 128

SPRITES = {
    'borge': ['Hunt.Obsidian', 'Hunt.Behlium', 'Hunt.HellishBiomatter'],
    'ozzy': ['Hunt.FarahyteOre', 'Hunt.Galvarium', 'Hunt.VectidEmerald'],
    'knox': ['Hunt.Glacium', 'Hunt.AquariusQuartz', 'Hunt.NautilusTesseract'],
}
LEGACY_BORGE = ['loot_mat1.png', 'loot_mat2.png', 'loot_mat3.png']


def load_sprites(wanted):
    found = {}
    for name in sorted(os.listdir(ASSET_DIR)):
        path = os.path.join(ASSET_DIR, name)
        if os.path.isdir(path) or name.endswith(('.resS', '.resource')) or '.split' in name:
            continue
        try:
            env = UnityPy.load(path)
        except Exception:
            continue
        for obj in env.objects:
            if obj.type.name != 'Sprite':
                continue
            try:
                sprite = obj.read()
            except Exception:
                continue
            if sprite.m_Name in wanted and sprite.m_Name not in found:
                found[sprite.m_Name] = sprite.image
    return found


def normalize(img, size):
    """Trim to visible pixels, then fit (up or down) centred into a transparent size x size."""
    img = img.convert('RGBA')
    bbox = img.getchannel('A').getbbox()
    if bbox:
        img = img.crop(bbox)
    scale = min(size / img.width, size / img.height)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2), img)
    return canvas


def signature(img):
    # Composited onto a flat grey so fully-transparent pixels (whose RGB is arbitrary) cannot
    # contribute noise to the comparison.
    # Raw RGB bytes rather than getdata(), which Pillow deprecates for removal in Pillow 14.
    norm = normalize(img, 32)
    flat = Image.alpha_composite(Image.new('RGBA', norm.size, (128, 128, 128, 255)), norm).convert('RGB')
    return flat.tobytes()


def distance(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def cross_check(found):
    paths = [os.path.join(PUBLIC, f) for f in LEGACY_BORGE]
    if not all(os.path.exists(p) for p in paths):
        print('SKIP  cross-check: legacy Borge icons no longer present')
        return True
    committed = [signature(Image.open(p)) for p in paths]
    ok = True
    for i, name in enumerate(SPRITES['borge']):
        sig = signature(found[name])
        dists = [distance(sig, c) for c in committed]
        best = min(range(3), key=lambda j: dists[j])
        match = best == i
        ok &= match
        others = ', '.join(f'{LEGACY_BORGE[j]} {dists[j]:.1f}' for j in range(3) if j != i)
        print(f"{'ok  ' if match else 'FAIL'}  {name} closest to its own {LEGACY_BORGE[i]} "
              f"({dists[i]:.1f}) -- others: {others}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()
    if not os.path.isdir(ASSET_DIR):
        sys.exit(f'no extracted APK assets at {ASSET_DIR} (see tools/gamefiles/README.md)')

    wanted = {n for names in SPRITES.values() for n in names}
    found = load_sprites(wanted)
    missing = sorted(wanted - set(found))
    if missing:
        sys.exit(f'FAIL  sprites not found in {APK}: {", ".join(missing)}')
    if not cross_check(found):
        sys.exit('FAIL  a Borge sprite is not closest to its own committed icon -- mapping is wrong, not writing')

    for hunter, names in SPRITES.items():
        for i, name in enumerate(names, 1):
            src = found[name]
            print(f'      {hunter}_mat{i} <- {name:<24} native {src.width}x{src.height}')
            if args.write:
                os.makedirs(OUT_DIR, exist_ok=True)
                buf = io.BytesIO()
                normalize(src, OUT_SIZE).save(buf, 'PNG', optimize=True)
                with open(os.path.join(OUT_DIR, f'{hunter}_mat{i}.png'), 'wb') as f:
                    f.write(buf.getvalue())
    total = sum(map(len, SPRITES.values()))
    print(f"{'wrote' if args.write else 'dry run (pass --write) --'} {total} icons, {OUT_SIZE}x{OUT_SIZE}"
          f" -> {os.path.relpath(OUT_DIR, REPO)}")


if __name__ == '__main__':
    main()
