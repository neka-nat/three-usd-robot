import { Bounds, Grid, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { UsdRobot } from "three-usd-robot/react";

// Load `?asset=<url>` (any .usda / .usdc / binary .usd / .usdz) or the sample arm.
const asset = new URLSearchParams(location.search).get("asset") ?? "/robot.usda";

function App() {
  return (
    <Canvas camera={{ position: [3, 2, 3], near: 0.01, far: 1000 }}>
      <color attach="background" args={["#202024"]} />
      <hemisphereLight intensity={1.2} groundColor="#404040" />
      <directionalLight position={[3, 5, 2]} intensity={1.6} />
      <Grid infiniteGrid sectionColor="#444444" cellColor="#303030" fadeDistance={40} />

      <Suspense fallback={null}>
        {/* Bounds auto-frames the robot; the loader normalizes up-axis & units. */}
        <Bounds fit clip observe margin={1.2}>
          <UsdRobot url={asset} showJointAxes animate />
        </Bounds>
      </Suspense>

      <OrbitControls makeDefault />
    </Canvas>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
