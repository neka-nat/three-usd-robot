/**
 * React Three Fiber + @react-three/xr rehearsal (M36): the stack botrail
 * uses — R3F 8, @react-three/xr 6, three r169, a Z-up world — wired to
 * `three-usd-robot/xr` and `/helpers`:
 *
 *   - `<XROrigin>` carries `xrOriginQuaternion("Z")`; `xrOriginPlacement`
 *     stands the player in front of the robot when the session starts
 *   - `<UsdRobot>`'s pointer events (mouse on the desktop, the controller
 *     ray in XR — the same handlers) resolve to links with `resolveLink`;
 *     selection is on pointer down (trigger press)
 *   - a `TcpTargetHandle` is grabbed by the right grip through
 *     `useXRInputSourceEvent` + `handle.grab(gripObject)`; its `change`
 *     events show on the HUD (no IK here — it snaps back on release)
 *
 *   ?asset=<url> | ?isaac=<path>   any asset / NVIDIA CDN asset
 *   ?anim=0                        do not advance time-sampled animation
 *   ?emulate=1                     install the IWER headset emulator
 */

import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import {
  XR,
  XROrigin,
  XRSpace,
  createXRStore,
  useXR,
  useXRInputSourceEvent,
  useXRInputSourceState,
} from "@react-three/xr";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import type { ThreeUsdRobot } from "three-usd-robot";
import { highlightLink, restoreAllLinkMaterials } from "three-usd-robot/helpers";
import { UsdRobot } from "three-usd-robot/react";
import { applyRenderDefaults } from "three-usd-robot/rendering";
import {
  type TcpTargetEvent,
  TcpTargetHandle,
  resolveLink,
  xrOriginPlacement,
  xrOriginQuaternion,
} from "three-usd-robot/xr";
import {
  type Emulator,
  aimEmulatedController,
  installEmulator,
  placeEmulatedController,
  setEmulatedButton,
} from "./emulate";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const ISAAC = "https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1";
const PRESETS: Record<string, string> = {
  "Franka Panda (CDN)": `${ISAAC}/Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd`,
  "Factory cell (local)": "/factory.usda",
  "Animated arm (local)": "/arm_anim.usda",
};
const params = new URLSearchParams(location.search);
const isaacPath = params.get("isaac");
const initialUrl =
  params.get("asset") ?? (isaacPath ? `${ISAAC}/${isaacPath}` : Object.values(PRESETS)[0]!);
const emulate = params.get("emulate") === "1";
const animate = params.get("anim") !== "0";

/** botrail's world: Z-up, metres. The origin, not the content, is rotated. */
const WORLD_UP = "Z" as const;
const UP = new THREE.Vector3(0, 0, 1);
const GRAB_REACH = 0.2;

// `emulate: false` — the viewer installs IWER itself (see emulate.ts), so the
// store never injects a second runtime (nor its DevUI) on localhost.
// `grabPointer: false` — the grip is reserved for the TCP handle; the default
// grab pointer would also turn a squeeze near the robot into pointer events
// on its meshes (and toggle the selection).
const store = createXRStore({ emulate: false, controller: { grabPointer: false } });

// ---------------------------------------------------------------------------
// Shared viewer state (also what scripts/xr-capture.py reads through __xrViewer)
// ---------------------------------------------------------------------------

type Viewpoint = { standAt: THREE.Vector3; lookAt: THREE.Vector3; radius: number };
const viewer = {
  robot: null as ThreeUsdRobot | null,
  origin: null as THREE.Group | null,
  emulator: null as Emulator | null,
  handle: null as TcpTargetHandle | null,
  /** An Object3D tracking the right controller's grip space (an <XRSpace> under the origin). */
  rightGrip: null as THREE.Object3D | null,
  xrFrames: 0,
  presenting: false,
  hovered: null as string | null,
  selected: null as string | null,
  tcp: { link: null as string | null, phase: "-", changes: 0, last: null as number[] | null },
  viewpoint: { standAt: new THREE.Vector3(0, -1.5, 0), lookAt: new THREE.Vector3(), radius: 1 } as Viewpoint,
  frameTimes: [] as number[],
  drawCalls: 0,
  triangles: 0,
};

function frameRobot(robot: ThreeUsdRobot): Viewpoint {
  robot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(robot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  // Stand on the −Y side (the Y-up viewer's +Z side), on the floor, facing the centre.
  const standAt = center
    .clone()
    .add(new THREE.Vector3(0.35, -1, 0).setLength(Math.max(radius * 2.2, 1.2)))
    .projectOnPlane(UP);
  return { standAt, lookAt: center, radius };
}

function guessToolLink(robot: ThreeUsdRobot): string | null {
  const leaves = Object.values(robot.tree.nodes).filter((n) => n.children.length === 0);
  leaves.sort((a, b) => b.depth - a.depth);
  return leaves[0]?.link ?? null;
}

// ---------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------

/** The player's origin: rotated for the Z-up world, placed in front of the robot at session start. */
function Origin() {
  const ref = useRef<THREE.Group>(null);
  const session = useXR((s) => s.session);
  const pending = useRef(false);
  useEffect(() => {
    viewer.origin = ref.current;
    pending.current = session !== undefined;
    viewer.xrFrames = 0;
    if (!session && ref.current) {
      ref.current.position.set(0, 0, 0);
      ref.current.quaternion.copy(xrOriginQuaternion(WORLD_UP));
    }
  }, [session]);
  useFrame(({ gl, camera }) => {
    viewer.presenting = gl.xr.isPresenting;
    if (!gl.xr.isPresenting || !ref.current) return;
    viewer.xrFrames++;
    // Under <XR> the frame camera is the XR camera: its local pose is the head
    // in the reference space, valid from the second frame on.
    if (pending.current && viewer.xrFrames >= 2) {
      pending.current = false;
      const { position, quaternion } = xrOriginPlacement({
        worldUp: WORLD_UP,
        standAt: viewer.viewpoint.standAt,
        lookAt: viewer.viewpoint.lookAt,
        head: { position: camera.position, quaternion: camera.quaternion },
      });
      ref.current.position.copy(position);
      ref.current.quaternion.copy(quaternion);
    }
  });
  return (
    <XROrigin ref={ref} quaternion={xrOriginQuaternion(WORLD_UP)}>
      <RightGripSpace />
    </XROrigin>
  );
}

/**
 * An object that follows the right controller's grip space — what the TCP
 * handle is handed to grab. Explicit rather than the controller model
 * (`XRControllerState.object`) so it exists before any model loads; it must
 * live under <XROrigin>, where XR spaces are resolved.
 */
function RightGripSpace() {
  const right = useXRInputSourceState("controller", "right");
  const gripSpace = right?.inputSource.gripSpace;
  useEffect(() => () => {
    viewer.rightGrip = null;
  }, []);
  if (!gripSpace) return null;
  return (
    <XRSpace
      space={gripSpace}
      ref={(object) => {
        viewer.rightGrip = object;
      }}
    />
  );
}

/** The TCP target handle, grabbed by the right grip when the hand is within reach. */
function TcpHandle({
  robot,
  link,
  size,
  onEvent,
}: {
  robot: ThreeUsdRobot;
  link: string;
  size: number;
  onEvent: (event: TcpTargetEvent) => void;
}) {
  const handle = useMemo(() => new TcpTargetHandle(robot, link, { size }), [robot, link, size]);
  useEffect(() => {
    viewer.handle = handle;
    viewer.tcp = { link: handle.link, phase: "-", changes: 0, last: null };
    return () => {
      if (viewer.handle === handle) viewer.handle = null;
      handle.dispose();
    };
  }, [handle]);
  useEffect(() => {
    const listener = (event: TcpTargetEvent) => onEvent(event);
    handle.addEventListener("grabstart", listener);
    handle.addEventListener("change", listener);
    handle.addEventListener("grabend", listener);
    return () => {
      handle.removeEventListener("grabstart", listener);
      handle.removeEventListener("change", listener);
      handle.removeEventListener("grabend", listener);
    };
  }, [handle, onEvent]);

  // Squeeze within reach → grab the grip-space object (see RightGripSpace);
  // the handle keeps its offset to the hand until the squeeze ends.
  const right = useXRInputSourceState("controller", "right");
  useXRInputSourceEvent(
    right?.inputSource,
    "squeezestart",
    () => {
      const grip = viewer.rightGrip;
      if (!grip) return;
      grip.updateWorldMatrix(true, false);
      handle.updateWorldMatrix(true, false);
      const distance = new THREE.Vector3()
        .setFromMatrixPosition(grip.matrixWorld)
        .distanceTo(new THREE.Vector3().setFromMatrixPosition(handle.matrixWorld));
      if (distance <= GRAB_REACH) handle.grab(grip);
    },
    [right, handle],
  );
  useXRInputSourceEvent(right?.inputSource, "squeezeend", () => handle.release(), [right, handle]);

  return <primitive object={handle} />;
}

/** Frame stats: draw calls, triangles and frame time, like the vanilla viewer's HUD. */
function Stats({ onStats }: { onStats: (text: string) => void }) {
  const last = useRef(performance.now());
  const lastPush = useRef(0);
  useFrame(({ gl }) => {
    const now = performance.now();
    viewer.frameTimes.push(now - last.current);
    if (viewer.frameTimes.length > 90) viewer.frameTimes.shift();
    last.current = now;
    viewer.drawCalls = gl.info.render.calls;
    viewer.triangles = gl.info.render.triangles;
    if (now - lastPush.current > 250) {
      lastPush.current = now;
      const s = stats();
      onStats(
        `${s.frameMsAvg.toFixed(1)} ms avg · ${s.frameMsMax.toFixed(1)} max (72 Hz = 13.9)\n` +
          `${s.drawCalls} draw calls · ${(s.triangles / 1000).toFixed(0)}k tris\n` +
          `${s.presenting ? "XR" : "desktop"} · tcp ${viewer.tcp.phase} ×${viewer.tcp.changes}`,
      );
    }
  });
  return null;
}

function stats() {
  const n = viewer.frameTimes.length || 1;
  return {
    presenting: viewer.presenting,
    xrFrames: viewer.xrFrames,
    frameMsAvg: Math.round((viewer.frameTimes.reduce((a, b) => a + b, 0) / n) * 10) / 10,
    frameMsMax: Math.round(viewer.frameTimes.reduce((a, b) => Math.max(a, b), 0) * 10) / 10,
    drawCalls: viewer.drawCalls,
    triangles: viewer.triangles,
    worldUp: WORLD_UP,
  };
}

/** Desktop orbit; off while presenting (the XR camera owns the view then). */
function DesktopControls() {
  const session = useXR((s) => s.session);
  return <OrbitControls makeDefault enabled={session === undefined} />;
}

function RenderDefaults() {
  const gl = useThree((s) => s.gl);
  useEffect(() => applyRenderDefaults(gl), [gl]);
  return null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [url, setUrl] = useState(initialUrl);
  const [robot, setRobot] = useState<ThreeUsdRobot | null>(null);
  const [status, setStatus] = useState("loading…");
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tcpText, setTcpText] = useState("–");
  const [statsText, setStatsText] = useState("");
  const [inSession, setInSession] = useState(false);

  useEffect(() => store.subscribe((s) => setInSession(s.session !== undefined)), []);

  const onLoad = useCallback((next: ThreeUsdRobot) => {
    setRobot(next);
    viewer.robot = next;
    viewer.viewpoint = frameRobot(next);
    setHovered(null);
    setSelected(null);
    setStatus(
      `${next.robot.name} — ${next.getLinkNames().length} links, ${next.getJointNames().length} joints · ${WORLD_UP}-up`,
    );
  }, []);

  // Hover / selection tint, from whichever pointer delivered the event.
  useEffect(() => {
    viewer.hovered = hovered;
    viewer.selected = selected;
    if (!robot) return;
    restoreAllLinkMaterials(robot);
    if (hovered && hovered !== selected) highlightLink(robot, hovered, { color: 0xffc400, emissiveIntensity: 0.5 });
    if (selected) highlightLink(robot, selected, { color: 0xff4444, emissiveIntensity: 0.8 });
  }, [robot, hovered, selected]);

  const onPointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!robot) return;
      e.stopPropagation();
      setHovered(resolveLink(robot, e.object)?.link.primPath ?? null);
    },
    [robot],
  );
  const onPointerOut = useCallback(() => setHovered(null), []);
  // Select on pointer down (trigger press / mouse button) rather than click:
  // a click needs the press and the release within a short window, which a
  // long trigger pull — or a slow frame — breaks.
  const onPointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!robot) return;
      e.stopPropagation();
      const hit = resolveLink(robot, e.object);
      if (hit) setSelected((cur) => (cur === hit.link.primPath ? null : hit.link.primPath));
    },
    [robot],
  );

  const onTcpEvent = useCallback((event: TcpTargetEvent) => {
    viewer.tcp.phase = event.phase;
    if (event.phase === "move" || event.phase === "set") {
      viewer.tcp.changes++;
      viewer.tcp.last = event.pose.position;
    }
    const p = event.pose.position;
    setTcpText(`${event.phase} · (${p.map((v) => v.toFixed(3)).join(", ")}) m [${event.space}]`);
  }, []);

  const toolLink = robot ? guessToolLink(robot) : null;
  const handleSize = THREE.MathUtils.clamp(viewer.viewpoint.radius * 0.12, 0.03, 0.3);
  const leaf = (path: string | null) => path?.split("/").pop() ?? "–";

  return (
    <>
      <Canvas
        shadows
        camera={{ up: [0, 0, 1], position: [2.5, -2.5, 1.8], near: 0.02, far: 300 }}
        gl={{ antialias: true, preserveDrawingBuffer: emulate }}
      >
        <XR store={store}>
          <RenderDefaults />
          <Origin />
          <color attach="background" args={["#202024"]} />
          <hemisphereLight intensity={0.6} groundColor="#404040" />
          <directionalLight
            position={[3, 2, 6]}
            intensity={1.4}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-normalBias={0.02}
          />
          <Grid
            rotation={[Math.PI / 2, 0, 0]}
            infiniteGrid
            sectionColor="#50545c"
            cellColor="#34373d"
            fadeDistance={30}
          />
          <Suspense fallback={null}>
            <UsdRobot
              key={url}
              url={url}
              loaderOptions={{ worldUp: WORLD_UP, loadSceneGeometry: true }}
              animate={animate}
              onLoad={onLoad}
              onPointerMove={onPointerMove}
              onPointerOut={onPointerOut}
              onPointerDown={onPointerDown}
            />
          </Suspense>
          {robot && toolLink && (
            <TcpHandle key={url} robot={robot} link={toolLink} size={handleSize} onEvent={onTcpEvent} />
          )}
          <DesktopControls />
          <Stats onStats={setStatsText} />
        </XR>
      </Canvas>

      <div id="panel">
        <div style={{ fontSize: 11, opacity: 0.6 }}>
          React Three Fiber + @react-three/xr · Z-up world · three r{THREE.REVISION}
        </div>
        <select
          value={Object.values(PRESETS).includes(url) ? url : ""}
          onChange={(e) => {
            setRobot(null);
            setStatus("loading…");
            setUrl(e.target.value);
          }}
        >
          {!Object.values(PRESETS).includes(url) && <option value="">(custom ?asset=…)</option>}
          {Object.entries(PRESETS).map(([label, value]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <div id="status">{status}</div>
        <div>
          hover <b>{leaf(hovered)}</b> · selected <b>{leaf(selected)}</b>
        </div>
        <div>tcp {toolLink ? leaf(toolLink) : "–"}: {tcpText}</div>
        <div id="stats" className="mono">
          {statsText}
        </div>
      </div>
      <button
        id="VRButton"
        type="button"
        onClick={() => (inSession ? store.getState().session?.end() : void store.enterVR())}
      >
        {inSession ? "EXIT VR" : "ENTER VR"}
      </button>
      <div id="hint">
        desktop: drag to orbit, hover / click links · headset: point at a link, trigger to select,
        squeeze the right grip next to the TCP handle to drag it · <code>?emulate=1</code> injects the
        IWER headset emulator
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Boot (emulator first: the store looks at navigator.xr when a session is requested)
// ---------------------------------------------------------------------------

Object.assign(window as unknown as Record<string, unknown>, {
  __xrViewer: {
    store,
    get robot() {
      return viewer.robot;
    },
    get emulator() {
      return viewer.emulator;
    },
    get xrFrames() {
      return viewer.xrFrames;
    },
    get hovered() {
      return viewer.hovered;
    },
    get selected() {
      return viewer.selected;
    },
    stats,
    report() {
      const robot = viewer.robot;
      let box: THREE.Box3 | null = null;
      const links = new THREE.Box3();
      if (robot) {
        robot.updateMatrixWorld(true);
        box = new THREE.Box3().setFromObject(robot);
        for (const link of robot.getLinkObjectsByPath().values()) links.expandByObject(link);
      }
      const head = new THREE.Vector3();
      const origin = viewer.origin;
      const xrCamera = origin?.children.find((c) => (c as THREE.Camera).isCamera) as THREE.Camera | undefined;
      xrCamera?.getWorldPosition(head);
      const handle = viewer.handle;
      return {
        ...stats(),
        headWorld: head.toArray(),
        headHeight: head.dot(UP),
        robotMin: box?.min.toArray() ?? null,
        robotFloorGap: box ? box.min.dot(UP) : null,
        robotCenter: box?.getCenter(new THREE.Vector3()).toArray() ?? null,
        linksCenter: links.isEmpty() ? null : links.getCenter(new THREE.Vector3()).toArray(),
        origin: origin ? { position: origin.position.toArray(), quaternion: origin.quaternion.toArray() } : null,
        viewpoint: { standAt: viewer.viewpoint.standAt.toArray(), lookAt: viewer.viewpoint.lookAt.toArray() },
        hovered: viewer.hovered,
        selected: viewer.selected,
        hoverNames: [null, viewer.hovered?.split("/").pop() ?? null],
        tcp: {
          ...viewer.tcp,
          grabbed: handle?.grabbed ?? false,
          handleWorld: handle ? handle.getWorldPosition(new THREE.Vector3()).toArray() : null,
        },
      };
    },
    aim(hand: "left" | "right", target: [number, number, number]) {
      if (viewer.emulator && viewer.origin)
        aimEmulatedController(viewer.emulator, viewer.origin, hand, new THREE.Vector3(...target));
    },
    place(hand: "left" | "right", point: [number, number, number]) {
      if (viewer.emulator && viewer.origin)
        placeEmulatedController(viewer.emulator, viewer.origin, hand, new THREE.Vector3(...point));
    },
    press(hand: "left" | "right", button: "trigger" | "squeeze") {
      if (!viewer.emulator) return;
      setEmulatedButton(viewer.emulator, hand, button, true);
      setTimeout(() => viewer.emulator && setEmulatedButton(viewer.emulator, hand, button, false), 150);
    },
    hold(hand: "left" | "right", button: "trigger" | "squeeze", pressed: boolean) {
      if (viewer.emulator) setEmulatedButton(viewer.emulator, hand, button, pressed);
    },
    enterXR: () => store.enterVR(),
  },
});

(emulate ? installEmulator() : Promise.resolve(null)).then((device) => {
  viewer.emulator = device;
  createRoot(document.getElementById("root")!).render(<App />);
});
