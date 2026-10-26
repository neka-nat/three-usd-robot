#!/usr/bin/env python3
"""Deterministic headless capture of a three-usd-robot demo frame (M32).

    python3 scripts/reference/capture_demo.py <url> <out.png> \
        [--eye x,y,z --target x,y,z] [--size WxH] [--ao=0|1] [--traa=0|1] \
        [--env f] [--exposure f] [--js 'return v.scene.children.length'] [--gui]

Works against `examples/vite-usd-inspector` and `examples/vite-webgpu-viewer`
(`npm run dev` first; the inspector serves /calibration/*.usda, e.g.
`http://127.0.0.1:5173/?asset=/calibration/rect_15000.usda`). It waits for the
status line, positions the camera, stops the render loop, draws one frame
through `window.__usdViewer.renderOnce()` and reads the WebGL canvas, so a
software-GL browser cannot race it. `--js` runs a snippet with the viewer
internals as `v` before rendering (its return value is printed).

Needs Playwright (`pip install playwright && playwright install chromium`).
Software GL via SwiftShader is fine (a frame takes seconds, not milliseconds).
With TRAA enabled a single frame is dominated by its history — the script
switches it off unless `--traa=1`.
"""

from __future__ import annotations

import argparse
import base64
import sys
import time

from playwright.sync_api import sync_playwright

CHROMIUM_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
]


def vec(text: str) -> list[float]:
    return [float(v) for v in text.split(",")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url")
    parser.add_argument("out")
    parser.add_argument("--eye", type=vec)
    parser.add_argument("--target", type=vec)
    parser.add_argument("--size", default="1280x800")
    parser.add_argument("--ao", type=int)
    parser.add_argument("--traa", type=int, default=0)
    parser.add_argument("--env", type=float, help="scene.environmentIntensity override")
    parser.add_argument("--exposure", type=float, help="renderer.toneMappingExposure override")
    parser.add_argument("--js", help="snippet run with the viewer internals as `v` before rendering")
    parser.add_argument("--gui", action="store_true", help="keep helpers (grid) visible")
    parser.add_argument("--timeout", type=float, default=300, help="seconds to wait for the asset")
    args = parser.parse_args()
    width, height = (int(v) for v in args.size.split("x"))

    errors: list[str] = []
    logs: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=CHROMIUM_ARGS)
        page = browser.new_page(viewport={"width": width, "height": height})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on(
            "console",
            lambda m: logs.append(m.text)
            if m.type in ("warning", "error") and "GL Driver" not in m.text
            else None,
        )
        page.goto(args.url, wait_until="domcontentloaded")
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            text = page.evaluate("document.getElementById('status')?.textContent || ''")
            if text and "loading" not in text and "fetching" not in text and "failed" not in text:
                break
            time.sleep(1)
        print("status:", page.evaluate("document.getElementById('status')?.textContent || ''"))
        page.evaluate("() => window.__usdViewer.renderer.setAnimationLoop(null)")
        if args.eye and args.target:
            page.evaluate(
                "([e, t]) => { const v = window.__usdViewer; v.camera.position.set(e[0], e[1], e[2]);"
                " v.controls.target.set(t[0], t[1], t[2]); v.controls.update(); }",
                [args.eye, args.target],
            )
        if args.ao is not None:
            page.evaluate("(on) => { window.__usdViewer.lighting.ambientOcclusion = on; }", bool(args.ao))
        page.evaluate(
            "(on) => { const v = window.__usdViewer; if (v.post && v.post.traa !== on) { v.post.traa = on; v.rebuild(); } }",
            bool(args.traa),
        )
        if args.env is not None:
            page.evaluate(
                "(e) => { const s = window.__usdViewer.scene; s.environmentIntensity = e; s.backgroundIntensity = e; }",
                args.env,
            )
        if args.exposure is not None:
            page.evaluate("(e) => { window.__usdViewer.renderer.toneMappingExposure = e; }", args.exposure)
        if args.js:
            print("js:", page.evaluate("(src) => JSON.stringify((new Function('v', src))(window.__usdViewer))", args.js))
        if not args.gui:
            page.evaluate(
                "() => { window.__usdViewer.scene.traverse(o => { if (o.type === 'GridHelper') o.visible = false; }); }"
            )
        started = time.time()
        data = page.evaluate(
            "() => { const v = window.__usdViewer; v.renderOnce(); return v.renderer.domElement.toDataURL('image/png'); }"
        )
        print(f"rendered one frame in {time.time() - started:.1f}s")
        with open(args.out, "wb") as f:
            f.write(base64.b64decode(data.split(",", 1)[1]))
        browser.close()
    print("errors:", errors[:3])
    print("console:", [line[:200] for line in logs[:6]])
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
