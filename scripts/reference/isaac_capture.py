#!/usr/bin/env python3
"""Render a USD stage in Isaac Sim (RTX) from a fixed camera to a PNG (M32).

Run with Isaac Sim's Python (standalone SimulationApp):

    ./python.sh scripts/reference/isaac_capture.py \
        --usd /path/to/three-usd-robot/examples/vite-usd-inspector/public/calibration/rect_15000.usda \
        --out rect_15000_isaac.png --eye -2.45,-2.45,2.25 --target 0,0,0.25 \
        [--renderer RaytracedLighting|RealTimePathTracing|PathTracing] [--spp 256] \
        [--tonemap Aces|Linear|Clamp] [--size 1280x800] [--warmup 60]

The same camera pose (eye / target, stage units, Z-up as authored) goes to
`capture_demo.py` on the three-usd-robot side; `compare.py` then reports the
luminance ratios. `--tonemap Linear` (or Clamp) gives measurement-friendly
output; Aces matches the viewer's default look.

Written against Isaac Sim 4.5 / 5.x APIs (`isaacsim.SimulationApp`,
`omni.kit.viewport.utility.capture_viewport_to_file`); not exercised in CI —
treat failures as API drift and check the release notes.
"""

from __future__ import annotations

import argparse
import sys
import time

TONEMAP_OPS = {
    # /rtx/post/tonemap/op index order per NVIDIA's kit-sample-extensions
    # render_settings.py (Isaac's own docs list Aces at index 4 — verify on
    # your build with the Render Settings panel).
    "Clamp": 0,
    "Linear": 1,
    "Reinhard": 2,
    "ReinhardModified": 3,
    "HejiHableAlu": 4,
    "HableUc2": 5,
    "Aces": 6,
    "Iray": 7,
}


def vec(text: str) -> list[float]:
    return [float(v) for v in text.split(",")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--usd", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--eye", type=vec, default=[-2.45, -2.45, 2.25])
    parser.add_argument("--target", type=vec, default=[0.0, 0.0, 0.25])
    parser.add_argument("--renderer", default="RaytracedLighting")
    parser.add_argument("--spp", type=int, default=256, help="path-tracing samples (PathTracing only)")
    parser.add_argument("--tonemap", default="Aces", choices=sorted(TONEMAP_OPS))
    parser.add_argument("--size", default="1280x800")
    parser.add_argument("--warmup", type=int, default=60, help="frames to render before capturing")
    args = parser.parse_args()
    width, height = (int(v) for v in args.size.split("x"))

    try:
        from isaacsim import SimulationApp  # Isaac Sim 4.5+
    except ImportError:  # pragma: no cover - older releases
        from omni.isaac.kit import SimulationApp  # type: ignore

    app = SimulationApp(
        {"headless": True, "renderer": args.renderer, "width": width, "height": height, "anti_aliasing": 3}
    )
    try:
        import carb
        import omni.usd
        from omni.kit.viewport.utility import capture_viewport_to_file, get_active_viewport

        try:
            from isaacsim.core.utils.viewports import set_camera_view
        except ImportError:  # pragma: no cover
            from omni.isaac.core.utils.viewports import set_camera_view  # type: ignore

        settings = carb.settings.get_settings()
        settings.set("/rtx/post/tonemap/op", TONEMAP_OPS[args.tonemap])
        if args.renderer == "PathTracing":
            settings.set("/rtx/pathtracing/spp", 1)
            settings.set("/rtx/pathtracing/totalSpp", args.spp)

        context = omni.usd.get_context()
        if not context.open_stage(args.usd):
            print(f"failed to open {args.usd}", file=sys.stderr)
            return 1
        for _ in range(10):
            app.update()

        set_camera_view(eye=args.eye, target=args.target, camera_prim_path="/OmniverseKit_Persp")
        frames = max(args.warmup, args.spp if args.renderer == "PathTracing" else 0)
        started = time.time()
        for _ in range(frames):
            app.update()
        capture_viewport_to_file(get_active_viewport(), file_path=args.out)
        for _ in range(10):  # let the capture flush
            app.update()
        print(f"wrote {args.out} after {frames} frames ({time.time() - started:.1f}s)")
        return 0
    finally:
        app.close()


if __name__ == "__main__":
    sys.exit(main())
