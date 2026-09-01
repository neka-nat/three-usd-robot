/**
 * UsdLux schema helpers (M25) — type checks and light description extraction.
 *
 * Light inputs are read `inputs:`-namespaced first with a fallback to the
 * pre-21.02 un-namespaced spelling; Omniverse assets author both (and some,
 * like `texture:file` on stock Isaac DomeLights, only the legacy one).
 * Extraction is Three.js-independent: the resulting {@link LightDescription}
 * is bound to concrete lights in `three/LightBinding`.
 */

import { AssetPath } from "../parser/ast.js";
import type { Prim } from "../usd/Prim.js";

/** Renderable UsdLux kinds (`DomeLight_1` is the 23.11 dome revision). */
const LIGHT_KIND_BY_TYPE: ReadonlyMap<string, UsdLightKind> = new Map([
  ["DistantLight", "distant"],
  ["SphereLight", "sphere"],
  ["RectLight", "rect"],
  ["DiskLight", "disk"],
  ["CylinderLight", "cylinder"],
  ["DomeLight", "dome"],
  ["DomeLight_1", "dome"],
]);

/** Recognized but unrenderable light schemas (skipped with a warning). */
const UNSUPPORTED_LIGHT_TYPES: ReadonlySet<string> = new Set([
  "PortalLight",
  "GeometryLight",
  "PluginLight",
]);

export type UsdLightKind = "distant" | "sphere" | "rect" | "disk" | "cylinder" | "dome";

/** True for any UsdLux light prim this runtime can bind (or collect, for domes). */
export function isLight(prim: Prim): boolean {
  return LIGHT_KIND_BY_TYPE.has(prim.GetTypeName());
}

/** True for a light schema the runtime knows about but cannot render (yet). */
export function isUnsupportedLight(prim: Prim): boolean {
  return UNSUPPORTED_LIGHT_TYPES.has(prim.GetTypeName());
}

/** The light kind of a prim, or `null` for non-light prims. */
export function getLightKind(prim: Prim): UsdLightKind | null {
  return LIGHT_KIND_BY_TYPE.get(prim.GetTypeName()) ?? null;
}

/**
 * A UsdLux light resolved to plain values. Sizes and distances are in stage
 * units of the light's local frame — multiply by the accumulated world scale
 * (the prim chain often carries an `xformOp:scale`, e.g. stock Isaac rooms).
 */
export type LightDescription = {
  primPath: string;
  name: string;
  kind: UsdLightKind;
  /**
   * Effective linear RGB: `inputs:color`, multiplied by the blackbody tint of
   * `inputs:colorTemperature` when `inputs:enableColorTemperature` is set.
   */
  color: [number, number, number];
  /**
   * Effective scalar emission: `inputs:intensity × 2^inputs:exposure`, in the
   * authoring app's photometric units (see docs/lighting.md for calibration).
   * Defaults to 1, except DistantLight whose schema fallback is 50000.
   */
  intensity: number;
  /** `inputs:normalize` — power is normalized by emitter size (not applied yet). */
  normalize: boolean;
  /** ShadowAPI `shadow:enable`, defaulting to `true` when unauthored. */
  shadowEnabled: boolean;
  /** True when `shadow:enable` is actually authored (gates point-light shadows). */
  shadowAuthored: boolean;
  /** ShapingAPI cone when it actually restricts emission (half-angle < 90°). */
  cone?: { angleDeg: number; softness: number };
  /** SphereLight / DiskLight / CylinderLight radius (stage units). */
  radius?: number;
  /** RectLight size (stage units). */
  width?: number;
  height?: number;
  /** CylinderLight length (stage units). */
  length?: number;
  /** DistantLight angular size (degrees). */
  angle?: number;
  /** SphereLight `treatAsPoint`. */
  treatAsPoint?: boolean;
  /** DomeLight / RectLight `texture:file` asset path (unresolved). */
  textureFile?: string;
  /** DomeLight `texture:format` (`latlong`, `angular`, …). */
  textureFormat?: string;
  /** DomeLight_1 `poleAxis` (`scene` / `Y` / `Z`). */
  poleAxis?: string;
};

/**
 * Resolve a light prim into a {@link LightDescription}, or `null` for
 * non-light prims. Purely declarative — visibility/purpose gating is the
 * binder's concern.
 */
export function readLightDescription(prim: Prim): LightDescription | null {
  const kind = getLightKind(prim);
  if (!kind) return null;

  const intensity = inputNumber(prim, "intensity") ?? (kind === "distant" ? 50000 : 1);
  const exposure = inputNumber(prim, "exposure") ?? 0;

  let color = inputVec3(prim, "color") ?? ([1, 1, 1] as [number, number, number]);
  if (inputBoolean(prim, "enableColorTemperature") === true) {
    const tint = colorTemperatureToRgb(inputNumber(prim, "colorTemperature") ?? 6500);
    color = [color[0] * tint[0], color[1] * tint[1], color[2] * tint[2]];
  }

  const shadowAuthoredValue = inputBoolean(prim, "shadow:enable");
  const desc: LightDescription = {
    primPath: prim.GetPath(),
    name: prim.GetName(),
    kind,
    color,
    intensity: intensity * 2 ** exposure,
    normalize: inputBoolean(prim, "normalize") ?? false,
    shadowEnabled: shadowAuthoredValue ?? true,
    shadowAuthored: shadowAuthoredValue !== undefined,
  };

  // ShapingAPI: Omniverse authors `angle = 180` as "no coning"; only a
  // half-angle below 90° actually restricts emission to a cone.
  const coneAngle = inputNumber(prim, "shaping:cone:angle");
  if (coneAngle !== undefined && coneAngle < 90) {
    desc.cone = { angleDeg: coneAngle, softness: inputNumber(prim, "shaping:cone:softness") ?? 0 };
  }

  switch (kind) {
    case "distant": {
      const angle = inputNumber(prim, "angle");
      if (angle !== undefined) desc.angle = angle;
      break;
    }
    case "sphere": {
      desc.radius = inputNumber(prim, "radius") ?? 0.5;
      const asPoint = inputBoolean(prim, "treatAsPoint");
      if (asPoint !== undefined) desc.treatAsPoint = asPoint;
      break;
    }
    case "rect": {
      desc.width = inputNumber(prim, "width") ?? 1;
      desc.height = inputNumber(prim, "height") ?? 1;
      const file = inputAssetPath(prim, "texture:file");
      if (file) desc.textureFile = file;
      break;
    }
    case "disk":
      desc.radius = inputNumber(prim, "radius") ?? 0.5;
      break;
    case "cylinder":
      desc.radius = inputNumber(prim, "radius") ?? 0.5;
      desc.length = inputNumber(prim, "length") ?? 1;
      break;
    case "dome": {
      const file = inputAssetPath(prim, "texture:file");
      if (file) desc.textureFile = file;
      const format = inputString(prim, "texture:format");
      if (format) desc.textureFormat = format;
      const poleAxis = inputString(prim, "poleAxis");
      if (poleAxis) desc.poleAxis = poleAxis;
      break;
    }
  }
  return desc;
}

/** Read `inputs:<name>` with a fallback to the legacy un-namespaced `<name>`. */
function inputValue(prim: Prim, name: string): unknown {
  const namespaced = prim.GetAttribute(`inputs:${name}`).Get();
  if (namespaced !== undefined) return namespaced;
  return prim.GetAttribute(name).Get();
}

function inputNumber(prim: Prim, name: string): number | undefined {
  const v = inputValue(prim, name);
  return typeof v === "number" ? v : undefined;
}

function inputBoolean(prim: Prim, name: string): boolean | undefined {
  const v = inputValue(prim, name);
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1; // bools sometimes author as ints
  return undefined;
}

function inputString(prim: Prim, name: string): string | undefined {
  const v = inputValue(prim, name);
  return typeof v === "string" ? v : undefined;
}

function inputVec3(prim: Prim, name: string): [number, number, number] | undefined {
  const v = inputValue(prim, name);
  if (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    typeof v[2] === "number"
  ) {
    return [v[0], v[1], v[2]];
  }
  return undefined;
}

function inputAssetPath(prim: Prim, name: string): string | undefined {
  const v = inputValue(prim, name);
  return v instanceof AssetPath && v.path ? v.path : undefined;
}

/**
 * Blackbody temperature → linear-ish RGB tint, normalized so 6500 K is white.
 * Piecewise curve fit (Tanner Helland's approximation); good to a few percent
 * over UsdLux's 1000–10000 K authoring range.
 */
export function colorTemperatureToRgb(kelvin: number): [number, number, number] {
  const raw = blackbodyRgb(kelvin);
  const white = blackbodyRgb(6500);
  return [raw[0] / white[0], raw[1] / white[1], raw[2] / white[2]];
}

function blackbodyRgb(kelvin: number): [number, number, number] {
  const t = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (v: number) => Math.min(Math.max(v, 0), 255) / 255;
  return [clamp(r), clamp(g), clamp(b)];
}
