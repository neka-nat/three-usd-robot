/**
 * The WebXR input events three dispatches on its controller spaces (target
 * ray, grip and hand alike — `WebXRController.dispatchEvent` fans out to all
 * three): `select*` for the trigger, `squeeze*` for the grip button, and the
 * input-source lifecycle. Typed once here so the rest of `/xr` can subscribe
 * to any controller object without re-declaring three's event maps.
 */

import type * as THREE from "three";

export type XrInputEventType =
  | "select"
  | "selectstart"
  | "selectend"
  | "squeeze"
  | "squeezestart"
  | "squeezeend"
  | "connected"
  | "disconnected";

/** An input event as three dispatches it: `data` is the WebXR input source. */
export type XrInputEvent = { type: XrInputEventType; data: XRInputSource };

type XrInputEventMap = { [K in XrInputEventType]: { data: XRInputSource } };

/**
 * Subscribe to a WebXR input event on a controller space (`renderer.xr.getController(i)`
 * / `getControllerGrip(i)` / `getHand(i)`). Returns the unsubscribe function.
 */
export function onXrInput(
  space: THREE.Object3D,
  type: XrInputEventType,
  listener: (event: { data: XRInputSource }) => void,
): () => void {
  const target = space as unknown as THREE.EventDispatcher<XrInputEventMap>;
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}
