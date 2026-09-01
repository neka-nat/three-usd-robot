/**
 * Binds `UsdGeomCamera` prims to Three.js cameras and attaches them into the
 * robot's hierarchy (M27).
 *
 * USD and Three.js share the same camera frame (−Z forward, +Y up), so a
 * camera places with its prim transform alone — under its link object when it
 * is mounted on the robot (a wrist or sensor camera follows the joints), else
 * under the mirrored scenery groups or the root. Focal length and apertures
 * are millimeters on a film back; clipping range and focus distance are stage
 * units and get the same world normalization as everything else.
 */

import * as THREE from "three";
import { isNonVisualPurpose } from "../schemas/usdGeom.js";
import {
  type CameraDescription,
  isCamera,
  readCameraDescription,
} from "../schemas/usdGeomCamera.js";
import type { Stage } from "../usd/Stage.js";
import type { ThreeUsdRobot } from "./ThreeUsdRobot.js";
import { attachAtPrim, collectAnchors, worldScaleOf } from "./stageAnchors.js";

/** A bound USD camera — perspective or orthographic. */
export type UsdBoundCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export type BindCamerasOptions = {
  /** Receives fidelity diagnostics. */
  onWarn?: (message: string) => void;
};

/**
 * Traverse the stage and bind every `Camera` prim. Call after mesh binding so
 * cameras anchor into the existing hierarchy. Cameras with
 * `visibility = "invisible"` or a guide/proxy purpose are skipped. Each
 * result carries `userData.primPath` and `userData.usdCamera` (its
 * {@link CameraDescription}).
 */
export function bindCameras(
  stage: Stage,
  robot3d: ThreeUsdRobot,
  options: BindCamerasOptions = {},
): UsdBoundCamera[] {
  const cameras: UsdBoundCamera[] = [];
  const anchors = collectAnchors(robot3d);
  const rootScale = robot3d.scale.x || 1;

  for (const prim of stage.Traverse()) {
    if (!isCamera(prim)) continue;
    if (prim.GetAttribute("visibility").Get() === "invisible") continue;
    if (isNonVisualPurpose(prim)) continue;
    const desc = readCameraDescription(prim);
    if (!desc) continue;

    const worldScale = worldScaleOf(prim, rootScale);
    const camera = createThreeCamera(desc, worldScale, options.onWarn);

    camera.name = desc.name;
    camera.userData.kind = "camera";
    camera.userData.primPath = desc.primPath;
    camera.userData.usdCamera = desc;
    camera.userData.usdCameraWorldScale = worldScale;

    attachAtPrim(camera, prim, anchors, robot3d);
    cameras.push(camera);
  }
  return cameras;
}

function createThreeCamera(
  desc: CameraDescription,
  worldScale: number,
  onWarn: ((message: string) => void) | undefined,
): UsdBoundCamera {
  const near = Math.max(desc.clippingRange[0] * worldScale, 1e-5);
  const far = Math.max(desc.clippingRange[1] * worldScale, near + 1e-5);

  if (desc.projection === "orthographic") {
    // Orthographic apertures are tenths of a stage unit (GfCamera).
    const halfWidth = (desc.horizontalAperture / 10 / 2) * worldScale;
    const halfHeight = (desc.verticalAperture / 10 / 2) * worldScale;
    return new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, near, far);
  }

  const camera = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(2 * Math.atan(desc.verticalAperture / (2 * desc.focalLength))),
    desc.horizontalAperture / desc.verticalAperture,
    near,
    far,
  );
  // Film metrics for consumers that think in lens terms (mm).
  camera.filmGauge = desc.horizontalAperture;
  camera.filmOffset = desc.horizontalApertureOffset;
  if (desc.verticalApertureOffset !== 0) {
    onWarn?.(
      `Camera ${desc.primPath} authors a verticalApertureOffset; Three.js has no vertical film offset — ignored`,
    );
  }
  if (desc.focusDistance > 0) camera.focus = desc.focusDistance * worldScale;
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * `UsdRender` aspect-ratio conform policies: how a camera's fixed aperture
 * meets a viewport of a different aspect. `expandAperture` (the USD default)
 * always shows at least the authored view; `cropAperture` never shows more;
 * the `adjust*` policies pin one axis outright.
 */
export type AspectConformPolicy =
  | "expandAperture"
  | "cropAperture"
  | "adjustApertureWidth"
  | "adjustApertureHeight";

/**
 * Fit a bound USD camera to a viewport aspect ratio (width / height) and
 * update its projection. Call on resize, or before rendering through a camera
 * from {@link ThreeUsdRobot.cameras}. Cameras without USD metadata just get
 * the aspect applied.
 */
export function conformCameraAspect(
  camera: UsdBoundCamera,
  viewportAspect: number,
  policy: AspectConformPolicy = "expandAperture",
): void {
  const desc = camera.userData.usdCamera as CameraDescription | undefined;

  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera;
    const worldScale = (camera.userData.usdCameraWorldScale as number | undefined) ?? 1;
    const halfWidth = desc ? (desc.horizontalAperture / 10 / 2) * worldScale : ortho.right;
    const halfHeight = desc ? (desc.verticalAperture / 10 / 2) * worldScale : ortho.top;
    if (widthFollows(policy, viewportAspect, halfWidth / halfHeight)) {
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      ortho.right = halfHeight * viewportAspect;
      ortho.left = -ortho.right;
    } else {
      ortho.right = halfWidth;
      ortho.left = -halfWidth;
      ortho.top = halfWidth / viewportAspect;
      ortho.bottom = -ortho.top;
    }
    ortho.updateProjectionMatrix();
    return;
  }

  const persp = camera as THREE.PerspectiveCamera;
  persp.aspect = viewportAspect;
  if (desc) {
    const vFov = 2 * Math.atan(desc.verticalAperture / (2 * desc.focalLength));
    const hFov = 2 * Math.atan(desc.horizontalAperture / (2 * desc.focalLength));
    const apertureAspect = desc.horizontalAperture / desc.verticalAperture;
    persp.fov = THREE.MathUtils.radToDeg(
      widthFollows(policy, viewportAspect, apertureAspect)
        ? vFov // keep the vertical view; width follows the viewport
        : 2 * Math.atan(Math.tan(hFov / 2) / viewportAspect), // keep the horizontal view
    );
  }
  persp.updateProjectionMatrix();
}

/** True when the policy keeps the vertical extent and lets width follow. */
function widthFollows(
  policy: AspectConformPolicy,
  viewportAspect: number,
  apertureAspect: number,
): boolean {
  switch (policy) {
    case "adjustApertureWidth":
      return true;
    case "adjustApertureHeight":
      return false;
    case "expandAperture":
      return viewportAspect >= apertureAspect;
    case "cropAperture":
      return viewportAspect < apertureAspect;
  }
}
