/**
 * `three-usd-robot/nodes` — optional TSL / WebGPU entry (M22).
 *
 * Executes natively-authored MaterialX (`ND_*`) shader graphs — procedural
 * noise, ramps, math — by converting them to three.js TSL node materials
 * (`MeshPhysicalNodeMaterial`, WebGPURenderer), plugged into the core through
 * the `materialFactory` hook:
 *
 * ```ts
 * import { ThreeUsdRobotLoader } from "three-usd-robot";
 * import { createMaterialXNodeFactory } from "three-usd-robot/nodes";
 *
 * const loader = new ThreeUsdRobotLoader({
 *   materialFactory: createMaterialXNodeFactory({ onWarn: console.warn }),
 * });
 * ```
 *
 * The `three/webgpu` / `three/tsl` dependencies live in this entry alone —
 * the WebGL core bundles never import them (verified at build time).
 */

export { loadMaterialXDocument } from "./nodes/loadMaterialXDocument.js";
export {
  buildStandardSurfaceNodeMaterial,
  createMaterialXNodeFactory,
  type MaterialXNodeFactoryOptions,
} from "./nodes/materialXNodeFactory.js";
