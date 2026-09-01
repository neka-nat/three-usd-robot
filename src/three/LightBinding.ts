/**
 * Binds UsdLux light prims to Three.js lights and attaches them into the
 * robot's hierarchy (M25).
 *
 * Placement mirrors the gprim binding: a light under a link prim parents to
 * that link's object (so a wrist lamp moves with the joint chain), anything
 * else parents to the deepest already-mirrored ancestor — a scenery group from
 * `bindSceneMeshes` — or the robot root, positioned by its accumulated local
 * transform. Up-axis and unit normalization then apply at the root as usual.
 *
 * DomeLights create no Three.js light: they are collected on
 * {@link ThreeUsdRobot.domeLights} for IBL application (environment maps, M26).
 */

import * as THREE from "three";
import { type Mat4, identity4, multiply } from "../kinematics/transforms.js";
import { isNonVisualPurpose } from "../schemas/usdGeom.js";
import {
  type LightDescription,
  getLightKind,
  isUnsupportedLight,
  readLightDescription,
} from "../schemas/usdLux.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import { computeLocalTransform, computeWorldTransform } from "../usd/xformOps.js";
import type { ThreeUsdRobot } from "./ThreeUsdRobot.js";

export type BindLightsOptions = {
  /**
   * Multiplies every light's effective emission (`intensity × 2^exposure`).
   * Default `1` — the authored UsdLux value passes through unchanged. Stages
   * authored in Omniverse/RTX photometric units (intensities in the thousands)
   * typically want `0.001` to land in Three.js's exposure-1 range; see
   * docs/lighting.md.
   */
  lightIntensityScale?: number;
  /**
   * Configure shadow casting: `castShadow` per the light's ShadowAPI, with the
   * shadow camera fitted to the scene bounds. Default `false` here — the
   * loader defaults it on.
   */
  shadows?: boolean;
  /** Receives fidelity diagnostics (unsupported/approximated light types). */
  onWarn?: (message: string) => void;
};

/** Result of {@link bindLights}. */
export type BoundLights = {
  /**
   * The Three.js lights created, already attached to the hierarchy. Each
   * carries `userData.primPath` and `userData.usdLight` (its
   * {@link LightDescription}).
   */
  lights: THREE.Light[];
  /** DomeLights parsed but not realized — IBL environment application is M26. */
  domes: LightDescription[];
};

/**
 * Traverse the stage and bind every supported UsdLux light. Call after mesh
 * binding so lights can anchor to the mirrored scenery groups and shadow
 * cameras can fit the scene bounds. Lights with `visibility = "invisible"` or
 * a guide/proxy purpose are skipped.
 */
export function bindLights(
  stage: Stage,
  robot3d: ThreeUsdRobot,
  options: BindLightsOptions = {},
): BoundLights {
  const intensityScale = options.lightIntensityScale ?? 1;
  const shadows = options.shadows ?? false;
  const lights: THREE.Light[] = [];
  const domes: LightDescription[] = [];

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    options.onWarn?.(message);
  };

  // primPath → already-created object (scenery groups, gprims, link frames):
  // the deepest such ancestor anchors a light so it inherits that subtree's
  // motion. Links index by their own primPath too.
  const anchors = new Map<string, THREE.Object3D>();
  robot3d.traverse((object) => {
    const path = (object.userData as { primPath?: unknown }).primPath;
    if (typeof path === "string" && !anchors.has(path)) anchors.set(path, object);
  });
  for (const [path, link] of robot3d.getLinkObjectsByPath()) anchors.set(path, link);

  const rootScale = robot3d.scale.x || 1;
  let metrics: { center: THREE.Vector3; radius: number } | null = null;
  const sceneMetrics = () => {
    if (!metrics) {
      // Lights carry no geometry, so bounds are the meshes bound before us —
      // in the normalized (post-root) world, i.e. meters.
      const box = new THREE.Box3().setFromObject(robot3d);
      const sphere = new THREE.Sphere();
      if (!box.isEmpty()) box.getBoundingSphere(sphere);
      metrics = { center: sphere.center.clone(), radius: Math.max(sphere.radius, 0.5) };
    }
    return metrics;
  };

  for (const prim of stage.Traverse()) {
    if (isUnsupportedLight(prim)) {
      warnOnce(
        prim.GetTypeName(),
        `${prim.GetTypeName()} lights are not supported yet; skipping (e.g. ${prim.GetPath()})`,
      );
      continue;
    }
    if (!getLightKind(prim)) continue;
    if (prim.GetAttribute("visibility").Get() === "invisible") continue;
    if (isNonVisualPurpose(prim)) continue;

    const desc = readLightDescription(prim);
    if (!desc) continue;

    if (desc.kind === "dome") {
      domes.push(desc);
      warnOnce(
        "DomeLight",
        `DomeLight ${desc.primPath} is surfaced on robot.domeLights but not yet applied as an environment map (IBL is M26)`,
      );
      continue;
    }

    const light = createThreeLight(desc, worldScaleOf(prim, rootScale), intensityScale, warnOnce);
    if (!light) continue;

    light.name = desc.name;
    light.userData.kind = "light";
    light.userData.primPath = desc.primPath;
    light.userData.usdLight = desc;

    const anchor = findAnchor(prim, anchors);
    light.matrixAutoUpdate = false;
    light.matrix.fromArray(transformFrom(anchor?.prim ?? null, prim));
    light.matrixWorldNeedsUpdate = true;
    (anchor?.object ?? robot3d).add(light);

    if (shadows) configureShadow(light, desc, prim, rootScale, robot3d, sceneMetrics);
    lights.push(light);
  }

  return { lights, domes };
}

/** UsdLux lights emit along their local −Z; Three.js directional/spot lights
 * aim at a `target` object, so one is parented inside the light at (0, 0, −1). */
function aimAlongMinusZ(light: THREE.DirectionalLight | THREE.SpotLight): void {
  const target = new THREE.Object3D();
  target.name = "target";
  target.position.set(0, 0, -1);
  light.add(target);
  light.target = target;
}

/**
 * Realize a (non-dome) light description as a Three.js light. `worldScale`
 * converts authored emitter sizes (stage units under the prim's accumulated
 * scale — stock Isaac rooms scale their light prims) into world meters, which
 * `RectAreaLight` sizes require because Three.js ignores ancestor scale there.
 */
function createThreeLight(
  desc: LightDescription,
  worldScale: number,
  intensityScale: number,
  warnOnce: (key: string, message: string) => void,
): THREE.Light | null {
  const color = new THREE.Color(desc.color[0], desc.color[1], desc.color[2]);
  const intensity = desc.intensity * intensityScale;

  switch (desc.kind) {
    case "distant": {
      const light = new THREE.DirectionalLight(color, intensity);
      aimAlongMinusZ(light);
      return light;
    }
    case "sphere": {
      if (desc.cone) {
        const angle = THREE.MathUtils.degToRad(Math.min(desc.cone.angleDeg, 89.9));
        const penumbra = Math.min(Math.max(desc.cone.softness, 0), 1);
        const light = new THREE.SpotLight(color, intensity, 0, angle, penumbra);
        aimAlongMinusZ(light);
        return light;
      }
      return new THREE.PointLight(color, intensity);
    }
    case "rect": {
      const width = (desc.width ?? 1) * worldScale;
      const height = (desc.height ?? 1) * worldScale;
      return new THREE.RectAreaLight(color, intensity, width, height);
    }
    case "disk": {
      // Square area light matched to the disk: side 2r, emission scaled by the
      // disk/square area ratio (π/4) so total output stays comparable.
      const side = 2 * (desc.radius ?? 0.5) * worldScale;
      return new THREE.RectAreaLight(color, intensity * (Math.PI / 4), side, side);
    }
    case "cylinder":
      warnOnce(
        "CylinderLight",
        `CylinderLight has no Three.js equivalent; approximating as a point light (e.g. ${desc.primPath})`,
      );
      return new THREE.PointLight(color, intensity);
    case "dome":
      return null; // collected by the caller
  }
}

/**
 * Enable and fit shadows. Directional and spot lights cast per ShadowAPI
 * (`shadow:enable` defaults on); point lights only when `shadow:enable` is
 * explicitly authored `true` — a point shadow renders six cube faces, too
 * expensive to switch on for every stock ceiling light. RectAreaLight cannot
 * cast shadows in Three.js.
 */
function configureShadow(
  light: THREE.Light,
  desc: LightDescription,
  prim: Prim,
  rootScale: number,
  robot3d: ThreeUsdRobot,
  sceneMetrics: () => { center: THREE.Vector3; radius: number },
): void {
  const directionalOrSpot =
    (light as THREE.DirectionalLight).isDirectionalLight || (light as THREE.SpotLight).isSpotLight;
  const cast = directionalOrSpot
    ? desc.shadowEnabled
    : (light as THREE.PointLight).isPointLight && desc.shadowAuthored && desc.shadowEnabled;
  if (!cast) return;

  const { center, radius } = sceneMetrics();
  // Light position in the normalized world (stage world × root scale/rotation);
  // good enough to range the shadow camera even for link-mounted lights.
  const m = computeWorldTransform(prim);
  const position = new THREE.Vector3(m[12], m[13], m[14])
    .multiplyScalar(rootScale)
    .applyQuaternion(robot3d.quaternion);
  const distance = position.distanceTo(center);

  light.castShadow = true;

  if ((light as THREE.DirectionalLight).isDirectionalLight) {
    const shadow = (light as THREE.DirectionalLight).shadow;
    shadow.normalBias = 0.02 * radius;
    const camera = shadow.camera;
    const extent = radius * 1.5;
    camera.left = -extent;
    camera.right = extent;
    camera.top = extent;
    camera.bottom = -extent;
    // Negative near keeps geometry behind a light placed inside the scene
    // (distant lights often sit at the origin) inside the ortho frustum.
    camera.near = distance - 2.5 * radius;
    camera.far = distance + 2.5 * radius;
    camera.updateProjectionMatrix();
    shadow.mapSize.set(2048, 2048);
  } else if ((light as THREE.SpotLight).isSpotLight) {
    const shadow = (light as THREE.SpotLight).shadow;
    shadow.normalBias = 0.02 * radius;
    shadow.camera.near = radius / 100;
    shadow.camera.far = distance + 2.5 * radius;
    shadow.camera.updateProjectionMatrix();
    shadow.mapSize.set(1024, 1024);
  } else {
    const shadow = (light as THREE.PointLight).shadow;
    shadow.normalBias = 0.02 * radius;
    shadow.camera.near = radius / 100;
    shadow.camera.far = Math.max(4 * radius, distance + 2 * radius);
    shadow.camera.updateProjectionMatrix();
    shadow.mapSize.set(512, 512);
  }
}

/** The deepest ancestor prim that already has a Three.js object to anchor to. */
function findAnchor(
  prim: Prim,
  anchors: Map<string, THREE.Object3D>,
): { object: THREE.Object3D; prim: Prim } | null {
  for (let p = prim.GetParent(); p && !p.IsPseudoRoot(); p = p.GetParent()) {
    const object = anchors.get(p.GetPath());
    if (object) return { object, prim: p };
  }
  return null;
}

/**
 * Accumulated local transform from `anchorPrim` (exclusive) down to `prim`
 * (inclusive); from the stage root when `anchorPrim` is `null`.
 */
function transformFrom(anchorPrim: Prim | null, prim: Prim): Mat4 {
  const stop = anchorPrim?.GetPath();
  const chain: Prim[] = [];
  for (
    let p: Prim | null = prim;
    p && !p.IsPseudoRoot() && p.GetPath() !== stop;
    p = p.GetParent()
  ) {
    chain.push(p);
  }
  chain.reverse();
  let m = identity4();
  for (const link of chain) m = multiply(m, computeLocalTransform(link).matrix);
  return m;
}

/** Uniform-ish world scale at `prim`: root normalization × the prim chain's scale. */
function worldScaleOf(prim: Prim, rootScale: number): number {
  const m = computeWorldTransform(prim);
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  return rootScale * ((sx + sy + sz) / 3);
}
