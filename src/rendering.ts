/**
 * `three-usd-robot/rendering`
 *
 * Optional viewer-side rendering helpers, split from the main entry because
 * they import three's addons (`three/addons/…` loaders) — the same isolation
 * pattern as `three-usd-robot/nodes` for WebGPU/TSL (M22).
 *
 * ```ts
 * import { ThreeUsdRobotLoader } from "three-usd-robot";
 * import { applyUsdEnvironment } from "three-usd-robot/rendering";
 *
 * const robot = await new ThreeUsdRobotLoader({ lightIntensityScale: 0.001 }).loadAsync(url);
 * scene.add(robot);
 * await applyUsdEnvironment(robot, scene, { background: true }); // DomeLight → IBL
 * ```
 */

export {
  applyUsdEnvironment,
  type ApplyUsdEnvironmentOptions,
  type UsdEnvironment,
} from "./rendering/environment.js";
