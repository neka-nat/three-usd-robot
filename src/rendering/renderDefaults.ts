/**
 * One-call renderer defaults (M28) — the settings every USD viewer built on
 * this library ends up wanting: filmic tone mapping (USD lights and HDRI
 * domes are HDR values; three's default `NoToneMapping` clips them), soft
 * shadow maps (the loader pre-flags meshes and lights, M25), and optionally
 * an exposure — either a plain multiplier or a `UsdGeomCamera` description,
 * whose USD 24.11 linear exposure scale is applied (M27).
 *
 * Deliberately small: post-processing (AO, SSR, TAA, bloom) stays out of the
 * library — compose three's own passes in your app; the Vite example shows a
 * GTAO setup.
 */

import * as THREE from "three";
import { type CameraDescription, computeCameraExposureScale } from "../schemas/usdGeomCamera.js";

/** Filmic curve to install. `"none"` restores three's linear pass-through. */
export type ToneMappingPreset = "ACES" | "AgX" | "neutral" | "none";

export type RenderDefaultsOptions = {
  /** Default `"ACES"`. `"neutral"` (Khronos PBR Neutral) needs three r162+. */
  toneMapping?: ToneMappingPreset;
  /**
   * Sets `toneMappingExposure`: a number as-is, or a
   * {@link CameraDescription} via its linear exposure scale
   * ({@link computeCameraExposureScale}). Left untouched when omitted.
   */
  exposure?: number | CameraDescription;
  /** Enable `PCFSoftShadowMap` shadow rendering (default `true`). */
  shadows?: boolean;
  /** Receives compatibility diagnostics. */
  onWarn?: (message: string) => void;
};

/**
 * The renderer surface this helper touches — satisfied by `WebGLRenderer`
 * and `WebGPURenderer` alike, without depending on `three/webgpu` types.
 */
export type RenderDefaultsTarget = {
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
};

/**
 * Apply viewer defaults to a renderer:
 *
 * ```ts
 * import { applyRenderDefaults } from "three-usd-robot/rendering";
 *
 * applyRenderDefaults(renderer); // ACES + soft shadow maps
 * applyRenderDefaults(renderer, { toneMapping: "AgX", exposure: robot.cameras[0]?.userData.usdCamera });
 * ```
 *
 * Only ever switches features on or assigns requested values — `shadows:
 * false` skips enabling shadow maps rather than force-disabling them.
 */
export function applyRenderDefaults(
  renderer: RenderDefaultsTarget,
  options: RenderDefaultsOptions = {},
): void {
  renderer.toneMapping = resolveToneMapping(options.toneMapping ?? "ACES", options.onWarn);
  if (options.exposure !== undefined) {
    renderer.toneMappingExposure =
      typeof options.exposure === "number"
        ? options.exposure
        : computeCameraExposureScale(options.exposure);
  }
  if (options.shadows ?? true) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
}

function resolveToneMapping(
  preset: ToneMappingPreset,
  onWarn: ((message: string) => void) | undefined,
): THREE.ToneMapping {
  switch (preset) {
    case "none":
      return THREE.NoToneMapping;
    case "AgX":
      return THREE.AgXToneMapping;
    case "neutral": {
      // Runtime lookup: the peer floor (r160) predates NeutralToneMapping (r162).
      const neutral = (THREE as Record<string, unknown>).NeutralToneMapping;
      if (typeof neutral === "number") return neutral as THREE.ToneMapping;
      onWarn?.('this three.js has no NeutralToneMapping (added r162); using "ACES" instead');
      return THREE.ACESFilmicToneMapping;
    }
    case "ACES":
      return THREE.ACESFilmicToneMapping;
  }
}
