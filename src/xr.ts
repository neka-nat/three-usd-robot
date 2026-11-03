/**
 * `three-usd-robot/xr`
 *
 * The WebXR-facing pieces of a robot viewer, on top of the input-agnostic
 * ones in `three-usd-robot/helpers` (re-exported here for one import):
 *
 * - {@link XrOriginRig} — camera + controller spaces under one origin, with
 *   Y-up / Z-up worlds, recenter / teleport and a player scale; or just the
 *   placement math ({@link xrOriginPlacement}) for an origin owned by a
 *   framework such as `@react-three/xr`
 * - {@link XrRayPicker} — hover / select links along a controller ray
 * - {@link bindXrGrab} — a grip button grabs a {@link TcpTargetHandle}
 *
 * Depends only on `three` (no addons): session UI, locomotion policy and
 * spatial UI stay with the application — three's `VRButton`, or
 * `@react-three/xr` in a React app, fit alongside.
 *
 * ```ts
 * import { XrOriginRig, XrRayPicker, bindXrGrab, TcpTargetHandle } from "three-usd-robot/xr";
 *
 * const rig = new XrOriginRig(renderer, camera, { worldUp: "Z" });
 * scene.add(rig);
 * const picker = new XrRayPicker(rig.controllers[0], () => robots);
 * picker.addEventListener("select", ({ hit }) => select(hit.link.primPath));
 * const handle = new TcpTargetHandle(robot, "tool0");
 * scene.add(handle);
 * bindXrGrab(handle, rig.grips[1], { maxDistance: 0.15 });
 * renderer.setAnimationLoop(() => { picker.update(); renderer.render(scene, camera); });
 * ```
 */

export { onXrInput, type XrInputEvent, type XrInputEventType } from "./xr/events.js";
export { bindXrGrab, type XrGrabOptions } from "./xr/grab.js";
export {
  type XrManagerLike,
  XrOriginRig,
  type XrOriginRigOptions,
  type XrWorldUp,
  xrOriginQuaternion,
  type XrOriginPlacementOptions,
  xrOriginPlacement,
} from "./xr/origin.js";
export { XrRayPicker, type XrRayPickerEventMap, type XrRayPickerOptions } from "./xr/rayPicker.js";

// The input-agnostic pieces these build on (also in `three-usd-robot/helpers`).
export {
  type HandleSpace,
  type LinkHit,
  type LinkHitKind,
  type LinkPick,
  type PickLinkOptions,
  pickLink,
  resolveLink,
  type TcpConstraints,
  type TcpTargetEvent,
  TcpTargetHandle,
  type TcpTargetHandleEventMap,
  type TcpTargetHandleOptions,
  type TcpTargetPhase,
  type TcpTargetStatus,
} from "./helpers.js";
