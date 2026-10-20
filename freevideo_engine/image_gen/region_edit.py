"""Edit only a selected region of a picture.

The caller supplies the original picture and a mask (white = change). The
sampler keeps the unselected part of the latent on the original's own noise
path at every step, and the finished picture is blended over the original with
a feathered edge, so pixels outside the grown selection are the original's.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

LATENT_CELL = 16
DEFAULT_GROW = 24
DEFAULT_FEATHER = 16


def _odd(radius):
    return max(1, int(radius) * 2 + 1)


def grown_mask(mask, grow=DEFAULT_GROW):
    """Mask as an L image, selection grown by ``grow`` pixels."""
    if not isinstance(mask, Image.Image):
        raise ValueError("mask must be a PIL image")
    mask = mask.convert("L").point(lambda v: 255 if v >= 128 else 0)
    if grow > 0:
        mask = mask.filter(ImageFilter.MaxFilter(_odd(grow)))
    return mask


def lasso_mask(size, points):
    """A drawn curve closed by joining its last point to its first, filled."""
    mask = Image.new("L", size, 0)
    points = [(float(x), float(y)) for x, y in points]
    if len(points) >= 3:
        ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def combine_masks(size, added, removed=()):
    """Union of the added selections minus the union of the removed ones (L images, 255 = selected)."""
    result = np.zeros((size[1], size[0]), dtype=bool)
    for mask in added:
        result |= np.asarray(mask.convert("L").resize(size)) >= 128
    for mask in removed:
        result &= ~(np.asarray(mask.convert("L").resize(size)) >= 128)
    return Image.fromarray(result.astype(np.uint8) * 255, "L")


def selection_is_empty(mask):
    return not np.asarray(mask.convert("L")).max() >= 128


def latent_mask(mask, size, *, grow=DEFAULT_GROW, feather=DEFAULT_FEATHER):
    """1.0 on the latent cells the model may change, else 0.0, shaped (rows, cols).

    Covers the grown selection plus the feather, so the soft edge of the final
    blend lies inside regenerated content.
    """
    width, height = size
    base = grown_mask(mask.resize((width, height), Image.Resampling.NEAREST), grow + feather)
    array = np.asarray(base, dtype=np.uint8) > 0
    rows, cols = height // LATENT_CELL, width // LATENT_CELL
    cells = array[:rows * LATENT_CELL, :cols * LATENT_CELL].reshape(rows, LATENT_CELL, cols, LATENT_CELL)
    return cells.any(axis=(1, 3)).astype(np.float32)


def blend_alpha(mask, size, *, grow=DEFAULT_GROW, feather=DEFAULT_FEATHER):
    """Feathered 0..1 alpha at ``size``: 1 inside the grown selection, 0 beyond the feather."""
    resized = mask.resize(size, Image.Resampling.NEAREST)
    soft = grown_mask(resized, grow).filter(ImageFilter.GaussianBlur(feather / 2))
    alpha = np.asarray(soft, dtype=np.float32) / 255.0
    # The blur is centred on the grown edge: widen so the alpha reaches 1 inside the selection
    # and is exactly 0 where the latent mask no longer reaches.
    hard = np.asarray(grown_mask(resized, grow + feather), dtype=np.uint8) > 0
    alpha = np.where(hard, alpha, 0.0)
    return alpha


def composite(original, generated, alpha):
    """Original pixels where alpha is 0; generated pixels (resized to the original) where 1."""
    original = original.convert("RGB")
    if generated.size != original.size:
        generated = generated.resize(original.size, Image.Resampling.LANCZOS)
    src = np.asarray(original, dtype=np.float32)
    new = np.asarray(generated.convert("RGB"), dtype=np.float32)
    out = new * alpha[..., None] + src * (1.0 - alpha[..., None])
    result = np.asarray(original).copy()
    changed = alpha > 0
    result[changed] = np.clip(np.rint(out[changed]), 0, 255).astype(np.uint8)
    return Image.fromarray(result)
