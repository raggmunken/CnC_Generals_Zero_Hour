"""Turn a generated art sheet into the engine's sprite atlas.

    python3 tools/import-sheet.py <generated.png> [client/public/sprites.png]

Image models hand back an 8x3 sheet with the transparency checkerboard *painted
in* -- they draw the pattern rather than writing an alpha channel. This keys
that checkerboard out, then does the four things that make art usable in the
engine but that no image model will do reliably: force units and buildings to
neutral greyscale (the renderer multiplies them by the player colour),
normalise every sprite's scale and centring within its cell, make the terrain
tiles wrap seamlessly, and premultiply on the way down to 128px so edges do not
pick up a grey fringe.

Needs numpy, scipy and Pillow: pip install numpy scipy Pillow
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

SRC = sys.argv[1] if len(sys.argv) > 1 else 'assets/generated-sheet.png'
DST = sys.argv[2] if len(sys.argv) > 2 else 'client/public/sprites.png'
OUT_CELL = 128
TERRAIN = {(0, 0), (0, 1), (0, 2), (0, 3), (0, 4)}
BLANK = {(2, 7)}                      # generator watermark; cell is unused
OVERLAY = {(2, 4), (2, 5), (2, 6)}    # supply / selection / rally keep their colour

src = np.asarray(Image.open(SRC).convert('RGB')).astype(np.int16)
H, W, _ = src.shape
if W % 8 or H % 3:
    sys.exit(f'{SRC} is {W}x{H}; expected an 8-column by 3-row grid')
SRC_CELL = W // 8
if H // 3 != SRC_CELL:
    sys.exit(f'{SRC} cells are {SRC_CELL}x{H // 3}; they must be square')
r, g, b = src[..., 0], src[..., 1], src[..., 2]
grey = (np.abs(r - g) < 8) & (np.abs(g - b) < 8) & (np.abs(r - b) < 8)
light, dark = grey & (np.abs(r - 185) <= 10), grey & (np.abs(r - 127) <= 10)
tone = light | dark
loose = grey & (r >= 110) & (r <= 205)
# Two keyings, intersected. The loose one floods mid-grey anti-aliasing but can
# run down a flat-grey gun barrel into the sprite; the strict one stops at exact
# checker tones but mistakes a building's grey interior for background. Neither
# fails on true background, so the intersection keeps both sprites whole.
# Flood only through pixels whose own neighbourhood is mostly checker tone. The
# thin anti-aliased lines between checker squares qualify, so the flood spans
# the whole background; the flat mid-grey of a gun barrel does not, so the flood
# stops at the sprite instead of running down the barrel and eating it.
# The drawn art is olive-tinted (blue channel sits below the others); the
# generator's background — checker squares and the flat grey smears where it
# blurred them — is perfectly neutral. Let the flood through either territory it
# is sure of, and it stops at the sprite instead of running down a gun barrel.
neutral = (np.abs(r - b) <= 3) & (np.abs(r - g) <= 3) & (r >= 135) & (r <= 195)
loose &= (ndimage.uniform_filter(tone.astype(float), 9) > 0.40) | neutral
# A window that is nearly all checker tone *and* carries both tones is
# certainly background; flat grey on a sprite fails the both-tones test.
core = ((ndimage.uniform_filter(tone.astype(float), 25) > 0.90)
        & (ndimage.uniform_filter(light.astype(float), 25) > 0.25)
        & (ndimage.uniform_filter(dark.astype(float), 25) > 0.25))


def flood(mask, seed):
    """The connected regions of `mask` that a certain-background pixel reaches."""
    lbl, n = ndimage.label(mask)
    if n == 0:
        return np.zeros(mask.shape, bool)
    ids = lbl[seed]
    keep = np.zeros(n + 1, bool)
    keep[np.unique(ids[ids > 0])] = True
    return keep[lbl]


def resize_rgba(rgb, alpha, size):
    """Premultiplied resize, so transparent pixels cannot bleed grey fringes in."""
    a = alpha.astype(np.float64) / 255.0
    pm = np.dstack([rgb * a[..., None], alpha]).astype(np.uint8)
    out = np.asarray(Image.fromarray(pm, 'RGBA').resize(size, Image.LANCZOS)).astype(np.float64)
    oa = out[..., 3:4] / 255.0
    return np.clip(np.divide(out[..., :3], np.where(oa > 0, oa, 1), where=True), 0, 255), out[..., 3]


def seamless(tile):
    """Roll the wrap point into the interior, then heal the resulting cross by
    cross-fading with its own mirror — the mirror is continuous on its axis."""
    t = np.roll(tile, (tile.shape[0] // 2, tile.shape[1] // 2), axis=(0, 1)).astype(np.float64)
    n, band = tile.shape[0], 28
    c = n // 2
    ramp = np.clip(1 - np.abs(np.arange(-band, band) + 0.5) / band, 0, 1) ** 0.8
    sl = slice(c - band, c + band)
    w = ramp[None, :, None]
    t[:, sl] = t[:, sl] * (1 - w) + t[:, sl][:, ::-1] * w
    w = ramp[:, None, None]
    t[sl] = t[sl] * (1 - w) + t[sl][::-1] * w
    return t


out = np.zeros((3 * OUT_CELL, 8 * OUT_CELL, 4), np.uint8)
for row in range(3):
    for col in range(8):
        if (row, col) in BLANK:
            continue
        ys, xs = slice(row * SRC_CELL, (row + 1) * SRC_CELL), slice(col * SRC_CELL, (col + 1) * SRC_CELL)
        rgb = src[ys, xs].astype(np.float64)
        dst = (slice(row * OUT_CELL, (row + 1) * OUT_CELL), slice(col * OUT_CELL, (col + 1) * OUT_CELL))

        if (row, col) in TERRAIN:
            inner = rgb[2:SRC_CELL - 2, 2:SRC_CELL - 2]
            small = np.asarray(Image.fromarray(inner.astype(np.uint8)).resize((OUT_CELL, OUT_CELL), Image.LANCZOS))
            out[dst[0], dst[1], :3] = np.clip(seamless(small), 0, 255).astype(np.uint8)
            out[dst[0], dst[1], 3] = 255
            continue

        seed = core[ys, xs]
        bg = flood(loose[ys, xs], seed)
        keep = ~bg
        # Drop specks, and drop any island that is itself checkerboard: a
        # leftover patch is almost entirely the two exact checker tones with
        # both well represented, which no drawn sprite region is.
        lbl, n = ndimage.label(keep)
        if n:
            idx = np.arange(1, n + 1)
            sizes = ndimage.sum(keep, lbl, idx)
            ft = ndimage.mean(tone[ys, xs].astype(float), lbl, idx)
            fl = ndimage.mean(light[ys, xs].astype(float), lbl, idx)
            fd = ndimage.mean(dark[ys, xs].astype(float), lbl, idx)
            # ...and drop flat grey islands: the generator smeared some checker
            # squares into a featureless mid-grey that the tone test misses.
            mr = ndimage.mean(rgb[..., 0], lbl, idx)
            mg = ndimage.mean(rgb[..., 1], lbl, idx)
            mb = ndimage.mean(rgb[..., 2], lbl, idx)
            sd = ndimage.standard_deviation(rgb[..., 0], lbl, idx)
            checker = (ft > 0.70) & (np.minimum(fl, fd) > 0.15)
            smear = ((sd < 12) & (np.abs(mr - mg) < 6) & (np.abs(mg - mb) < 6)
                     & (mr > 138) & (mr < 182))
            good = (sizes >= 40) & ~checker & ~smear
            keep = np.isin(lbl, idx[good])
        if not keep.any():
            continue
        # Each cell holds one object. Keep the body and anything close enough to
        # belong to it (a severed barrel tip); discard distant slivers, which are
        # keying residue and would otherwise skew the bounding box.
        lbl, n = ndimage.label(keep)
        idx = np.arange(1, n + 1)
        sizes = ndimage.sum(keep, lbl, idx)
        body = idx[np.argmax(sizes)]
        near = ndimage.binary_dilation(lbl == body, np.ones((3, 3)), iterations=7)
        boxes = ndimage.find_objects(lbl)
        touch = {body}
        for i, sl in enumerate(boxes, start=1):
            if i == body or sl is None or not (near & (lbl == i)).any():
                continue
            h, w_ = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
            if min(h, w_) > 4:          # a hairline is keying residue, not art
                touch.add(i)
        keep = np.isin(lbl, sorted(touch))
        if not keep.any():
            continue

        if (row, col) not in OVERLAY:
            # The engine multiplies these by the player colour, so they have to
            # be neutral, and they have to be bright: the generated art sits
            # around 40% grey, and 40% of a mid-red is nearly black on screen.
            lum = rgb @ (0.299, 0.587, 0.114)
            lum = 255.0 * np.clip(lum / 255.0, 0, 1) ** 0.60
            rgb = np.dstack([lum, lum, lum])

        yy, xx = np.where(keep)
        y0, y1, x0, x1 = yy.min(), yy.max() + 1, xx.min(), xx.max() + 1
        crop_rgb, crop_a = rgb[y0:y1, x0:x1], np.where(keep, 255, 0).astype(np.uint8)[y0:y1, x0:x1]
        h, w_ = y1 - y0, x1 - x0
        scale = (OUT_CELL - 10) / max(h, w_)
        nw, nh = max(1, round(w_ * scale)), max(1, round(h * scale))
        cr, ca = resize_rgba(crop_rgb, crop_a, (nw, nh))
        oy, ox = (OUT_CELL - nh) // 2, (OUT_CELL - nw) // 2
        cell = np.zeros((OUT_CELL, OUT_CELL, 4), np.uint8)
        cell[oy:oy + nh, ox:ox + nw, :3] = cr.astype(np.uint8)
        cell[oy:oy + nh, ox:ox + nw, 3] = ca.astype(np.uint8)
        out[dst[0], dst[1]] = cell

Image.fromarray(out, 'RGBA').save(DST)
print(f'wrote {DST} {out.shape[1]}x{out.shape[0]}')
# Composite over magenta: any checkerboard the keying missed is then obvious,
# which looking at the RGBA file in a viewer will not tell you.
a = out[..., 3:4] / 255.0
check = (out[..., :3] * a + np.array([255, 0, 255]) * (1 - a)).astype(np.uint8)
Image.fromarray(check).save('/tmp/sheet-check.png')
print('keying check (magenta = transparent): /tmp/sheet-check.png')
