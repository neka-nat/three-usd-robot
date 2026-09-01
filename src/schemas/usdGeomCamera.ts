/**
 * UsdGeomCamera schema helpers (M27) — type check, description extraction,
 * and the linear exposure-scale math.
 *
 * Focal length and apertures follow the practical convention of every DCC
 * (Isaac Sim, Blender, usdview): they are millimeters on a virtual film back,
 * regardless of stage units. Clipping range and focus distance are stage
 * units. Orthographic apertures are tenths of a stage unit (GfCamera's
 * `APERTURE_UNIT`), so `aperture / 10` is the view-box size.
 */

import type { Prim } from "../usd/Prim.js";

export function isCamera(prim: Prim): boolean {
  return prim.GetTypeName() === "Camera";
}

/** A UsdGeomCamera resolved to plain values (schema fallbacks applied). */
export type CameraDescription = {
  primPath: string;
  name: string;
  projection: "perspective" | "orthographic";
  /** Millimeters (see module doc). */
  focalLength: number;
  horizontalAperture: number;
  verticalAperture: number;
  /** Lens shift, millimeters. */
  horizontalApertureOffset: number;
  verticalApertureOffset: number;
  /** Near/far, stage units. */
  clippingRange: [number, number];
  /** `0` disables depth of field. */
  fStop: number;
  /** Stage units; `0` = unset. */
  focusDistance: number;
  /** Exposure compensation, stops (EV). */
  exposure: number;
  /** Exposure system (USD 24.11) — authored values only, see {@link computeCameraExposureScale}. */
  exposureIso?: number;
  exposureTime?: number;
  exposureFStop?: number;
  exposureResponsivity?: number;
};

/** Resolve a Camera prim into a {@link CameraDescription}, or `null` if not one. */
export function readCameraDescription(prim: Prim): CameraDescription | null {
  if (!isCamera(prim)) return null;

  const projection = attrString(prim, "projection");
  const range = attrVec2(prim, "clippingRange") ?? [1, 1000000];
  const desc: CameraDescription = {
    primPath: prim.GetPath(),
    name: prim.GetName(),
    projection: projection === "orthographic" ? "orthographic" : "perspective",
    focalLength: attrNumber(prim, "focalLength") ?? 50,
    horizontalAperture: attrNumber(prim, "horizontalAperture") ?? 20.955,
    verticalAperture: attrNumber(prim, "verticalAperture") ?? 15.2908,
    horizontalApertureOffset: attrNumber(prim, "horizontalApertureOffset") ?? 0,
    verticalApertureOffset: attrNumber(prim, "verticalApertureOffset") ?? 0,
    clippingRange: [range[0], range[1]],
    fStop: attrNumber(prim, "fStop") ?? 0,
    focusDistance: attrNumber(prim, "focusDistance") ?? 0,
    exposure: attrNumber(prim, "exposure") ?? 0,
  };
  const iso = attrNumber(prim, "exposure:iso");
  if (iso !== undefined) desc.exposureIso = iso;
  const time = attrNumber(prim, "exposure:time");
  if (time !== undefined) desc.exposureTime = time;
  const fStop = attrNumber(prim, "exposure:fStop");
  if (fStop !== undefined) desc.exposureFStop = fStop;
  const responsivity = attrNumber(prim, "exposure:responsivity");
  if (responsivity !== undefined) desc.exposureResponsivity = responsivity;
  return desc;
}

/**
 * `UsdGeomCamera::ComputeLinearExposureScale` (USD 24.11):
 * `time × iso/100 × responsivity ÷ fStop² × 2^exposure`. Schema fallbacks
 * make an unauthored camera scale by exactly `2^exposure` (i.e. `1`), so it
 * is safe to feed straight into `renderer.toneMappingExposure` — a stage
 * authored with real photographic values yields a physically small scale that
 * pairs with `lightIntensityScale: 1` raw photometric lighting.
 */
export function computeCameraExposureScale(camera: CameraDescription): number {
  const fStop = camera.exposureFStop ?? 1;
  return (
    ((camera.exposureTime ?? 1) *
      ((camera.exposureIso ?? 100) / 100) *
      (camera.exposureResponsivity ?? 1) *
      2 ** camera.exposure) /
    (fStop * fStop)
  );
}

function attrNumber(prim: Prim, name: string): number | undefined {
  const v = prim.GetAttribute(name).Get();
  return typeof v === "number" ? v : undefined;
}

function attrString(prim: Prim, name: string): string | undefined {
  const v = prim.GetAttribute(name).Get();
  return typeof v === "string" ? v : undefined;
}

function attrVec2(prim: Prim, name: string): [number, number] | undefined {
  const v = prim.GetAttribute(name).Get();
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [v[0], v[1]];
  }
  return undefined;
}
