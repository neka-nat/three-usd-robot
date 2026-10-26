/**
 * `three-usd-robot/rendering`
 *
 * Optional viewer-side rendering helpers, split from the main entry because
 * they import three's addons (`three/addons/…` loaders) — the same isolation
 * pattern as `three-usd-robot/nodes` for WebGPU/TSL (M22).
 *
 * ```ts
 * import { ThreeUsdRobotLoader } from "three-usd-robot";
 * import { applyRenderDefaults, applyUsdEnvironment } from "three-usd-robot/rendering";
 *
 * applyRenderDefaults(renderer); // ACES tone mapping + soft shadow maps
 * const robot = await new ThreeUsdRobotLoader().loadAsync(url);
 * scene.add(robot);
 * await applyUsdEnvironment(robot, scene, { background: true }); // DomeLight → IBL
 * ```
 */

export {
  applyUsdEnvironment,
  createRoomEnvironment,
  environmentEulerFor,
  type ApplyUsdEnvironmentOptions,
  type EnvironmentFallback,
  type UsdEnvironment,
} from "./rendering/environment.js";
export { decodeRadianceHdr, type RadianceHdrImage } from "./rendering/radianceHdr.js";
export {
  applyRenderDefaults,
  softShadowMapType,
  type RenderDefaultsOptions,
  type RenderDefaultsTarget,
  type ToneMappingPreset,
} from "./rendering/renderDefaults.js";
