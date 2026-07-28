import { Bounds, Grid, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  exportThreeUsdRobot,
  RAD2DEG,
  serializeUsda,
  type ThreeUsdRobot,
  writeUsdz,
} from "three-usd-robot";
import { UsdRobot } from "three-usd-robot/react";

/** NVIDIA's public Isaac Sim asset CDN — no login, CORS-enabled. */
const ISAAC_ROOT =
  "https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1";

const PRESETS: { label: string; url: string }[] = [
  { label: "Franka Panda", url: `${ISAAC_ROOT}/Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd` },
  {
    label: "Kawasaki RS007N + gripper",
    url: `${ISAAC_ROOT}/Isaac/Robots/Kawasaki/RS007N/rs007n_onrobot_rg2.usd`,
  },
  { label: "Fanuc CRX-10iA/L", url: `${ISAAC_ROOT}/Isaac/Robots/Fanuc/CRX10IAL/crx10ial.usd` },
  { label: "Shadow Hand", url: `${ISAAC_ROOT}/Isaac/Robots/ShadowRobot/ShadowHand/shadow_hand.usd` },
  { label: "Factory cell (local)", url: "/factory.usda" },
  { label: "Sample arm (local)", url: "/robot.usda" },
];

// `?asset=<url>` loads any URL; `?isaac=<path under Isaac/>` uses the CDN above.
const params = new URLSearchParams(location.search);
const isaacPath = params.get("isaac");
const initialUrl =
  params.get("asset") ?? (isaacPath ? `${ISAAC_ROOT}/${isaacPath}` : PRESETS[0]!.url);

function download(filename: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One slider per articulated joint, driving `setJointValue` directly. */
function JointPanel({ robot }: { robot: ThreeUsdRobot }) {
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(robot.getJointNames().map((n) => [n, robot.getJointValue(n) ?? 0])),
  );

  const set = useCallback(
    (name: string, value: number) => {
      robot.setJointValue(name, value);
      setValues((prev) => ({ ...prev, [name]: value }));
    },
    [robot],
  );

  const reset = () => {
    for (const name of robot.getJointNames()) {
      set(name, robot.robot.joints[name]?.initialValue ?? 0);
    }
  };

  return (
    <div style={panel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{robot.robot.name}</strong>
        <button type="button" onClick={reset} style={{ fontSize: 11 }}>
          reset
        </button>
      </div>
      <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 8 }}>
        {robot.getLinkNames().length} links · {robot.getJointNames().length} joints
      </div>
      {robot.getJointNames().map((name) => {
        const joint = robot.robot.joints[name]!;
        const angular = joint.type !== "prismatic";
        // Unlimited joints still need a slider range; ±180° reads naturally.
        const lower = joint.lower ?? (angular ? -Math.PI : -0.5);
        const upper = joint.upper ?? (angular ? Math.PI : 0.5);
        const value = values[name] ?? 0;
        return (
          <label key={name} style={{ display: "block", marginBottom: 6 }}>
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span>{name}</span>
              <span style={{ opacity: 0.7 }}>
                {angular ? `${(value * RAD2DEG).toFixed(1)}°` : `${value.toFixed(3)} m`}
              </span>
            </span>
            <input
              type="range"
              min={lower}
              max={upper}
              step={(upper - lower) / 200}
              value={value}
              onChange={(e) => set(name, Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
        );
      })}
    </div>
  );
}

function App() {
  const [url, setUrl] = useState(initialUrl);
  const [robot, setRobot] = useState<ThreeUsdRobot | null>(null);

  const select = (next: string) => {
    setRobot(null);
    setUrl(next);
  };

  const exportUsd = (kind: "usda" | "usdz") => {
    if (!robot) return;
    const usda = serializeUsda(exportThreeUsdRobot(robot));
    if (kind === "usda") return download("robot.usda", usda, "text/plain");
    // .slice() re-backs the view with a plain ArrayBuffer, as Blob requires.
    download("robot.usdz", writeUsdz({ "robot.usda": usda }).slice(), "model/vnd.usdz+zip");
  };

  return (
    <>
      <Canvas camera={{ position: [3, 2, 3], near: 0.01, far: 1000 }}>
        <color attach="background" args={["#202024"]} />
        <hemisphereLight intensity={1.2} groundColor="#404040" />
        <directionalLight position={[3, 5, 2]} intensity={1.6} />
        <Grid infiniteGrid sectionColor="#444444" cellColor="#303030" fadeDistance={40} />

        <Suspense fallback={null}>
          {/* Bounds auto-frames the robot; the loader normalizes up-axis & units. */}
          <Bounds key={url} fit clip observe margin={1.2}>
            {/* `loadSceneGeometry` also draws static scenery around the machines. */}
            <UsdRobot
              url={url}
              loaderOptions={{ loadSceneGeometry: true }}
              showJointAxes
              animate
              onLoad={setRobot}
            />
          </Bounds>
        </Suspense>

        <OrbitControls makeDefault />
      </Canvas>

      <div style={{ ...panel, top: 12, left: 12, width: 260 }}>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>
          Stock Isaac Sim assets, loaded straight from NVIDIA's CDN
        </div>
        <select
          value={PRESETS.some((p) => p.url === url) ? url : ""}
          onChange={(e) => select(e.target.value)}
          style={{ width: "100%", marginBottom: 8 }}
        >
          {!PRESETS.some((p) => p.url === url) && <option value="">(custom ?asset=…)</option>}
          {PRESETS.map((p) => (
            <option key={p.url} value={p.url}>
              {p.label}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => exportUsd("usda")} disabled={!robot}>
            Download .usda
          </button>
          <button type="button" onClick={() => exportUsd("usdz")} disabled={!robot}>
            .usdz
          </button>
        </div>
        {!robot && <div style={{ marginTop: 8, fontSize: 12 }}>loading…</div>}
      </div>

      {robot && <JointPanel key={url} robot={robot} />}
    </>
  );
}

const panel: React.CSSProperties = {
  position: "fixed",
  top: 12,
  right: 12,
  width: 240,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
  padding: 12,
  borderRadius: 8,
  background: "rgba(24, 24, 28, 0.88)",
  color: "#e6e6e6",
  font: "13px/1.4 system-ui, sans-serif",
  backdropFilter: "blur(4px)",
};

createRoot(document.getElementById("root")!).render(<App />);
