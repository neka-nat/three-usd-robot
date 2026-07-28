import { Bounds, Grid, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  exportThreeUsdRobot,
  serializeUsda,
  type ThreeUsdRobot,
  writeUsdz,
} from "three-usd-robot";
import { UsdRobot } from "three-usd-robot/react";

// Load `?asset=<url>` (any .usda / .usdc / binary .usd / .usdz) or the sample arm.
const asset = new URLSearchParams(location.search).get("asset") ?? "/robot.usda";

function download(filename: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [robot, setRobot] = useState<ThreeUsdRobot | null>(null);

  const exportUsda = () => {
    if (!robot) return;
    download("robot.usda", serializeUsda(exportThreeUsdRobot(robot)), "text/plain");
  };
  const exportUsdz = () => {
    if (!robot) return;
    const usda = serializeUsda(exportThreeUsdRobot(robot));
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
          <Bounds fit clip observe margin={1.2}>
            {/* `loadSceneGeometry` also draws the static cell around the machines. */}
            <UsdRobot
              url={asset}
              loaderOptions={{ loadSceneGeometry: true }}
              showJointAxes
              animate
              onLoad={setRobot}
            />
          </Bounds>
        </Suspense>

        <OrbitControls makeDefault />
      </Canvas>

      {/* Export the loaded robot back out as USD (see docs/export-design.md). */}
      <div style={{ position: "fixed", top: 12, left: 12, display: "flex", gap: 8 }}>
        <button type="button" onClick={exportUsda} disabled={!robot}>
          Download .usda
        </button>
        <button type="button" onClick={exportUsdz} disabled={!robot}>
          Download .usdz
        </button>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
