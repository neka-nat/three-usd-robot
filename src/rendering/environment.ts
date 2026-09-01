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
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import type { LightDescription } from "../schemas/usdLux.js";
import type { ThreeUsdRobot } from "../three/ThreeUsdRobot.js";
import { computeWorldTransform } from "../usd/xformOps.js";

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
  /** Receives fallback/compatibility diagnostics. */
  onWarn?: (message: string) => void;
};

/** What {@link applyUsdEnvironment} applied to the scene. */
export type UsdEnvironment = {
  dome: LightDescription;
  /** The environment texture — equirectangular HDR/LDR, or 1×1 dome color. */
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
  if (!dome) return null;
  const onWarn = options.onWarn;

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
  return { dome, texture, rotation, intensity };
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
    const texData = new RGBELoader().parse(toArrayBuffer(bytes));
    const texture = new THREE.DataTexture(
      texData.data as unknown as BufferSource,
      texData.width,
      texData.height,
      THREE.RGBAFormat,
      texData.type,
    );
    texture.flipY = true; // Radiance scanlines run top-down
    return finishDataTexture(texture, THREE.LinearSRGBColorSpace);
  }
  if (/\.exr$/i.test(url)) {
    const texData = new EXRLoader().parse(toArrayBuffer(bytes));
    const texture = new THREE.DataTexture(
      texData.data as unknown as BufferSource,
      texData.width,
      texData.height,
      texData.format,
      texData.type,
    );
    texture.flipY = false; // EXR rows decode bottom-up already
    return finishDataTexture(texture, texData.colorSpace);
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

/** 1×1 float environment of the dome's (linear) color — a uniform sky. */
function colorTexture(color: [number, number, number]): THREE.Texture {
  const data = new Float32Array([color[0], color[1], color[2], 1]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.FloatType);
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
