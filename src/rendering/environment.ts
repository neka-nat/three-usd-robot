/**
 * DomeLight → image-based environment lighting (M26).
 *
 * A `DomeLight` is not a discrete light: it is the scene's environment. This
 * module fetches the dome's texture through the robot's captured asset context
 * (so relative CDN paths and `.usdz`-embedded images both work), decodes
 * `.hdr` / `.exr` (via three's addons loaders) or LDR images into an
 * equirectangular texture, and applies it as `scene.environment` — three
 * prefilters equirectangular environments internally, no PMREM setup needed.
 *
 * Orientation: three.js expects the equirect pole along +Y. The dome's pole
 * follows `poleAxis` (`DomeLight_1`) or, for the original `DomeLight` schema,
 * the stage up-axis — composed with the dome prim's own rotation and the
 * loader's up-axis normalization into `scene.environmentRotation` (three
 * r162+; skipped with a warning on older peers when it matters).
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import type { LightDescription } from "../schemas/usdLux.js";
import type { ThreeUsdRobot } from "../three/ThreeUsdRobot.js";
import { computeWorldTransform } from "../usd/xformOps.js";
import { decodeRadianceHdr } from "./radianceHdr.js";

export type ApplyUsdEnvironmentOptions = {
  /** Also show the environment as `scene.background` (default `false`). */
  background?: boolean;
  /**
   * Multiplies the dome's authored emission (`intensity × 2^exposure`) into
   * `scene.environmentIntensity`. Defaults to the `lightIntensityScale` the
   * robot was loaded with, so the environment stays in balance with the bound
   * lights (see docs/lighting.md).
   */
  intensityScale?: number;
  /** The dome to apply when the stage has several (default: the first). */
  dome?: LightDescription;
  /**
   * What to install when the stage authors no DomeLight (M30): `"room"`
   * prefilters three's `RoomEnvironment` (a neutral studio box — needs
   * `renderer`), a `THREE.Texture` is used as given (an equirect or PMREM
   * texture of your own), `"none"` (default) leaves the scene untouched.
   * Robot-only Isaac assets have no dome, and their metals and glossy
   * plastics only read right with something to reflect.
   */
  fallback?: EnvironmentFallback;
  /** The WebGL renderer that prefilters `fallback: "room"`. */
  renderer?: THREE.WebGLRenderer;
  /** `scene.environmentIntensity` for a fallback environment (default 1). */
  fallbackIntensity?: number;
  /** Receives fallback/compatibility diagnostics. */
  onWarn?: (message: string) => void;
};

export type EnvironmentFallback = "none" | "room" | THREE.Texture;

/** What {@link applyUsdEnvironment} applied to the scene. */
export type UsdEnvironment = {
  /** Where the environment came from: the stage's dome, or a fallback (M30). */
  source: "dome" | "room" | "texture";
  /** The DomeLight realized (absent for fallbacks). */
  dome?: LightDescription;
  /** The environment texture — equirectangular HDR/LDR, 1×1 dome color, or the fallback. */
  texture: THREE.Texture;
  /** Environment orientation applied (identity when unsupported by the peer). */
  rotation: THREE.Euler;
  /** Effective emission written to `scene.environmentIntensity`. */
  intensity: number;
};

/**
 * Realize the stage's DomeLight as the scene environment. Resolves the dome's
 * texture (falling back to a uniform texture of the dome color when it has
 * none, or when it cannot be fetched or decoded) and sets
 * `scene.environment(+Rotation/+Intensity)` — and, with
 * `options.background`, the matching background properties. Returns `null`
 * when the robot has no DomeLight; the scene is left untouched.
 */
export async function applyUsdEnvironment(
  robot: ThreeUsdRobot,
  scene: THREE.Scene,
  options: ApplyUsdEnvironmentOptions = {},
): Promise<UsdEnvironment | null> {
  const dome = options.dome ?? robot.domeLights[0];
  const onWarn = options.onWarn;
  if (!dome) return applyFallbackEnvironment(scene, options);

  let texture: THREE.Texture | null = null;
  if (dome.textureFile) {
    if (
      dome.textureFormat &&
      dome.textureFormat !== "latlong" &&
      dome.textureFormat !== "automatic"
    ) {
      onWarn?.(
        `DomeLight texture:format "${dome.textureFormat}" is not supported; sampling it as latlong (equirectangular)`,
      );
    }
    try {
      texture = await loadDomeTexture(robot, dome.textureFile);
    } catch (err) {
      onWarn?.(
        `DomeLight texture ${dome.textureFile} could not be loaded (${(err as Error).message}); falling back to the dome color`,
      );
    }
  }
  texture ??= colorTexture(dome.color);

  const intensity = dome.intensity * (options.intensityScale ?? robot.lightIntensityScale ?? 1);
  const rotation = domeRotation(robot, dome);

  scene.environment = texture;
  setSceneEuler(scene, "environmentRotation", rotation, onWarn);
  setSceneNumber(scene, "environmentIntensity", intensity, onWarn);
  if (options.background) {
    scene.background = texture;
    setSceneEuler(scene, "backgroundRotation", rotation, undefined);
    setSceneNumber(scene, "backgroundIntensity", intensity, undefined);
  }
  return { source: "dome", dome, texture, rotation, intensity };
}

/** The dome-less branch of {@link applyUsdEnvironment} (M30). */
function applyFallbackEnvironment(
  scene: THREE.Scene,
  options: ApplyUsdEnvironmentOptions,
): UsdEnvironment | null {
  const fallback = options.fallback ?? "none";
  if (fallback === "none") return null;
  let texture: THREE.Texture;
  let source: UsdEnvironment["source"];
  if (fallback === "room") {
    if (!options.renderer) {
      options.onWarn?.(
        'fallback: "room" needs the renderer to prefilter the RoomEnvironment; no environment applied',
      );
      return null;
    }
    texture = createRoomEnvironment(options.renderer);
    source = "room";
  } else {
    texture = fallback;
    source = "texture";
  }
  const intensity = options.fallbackIntensity ?? 1;
  const rotation = new THREE.Euler();
  scene.environment = texture;
  setSceneEuler(scene, "environmentRotation", rotation, undefined);
  setSceneNumber(scene, "environmentIntensity", intensity, options.onWarn);
  return { source, texture, rotation, intensity };
}

/**
 * three's `RoomEnvironment` (a neutral studio box) prefiltered into an
 * environment texture — the stand-in sky for stages without a DomeLight
 * (M30). Build it once per renderer and reuse it; the caller owns disposal.
 */
export function createRoomEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

/**
 * Fetch and decode the dome image through the robot's asset context: `.hdr`
 * (Radiance RGBE) and `.exr` decode to float data textures; anything else
 * decodes as an LDR image (browser only). The result is equirect-mapped.
 */
async function loadDomeTexture(robot: ThreeUsdRobot, assetPath: string): Promise<THREE.Texture> {
  const context = robot.assetContext;
  if (!context) {
    throw new Error("robot carries no asset context (was it built by ThreeUsdRobotLoader?)");
  }
  const url = context.resolver.resolve(assetPath, context.baseUrl);
  const bytes = context.resolver.fetchBytes
    ? await context.resolver.fetchBytes(url)
    : new TextEncoder().encode(await context.resolver.fetchText(url));

  if (/\.hdr$/i.test(url)) {
    // In-house RGBE decoder (M29): independent of three's RGBELoader →
    // HDRLoader rename in r180.
    const image = decodeRadianceHdr(bytes);
    const texture = new THREE.DataTexture(
      image.data,
      image.width,
      image.height,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    );
    texture.flipY = true; // Radiance scanlines run top-down
    return finishDataTexture(texture, THREE.LinearSRGBColorSpace);
  }
  if (/\.exr$/i.test(url)) {
    const texData = new EXRLoader().parse(toArrayBuffer(bytes));
    const texture = new THREE.DataTexture(
      // Typed as a generic typed array across three releases (r186 narrowed it).
      texData.data as unknown as Float32Array,
      texData.width,
      texData.height,
      texData.format,
      texData.type,
    );
    texture.flipY = false; // EXR rows decode bottom-up already
    return finishDataTexture(texture, texData.colorSpace ?? THREE.LinearSRGBColorSpace);
  }

  const texture = new THREE.Texture(await decodeImage(bytes, url));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

function finishDataTexture(texture: THREE.DataTexture, colorSpace: string): THREE.Texture {
  texture.colorSpace = colorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Small float equirect filled with the dome's (linear) color — a uniform sky.
 * Deliberately not 1×1: three's PMREM prefilter sizes its cubemap from the
 * equirect width (width / 4), and a degenerate size breaks the shader of
 * every environment-lit material (`useProgram: program not valid`).
 */
function colorTexture(color: [number, number, number]): THREE.Texture {
  const width = 64;
  const height = 32;
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 1;
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  return finishDataTexture(texture, THREE.LinearSRGBColorSpace);
}

/**
 * Environment orientation: (root up-axis normalization) × (dome prim's stage
 * rotation) × (pole correction from three's +Y-pole equirect convention to
 * the dome's pole axis).
 */
function domeRotation(robot: ThreeUsdRobot, dome: LightDescription): THREE.Euler {
  const q = robot.quaternion.clone();

  const prim = robot.stage?.GetPrimAtPath(dome.primPath);
  if (prim) {
    const world = new THREE.Matrix4().fromArray(computeWorldTransform(prim));
    const rotation = new THREE.Matrix4().extractRotation(world); // drops the prim chain's scale
    q.multiply(new THREE.Quaternion().setFromRotationMatrix(rotation));
  }

  // DomeLight_1 authors poleAxis; the original schema follows the stage up-axis.
  const pole = dome.poleAxis === "Y" || dome.poleAxis === "Z" ? dome.poleAxis : robot.robot.upAxis;
  if (pole === "Z") {
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  }
  return environmentEulerFor(q);
}

/**
 * The `Scene.environmentRotation` / `backgroundRotation` Euler that shows the
 * environment rotated by `visible` on the installed three (M29). Up to r183
 * the renderer applied the Euler to the *sampling* vector, which displays the
 * map rotated by the inverse; r184 (#33077 / #33232) aligned it with how
 * objects rotate. `revision` is overridable for tests.
 */
export function environmentEulerFor(
  visible: THREE.Quaternion,
  revision: number = Number(THREE.REVISION),
): THREE.Euler {
  const q = revision >= 184 ? visible : visible.clone().invert();
  return new THREE.Euler().setFromQuaternion(q);
}

/** Set a Scene Euler property when the installed three has it (r162+). */
function setSceneEuler(
  scene: THREE.Scene,
  name: "environmentRotation" | "backgroundRotation",
  rotation: THREE.Euler,
  onWarn: ((message: string) => void) | undefined,
): void {
  if (name in scene) {
    scene[name].copy(rotation);
  } else if (Math.abs(rotation.x) + Math.abs(rotation.y) + Math.abs(rotation.z) > 1e-6) {
    onWarn?.(`this three.js has no Scene.${name} (added r162); the dome orientation is dropped`);
  }
}

/** Set a Scene number property when the installed three has it (r163+). */
function setSceneNumber(
  scene: THREE.Scene,
  name: "environmentIntensity" | "backgroundIntensity",
  value: number,
  onWarn: ((message: string) => void) | undefined,
): void {
  if (name in scene) {
    scene[name] = value;
  } else if (Math.abs(value - 1) > 1e-6) {
    onWarn?.(`this three.js has no Scene.${name} (added r163); the dome intensity is dropped`);
  }
}

/** `RGBELoader.parse` wants an ArrayBuffer aligned to the data. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/** Decode LDR image bytes via a blob URL (browser environments). */
function decodeImage(bytes: Uint8Array, url: string): Promise<HTMLImageElement> {
  if (typeof Image === "undefined") {
    return Promise.reject(new Error("LDR dome textures need a browser image decoder"));
  }
  const mime = /\.jpe?g$/i.test(url)
    ? "image/jpeg"
    : /\.webp$/i.test(url)
      ? "image/webp"
      : "image/png";
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`failed to decode dome texture: ${url}`));
    };
    img.src = objectUrl;
  });
}
