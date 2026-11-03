/**
 * Wire an XR controller's grip button to a {@link TcpTargetHandle}: squeeze
 * to grab (the handle keeps its offset to the grip space and follows it),
 * let go to release — the commit point for a taught pose. The application
 * still owns what a `change` means; this only connects the two.
 */

import * as THREE from "three";
import type { TcpTargetHandle } from "../helpers/TcpTargetHandle.js";
import { onXrInput } from "./events.js";

export type XrGrabOptions = {
  /** Event that starts the grab (default `"squeezestart"`, the grip button). */
  start?: "squeezestart" | "selectstart";
  /** Event that ends it (default `"squeezeend"`). */
  end?: "squeezeend" | "selectend";
  /** Only grab when the grip is within this distance of the handle (world units; default: always). */
  maxDistance?: number;
  /** Extra gate evaluated at the start event (e.g. "the ray points at the handle"). */
  when?: () => boolean;
};

/**
 * Bind the grip's start / end events to `handle.grab(grip)` / `handle.release()`.
 * Returns the unbind function, which also releases a grab in progress.
 *
 * ```ts
 * const unbind = bindXrGrab(handle, rig.grips[0], { maxDistance: 0.15 });
 * ```
 */
export function bindXrGrab(
  handle: TcpTargetHandle,
  grip: THREE.Object3D,
  options: XrGrabOptions = {},
): () => void {
  let held = false;
  const offStart = onXrInput(grip, options.start ?? "squeezestart", () => {
    if (options.when && !options.when()) return;
    if (options.maxDistance !== undefined) {
      grip.updateWorldMatrix(true, false);
      handle.updateWorldMatrix(true, false);
      const distance = new THREE.Vector3()
        .setFromMatrixPosition(grip.matrixWorld)
        .distanceTo(new THREE.Vector3().setFromMatrixPosition(handle.matrixWorld));
      if (distance > options.maxDistance) return;
    }
    handle.grab(grip);
    held = true;
  });
  const offEnd = onXrInput(grip, options.end ?? "squeezeend", () => {
    if (!held) return;
    held = false;
    handle.release();
  });
  return () => {
    offStart();
    offEnd();
    if (held) {
      held = false;
      handle.release();
    }
  };
}
