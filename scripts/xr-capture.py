#!/usr/bin/env python3
"""Headless WebXR check of `examples/vite-xr-viewer` through the IWER emulator.

    python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1&asset=/factory.usda" out.png \
        [--frames 4] [--aim right|left] [--select] [--tabletop] [--grab] [--teach] [--ik] [--size WxH] [--profile DIR] [--timeout 300]

Steps: wait for the asset (status line) → click three's `VRButton` (IWER's
`navigator.xr` grants the immersive-vr session) → wait for N rendered XR
frames → optionally aim an emulated controller at the robot, pull the trigger
(`--select`), squeeze the left grip (`--tabletop`), grab the TCP handle with
the right grip (`--grab`), teach a loop by turning a joint (`--teach`) or drag
the handle around and check that the arm follows it (`--ik`; with `--no-xr`
the same through the desktop gizmo path) → read the viewer's `report()`
(frame stats, head height, robot floor contact, hover/selection) and
screenshot the stereo canvas. Prints a JSON report; exits 1 on page errors.

Needs Playwright (`pip install playwright && playwright install chromium`).
Software GL (SwiftShader) is fine — an XR frame takes seconds, not milliseconds,
so the frame-time numbers are *not* a performance measurement; use a headset for that.
`--profile DIR` keeps a persistent browser profile so CDN assets stay cached.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from playwright.sync_api import sync_playwright

CHROMIUM_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
]


def _dist(a: list[float] | None, b: list[float] | None) -> float:
    if not a or not b:
        return float("nan")
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url")
    parser.add_argument("out")
    parser.add_argument("--frames", type=int, default=4, help="XR frames to render before measuring")
    parser.add_argument("--aim", choices=["left", "right"], help="aim this emulated controller at the robot")
    parser.add_argument("--select", action="store_true", help="pull the aimed controller's trigger")
    parser.add_argument("--tabletop", action="store_true", help="squeeze the left grip (tabletop scale)")
    parser.add_argument("--grab", action="store_true", help="move the right controller onto the TCP handle, squeeze, drag 10 cm, let go")
    parser.add_argument("--teach", action="store_true", help="grab a link to turn its joint, record two waypoints, play the loop, export and re-parse")
    parser.add_argument("--ik", action="store_true", help="grab the TCP handle, drag it to reachable and unreachable targets, check the arm follows, record a waypoint")
    parser.add_argument("--size", default="1280x720")
    parser.add_argument("--profile", help="persistent browser profile directory (asset cache)")
    parser.add_argument("--no-xr", action="store_true", help="desktop view only: skip entering the XR session")
    parser.add_argument("--timeout", type=float, default=300, help="seconds to wait for the asset")
    args = parser.parse_args()
    width, height = (int(v) for v in args.size.split("x"))

    errors: list[str] = []
    logs: list[str] = []
    report: dict = {}
    with sync_playwright() as p:
        if args.profile:
            context = p.chromium.launch_persistent_context(
                args.profile, headless=True, args=CHROMIUM_ARGS, viewport={"width": width, "height": height}
            )
            page = context.pages[0] if context.pages else context.new_page()
            closer = context
        else:
            browser = p.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            page = browser.new_page(viewport={"width": width, "height": height})
            closer = browser
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on(
            "console",
            lambda m: logs.append(m.text)
            if m.type in ("warning", "error") and "GL Driver" not in m.text
            else None,
        )
        page.goto(args.url, wait_until="domcontentloaded")

        def wait_for(predicate_js: str, what: str, timeout: float) -> None:
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    if page.evaluate(predicate_js):
                        return
                except Exception as err:  # a dev-server HMR reload destroys the context; keep polling
                    if "Execution context was destroyed" not in str(err):
                        raise
                time.sleep(0.5)
            raise TimeoutError(f"timed out waiting for {what}")

        wait_for(
            "() => { const t = document.getElementById('status')?.textContent || '';"
            " return t && !t.includes('loading') && !t.includes('fetching') && !t.includes('failed'); }",
            "the asset",
            args.timeout,
        )
        print("status:", page.evaluate("document.getElementById('status')?.textContent"))

        if args.no_xr:
            time.sleep(2)
            if args.ik:
                # The desktop gizmo path, without a mouse: grab the handle with no
                # source and move its own transform, as TransformControls would.
                before = page.evaluate("() => window.__xrViewer.report().tcp")
                # 4 cm sideways: a small move any arm can follow from its rest pose.
                page.evaluate("() => { const h = window.__xrViewer.tcpHandle; h.grab(); h.position.x += 0.04; }")
                time.sleep(1.5)
                during = page.evaluate("() => { const r = window.__xrViewer.report(); return { ...r.tcp, ik: r.ik }; }")
                page.evaluate("() => window.__xrViewer.tcpHandle.release()")
                time.sleep(0.5)
                after = page.evaluate("() => window.__xrViewer.report().tcp")
                print("desktop ik: tool moved", f"{_dist(before['toolWorld'], during['toolWorld']) * 1000:.1f} mm,",
                      f"tool→handle {_dist(during['toolWorld'], during['handleWorld']) * 1000:.1f} mm,",
                      "converged =", during["ik"] and during["ik"].get("converged"),
                      f"| after release: handle→tool {_dist(after['toolWorld'], after['handleWorld']) * 1000:.1f} mm")
            report = page.evaluate("() => window.__xrViewer.report()")
            page.screenshot(path=args.out)
            closer.close()
            print(json.dumps(report, indent=1))
            print("errors:", errors[:3])
            return 1 if errors else 0

        try:
            wait_for("() => document.getElementById('VRButton')?.textContent === 'ENTER VR'", "VRButton", 30)
        except TimeoutError:
            print("VRButton text:", page.evaluate("() => document.getElementById('VRButton')?.textContent"))
            print("console:", logs[:8])
            raise
        page.click("#VRButton")
        wait_for(f"() => window.__xrViewer.xrFrames >= {args.frames}", f"{args.frames} XR frames", args.timeout)
        print(f"presenting after {args.frames} frames:", page.evaluate("() => window.__xrViewer.stats().presenting"))

        def settle(frames: int) -> None:
            target = page.evaluate("() => window.__xrViewer.xrFrames") + frames
            wait_for(f"() => window.__xrViewer.xrFrames >= {target}", f"{frames} more XR frames", args.timeout)

        if args.aim:
            center = page.evaluate("() => { const r = window.__xrViewer.report(); return r.linksCenter ?? r.robotCenter; }")
            print("aiming at:", center)
            page.evaluate("([hand, c]) => window.__xrViewer.aim(hand, c)", [args.aim, center])
            settle(2)
            print("hover after aiming:", page.evaluate("() => window.__xrViewer.report().hoverNames"))
            if args.select:
                # Hold the trigger across rendered frames: a timed tap can fall
                # between two software-GL frames and never register.
                page.evaluate("(hand) => window.__xrViewer.hold(hand, 'trigger', true)", args.aim)
                settle(2)
                page.evaluate("(hand) => window.__xrViewer.hold(hand, 'trigger', false)", args.aim)
                settle(2)
                print("selected:", page.evaluate("() => window.__xrViewer.report().selected"))
        if args.tabletop:
            page.evaluate("() => window.__xrViewer.press('left', 'squeeze')")
            time.sleep(0.4)
            settle(2)
        if args.grab:
            at = page.evaluate("() => window.__xrViewer.report().tcp.handleWorld")
            print("tcp handle at:", at)
            page.evaluate("(p) => window.__xrViewer.place('right', p)", at)
            settle(2)
            page.evaluate("() => window.__xrViewer.hold('right', 'squeeze', true)")
            settle(2)
            print("grabbed while holding:", page.evaluate("() => window.__xrViewer.report().tcp.grabbed"))
            page.evaluate("(p) => window.__xrViewer.place('right', [p[0] + 0.1, p[1], p[2]])", at)
            settle(2)
            print("after drag:", page.evaluate("() => { const t = window.__xrViewer.report().tcp; return { phase: t.phase, changes: t.changes, last: t.last }; }"))
            page.evaluate("() => window.__xrViewer.hold('right', 'squeeze', false)")
            settle(2)
            print("after release:", page.evaluate("() => { const t = window.__xrViewer.report().tcp; return { phase: t.phase, grabbed: t.grabbed }; }"))

        if args.ik:
            ev = page.evaluate

            def tcp_state() -> dict:
                return ev("() => { const r = window.__xrViewer.report(); return { ...r.tcp, ik: r.ik, joints: r.joints }; }")

            state = tcp_state()
            ik = state["ik"]
            print("ik: chain =", [j.split("/")[-1] for j in ik["joints"]] if ik else None,
                  "· orientation tracked =", ik and ik["tracksOrientation"])
            at = state["handleWorld"]
            before = state["joints"]
            ev("(p) => window.__xrViewer.place('right', p)", at)
            settle(2)
            ev("() => window.__xrViewer.hold('right', 'squeeze', true)")
            settle(2)
            print("ik: grabbed =", tcp_state()["grabbed"])
            # Small sideways moves first (any arm follows those from its rest pose;
            # the sample arm's tool frame sits on its last joint, so it can only move
            # on a sphere), then sideways + down (a 6+ DOF arm bends for it — the
            # Franka starts straight up with its elbow at a limit), then one far
            # beyond the arm, which must come back as unreachable.
            up = ev("() => window.__xrViewer.report().worldUp")
            world = (lambda a, b, c: [a, b, c]) if up == "Y" else (lambda a, b, c: [a, c, b])  # (x, up, third)
            targets = [("4 cm x", (0.04, 0.0, 0.0)), ("4 cm x, 4 cm third", (0.04, 0.0, 0.04)), ("10 cm x, 10 cm down", (0.10, -0.10, 0.0)), ("far", (2.5, 0.0, 0.0))]
            for name, (a, b, c) in targets:
                off = world(a, b, c)
                ev("(p) => window.__xrViewer.place('right', p)", [at[0] + off[0], at[1] + off[1], at[2] + off[2]])
                settle(4)
                t = tcp_state()
                print(f"  {name}: tool→handle {_dist(t['toolWorld'], t['handleWorld']) * 1000:.1f} mm, "
                      f"converged = {t['ik']['converged']}, posErr = {t['ik']['positionError'] * 1000:.1f} mm, "
                      f"oriErr = {t['ik']['orientationError']:.3f} rad, reachable = {t['reachable']}")
            ev("() => window.__xrViewer.hold('right', 'squeeze', false)")
            settle(2)
            t = tcp_state()
            moved = max(abs(t["joints"][k] - before.get(k, 0.0)) for k in t["joints"]) if t["joints"] else 0.0
            print(f"ik: released: grabbed = {t['grabbed']}, handle→tool {_dist(t['toolWorld'], t['handleWorld']) * 1000:.1f} mm, "
                  f"reachable = {t['reachable']}, joints moved by up to {moved:.3f} rad")
            ev("() => window.__xrViewer.hold('right', 'a-button', true)")
            settle(2)
            ev("() => window.__xrViewer.hold('right', 'a-button', false)")
            settle(1)
            print("ik: waypoints after A =", ev("() => window.__xrViewer.report().teach.waypoints"))

        if args.teach:
            ev = page.evaluate

            def hold(hand: str, button: str, pressed: bool) -> None:
                ev("([h, b, p]) => window.__xrViewer.hold(h, b, p)", [hand, button, pressed])

            def tap(hand: str, button: str) -> None:
                hold(hand, button, True)
                settle(2)
                hold(hand, button, False)
                settle(1)

            def joints() -> dict:
                return ev("() => window.__xrViewer.report().joints")

            def teach_state() -> dict:
                return ev("() => window.__xrViewer.report().teach")

            links = ev("() => window.__xrViewer.report().links")
            target = next((l for l in links if l["joint"] and l["center"]), None)
            if target is None:
                raise RuntimeError("no articulated link to grab")
            print("teach: grabbing", target["name"], "near", [round(v, 3) for v in target["center"]])
            # Hand next to the link's visual centre, then swung around it: the joint above should turn.
            for step, move in enumerate(([0.1, 0.0, 0.2], [-0.2, 0.0, 0.1]), start=1):
                p0 = target["center"]
                ev("(p) => window.__xrViewer.place('right', p)", [p0[0] + 0.1, p0[1], p0[2]])
                settle(2)
                before = joints()
                hold("right", "squeeze", True)
                settle(2)
                print(f"  step {step}: grabbing =", teach_state()["grabbing"])
                ev("(p) => window.__xrViewer.place('right', p)", [p0[0] + move[0], p0[1] + move[1], p0[2] + move[2]])
                settle(3)
                after = joints()
                delta = max(abs(after[k] - before.get(k, 0.0)) for k in after) if after else 0.0
                print(f"  step {step}: max joint delta = {delta:.3f} rad, limit exceeded = {teach_state()['limitExceeded']}")
                hold("right", "squeeze", False)
                settle(1)
                tap("right", "a-button")
                print(f"  step {step}: waypoints =", teach_state()["waypoints"])
            tap("left", "a-button")  # X: play
            state = teach_state()
            print("teach: playing =", state["playing"], "range =", state["timeRange"])
            snap1 = joints()
            settle(4)
            snap2 = joints()
            moved = max(abs(snap2[k] - snap1[k]) for k in snap2) if snap2 else 0.0
            print(f"teach: joints moved during playback by up to {moved:.3f} rad")
            tap("left", "a-button")  # X: pause
            print("teach: verify export →", json.dumps(ev("() => window.__xrViewer.verifyTaught()")))

        report = page.evaluate("() => window.__xrViewer.report()")
        page.screenshot(path=args.out)
        closer.close()

    print(json.dumps(report, indent=1))
    print("errors:", errors[:3])
    print("console:", [line[:200] for line in logs[:8]])
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
