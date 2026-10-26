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
 * {@link ThreeUsdRobot.domeLights}, to be applied as the scene environment by
 * `applyUsdEnvironment` from `three-usd-robot/rendering` (M26).
 */

import * as THREE from "three";
import { isInvisible, isNonVisualPurpose } from "../schemas/usdGeom.js";
import {
  type LightDescription,
  getLightKind,
  isUnsupportedLight,
  readLightDescription,
} from "../schemas/usdLux.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import { computeWorldTransform } from "../usd/xformOps.js";
import type { ThreeUsdRobot } from "./ThreeUsdRobot.js";
import { attachAtPrim, collectAnchors, worldScaleOf } from "./stageAnchors.js";

export type BindLightsOptions = {
  /**
   * How authored emissions (`intensity × 2^exposure`) map to Three.js
   * intensities. A number multiplies them verbatim. `"auto"` (the default)
   * detects photometric authoring per stage — Omniverse/RTX assets carry
   * values in the hundreds to tens of thousands — and scales every light and
   * dome by `0.001` when any emission exceeds `100`, leaving unitless stages
   * untouched. See docs/lighting.md.
   */
  lightIntensityScale?: number | "auto";
  /**
   * Configure shadow casting: `castShadow` per the light's ShadowAPI, with the
   * shadow camera fitted to the scene bounds. Default `false` here — the
   * loader defaults it on.
   */
  shadows?: boolean;
  /**
   * How an emitter's size enters its Three.js intensity (M29). `"radiance"`
   * follows UsdLux / RTX: `intensity` is the emitted radiance, so a sphere of
   * radius r becomes a point light of `π r² × intensity` candela, a rect
   * keeps `intensity` as nits, and `normalize = true` divides by the emitter
   * area first. `"point"` passes `intensity` straight through (Storm-style
   * unitless authoring). `"auto"` (default) picks `"radiance"` for
   * photometric stages — the ones the `"auto"` intensity scale recognizes —
   * and `"point"` otherwise.
   */
  emitterModel?: "auto" | "radiance" | "point";
  /**
   * Extra photometric emissions (e.g. OmniPBR `emissive_intensity` in nits)
   * that take part in the `"auto"` calibration decision alongside the lights.
   */
  additionalEmissions?: number[];
  /**
   * Give RectLights / DiskLights a shadow (M30). three's `RectAreaLight`
   * casts none, so a co-located `SpotLight` child takes `share` of the
   * panel's emission (on-axis candela = share × nits × area) and casts a
   * soft shadow map while the area light keeps the rest — the shadow's
   * darkness equals the share. `true` ≙ `{ share: 0.5, mapSize: 2048 }`.
   * Default `false` here; the loader turns it on with `shadows`. The proxy
   * is reachable as `light.userData.shadowProxy`.
   */
  areaLightShadows?: boolean | AreaLightShadowOptions;
  /**
   * What shadow cameras are fitted to (M30): the whole bound scene
   * (default) or only the robot's links — tighter texels on the robot when
   * it stands in a large cell, at the price of scenery outside the frustum
   * casting nothing.
   */
  shadowFocus?: "scene" | "robot";
  /** Receives fidelity diagnostics (unsupported/approximated light types). */
  onWarn?: (message: string) => void;
};

export type AreaLightShadowOptions = {
  /** Fraction of the area light's emission moved onto the shadow-casting spot (default 0.5). */
  share?: number;
  /** Shadow map resolution for the proxy (default 2048). */
  mapSize?: number;
};

/** Result of {@link bindLights}. */
export type BoundLights = {
  /**
   * The Three.js lights created, already attached to the hierarchy. Each
   * carries `userData.primPath` and `userData.usdLight` (its
   * {@link LightDescription}).
   */
  lights: THREE.Light[];
  /** DomeLights parsed but not realized — apply via `applyUsdEnvironment` (M26). */
  domes: LightDescription[];
  /**
   * The intensity multiplier actually applied — `"auto"` resolved against the
   * stage's authored emissions (`0.001` or `1`), or the number passed in.
   * Feed it to `applyUsdEnvironment` so the dome environment matches; the
   * loader stores it on {@link ThreeUsdRobot.lightIntensityScale}.
   */
  appliedIntensityScale: number;
  /** The emitter model actually applied (`"auto"` resolved; M29). */
  emitterModel: "radiance" | "point";
  /** Shadow-casting spot proxies added under area lights (M30). */
  shadowProxies: THREE.SpotLight[];
};

/** Emissions above this read as photometric (nits/lux-style) authoring. */
const AUTO_PHOTOMETRIC_THRESHOLD = 100;
/** The stage-wide multiplier `"auto"` applies to photometric authoring. */
const AUTO_PHOTOMETRIC_SCALE = 0.001;

/** True when the stage's emissions read as photometric authoring. */
function isPhotometric(descriptions: LightDescription[], extra: number[]): boolean {
  const max = [...descriptions.map((d) => d.intensity), ...extra].reduce(
    (m, v) => Math.max(m, v),
    0,
  );
  return max > AUTO_PHOTOMETRIC_THRESHOLD;
}

/** Resolve `"auto"` against everything the stage authors (lights and domes). */
function resolveIntensityScale(option: number | "auto", photometric: boolean): number {
  if (option !== "auto") return option;
  return photometric ? AUTO_PHOTOMETRIC_SCALE : 1;
}

type EmitterModel = "radiance" | "point";

function resolveEmitterModel(
  option: "auto" | "radiance" | "point" | undefined,
  photometric: boolean,
): EmitterModel {
  if (option === "radiance" || option === "point") return option;
  return photometric ? "radiance" : "point";
}

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
  const shadows = options.shadows ?? false;
  const lights: THREE.Light[] = [];
  const domes: LightDescription[] = [];

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    options.onWarn?.(message);
  };

  // The deepest already-bound ancestor (scenery group, gprim, link frame)
  // anchors each light so it inherits that subtree's motion.
  const anchors = collectAnchors(robot3d);

  const rootScale = robot3d.scale.x || 1;
  let metrics: { center: THREE.Vector3; radius: number } | null = null;
  const sceneMetrics = () => {
    if (!metrics) {
      // Lights carry no geometry, so bounds are the meshes bound before us —
      // in the normalized (post-root) world, i.e. meters. `shadowFocus:
      // "robot"` narrows them to the link subtrees (M30).
      robot3d.updateMatrixWorld(true);
      const box = new THREE.Box3();
      if (options.shadowFocus === "robot") {
        for (const link of robot3d.getLinkObjectsByPath().values()) {
          box.union(new THREE.Box3().setFromObject(link));
        }
      }
      if (box.isEmpty()) box.setFromObject(robot3d);
      const sphere = new THREE.Sphere();
      if (!box.isEmpty()) box.getBoundingSphere(sphere);
      metrics = { center: sphere.center.clone(), radius: Math.max(sphere.radius, 0.5) };
    }
    return metrics;
  };
  const areaShadow = resolveAreaShadowOptions(options.areaLightShadows);
  const shadowProxies: THREE.SpotLight[] = [];

  // First pass: gather every renderable light description, so `"auto"` can
  // judge the stage's authoring style before any intensity is committed.
  const gathered: { prim: Prim; desc: LightDescription }[] = [];
  for (const prim of stage.Traverse()) {
    if (isUnsupportedLight(prim)) {
      warnOnce(
        prim.GetTypeName(),
        `${prim.GetTypeName()} lights are not supported yet; skipping (e.g. ${prim.GetPath()})`,
      );
      continue;
    }
    if (!getLightKind(prim)) continue;
    if (isInvisible(prim) || isNonVisualPurpose(prim)) continue;
    const desc = readLightDescription(prim);
    if (desc) gathered.push({ prim, desc });
  }

  const photometric = isPhotometric(
    gathered.map(({ desc }) => desc),
    options.additionalEmissions ?? [],
  );
  const intensityScale = resolveIntensityScale(options.lightIntensityScale ?? "auto", photometric);
  const emitterModel = resolveEmitterModel(options.emitterModel, photometric);

  for (const { prim, desc } of gathered) {
    if (desc.kind === "dome") {
      domes.push(desc);
      warnOnce(
        "DomeLight",
        `DomeLight ${desc.primPath} is surfaced on robot.domeLights — apply it as the scene environment with applyUsdEnvironment from three-usd-robot/rendering`,
      );
      continue;
    }

    const light = createThreeLight(
      desc,
      worldScaleOf(prim, rootScale),
      intensityScale,
      emitterModel,
      warnOnce,
    );
    if (!light) continue;

    light.name = desc.name;
    light.userData.kind = "light";
    light.userData.primPath = desc.primPath;
    light.userData.usdLight = desc;

    attachAtPrim(light, prim, anchors, robot3d);

    if (shadows) {
      configureShadow(light, desc, prim, rootScale, robot3d, sceneMetrics);
      if (areaShadow && (light as THREE.RectAreaLight).isRectAreaLight && desc.shadowEnabled) {
        shadowProxies.push(
          addAreaShadowProxy(
            light as THREE.RectAreaLight,
            desc,
            prim,
            rootScale,
            robot3d,
            sceneMetrics,
            areaShadow,
          ),
        );
      }
    }
    lights.push(light);
  }

  return { lights, domes, appliedIntensityScale: intensityScale, emitterModel, shadowProxies };
}

function resolveAreaShadowOptions(
  option: boolean | AreaLightShadowOptions | undefined,
): Required<AreaLightShadowOptions> | null {
  if (!option) return null;
  const opts = option === true ? {} : option;
  return {
    share: Math.min(Math.max(opts.share ?? 0.5, 0), 1),
    mapSize: opts.mapSize ?? 2048,
  };
}

/**
 * Shadow proxy for an area light (M30): a `SpotLight` child at the panel's
 * origin, aimed along its −Z, carrying `share` of the emission as the
 * on-axis luminous intensity of a Lambertian panel (radiance × area, in
 * candela) with a soft shadow map fitted to the scene; the area light keeps
 * `1 − share`. The cone is widened to cover the scene bounds as seen from
 * the light (up to ~85°).
 */
function addAreaShadowProxy(
  area: THREE.RectAreaLight,
  desc: LightDescription,
  prim: Prim,
  rootScale: number,
  robot3d: ThreeUsdRobot,
  sceneMetrics: () => { center: THREE.Vector3; radius: number },
  options: Required<AreaLightShadowOptions>,
): THREE.SpotLight {
  const { center, radius } = sceneMetrics();
  const m = computeWorldTransform(prim);
  const position = new THREE.Vector3(m[12], m[13], m[14])
    .multiplyScalar(rootScale)
    .applyQuaternion(robot3d.quaternion);
  const distance = Math.max(position.distanceTo(center), 1e-3);

  const candela = options.share * area.intensity * area.width * area.height;
  area.intensity *= 1 - options.share;

  // Cover the scene as seen from the panel, but cap the cone at 60°: past
  // that the spot's perspective shadow map (FOV = 2 × angle) degenerates and
  // the shadow vanishes — a ceiling panel aimed down still covers a floor
  // radius of 1.7 × its height.
  const halfAngle = Math.min(Math.atan2(radius, distance) + 0.2, Math.PI / 3);
  const proxy = new THREE.SpotLight(area.color.clone(), candela, 0, halfAngle, 0.5, 2);
  proxy.name = `${desc.name}_shadow`;
  proxy.userData.kind = "light";
  proxy.userData.shadowProxy = true;
  proxy.userData.primPath = desc.primPath;
  aimAlongMinusZ(proxy);
  area.add(proxy);
  area.userData.shadowProxy = proxy;

  proxy.castShadow = true;
  const shadow = proxy.shadow;
  // Small biases: the panel's shadow is what this proxy exists for, and the
  // scene-radius-scaled normal bias of the other lights would erase it.
  shadow.normalBias = 0.004 * radius;
  shadow.bias = -0.0002;
  shadow.radius = 4; // PCF softening (ignored by PCFSoft; r182+ PCF is soft anyway)
  shadow.camera.near = Math.max(radius / 100, 0.01);
  shadow.camera.far = distance + 2.5 * radius;
  shadow.camera.updateProjectionMatrix();
  shadow.mapSize.set(options.mapSize, options.mapSize);
  return proxy;
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
  model: EmitterModel,
  warnOnce: (key: string, message: string) => void,
): THREE.Light | null {
  const color = new THREE.Color(desc.color[0], desc.color[1], desc.color[2]);
  const intensity = desc.intensity * intensityScale;
  const radiance = model === "radiance";

  switch (desc.kind) {
    case "distant": {
      const light = new THREE.DirectionalLight(color, intensity);
      aimAlongMinusZ(light);
      return light;
    }
    case "sphere": {
      // Radiance model (M29): a sphere of radius r with radiance L shows a
      // projected area π r² from every direction → L π r² candela. With
      // `normalize` the authored value is spread over the surface 4 π r²
      // first, leaving L / 4. `treatAsPoint` keeps the value as candela.
      const r = (desc.radius ?? 0.5) * worldScale;
      const candela =
        radiance && !desc.treatAsPoint
          ? desc.normalize
            ? intensity / 4
            : intensity * Math.PI * r * r
          : intensity;
      if (desc.cone) {
        const angle = THREE.MathUtils.degToRad(Math.min(desc.cone.angleDeg, 89.9));
        const penumbra = Math.min(Math.max(desc.cone.softness, 0), 1);
        const light = new THREE.SpotLight(color, candela, 0, angle, penumbra);
        aimAlongMinusZ(light);
        return light;
      }
      return new THREE.PointLight(color, candela);
    }
    case "rect": {
      const width = (desc.width ?? 1) * worldScale;
      const height = (desc.height ?? 1) * worldScale;
      // RectAreaLight intensity is a radiance (nits) already; `normalize`
      // divides the authored power by the panel area.
      const nits =
        radiance && desc.normalize ? intensity / Math.max(width * height, 1e-9) : intensity;
      return new THREE.RectAreaLight(color, nits, width, height);
    }
    case "disk": {
      // Square area light matched to the disk: side 2r, emission scaled by the
      // disk/square area ratio (π/4) so total output stays comparable.
      const r = (desc.radius ?? 0.5) * worldScale;
      const side = 2 * r;
      const nits =
        radiance && desc.normalize ? intensity / Math.max(Math.PI * r * r, 1e-9) : intensity;
      return new THREE.RectAreaLight(color, nits * (Math.PI / 4), side, side);
    }
    case "cylinder": {
      warnOnce(
        "CylinderLight",
        `CylinderLight has no Three.js equivalent; approximating as a point light (e.g. ${desc.primPath})`,
      );
      // Side-on projected area 2 r l (radiance), or the power spread over the
      // lateral surface 2 π r l when normalized.
      const r = (desc.radius ?? 0.5) * worldScale;
      const length = (desc.length ?? 1) * worldScale;
      const candela = radiance
        ? desc.normalize
          ? intensity / Math.PI
          : intensity * 2 * r * length
        : intensity;
      return new THREE.PointLight(color, candela);
    }
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
