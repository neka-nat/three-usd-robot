#!/usr/bin/env python3
"""Compare a reference render (e.g. Isaac Sim RTX) with a three-usd-robot capture (M32).

    python3 scripts/reference/compare.py ref.png test.png \
        [--crop-ref x,y,w,h] [--crop-test x,y,w,h] \
        [--region floor=0.3,0.75,0.4,0.2 --region wall=0.6,0.1,0.3,0.3 ...] \
        [--out diff.png] [--json result.json]

Both images are sRGB PNG/JPEG screenshots. The test image is resized to the
reference crop. Reported:

- SSIM (gray, Gaussian window, Wang et al. 2004) — structure agreement,
  0..1; only meaningful when both renders share the camera.
- mean dE76 in CIELAB — overall color/brightness distance (dE < 2.3 is a JND).
- per-region mean *linear* luminance (sRGB decoded) of ref and test, their
  ratio and the exposure factor (ref / test) that would match them; the
  geometric mean over regions is the single multiplier to apply.

Regions are x,y,w,h fractions (0..1) of the cropped frame, origin top-left.
Needs numpy, scipy and Pillow.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter


def parse_box(text: str) -> tuple[int, int, int, int]:
    x, y, w, h = (int(v) for v in text.split(","))
    return x, y, w, h


def parse_region(text: str) -> tuple[str, tuple[float, float, float, float]]:
    name, box = text.split("=", 1)
    x, y, w, h = (float(v) for v in box.split(","))
    return name, (x, y, w, h)


def load(path: str, crop: tuple[int, int, int, int] | None) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if crop:
        x, y, w, h = crop
        img = img.crop((x, y, x + w, y + h))
    return np.asarray(img).astype(np.float64) / 255.0


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def luminance(rgb_linear: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb_linear[..., 0] + 0.7152 * rgb_linear[..., 1] + 0.0722 * rgb_linear[..., 2]


def rgb_to_lab(rgb_srgb: np.ndarray) -> np.ndarray:
    lin = srgb_to_linear(rgb_srgb)
    m = np.array(
        [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]
    )
    xyz = lin @ m.T
    white = np.array([0.95047, 1.0, 1.08883])
    t = xyz / white
    f = np.where(t > (6 / 29) ** 3, np.cbrt(t), t / (3 * (6 / 29) ** 2) + 4 / 29)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def ssim(a: np.ndarray, b: np.ndarray, sigma: float = 1.5) -> float:
    """SSIM on gray images in 0..1 with a Gaussian window (sigma 1.5)."""
    c1 = (0.01) ** 2
    c2 = (0.03) ** 2
    mu_a = gaussian_filter(a, sigma)
    mu_b = gaussian_filter(b, sigma)
    var_a = gaussian_filter(a * a, sigma) - mu_a**2
    var_b = gaussian_filter(b * b, sigma) - mu_b**2
    cov = gaussian_filter(a * b, sigma) - mu_a * mu_b
    num = (2 * mu_a * mu_b + c1) * (2 * cov + c2)
    den = (mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2)
    return float(np.mean(num / den))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ref")
    parser.add_argument("test")
    parser.add_argument("--crop-ref", type=parse_box)
    parser.add_argument("--crop-test", type=parse_box)
    parser.add_argument("--region", action="append", type=parse_region, default=[])
    parser.add_argument("--out", help="side-by-side + |diff| heatmap PNG")
    parser.add_argument("--json", help="write the numbers as JSON")
    args = parser.parse_args()

    ref = load(args.ref, args.crop_ref)
    test = load(args.test, args.crop_test)
    if test.shape != ref.shape:
        test = (
            np.asarray(
                Image.fromarray((test * 255).astype(np.uint8)).resize((ref.shape[1], ref.shape[0]), Image.LANCZOS)
            ).astype(np.float64)
            / 255.0
        )

    gray_ref = luminance(srgb_to_linear(ref))
    gray_test = luminance(srgb_to_linear(test))
    result: dict = {
        "size": [int(ref.shape[1]), int(ref.shape[0])],
        "ssim": round(ssim(gray_ref, gray_test), 4),
        "mean_dE76": round(float(np.mean(np.linalg.norm(rgb_to_lab(ref) - rgb_to_lab(test), axis=-1))), 3),
        "mean_luminance": {"ref": round(float(gray_ref.mean()), 5), "test": round(float(gray_test.mean()), 5)},
        "regions": {},
    }
    factors = []
    h, w = gray_ref.shape
    for name, (fx, fy, fw, fh) in args.region:
        x0, y0 = int(fx * w), int(fy * h)
        x1, y1 = int((fx + fw) * w), int((fy + fh) * h)
        r = float(gray_ref[y0:y1, x0:x1].mean())
        t = float(gray_test[y0:y1, x0:x1].mean())
        ratio = t / r if r > 0 else float("nan")
        factor = r / t if t > 0 else float("nan")
        factors.append(factor)
        result["regions"][name] = {
            "ref": round(r, 5),
            "test": round(t, 5),
            "test_over_ref": round(ratio, 4),
            "exposure_factor": round(factor, 4),
        }
    if factors:
        finite = [f for f in factors if np.isfinite(f) and f > 0]
        if finite:
            result["exposure_factor_geomean"] = round(float(np.exp(np.mean(np.log(finite)))), 4)

    if args.out:
        diff = np.abs(gray_ref - gray_test)
        diff = diff / max(float(diff.max()), 1e-6)
        heat = np.stack([diff, diff * 0.4, 1 - diff], axis=-1)
        strip = np.concatenate([ref, test, heat], axis=1)
        Image.fromarray((np.clip(strip, 0, 1) * 255).astype(np.uint8)).save(args.out)
        result["diff_image"] = args.out

    print(json.dumps(result, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
