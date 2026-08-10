"""Cut a ship's 11 node glyphs out of an in-game screenshot into assets/nodes/ icons.

The wiki (cifi.fandom.com) has per-ship pages for Cradle/Auxesia/Zagreus/Hephaestus/Demeter, and
those node icons were downloaded from it. It has no Koios or Zeus page, so those have to come off
a screenshot of the in-game node grid instead. This produces assets matching the wiki set's
convention: the GLYPH ONLY (no hexagon frame, no level pill), keyed to transparency, trimmed to
its bounding box, max dimension 128, RGBA PNG.

    python tools/assets/extract-node-icons.py <screenshot.png> <outdir>

Then eyeball the output against the ship's existing icons before copying it in -- several of the
steps below are thresholds, and a screenshot from a different device or theme may need retuning.
Verify the numbering too: for Zeus, 7 of the 11 already had (low-resolution) art, and matching
each new crop against it is what confirmed the grid-position -> node-code permutation rather than
assuming it.

Currently hardcodes Zeus's ordering via GRID_TO_CODE at the bottom; that permutation is
ship-independent (see shipsPage.js), but the output filenames are not, so change the prefix when
using this for Koios.
"""
from PIL import Image
import numpy as np
from scipy import ndimage
import os, sys

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

img = Image.open(SRC).convert('RGB')
a = np.asarray(img).astype(float)

# --- locate the 11 hex cells -------------------------------------------------------------
# Hex interiors are bluish; the page background is greenish-grey. That one difference finds the
# cells without hardcoding pixel coordinates, so a re-shot screenshot still works.
R, G, B = a[..., 0], a[..., 1], a[..., 2]
cellmask = (B - R) > 6
cellmask = ndimage.binary_closing(cellmask, np.ones((5, 5)))
cellmask = ndimage.binary_opening(cellmask, np.ones((3, 3)))
lab, n = ndimage.label(cellmask)
boxes = []
for i, sl in enumerate(ndimage.find_objects(lab), start=1):
    ys, xs = sl
    if (xs.stop - xs.start) >= 45 and (ys.stop - ys.start) >= 45 and (lab[sl] == i).sum() > 1200:
        boxes.append((xs.start, ys.start, xs.stop, ys.stop))
if len(boxes) != 11:
    raise SystemExit(f'expected 11 hex cells, found {len(boxes)} -- refusing to guess')

# Reading order = grid position order (the 4/3/4 honeycomb), NOT the node code.
boxes.sort(key=lambda b: (round(b[1] / 40), b[0]))

# Uniform window per cell so the 11 can be stacked and compared pixel-for-pixel below. The level
# pill starts ~93px down; 92 keeps the whole hexagon and none of the pill.
CW, CH = 140, 92
def smoothstep(v, lo, hi):
    t = np.clip((v - lo) / float(hi - lo), 0, 1)
    return t * t * (3 - 2 * t)

cells, rois, alphas, bgs, seeds = [], [], [], [], []
for (x0, y0, x1, y1) in boxes:
    cell = a[y0:y0 + CH, x0:x0 + CW]
    hexmask = ndimage.binary_fill_holes(cellmask[y0:y0 + CH, x0:x0 + CW])
    # Seal notches where a stroke runs out to the frame, else fill_holes leaves a gap that the
    # erosion then reams inward through, taking glyph with it.
    hexmask = ndimage.binary_closing(hexmask, np.ones((15, 15)))
    # Two insets. The WIDE one keeps a glyph's full extent; the TIGHT one is eroded past the
    # hexagon's inner rim so it contains glyph only. The tight mask is used purely as a seed
    # below -- eroding this far in one step would clip the widest glyphs.
    roi = ndimage.binary_erosion(hexmask, np.ones((7, 7)))
    seed_roi = ndimage.binary_erosion(hexmask, np.ones((27, 27)))

    lum = cell.max(axis=2)
    chroma = cell.max(axis=2) - cell.min(axis=2)

    # Separate glyph from background with a TOP-HAT rather than a brightness level. A global
    # level cannot work: above the hexagon's inner glow and the dim glyphs (grid 1's refinery,
    # grid 6's robot) are shredded; below it and the glow keys in and every icon comes out as a
    # full-ROI rectangle. Strokes are THIN while the fill and its vignette are SMOOTH, and a
    # white top-hat keys on exactly that difference, independent of how bright a glyph is.
    alpha = np.maximum(smoothstep(ndimage.white_tophat(lum, size=11), 7, 28),
                       smoothstep(ndimage.white_tophat(chroma, size=11), 9, 34)) * roi

    flat = roi & (chroma < 18) & (lum < 90)
    bgs.append(np.median(cell[flat], axis=0) if flat.sum() > 50 else np.array([24., 32., 41.]))
    cells.append(cell); rois.append(roi); alphas.append(alpha); seeds.append(seed_roi)

# --- remove the hexagon frame -------------------------------------------------------------
# The frame is a thin bright outline set ~10px inside the hex edge. Three approaches failed
# before this one, and the reasons are worth keeping:
#   * erode until it is gone -- it sits far enough in that clearing it also clips the widest
#     glyphs (grid 1's refinery loses its bottom bar);
#   * drop components that hug the ROI boundary -- a glyph that runs out and merges with the
#     frame becomes one component, so cell 1 emptied completely;
#   * subtract the per-pixel median across the 11 cells -- the frame IS identical everywhere,
#     but the glyphs are all centred too, so the median contains glyph mass and subtracting it
#     gutted every icon.
# What works: keep the full-extent mask, but only those components that reach into a mask eroded
# past the rim. The frame never does; every glyph does.
MAX_DIM = 128

GRID_TO_CODE = [8, 4, 6, 9, 2, 1, 3, 10, 7, 5, 11]  # from shipsPage.js -- grid position != code

for idx, (cell, roi, alpha, bg, seed_roi) in enumerate(zip(cells, rois, alphas, bgs, seeds), start=1):
    solid = alpha > 0.35
    slab, sn = ndimage.label(solid)
    if sn:
        keep_ids = []
        for i in range(1, sn + 1):
            comp = slab == i
            if int(comp.sum()) < 10:
                continue
            if not (comp & seed_roi).any():
                continue    # never reaches past the rim -> it is the frame, not a glyph
            keep_ids.append(i)
        if not keep_ids:
            raise SystemExit(f'cell {idx}: every component looked like frame')
        alpha = alpha * ndimage.binary_dilation(np.isin(slab, keep_ids), np.ones((3, 3)))

    # Tighten the edge before un-compositing. The top-hat key is a good detector but a loose
    # coverage estimate: it hands partial alpha to pixels that are mostly background, and
    # un-compositing then leaves the hex fill's dark grey sitting in the fringe -- a visible halo
    # once the icon is drawn over anything lighter. Raising alpha to a power pulls those low
    # values down without touching the solid core.
    alpha = np.clip(alpha, 0, 1) ** 1.8

    # Un-composite: every pixel is stroke-over-background, so recovering the stroke's true colour
    # keeps semi-transparent edges from carrying the dark hex fill into the final asset.
    al = np.clip(alpha, 1e-3, 1)[..., None]
    colour = np.clip(bg + (cell - bg) / al, 0, 255)

    out = Image.fromarray(np.dstack([colour, alpha * 255]).astype(np.uint8), 'RGBA')
    bbox = out.getbbox()
    if not bbox:
        raise SystemExit(f'cell {idx} produced an empty glyph')
    out = out.crop(bbox)
    w, h = out.size
    scale = MAX_DIM / float(max(w, h))
    out = out.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    code = GRID_TO_CODE[idx - 1]
    path = os.path.join(OUT, f'ZEUS{code}.png')
    out.save(path, optimize=True)
    print(f'grid {idx:>2} -> ZEUS{code}.png  {out.size[0]}x{out.size[1]}  {os.path.getsize(path)}b')
